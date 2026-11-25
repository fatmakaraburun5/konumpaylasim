/**
 * Paylaşım başlatma alt sayfası (@gorhom/bottom-sheet):
 *   SheetHeader → AudienceSwitch ("Arkadaşlar | Bağlantı (QR)")
 *     Arkadaşlar: RecipientPicker → DurationPicker (CustomDurationPicker) → "Paylaşımı başlat"
 *     Bağlantı:   DurationPicker (core `LINK_DURATION_OPTIONS`) → "QR oluştur" → `link_share_create` → LinkQrSheet
 * CTA, geçerli seçim yapılana kadar pasiftir. Başlatmadan önce gerekiyorsa PermissionFlow açılır
 * (bağlantı da konum yayını gerektirir).
 * Faz 8: konum izni (ben → o) vermediğim arkadaşlar "izin yok" etiketiyle görünür; başlatırken bir kez "X'e konumunu
 * görme izni de verilecek" onayı alınır ve `grant_location_view: true` ile başlatılır. Yerel izin listesi eskiyse
 * sunucunun `needs_grant_receiver_ids` yanıtı aynı onayı açar.
 */
import { ACCESS_TEXT, LINK_DURATION_OPTIONS, type DurationChoice, type LinkId, type UserId } from '@konum/core';
import {
  BottomSheetBackdrop,
  BottomSheetFooter,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
  type BottomSheetFooterProps,
} from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';
import { useCallback, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import { useFriendNames, useFriends } from '../../state/friendsStore';
import { linkStore } from '../../state/linkStore';
import { sharingStore, type StartResult } from '../../state/sharingStore';
import { Button, SheetHeader, Text, useTheme } from '../../ui';
import { needsPermissionFlow, PermissionFlow, type PermissionResult } from '../permissions/PermissionFlow';
import { shareContextOf, type ShareContext } from '../permissions/permissionPlanner';
import { AudienceSwitch, type ShareAudience } from './AudienceSwitch';
import { DurationPicker, EMPTY_DURATION, type DurationSelection } from './DurationPicker';
import { RecipientPicker } from './RecipientPicker';
import { grantOnShareConfirmText, needsLocationGrant, pickerRowAccess } from '../access/accessModel';
import { canNow, useCanFn } from '../access/useAccess';

export interface ShareSheetHandle {
  /** `audience` verilirse sayfa o sekmede açılır. */
  present: (audience?: ShareAudience) => void;
  dismiss: () => void;
}

export interface ShareSheetProps {
  /** Bağlantı oluşturuldu: QR sayfasını aç. */
  onLinkCreated?: (linkId: LinkId) => void;
  ref?: Ref<ShareSheetHandle>;
}

/** "X'e konumunu görme izni de verilecek…" onayı (web demoda AlertHost). */
function askGrant(names: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(ACCESS_TEXT.grantOnShareConfirm, grantOnShareConfirmText(names), [
      { text: 'Vazgeç', style: 'cancel', onPress: () => resolve(false) },
      { text: 'İzin ver ve paylaş', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

const LINK_FOREVER_TEXT =
  'Bağlantıya ya da QR koda sahip herkes, sen durdurana kadar konumunu görebilir. Haftada bir hatırlatma alırsın. Emin misin?';

/** [Varsayım] Bağlantı yokken QR oluşturmayı ~3 dk boyunca 5 sn'de bir yeniden dene (sayfa açık kaldıkça). */
const LINK_AUTO_RETRY_MS = 5_000;
const LINK_AUTO_RETRY_MAX = 36;

export function ShareSheet({ onLinkCreated, ref }: ShareSheetProps) {
  const theme = useTheme();
  const { colors, spacing } = theme;
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sheet = useRef<BottomSheetModal>(null);
  const friends = useFriends();
  const names = useFriendNames();
  const can = useCanFn();
  const now = useNow(15_000);

  const [audience, setAudience] = useState<ShareAudience>('friends');
  const [selected, setSelected] = useState<ReadonlySet<UserId>>(new Set());
  const [duration, setDuration] = useState<DurationSelection>(EMPTY_DURATION);
  const [permContext, setPermContext] = useState<ShareContext>({ shareMode: 'timed' });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permVisible, setPermVisible] = useState(false);

  // QR oluşturma bağlantı yokken gerçekten yeniden denenir; sayfa kapanınca / hedef değişince deneme iptal olur.
  const runId = useRef(0);

  const reset = useCallback(() => {
    runId.current++;
    setAudience('friends');
    setSelected(new Set());
    setDuration(EMPTY_DURATION);
    setError(null);
    setStarting(false);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      present: (a) => {
        if (a) setAudience(a);
        sheet.current?.present();
      },
      dismiss: () => sheet.current?.dismiss(),
    }),
    [],
  );

  const changeAudience = useCallback((a: ShareAudience) => {
    runId.current++;
    setStarting(false);
    setAudience(a);
    // Seçenek kümeleri farklı ("Özel süre" bağlantıda yok): süre seçimi sıfırlanır.
    setDuration(EMPTY_DURATION);
    setError(null);
  }, []);

  const toggle = useCallback((uid: UserId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const isLink = audience === 'link';
  const canStart = (isLink || selected.size > 0) && duration.choice !== null && !duration.error && !starting;

  const doStart = useCallback(async () => {
    if (!duration.choice) return;
    setStarting(true);
    setError(null);
    if (isLink) {
      const run = ++runId.current;
      const choice = duration.choice;
      for (let attempt = 0; ; attempt++) {
        // Aynı süre seçimiyle tekrar: linkStore aynı op_id'yi kullanır, sunucuda tek bağlantı oluşur.
        const created = await linkStore.getState().create(choice);
        if (run !== runId.current) return;
        if (created.ok) {
          setStarting(false);
          sheet.current?.dismiss();
          onLinkCreated?.(created.linkId);
          return;
        }
        if (created.error.code !== 'unavailable' || attempt >= LINK_AUTO_RETRY_MAX) {
          setStarting(false);
          setError(created.error.code === 'unavailable' ? 'Bağlantı yok. İnternetini kontrol edip tekrar dene.' : created.error.message);
          return;
        }
        setError('Bağlantı yok. İnternet gelince QR kendiliğinden oluşturulacak…');
        await new Promise((r) => setTimeout(r, LINK_AUTO_RETRY_MS));
        if (run !== runId.current) return;
      }
    }
    const ids = [...selected];
    const choice = duration.choice;
    // Faz 8: izin vermediğim alıcılar varsa önce bir kez sorulur.
    const needs = needsLocationGrant(ids, canNow());
    if (needs.length > 0) {
      const ok = await askGrant(needs.map((id) => names[id] ?? 'Arkadaşın'));
      if (!ok) {
        setStarting(false);
        return;
      }
    }
    await startFriends(ids, choice, needs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration.choice, isLink, names, onLinkCreated, selected]);

  /**
   * Konum izni YALNIZCA onay penceresinde adı geçen kişilere verilir (`confirmed`): onlar `grantLocationView: true`,
   * diğerleri `false` ile ayrı başlatılır. Yerel izin listesi eskiyse sunucunun döndürdüğü kişiler için yeniden sorulur.
   */
  const startFriends = async (ids: UserId[], choice: DurationChoice, confirmed: readonly UserId[]) => {
    const start = (list: readonly UserId[], grant: boolean) => sharingStore.getState().startShare(list, choice, { grantLocationView: grant });
    const grantIds = ids.filter((id) => confirmed.includes(id));
    const others = ids.filter((id) => !confirmed.includes(id));
    const granted = grantIds.length > 0 ? await start(grantIds, true) : null;
    const plain = others.length > 0 ? await start(others, false) : null;
    // Sunucu izin istedi (yerel liste eskiydi): yalnızca o kişiler için aynı onay, sonra izinle.
    const late = plain ? (plain.ok ? plain.needsGrantReceiverIds : (plain.needsGrantReceiverIds ?? [])) : [];
    let lateRun: StartResult | null = null;
    let lateDeclined = false;
    if (late.length > 0) {
      if (await askGrant(late.map((id) => names[id] ?? 'Arkadaşın'))) lateRun = await start(late, true);
      else lateDeclined = true;
    }
    const results = [granted, plain, lateRun].filter((r): r is StartResult => r !== null);
    const started = results.filter((r): r is Extract<StartResult, { ok: true }> => r.ok);
    // `plain` yalnızca izin istediği için başlamadıysa hata o değil, izin sorusudur.
    const failures = results.filter((r): r is Extract<StartResult, { ok: false }> => !r.ok && !(r === plain && late.length > 0));
    setStarting(false);
    if (started.length === 0) {
      setError(failures[0]?.error.message ?? (lateDeclined ? 'Paylaşım başlamadı: konum izni verilmedi.' : 'Paylaşım başlamadı.'));
      return;
    }
    sheet.current?.dismiss();
    const firstFailure = failures[0];
    if (firstFailure) Alert.alert('Bazı kişilerle paylaşılamadı', firstFailure.error.message);
    else if (started.some((r) => r.skippedReceiverIds.length > 0)) {
      Alert.alert('Bazı kişilerle paylaşılamadı', 'Seçtiğin kişilerden bazıları artık arkadaş listende değil.');
    }
  };

  const onStartPress = useCallback(async () => {
    if (!canStart) return;
    const ctx = shareContextOf(duration.choice, Date.now());
    if (await needsPermissionFlow(ctx)) {
      setPermContext(ctx);
      setPermVisible(true);
    } else await doStart();
  }, [canStart, doStart, duration.choice]);

  const onPermissionsDone = useCallback(
    (r: PermissionResult | null) => {
      setPermVisible(false);
      if (r?.foreground) void doStart();
    },
    [doStart],
  );

  const renderBackdrop = useCallback(
    (p: BottomSheetBackdropProps) => <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
    [],
  );

  const renderFooter = useCallback(
    (p: BottomSheetFooterProps) => (
      <BottomSheetFooter {...p} bottomInset={0}>
        <View style={{ backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: insets.bottom + spacing.sm, gap: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
          {error ? (
            <Text variant="label" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          ) : null}
          <Button title={isLink ? 'QR oluştur' : 'Paylaşımı başlat'} size="lg" onPress={onStartPress} disabled={!canStart} loading={starting} />
        </View>
      </BottomSheetFooter>
    ),
    [colors.border, colors.surface, canStart, error, insets.bottom, isLink, onStartPress, spacing.md, spacing.sm, spacing.xs, starting],
  );

  return (
    <>
      <BottomSheetModal
        ref={sheet}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        backdropComponent={renderBackdrop}
        footerComponent={renderFooter}
        onDismiss={reset}
        backgroundStyle={{ backgroundColor: colors.surface }}
        handleIndicatorStyle={{ backgroundColor: colors.border }}
        keyboardBehavior="interactive"
        android_keyboardInputMode="adjustResize"
      >
        <BottomSheetScrollView contentContainerStyle={{ paddingBottom: 140 + insets.bottom, gap: spacing.md }}>
          <SheetHeader
            title="Konumunu paylaş"
            subtitle={isLink ? 'QR kod ya da bağlantıyla, ne kadar süreyle?' : 'Kimlerle ve ne kadar süreyle?'}
            onClose={() => sheet.current?.dismiss()}
          />
          <AudienceSwitch value={audience} onChange={changeAudience} />
          {isLink ? null : (
            <View style={{ gap: spacing.xs }}>
              <Text variant="heading" style={{ paddingHorizontal: spacing.md }}>
                Kişiler {selected.size > 0 ? `(${selected.size})` : ''}
              </Text>
              <RecipientPicker
                friends={friends}
                selected={selected}
                onToggle={toggle}
                access={(uid) => pickerRowAccess('share', uid, can)}
                onAddFriend={() => {
                  sheet.current?.dismiss();
                  router.push('/friends');
                }}
              />
            </View>
          )}
          <View style={{ gap: spacing.xs }}>
            <Text variant="heading" style={{ paddingHorizontal: spacing.md }}>
              Süre
            </Text>
            <DurationPicker
              key={audience}
              value={duration}
              onChange={setDuration}
              now={now}
              options={isLink ? LINK_DURATION_OPTIONS : undefined}
              foreverConfirmText={isLink ? LINK_FOREVER_TEXT : undefined}
            />
          </View>
          <Text variant="caption" color="textSecondary" style={{ paddingHorizontal: spacing.md }}>
            {isLink
              ? 'QR kodu okutan ya da bağlantıyı açan herkes konumunu canlı görür; uygulaması olmayanlar tarayıcıda salt okunur haritada görür. Paylaşımı durdurduğun an bağlantı geçersiz olur.'
              : 'Seçtiğin kişiler birbirini görmez. Paylaşımı istediğin an durdurabilirsin; süre bitince kendiliğinden kapanır.'}
          </Text>
        </BottomSheetScrollView>
      </BottomSheetModal>
      <PermissionFlow visible={permVisible} context={permContext} onDone={onPermissionsDone} />
    </>
  );
}
