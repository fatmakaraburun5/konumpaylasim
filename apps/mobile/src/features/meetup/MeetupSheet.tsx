/**
 * Faz 5: "Buluşma noktası öner" alt sayfası (@gorhom/bottom-sheet; arka plan karartması YOK, harita yukarıda
 * görünür ve dokunulabilir kalır: numaralı pinler, orta nokta, kesikli çizgiler MapHome'da çizilir).
 *
 *   Arama adımı (kategori ve sonuçlar üstte: ilk durakta (%52) haritayla birlikte görünsün):
 *     kategori çipleri Kafe / Durak / Buluşma noktası (değişince yeniden arar)
 *     sonuç listesi (1-3): ad, adres, "Ayşe 12 dk · Sen ~9 dk", "Orta noktaya 350 m"; yedek durum metinleri;
 *       konumu görünmeyen arkadaşlar uyarısı (paylaşım yoksa öneriye katılamaz)
 *     katılımcı çipleri: Sen + seçili arkadaşlar, her biri için Araç / Yürüyüş / Bisiklet
 *       (varsayılan: yayılım ≤ 2 km → Yürüyüş, değilse Araç); haritada bırakılan nokta varsa "Sen" için
 *       "Konumum / Seçilen nokta" (seçili hedef → `positionOverrides.me`); değişince "Önerileri güncelle"
 *   Paylaş adımı: alıcılar (varsayılan katılımcılar, en çok 4), isteğe bağlı saat, not → `meetupStore.share`.
 */
import {
  MEETUP_CATEGORIES,
  MEETUP_CATEGORY_EMOJI,
  MEETUP_CATEGORY_TEXT,
  MEETUP_LIMITS,
  TRAVEL_MODES,
  type LatLng,
  type Meetup,
  type MeetupCategory,
  type TravelMode,
  type UserId,
} from '@konum/core';
import { BottomSheetModal, BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { now as serverNow } from '../../lib/clock';
import { useFriends } from '../../state/friendsStore';
import { meetupStore, useMeetupStore } from '../../state/meetupStore';
import { Avatar, Button, Chip, MIN_TOUCH, SheetHeader, Text, useTheme } from '../../ui';
import { TRAVEL_MODE_CHIP } from '../map/EtaCard';
import { defaultMeetupMode, MEETUP_FALLBACK_TEXT, meetAtOptions, participantPoints, suggestionRows, toggleMeetupFriend } from './meetupModel';

export interface MeetupSheetRequest {
  friendIds: UserId[];
  /** Haritada bırakılan nokta: "Sen" için seçili hedef olarak kullanılabilir. */
  pickedPoint?: LatLng | null;
}

export interface MeetupSheetHandle {
  present: (req: MeetupSheetRequest) => void;
  dismiss: () => void;
}

export interface MeetupSheetProps {
  /** Konumu bana görünen arkadaşlar (uid → konum). */
  friendPositions: Record<UserId, LatLng>;
  myPosition: LatLng | null;
  names: Record<UserId, string>;
  /** Sayfa açıldı / kapandı (MapHome alt alanı ve harita katmanı). */
  onOpenChange?: (open: boolean) => void;
  /** Sonuç listesinde öneri seçildi (harita odaklansın). */
  onFocusSuggestion?: (index: number) => void;
  onShared?: (m: Meetup) => void;
  ref?: Ref<MeetupSheetHandle>;
}

type Step = 'search' | 'share';

export function MeetupSheet({ friendPositions, myPosition, names, onOpenChange, onFocusSuggestion, onShared, ref }: MeetupSheetProps) {
  const { colors, radius, spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const sheet = useRef<BottomSheetModal>(null);
  const friends = useFriends();
  const status = useMeetupStore((s) => s.status);
  const result = useMeetupStore((s) => s.result);
  const selectedIndex = useMeetupStore((s) => s.selectedIndex);
  const storeError = useMeetupStore((s) => s.error);
  const missingFromStore = useMeetupStore((s) => s.missingFriendIds);

  const [step, setStep] = useState<Step>('search');
  const [friendIds, setFriendIds] = useState<UserId[]>([]);
  const [modes, setModes] = useState<Record<string, TravelMode>>({});
  const [category, setCategory] = useState<MeetupCategory>('cafe');
  const [pickedPoint, setPickedPoint] = useState<LatLng | null>(null);
  const [usePicked, setUsePicked] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [shareTo, setShareTo] = useState<UserId[]>([]);
  const [meetAtId, setMeetAtId] = useState('none');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const meetAtOpts = useMemo(() => meetAtOptions(serverNow()), [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const positionsRef = useRef({ friendPositions, myPosition });
  positionsRef.current = { friendPositions, myPosition };

  const run = (ids: UserId[], cat: MeetupCategory, m: Record<string, TravelMode>, picked: LatLng | null) => {
    setDirty(false);
    void meetupStore.getState().suggest({ friendIds: ids, category: cat, modes: m, positionOverrides: picked ? { me: picked } : undefined });
  };

  const defaultsFor = (ids: UserId[], picked: LatLng | null, prev: Record<string, TravelMode> = {}): Record<string, TravelMode> => {
    const { points } = participantPoints(ids, positionsRef.current.myPosition, positionsRef.current.friendPositions, picked ? { me: picked } : {});
    const d = defaultMeetupMode(points.map((p) => p.position));
    const out: Record<string, TravelMode> = { me: prev.me ?? d };
    for (const id of ids) out[id] = prev[id] ?? d;
    return out;
  };

  useImperativeHandle(
    ref,
    () => ({
      present: (req) => {
        const ids = [...new Set(req.friendIds)].slice(0, MEETUP_LIMITS.maxParticipants - 1);
        const picked = req.pickedPoint ?? null;
        const m = defaultsFor(ids, picked);
        setStep('search');
        setFriendIds(ids);
        setModes(m);
        setCategory('cafe');
        setPickedPoint(picked);
        setUsePicked(picked !== null);
        setLocalError(null);
        setShareTo(ids);
        setMeetAtId('none');
        setNote('');
        setShareError(null);
        sheet.current?.present();
        onOpenChange?.(true);
        if (ids.length > 0) run(ids, 'cafe', m, picked);
        else meetupStore.getState().clear();
      },
      dismiss: () => sheet.current?.dismiss(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onOpenChange],
  );

  const override = usePicked ? pickedPoint : null;
  const visible = (uid: UserId) => uid in friendPositions;
  const missing = [...new Set([...friendIds.filter((u) => !visible(u)), ...missingFromStore.filter((u) => friendIds.includes(u))])];
  const rows = suggestionRows(result, names);
  const others = friends.filter((f) => !friendIds.includes(f.uid));

  const toggleFriend = (uid: UserId) => {
    const r = toggleMeetupFriend(friendIds, uid);
    setLocalError(r.error);
    if (r.next.length === friendIds.length) return;
    setFriendIds(r.next);
    setModes((prev) => defaultsFor(r.next, override, prev));
    setShareTo((prev) => (r.next.includes(uid) ? [...new Set([...prev, uid])] : prev.filter((u) => u !== uid)).slice(0, MEETUP_LIMITS.maxShareRecipients));
    setDirty(true);
  };
  const setMode = (key: string, m: TravelMode) => {
    setModes((prev) => ({ ...prev, [key]: m }));
    setDirty(true);
  };
  const pickOrigin = (picked: boolean) => {
    if (picked === usePicked) return;
    setUsePicked(picked);
    setDirty(true);
  };
  const pickCategory = (c: MeetupCategory) => {
    setCategory(c);
    if (friendIds.length > 0) run(friendIds, c, modes, override);
  };
  const toggleShareTo = (uid: UserId) => {
    setShareError(null);
    setShareTo((prev) => {
      if (prev.includes(uid)) return prev.filter((u) => u !== uid);
      if (prev.length >= MEETUP_LIMITS.maxShareRecipients) {
        setShareError(`En çok ${MEETUP_LIMITS.maxShareRecipients} kişiye gönderebilirsin.`);
        return prev;
      }
      return [...prev, uid];
    });
  };

  const send = async () => {
    if (selectedIndex === null) return;
    setSending(true);
    setShareError(null);
    const at = meetAtOpts.find((o) => o.id === meetAtId)?.at ?? null;
    const r = await meetupStore.getState().share({ suggestionIndex: selectedIndex, to: shareTo, meet_at: at, note: note.trim() || null });
    setSending(false);
    if (!r.ok) {
      setShareError(r.error.message);
      return;
    }
    onShared?.(r.meetup);
    sheet.current?.dismiss();
  };

  const selected = selectedIndex !== null ? rows[selectedIndex] : undefined;

  return (
    <BottomSheetModal
      ref={sheet}
      snapPoints={['52%', '92%']}
      enableDynamicSizing={false}
      backgroundStyle={{ backgroundColor: colors.surface }}
      handleIndicatorStyle={{ backgroundColor: colors.border }}
      keyboardBehavior="interactive"
      android_keyboardInputMode="adjustResize"
      onDismiss={() => {
        meetupStore.getState().clear();
        onOpenChange?.(false);
      }}
    >
      <BottomSheetScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl, gap: spacing.md }} keyboardShouldPersistTaps="handled">
        <SheetHeader
          title={step === 'search' ? 'Buluşma noktası' : 'Öneriyi paylaş'}
          subtitle={step === 'search' ? 'Herkese makul sürede ulaşılabilir bir yer önerelim.' : selected ? `${selected.emoji} ${selected.title}` : undefined}
          onClose={() => sheet.current?.dismiss()}
        />

        {step === 'search' ? (
          <>
            <Section title="Nerede buluşalım?">
              <View style={[styles.wrap, { gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel="Yer türü">
                {MEETUP_CATEGORIES.map((c) => (
                  <Chip key={c} label={`${MEETUP_CATEGORY_EMOJI[c]} ${MEETUP_CATEGORY_TEXT[c]}`} selected={c === category} onPress={() => pickCategory(c)} />
                ))}
              </View>
            </Section>

            <Section title="Öneriler">
              {missing.length > 0 ? (
                <Text variant="label" color="warning" accessibilityLiveRegion="polite" testID="meetup-missing">
                  {`${missing.map((u) => names[u] ?? 'Bir arkadaşın').join(', ')} konumunu seninle paylaşmıyor; öneriye katılamaz.`}
                </Text>
              ) : null}
              {dirty || (status === 'idle' && friendIds.length > 0) ? (
                <Button title="Önerileri güncelle" onPress={() => run(friendIds, category, modes, override)} disabled={friendIds.length === 0} />
              ) : null}
              {friendIds.length === 0 ? (
                <Text variant="label" color="textSecondary">
                  Önce en az bir arkadaş seç.
                </Text>
              ) : status === 'loading' ? (
                <View style={[styles.row, { gap: spacing.xs }]}>
                  <ActivityIndicator color={colors.textSecondary} size="small" />
                  <Text variant="label" color="textSecondary">
                    Öneriler aranıyor…
                  </Text>
                </View>
              ) : status === 'error' ? (
                <Text variant="label" color="danger" accessibilityLiveRegion="polite">
                  {storeError ?? 'Öneri alınamadı.'}
                </Text>
              ) : result ? (
                <View style={{ gap: spacing.xs }}>
                  {result.fallback ? (
                    <Text variant="label" color={result.fallback === 'too_far' ? 'danger' : 'warning'} accessibilityLiveRegion="polite" testID="meetup-fallback">
                      {MEETUP_FALLBACK_TEXT[result.fallback]}
                    </Text>
                  ) : null}
                  {rows.map((r) => {
                    const on = r.index === selectedIndex;
                    return (
                      <Pressable
                        key={`${r.index}:${r.title}`}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={`Öneri ${r.number}: ${r.title}. ${r.etas}. ${r.fromCenter}`}
                        onPress={() => {
                          meetupStore.getState().select(r.index);
                          onFocusSuggestion?.(r.index);
                        }}
                        testID={`meetup-row-${r.number}`}
                        style={({ pressed }) => [
                          styles.result,
                          {
                            gap: spacing.sm,
                            padding: spacing.sm,
                            borderRadius: radius.md,
                            borderColor: on ? colors.primary : colors.border,
                            backgroundColor: on ? colors.primarySoft : pressed ? colors.surfaceAlt : colors.surface,
                          },
                        ]}
                      >
                        <View style={[styles.num, { backgroundColor: on ? colors.primary : colors.surface, borderColor: colors.primary }]}>
                          <Text variant="label" style={{ color: on ? colors.onPrimary : colors.primary, fontWeight: '700' }}>
                            {String(r.number)}
                          </Text>
                        </View>
                        <View style={styles.flex}>
                          <Text variant="heading" numberOfLines={1}>
                            {`${r.emoji} ${r.title}`}
                          </Text>
                          {r.address ? (
                            <Text variant="caption" color="textSecondary" numberOfLines={1}>
                              {r.address}
                            </Text>
                          ) : null}
                          <Text variant="label">{r.etas}</Text>
                          <Text variant="caption" color="textSecondary">
                            {r.estimated ? `${r.fromCenter} · ~ tahmini süre` : r.fromCenter}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                  {rows.length > 0 ? (
                    <Button title="Paylaş" onPress={() => setStep('share')} disabled={selectedIndex === null} />
                  ) : null}
                </View>
              ) : null}
            </Section>
            <Section title="Katılımcılar">
              <ParticipantRow name="Sen" mode={modes.me ?? 'DRIVE'} onMode={(m) => setMode('me', m)}>
                {pickedPoint ? (
                  <View style={[styles.wrap, { gap: spacing.xxs }]}>
                    <Chip label="Konumum" selected={!usePicked} onPress={() => pickOrigin(false)} />
                    <Chip label="📍 Seçilen nokta" selected={usePicked} onPress={() => pickOrigin(true)} />
                  </View>
                ) : !myPosition ? (
                  <Text variant="caption" color="danger">
                    Konumun alınamadı
                  </Text>
                ) : null}
              </ParticipantRow>
              {friendIds.map((uid) => (
                <ParticipantRow
                  key={uid}
                  name={names[uid] ?? 'Arkadaşın'}
                  mode={visible(uid) ? (modes[uid] ?? 'DRIVE') : null}
                  onMode={(m) => setMode(uid, m)}
                  onRemove={() => toggleFriend(uid)}
                >
                  {!visible(uid) ? (
                    <Text variant="caption" color="warning">
                      Konumu görünmüyor
                    </Text>
                  ) : null}
                </ParticipantRow>
              ))}
              {others.length > 0 && friendIds.length < MEETUP_LIMITS.maxParticipants - 1 ? (
                <View style={[styles.wrap, { gap: spacing.xs }]} accessibilityLabel="Arkadaş ekle">
                  {others.map((f) => (
                    <Chip key={f.uid} label={`+ ${f.displayName}${visible(f.uid) ? '' : ' (konum yok)'}`} onPress={() => toggleFriend(f.uid)} />
                  ))}
                </View>
              ) : null}
              {localError ? (
                <Text variant="label" color="danger">
                  {localError}
                </Text>
              ) : null}
            </Section>

          </>
        ) : (
          <>
            <Section title={`Kime gönderilsin${shareTo.length > 0 ? ` (${shareTo.length})` : ''}`}>
              <View style={[styles.wrap, { gap: spacing.xs }]}>
                {friends.map((f) => (
                  <Chip key={f.uid} label={f.displayName} selected={shareTo.includes(f.uid)} onPress={() => toggleShareTo(f.uid)} />
                ))}
              </View>
            </Section>
            <Section title="Buluşma saati (isteğe bağlı)">
              <View style={[styles.wrap, { gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel="Buluşma saati">
                {meetAtOpts.map((o) => (
                  <Chip key={o.id} label={o.label} selected={o.id === meetAtId} onPress={() => setMeetAtId(o.id)} />
                ))}
              </View>
            </Section>
            <Section title="Not (isteğe bağlı)">
              <BottomSheetTextInput
                value={note}
                onChangeText={setNote}
                placeholder="Örn. Kapının önünde bekliyorum"
                placeholderTextColor={colors.textSecondary}
                accessibilityLabel="Not"
                maxLength={120}
                style={[typography.body, styles.input, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.sm }]}
              />
            </Section>
            <View style={{ paddingHorizontal: spacing.md, gap: spacing.xs }}>
              {shareError ? (
                <Text variant="label" color="danger" accessibilityLiveRegion="assertive">
                  {shareError}
                </Text>
              ) : null}
              <Button title="Gönder" size="lg" onPress={() => void send()} loading={sending} disabled={shareTo.length === 0 || selectedIndex === null} />
              <Button title="Geri" variant="secondary" onPress={() => setStep('search')} disabled={sending} />
            </View>
          </>
        )}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.xs, paddingHorizontal: spacing.md }}>
      <Text variant="heading">{title}</Text>
      {children}
    </View>
  );
}

/** Katılımcı satırı: ad + (konumu varsa) Araç / Yürüyüş / Bisiklet çipleri + ek içerik. */
function ParticipantRow({ name, mode, onMode, onRemove, children }: { name: string; mode: TravelMode | null; onMode: (m: TravelMode) => void; onRemove?: () => void; children?: ReactNode }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.xxs }}>
      <View style={[styles.row, { gap: spacing.xs }]}>
        <Avatar name={name} size={28} />
        <Text variant="body" style={styles.flex} numberOfLines={1}>
          {name}
        </Text>
        {onRemove ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`${name} kişisini çıkar`} onPress={onRemove} hitSlop={8} style={styles.remove}>
            <Text variant="label" style={{ color: colors.textSecondary }}>
              Çıkar
            </Text>
          </Pressable>
        ) : null}
      </View>
      {mode ? (
        <View style={[styles.row, { gap: spacing.xxs }]} accessibilityRole="radiogroup" accessibilityLabel={`${name} ulaşım şekli`}>
          {TRAVEL_MODES.map((m) => (
            <Chip key={m} label={TRAVEL_MODE_CHIP[m]} selected={m === mode} onPress={() => onMode(m)} style={styles.flex} />
          ))}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  result: { flexDirection: 'row', alignItems: 'flex-start', borderWidth: 1.5 },
  num: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  remove: { minHeight: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: 8 },
  input: { minHeight: MIN_TOUCH + 4 },
});
