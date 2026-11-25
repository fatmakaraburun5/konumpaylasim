/**
 * Faz 6: widget / kilit ekranı derin bağlantısının onay kartı (`konum://quick-share?to=<uid>&src=<kaynak>`).
 *
 * Widget arka planda paylaşım başlatamadığında (oturum yok, token yok / bitmek üzere, "Her zaman" konum izni yok,
 * iOS 16, sunucu hatası) uygulamayı bu bağlantıyla açar. Akış (main) yerleşiminde, oturum ve arkadaş listesi
 * hazır olunca işlenir:
 *   arkadaş değil → "Artık arkadaş değilsiniz" · izin gerekiyorsa → mevcut izin akışı (PermissionFlow)
 *   → `runQuickShare` (başlat / 60 dk'ya uzat / zaten açık) → geri sayım + "Durdur" / "Tamam"
 *   hata: bağlantı yok → "Tekrar dene" (aynı kart), diğerleri kısa metin.
 * Giden paylaşım anlık görüntüsü gelmeden karar verilmesin diye istek kısa süre bekletilir (8 saatlik paylaşım
 * yanlışlıkla 1 saate kısalmasın). [Varsayım: 1,5 sn]
 */
import { formatCountdown, QUICK_SHARE_DURATION, type QuickShareStatus, type SessionId, type UserId } from '@konum/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { now as serverNow } from '../../lib/clock';
import { useNow } from '../../lib/useNow';
import { useAuthStore } from '../../state/authStore';
import { useFriendsById, useFriendsStore } from '../../state/friendsStore';
import { quickShareStore, useQuickShareStore, type QuickShareIntent } from '../../state/quickShareStore';
import { sharingStore, useSharingStore } from '../../state/sharingStore';
import { Button, cardShadow, Overlay, Text, useTheme } from '../../ui';
import { needsPermissionFlow, PermissionFlow, type PermissionResult } from '../permissions/PermissionFlow';
import { shareContextOf } from '../permissions/permissionPlanner';
import { FriendAvatar } from '../profile/FriendAvatar';
import { planQuickShareLink, QUICK_STATUS_TEXT, quickShareFailureView } from './quickShareModel';

const SNAPSHOT_GRACE_MS = 1_500;

type Phase =
  | { kind: 'idle' }
  | { kind: 'permission' }
  | { kind: 'running' }
  | { kind: 'done'; status: QuickShareStatus; expires_at: number | null; session_id: SessionId | null }
  | { kind: 'error'; text: string; retry: boolean };

export function QuickShareSheet() {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const pending = useQuickShareStore((s) => s.pending);
  const status = useAuthStore((s) => s.status);
  const friendsLoaded = useFriendsStore((s) => s.loaded);
  const byId = useFriendsById();
  const [job, setJob] = useState<QuickShareIntent | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [graceOver, setGraceOver] = useState(false);
  const [stopping, setStopping] = useState(false);
  const now = useNow(1_000);
  const shares = useSharingStore((s) => s.state.shares);
  const ctx = shareContextOf(QUICK_SHARE_DURATION, now);
  const jobRef = useRef<QuickShareIntent | null>(null);
  jobRef.current = job;

  useEffect(() => {
    if (!friendsLoaded) return;
    const t = setTimeout(() => setGraceOver(true), SNAPSHOT_GRACE_MS);
    return () => clearTimeout(t);
  }, [friendsLoaded]);

  const run = useCallback(async (to: UserId) => {
    setPhase({ kind: 'running' });
    const r = await quickShareStore.getState().run(to, 'link');
    if (jobRef.current?.to !== to) return;
    if (r.ok) setPhase({ kind: 'done', status: r.status, expires_at: r.expires_at, session_id: r.session_id });
    else setPhase({ kind: 'error', ...quickShareFailureView(r.error.code) });
  }, []);

  const begin = useCallback(
    async (to: UserId) => {
      if (await needsPermissionFlow(shareContextOf(QUICK_SHARE_DURATION, serverNow()))) setPhase({ kind: 'permission' });
      else await run(to);
    },
    [run],
  );

  useEffect(() => {
    if (!pending || job) return;
    const plan = planQuickShareLink({ authStatus: status, friendsLoaded: friendsLoaded && graceOver, isFriend: !!byId[pending.to] });
    if (plan.kind === 'wait' || plan.kind === 'signed_out') return; // istek girişten sonra işlenir
    const p = quickShareStore.getState().takePending(serverNow());
    if (!p) return;
    setJob(p);
    if (plan.kind === 'not_friend') setPhase({ kind: 'error', ...quickShareFailureView('not_friend') });
    else void begin(p.to);
  }, [pending, job, status, friendsLoaded, graceOver, byId, begin]);

  const close = () => {
    setJob(null);
    setPhase({ kind: 'idle' });
    setStopping(false);
  };

  const onPermDone = (r: PermissionResult | null) => {
    if (!job) return;
    if (r?.foreground) void run(job.to);
    else setPhase({ kind: 'error', ...quickShareFailureView('permission_denied') });
  };

  const stop = async (sessionId: SessionId) => {
    setStopping(true);
    await sharingStore.getState().stop(sessionId);
    close();
  };

  if (!job) return null;
  const name = byId[job.to]?.displayName ?? 'Arkadaşın';
  const first = name.split(' ')[0] ?? name;
  // "Durdur" oturumun tamamını durdurur: yalnızca oturum sadece bu kişiye ise gösterilir (zaten açık olan çok
  // kişilik paylaşım yanlışlıkla herkese kapanmasın; o durumda haritadaki paylaşım kartı kullanılır).
  const soloSession =
    phase.kind === 'done' && phase.session_id !== null
      ? Object.values(shares).filter((x) => x.session_id === phase.session_id).every((x) => x.receiver_id === job.to)
      : false;

  return (
    <>
      <Overlay visible={phase.kind !== 'permission'} onRequestClose={close} testID="quick-share-sheet">
        <View style={[styles.backdrop, { backgroundColor: 'rgba(15, 23, 42, 0.45)', paddingBottom: insets.bottom + spacing.md, paddingHorizontal: spacing.md }]}>
          <View style={[cardShadow, styles.card, { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.lg, gap: spacing.md }]} accessibilityViewIsModal>
            <View style={[styles.row, { gap: spacing.sm }]}>
              <FriendAvatar uid={job.to} fallbackName={name} size={48} />
              <View style={styles.flex}>
                <Text variant="heading" numberOfLines={1}>
                  {name}
                </Text>
                <Text variant="label" color="textSecondary">
                  Widget’tan 1 saatlik konum paylaşımı
                </Text>
              </View>
            </View>

            {phase.kind === 'running' || phase.kind === 'idle' ? (
              <View style={[styles.row, { gap: spacing.sm }]} accessibilityLiveRegion="polite">
                <ActivityIndicator color={colors.primary} />
                <Text variant="body">Paylaşım başlatılıyor…</Text>
              </View>
            ) : null}

            {phase.kind === 'done' ? (
              <View style={{ gap: spacing.xs }} accessibilityLiveRegion="polite">
                <Text variant="title" color="live">
                  {QUICK_STATUS_TEXT[phase.status]}
                </Text>
                <Text variant="body" color="textSecondary">
                  {phase.expires_at === null
                    ? `${first} konumunu sen durdurana kadar görüyor.`
                    : `${first} konumunu ${formatCountdown(Math.max(0, phase.expires_at - now))} daha görecek.`}
                </Text>
                {!soloSession ? (
                  <Text variant="label" color="textSecondary">
                    Bu paylaşımı haritadaki paylaşım kartından durdurabilirsin.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {phase.kind === 'error' ? (
              <Text variant="body" color="danger" accessibilityLiveRegion="assertive">
                {phase.text}
              </Text>
            ) : null}

            <View style={[styles.row, { gap: spacing.sm }]}>
              {phase.kind === 'done' && phase.session_id && soloSession ? (
                <Button title="Durdur" variant="secondary" block={false} style={styles.flex} loading={stopping} onPress={() => void stop(phase.session_id as SessionId)} />
              ) : null}
              {phase.kind === 'error' && phase.retry ? (
                <Button title="Tekrar dene" block={false} style={styles.flex} onPress={() => void begin(job.to)} />
              ) : null}
              <Button title={phase.kind === 'done' ? 'Tamam' : 'Kapat'} variant={phase.kind === 'done' ? 'primary' : 'ghost'} block={false} style={styles.flex} onPress={close} />
            </View>
          </View>
        </View>
      </Overlay>
      <PermissionFlow visible={phase.kind === 'permission'} context={ctx} onDone={onPermDone} />
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  card: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
