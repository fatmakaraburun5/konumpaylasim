/**
 * Faz 12: "Sık paylaştıkların" kısayol şeridi — haritanın alt alanında ve paylaşım sürerken kitapçığın hemen altında,
 * "Konumumu paylaş" düğmesiyle AYNI satırda (paylaşım sürerken harita alanından yükseklik yemez).
 *
 *   kapalı:   [◯ Ayşe] [◯ Mehmet] [◯ Can] [◯ Zeynep]  …  [＋ Paylaş]
 *   açık:     "Ayşe da konumunu seninle paylaşabiliyor"            ← karşılıklı izin bilgisi / engel metni
 *             [◯ Ayşe] [ 15 dk ] [ 1 saat ] [✕]                     ← tek dokunuş = paylaşım başlar
 *
 * Kişiye dokun → o kişinin iki süre düğmesi açılır (menü / sayfa yok). Engeller tek satırda, aynı yerde çözülür:
 *   görünmez        → "Görünür ol" (Faz 8 geri dönüş akışı)
 *   sözleşme        → "Sözleşmeyi aç"
 *   izin yok        → "İzin ver ve 15 dk paylaş" (Faz 8 `grant_location_view`; ikinci dokunuş açık onaydır)
 *   zaten açık      → "Konumunu zaten görüyor · 40 dk kaldı" (daha kısa süre düğmesi pasif; kısaltma yok)
 *   mola            → "Molan biter ve yayın yeniden açılır." (paylaşım başlayınca f12Services molayı bitirir)
 *   OS konum izni   → mevcut PermissionFlow
 * Kişiye uzun bas → "Öneriden kaldır" (cihazdaki geçmişi silinir; favoriyse favorilerde kalır).
 */
import { formatRemaining, SHORTCUT_DURATIONS, SHORTCUT_TEXT, type DurationChoice, type FrequentContact, type ShortcutDurationId, type UserId } from '@konum/core';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { now as serverNow } from '../../lib/clock';
import { useNow } from '../../lib/useNow';
import { useFriendsById } from '../../state/friendsStore';
import { shareHistoryStore } from '../../state/shareHistoryStore';
import { sharingStore } from '../../state/sharingStore';
import { Avatar, Button, Icon, MIN_TOUCH, Text, useTheme } from '../../ui';
import { openRestoreFlow } from '../invisible/invisibleFlow';
import { needsPermissionFlow, PermissionFlow, type PermissionResult } from '../permissions/PermissionFlow';
import { shareContextOf } from '../permissions/permissionPlanner';
import { friendAvatarProps } from '../../state/friendsStore';
import { quickShareFailureView } from '../quickShare/quickShareModel';
import { ShareButton } from '../map/ShareButton';
import { shortcutContextFor, useFrequentContacts } from './useFrequentContacts';

const choiceOf = (id: ShortcutDurationId): DurationChoice => ({ kind: 'preset', preset: id });
const minutesOf = (id: ShortcutDurationId) => SHORTCUT_DURATIONS.find((d) => d.id === id)!.minutes;
const labelOf = (id: ShortcutDurationId) => SHORTCUT_DURATIONS.find((d) => d.id === id)!.label;
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

type Msg = { tone: 'info' | 'danger' | 'live'; text: string } | null;
type Pending = { kind: 'grant'; dur: ShortcutDurationId } | { kind: 'invisible' } | { kind: 'consent' } | null;

export interface ShortcutStripProps {
  /** Satırın sonundaki "Konumumu paylaş" (paylaşım sürerken kısa "＋ Paylaş"). */
  onShare: () => void;
  /** Paylaşım sürüyor: düğme kısa, şerit kitapçığın altında. */
  compact: boolean;
}

export function ShortcutStrip({ onShare, compact }: ShortcutStripProps) {
  const { colors, radius, spacing } = useTheme();
  const now = useNow(15_000);
  const contacts = useFrequentContacts(now);
  const byId = useFriendsById();
  const [open, setOpen] = useState<UserId | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState<ShortcutDurationId | null>(null);
  const [perm, setPerm] = useState<{ uid: UserId; dur: ShortcutDurationId } | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (collapseTimer.current && clearTimeout(collapseTimer.current)), []);

  const nameOf = useCallback((uid: UserId) => byId[uid]?.displayName ?? 'Arkadaşın', [byId]);

  const close = useCallback(() => {
    setOpen(null);
    setMsg(null);
    setPending(null);
    setBusy(null);
  }, []);

  /** Açılınca: karşılıklı izin bilgisi / engel metni. */
  const describe = useCallback(
    (uid: UserId) => {
      const first = firstName(nameOf(uid));
      const ctx = shortcutContextFor(uid, 15, serverNow());
      setPending(null);
      switch (ctx.plan.kind) {
        case 'invisible':
          setPending({ kind: 'invisible' });
          return setMsg({ tone: 'danger', text: SHORTCUT_TEXT.invisible });
        case 'consent':
          setPending({ kind: 'consent' });
          return setMsg({ tone: 'danger', text: SHORTCUT_TEXT.consent });
        case 'needs_grant':
          return setMsg({ tone: 'info', text: SHORTCUT_TEXT.needsGrant(first) });
        default: {
          const t = ctx.activeUntil !== undefined ? SHORTCUT_TEXT.already(first, ctx.activeUntil === null ? null : formatRemaining(ctx.activeUntil - serverNow())) : ctx.grantFromThem ? SHORTCUT_TEXT.mutual(first) : SHORTCUT_TEXT.oneWay(first);
          const withBreak = ctx.plan.kind === 'start' && ctx.plan.endsBreak ? `${t}. ${SHORTCUT_TEXT.breakEnds}` : t;
          return setMsg({ tone: ctx.activeUntil !== undefined ? 'live' : 'info', text: withBreak });
        }
      }
    },
    [nameOf],
  );

  const toggle = (uid: UserId) => {
    if (open === uid) return close();
    setOpen(uid);
    describe(uid);
  };

  const finishOk = (uid: UserId, dur: ShortcutDurationId) => {
    setBusy(null);
    setPending(null);
    setMsg({ tone: 'live', text: SHORTCUT_TEXT.started(firstName(nameOf(uid)), labelOf(dur)) });
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(close, 2_500);
  };

  const run = async (uid: UserId, dur: ShortcutDurationId, grant: boolean) => {
    setBusy(dur);
    const r = await sharingStore.getState().startShare([uid], choiceOf(dur), grant ? { grantLocationView: true } : undefined);
    if (r.ok && !r.skippedReceiverIds.includes(uid) && !r.needsGrantReceiverIds.includes(uid)) return finishOk(uid, dur);
    setBusy(null);
    const needs = r.ok ? r.needsGrantReceiverIds : (r.needsGrantReceiverIds ?? []);
    if (needs.includes(uid)) {
      setPending({ kind: 'grant', dur });
      return setMsg({ tone: 'info', text: SHORTCUT_TEXT.needsGrant(firstName(nameOf(uid))) });
    }
    const code = r.ok ? 'not_friends' : r.error.code;
    if (code === 'invisible_mode') setPending({ kind: 'invisible' });
    setMsg({ tone: 'danger', text: quickShareFailureView(code).text });
  };

  const tapDuration = async (uid: UserId, dur: ShortcutDurationId) => {
    if (busy) return;
    const t = serverNow();
    const ctx = shortcutContextFor(uid, minutesOf(dur), t);
    switch (ctx.plan.kind) {
      case 'invisible':
        setPending({ kind: 'invisible' });
        return setMsg({ tone: 'danger', text: SHORTCUT_TEXT.invisible });
      case 'consent':
        setPending({ kind: 'consent' });
        return setMsg({ tone: 'danger', text: SHORTCUT_TEXT.consent });
      case 'already':
        return setMsg({ tone: 'live', text: SHORTCUT_TEXT.already(firstName(nameOf(uid)), ctx.plan.until === null ? null : formatRemaining(ctx.plan.until - t)) });
      case 'needs_grant':
        // Açık onay: ilk dokunuş açıklamayı ve "İzin ver ve paylaş"ı gösterir; o düğme izni + paylaşımı birlikte başlatır.
        setPending({ kind: 'grant', dur });
        return setMsg({ tone: 'info', text: SHORTCUT_TEXT.needsGrant(firstName(nameOf(uid))) });
      case 'start':
        if (await needsPermissionFlow(shareContextOf(choiceOf(dur), t))) return setPerm({ uid, dur });
        return run(uid, dur, false);
    }
  };

  const onPermDone = (r: PermissionResult | null) => {
    const p = perm;
    setPerm(null);
    if (!p) return;
    if (r?.foreground) void run(p.uid, p.dur, false);
    else setMsg({ tone: 'danger', text: quickShareFailureView('permission_denied').text });
  };

  const forget = (c: FrequentContact) => {
    Alert.alert(`${nameOf(c.uid)} öneriden kaldırılsın mı?`, c.favorite ? 'Paylaşım geçmişi bu cihazdan silinir. Favorilerinde kalır.' : 'Paylaşım geçmişi bu cihazdan silinir.', [
      { text: 'Vazgeç', style: 'cancel' },
      { text: 'Kaldır', style: 'destructive', onPress: () => (shareHistoryStore.getState().forget(c.uid), close()) },
    ]);
  };

  const shareBtn = compact ? (
    <Button title="＋ Paylaş" block={false} onPress={onShare} accessibilityLabel="Konumumu paylaş" accessibilityHint="Başka bir kişi eklemek için kişi ve süre seçme sayfasını açar" testID="map-share-button" />
  ) : null;

  // Öneri yoksa (yeni hesap / geçmiş silindi): yalnızca her zamanki "Konumumu paylaş" (paylaşım sürerken bir boy küçük).
  if (contacts.length === 0) return compact ? <ShareButton onPress={onShare} compact /> : null;
  const openC = open ? contacts.find((c) => c.uid === open) ?? null : null;
  const pill = (active: boolean) => [styles.pill, { borderRadius: radius.pill, paddingHorizontal: spacing.sm, gap: spacing.xs, backgroundColor: active ? colors.primarySoft : colors.surface, borderColor: active ? colors.primary : colors.border }];
  const msgColor = msg?.tone === 'danger' ? colors.danger : msg?.tone === 'live' ? colors.live : colors.textSecondary;

  return (
    <View style={{ gap: spacing.xs }} testID="shortcut-strip" pointerEvents="box-none">
      {msg && openC ? (
        <View style={[styles.msg, { backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: spacing.sm, borderColor: colors.border }]} accessibilityLiveRegion="polite">
          <Text variant="label" style={{ color: msgColor, flex: 1 }} numberOfLines={2} testID="shortcut-msg">
            {msg.text}
          </Text>
        </View>
      ) : null}
      <View style={[styles.row, { gap: spacing.xs }]} pointerEvents="box-none">
        {openC ? (
          <View style={[styles.row, styles.flex, { gap: spacing.xs }]}>
            <Pressable onPress={close} accessibilityRole="button" accessibilityLabel={`${nameOf(openC.uid)}, kapat`} style={pill(true)} testID={`shortcut-chip-${openC.uid}`}>
              {byId[openC.uid] ? <Avatar {...friendAvatarProps(byId[openC.uid]!)} size={32} /> : null}
              <Text variant="label" numberOfLines={1}>
                {firstName(nameOf(openC.uid))}
              </Text>
            </Pressable>
            {pending?.kind === 'invisible' ? (
              <Button title="Görünür ol" block={false} style={styles.flex} onPress={() => (close(), openRestoreFlow())} />
            ) : pending?.kind === 'consent' ? (
              <Button title="Sözleşmeyi aç" block={false} style={styles.flex} onPress={() => (close(), router.push('/consent'))} />
            ) : pending?.kind === 'grant' ? (
              <Button title={`İzin ver ve ${labelOf(pending.dur)} paylaş`} block={false} style={styles.flex} loading={busy !== null} onPress={() => void run(openC.uid, pending.dur, true)} testID="shortcut-grant" />
            ) : (
              SHORTCUT_DURATIONS.map((d) => (
                <Pressable
                  key={d.id}
                  onPress={() => void tapDuration(openC.uid, d.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${nameOf(openC.uid)} ile ${d.label} konum paylaş`}
                  testID={`shortcut-${d.id}`}
                  style={({ pressed }) => [styles.dur, { flex: 1, borderRadius: radius.pill, backgroundColor: pressed ? colors.primarySoft : openC.usual === d.id ? colors.primary : colors.surface, borderColor: colors.primary }]}
                >
                  {busy === d.id ? (
                    <ActivityIndicator color={openC.usual === d.id ? colors.onPrimary : colors.primary} />
                  ) : (
                    <Text variant="label" style={{ color: openC.usual === d.id ? colors.onPrimary : colors.primary, fontWeight: '700' }}>
                      {d.label}
                    </Text>
                  )}
                </Pressable>
              ))
            )}
            <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Kısayolu kapat" hitSlop={6} style={styles.x}>
              <Icon name="close" size={18} color={colors.textSecondary} />
            </Pressable>
          </View>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.flex} contentContainerStyle={{ gap: spacing.xs }} keyboardShouldPersistTaps="handled">
            {contacts.map((c) => {
              const f = byId[c.uid];
              return (
                <Pressable
                  key={c.uid}
                  onPress={() => toggle(c.uid)}
                  onLongPress={() => forget(c)}
                  accessibilityRole="button"
                  accessibilityLabel={`${nameOf(c.uid)}: 15 dakika ya da 1 saat konum paylaş`}
                  accessibilityHint="Uzun basınca öneriden kaldırılır"
                  testID={`shortcut-chip-${c.uid}`}
                  style={({ pressed }) => [pill(pressed)]}
                >
                  {f ? <Avatar {...friendAvatarProps(f)} size={32} /> : null}
                  <Text variant="label" numberOfLines={1}>
                    {firstName(nameOf(c.uid))}
                  </Text>
                  {c.favorite ? <Icon name="starFilled" size={12} color={colors.warning} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        )}
        {openC ? null : shareBtn}
      </View>
      {perm ? <PermissionFlow visible context={shareContextOf(choiceOf(perm.dur), serverNow())} onDone={onPermDone} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  pill: { flexDirection: 'row', alignItems: 'center', minHeight: MIN_TOUCH, borderWidth: 1, paddingVertical: 4 },
  dur: { minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, paddingHorizontal: 12 },
  msg: { minHeight: 32, flexDirection: 'row', alignItems: 'center', borderWidth: 1, paddingVertical: 6 },
  x: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
});
