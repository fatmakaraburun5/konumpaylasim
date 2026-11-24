/**
 * Web önizlemesi: kilit ekranı tarzı simüle telefon bildirimi ("Paylaşım N dk içinde bitiyor").
 *
 * Görünürlük core kuralıyla belirlenir: giden oturum `extendPromptAt` anına geldiğinde (`isNearExpiry`)
 * kart açılır. Düğmeler native bildirim eyleminin kullandığı depo yolunu çağırır
 * (`sharingStore.extend` / `sharingStore.stop`); açık bir demo bildirimi varsa o da kaldırılır.
 *
 * Faz 2: QR bağlantıları da aynı kartı alır (`linkStore.extend` / `linkStore.stop`, bildirim kimliği
 * `share-expiring-link:<link_id>`, native `expiryNotifications.ts` ile aynı). İkisi birden yaklaşıyorsa
 * önce bitecek olan gösterilir.
 */
import {
  extendPromptAt,
  formatRemaining,
  isNearExpiry,
  type ExtensionMinutes,
  type ShareSession,
  type UserId,
} from '@konum/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useFriendNames } from '../../state/friendsStore';
import { linkStore, useLinkSessions, useLinkStore, type LinkSession } from '../../state/linkStore';
import { sharingStore, useShareSessions, useSharingNow } from '../../state/sharingStore';
import { dismissNotificationAsync } from '../../services/notifications/expoNotifications.web';
import { expiryNotificationId } from '../../services/notifications/constants';
import { Text, useTheme } from '../../ui';

/** Yalnızca tarayıcı: buzlu cam görünümü. */
const FROSTED = { backdropFilter: 'blur(14px)' } as unknown as ViewStyle;

const LIVE_PHASES = new Set<ShareSession['phase']>(['active', 'expiring_soon', 'extending']);
const LINK_LIVE_PHASES = new Set<LinkSession['phase']>(['active', 'expiring_soon', 'extending']);

export type NearExpiry =
  | { kind: 'share'; session: ShareSession; leftMs: number; key: string; extending: boolean }
  | { kind: 'link'; link: LinkSession; leftMs: number; key: string; extending: boolean };

function nearShare(sessions: readonly ShareSession[], now: number): NearExpiry | null {
  for (const s of sessions) {
    if (!LIVE_PHASES.has(s.phase) || s.expires_at === null) continue;
    const like = { status: 'active' as const, share_mode: s.share_mode, started_at: s.started_at, expires_at: s.expires_at };
    const promptAt = extendPromptAt(like);
    if (promptAt === null || now < promptAt) continue;
    if (!isNearExpiry(like, now) && s.phase !== 'extending') continue;
    return { kind: 'share', session: s, leftMs: Math.max(0, s.expires_at - now), key: `${s.session_id}:${s.expires_at}`, extending: s.phase === 'extending' };
  }
  return null;
}

function nearLink(links: readonly LinkSession[], now: number): NearExpiry | null {
  for (const l of links) {
    if (!LINK_LIVE_PHASES.has(l.phase) || l.expires_at === null || l.prompt_at === null || now < l.prompt_at) continue;
    if (l.phase === 'active') continue; // uyarı penceresinde değil (core `isNearExpiry` → expiring_soon)
    return { kind: 'link', link: l, leftMs: Math.max(0, l.expires_at - now), key: `link:${l.link_id}:${l.expires_at}`, extending: l.phase === 'extending' };
  }
  return null;
}

/** Bildirim zamanına gelmiş (core `extendPromptAt` / `isNearExpiry`) ilk giden oturum ya da QR bağlantısı. */
export function useNearExpiry(): NearExpiry | null {
  const sessions = useShareSessions();
  const now = useSharingNow();
  const links = useLinkSessions();
  // Bağlantıların saati kendi deposunda ilerler (arkadaş paylaşımı yokken paylaşım saati durur).
  const linkNow = useLinkStore((s) => s.now);
  const share = nearShare(sessions, now);
  const link = nearLink(links, linkNow);
  if (share && link) return link.leftMs < share.leftMs ? link : share;
  return share ?? link;
}

const sameNear = (a: NearExpiry | null, b: NearExpiry | null) =>
  !!a && !!b && a.key === b.key && a.leftMs === b.leftMs && a.extending === b.extending;

/** "Ayşe" · "Ayşe ve Mehmet" · "Ayşe, Mehmet ve Zeynep" · "Ayşe, Mehmet ve 2 kişi daha" */
export function joinNames(ids: readonly UserId[], names: Record<UserId, string>): string {
  const first = ids.map((id) => (names[id] ?? 'Arkadaşın').split(' ')[0] ?? 'Arkadaşın');
  if (first.length === 0) return 'Arkadaşların';
  if (first.length === 1) return first[0]!;
  if (first.length <= 3) return `${first.slice(0, -1).join(', ')} ve ${first[first.length - 1]}`;
  return `${first.slice(0, 2).join(', ')} ve ${first.length - 2} kişi daha`;
}

function AppGlyph() {
  return (
    <View style={styles.appIcon}>
      <Svg width={14} height={14} viewBox="0 0 24 24">
        <Path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 1 1 13 0C18.5 14.8 12 21 12 21Z" fill="#FFFFFF" />
        <Circle cx={12} cy={9.8} r={2.4} fill="#2563EB" />
      </Svg>
    </View>
  );
}

export interface ExpiryNoticeProps {
  /** panel: yan panelde sabit kart · banner: dar ekranda üstten kayan bildirim. */
  mode: 'panel' | 'banner';
}

export function ExpiryNotice({ mode }: ExpiryNoticeProps) {
  const { colors, scheme } = useTheme();
  const dark = scheme === 'dark';
  const near = useNearExpiry();
  const names = useFriendNames();
  const [closed, setClosed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const visible = near !== null && closed !== near.key;

  const slide = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [rendered, setRendered] = useState<NearExpiry | null>(visible ? near : null);
  useEffect(() => {
    // `useNearExpiry` her çizimde yeni nesne döndürür: içerik aynıysa durumu değiştirme (aksi halde sonsuz döngü).
    if (visible && near) setRendered((prev) => (sameNear(prev, near) ? prev : near));
  }, [visible, near]);
  useEffect(() => {
    if (mode !== 'banner') return;
    Animated.timing(slide, { toValue: visible ? 1 : 0, duration: 260, useNativeDriver: false }).start(({ finished }) => {
      if (finished && !visible) setRendered(null);
    });
  }, [visible, mode, slide]);

  const shown = mode === 'banner' ? rendered : visible ? near : null;
  const receivers = shown?.kind === 'share' ? shown.session.active_receiver_ids : null;
  const body = useMemo(
    () =>
      receivers
        ? `${joinNames(receivers, names)} konumunu görmeye devam etsin mi?`
        : 'QR bağlantısını açanlar konumunu görmeye devam etsin mi?',
    [receivers, names],
  );

  if (!shown) {
    if (mode === 'banner') return null;
    return (
      <View style={[styles.placeholder, { borderColor: colors.border }]}>
        <Text variant="caption" color="textSecondary">
          Paylaşımının ya da QR bağlantının bitmesine az kalınca telefon bildirimi burada görünür.
        </Text>
      </View>
    );
  }

  const extending = shown.extending || busy !== null;
  // Native ile aynı kimlik: arkadaş oturumu `share-expiring-<session_id>`, bağlantı `share-expiring-link:<link_id>`.
  const notifId = expiryNotificationId(shown.kind === 'share' ? shown.session.session_id : `link:${shown.link.link_id}`);
  const dismissSystem = () => void dismissNotificationAsync(notifId).catch(() => undefined);
  const extend = async (m: ExtensionMinutes) => {
    setBusy(`extend${m}`);
    try {
      const ok =
        shown.kind === 'share'
          ? await sharingStore.getState().extend(shown.session.session_id, m)
          : await linkStore.getState().extend(shown.link.link_id, m);
      if (ok) dismissSystem();
    } finally {
      setBusy(null);
    }
  };
  const stop = () => {
    dismissSystem();
    setClosed(shown.key);
    if (shown.kind === 'share') void sharingStore.getState().stop(shown.session.session_id);
    else void linkStore.getState().stop(shown.link.link_id);
  };
  const title = shown.kind === 'share' ? 'Paylaşım' : 'QR bağlantısı';

  const cardBg = mode === 'banner' ? (dark ? '#1E293B' : '#FFFFFF') : dark ? 'rgba(30, 41, 59, 0.94)' : 'rgba(255, 255, 255, 0.96)';
  const actionBg = dark ? 'rgba(148, 163, 184, 0.16)' : 'rgba(15, 23, 42, 0.06)';

  const card = (
    <View
      accessibilityRole="alert"
      accessibilityLabel="Telefon bildirimi"
      style={[styles.card, FROSTED, { backgroundColor: cardBg, borderColor: dark ? 'rgba(148,163,184,0.18)' : 'rgba(15,23,42,0.06)' }]}
    >
      <View style={styles.headRow}>
        <AppGlyph />
        <Text variant="caption" style={{ color: colors.textSecondary, letterSpacing: 0.6, flex: 1 }} maxFontSizeMultiplier={1}>
          KONUM
        </Text>
        <Text variant="caption" color="textSecondary" maxFontSizeMultiplier={1}>
          şimdi
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Bildirimi kapat" onPress={() => setClosed(shown.key)} hitSlop={8} style={styles.close}>
          <Text variant="caption" color="textSecondary">✕</Text>
        </Pressable>
      </View>
      <Text variant="label" style={{ fontWeight: '700', color: colors.text }}>
        {`${title} ${formatRemaining(shown.leftMs)} içinde bitiyor`}
      </Text>
      <Text variant="label" style={{ color: colors.textSecondary, fontWeight: '400' }}>
        {body}
      </Text>
      <View style={styles.actions}>
        {([30, 60] as const).map((m) => (
          <Pressable
            key={m}
            accessibilityRole="button"
            disabled={extending}
            onPress={() => void extend(m)}
            style={({ pressed }) => [styles.action, { backgroundColor: pressed ? colors.primarySoft : actionBg, opacity: extending && busy !== `extend${m}` ? 0.5 : 1 }]}
          >
            {busy === `extend${m}` ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text variant="label" style={{ color: colors.primary, fontWeight: '600' }}>
                {m === 30 ? '+30 dk' : '+1 saat'}
              </Text>
            )}
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          disabled={extending}
          onPress={stop}
          style={({ pressed }) => [styles.action, { backgroundColor: pressed ? colors.dangerSoft : actionBg, opacity: extending ? 0.5 : 1 }]}
        >
          <Text variant="label" style={{ color: colors.danger, fontWeight: '600' }}>
            Durdur
          </Text>
        </Pressable>
      </View>
    </View>
  );

  if (mode === 'panel') return card;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.banner,
        {
          opacity: slide,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-180, 0] }) }],
        },
      ]}
    >
      {card}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 22,
    padding: 14,
    gap: 4,
    borderWidth: 1,
    boxShadow: '0px 12px 32px rgba(15, 23, 42, 0.22)',
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  appIcon: { width: 22, height: 22, borderRadius: 6, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center' },
  close: { paddingHorizontal: 4 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  action: { flex: 1, minHeight: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  banner: { position: 'absolute', top: 8, left: 8, right: 8, zIndex: 50 },
  placeholder: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 16, padding: 14 },
});
