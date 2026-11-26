/**
 * Faz 9: anlık fotoğraf görüntüleyicisi (tam ekran) — docs/PHASE9.md §1.1.
 *
 *   başlık "Ayşe · Anlık fotoğraf" · kapat
 *   görsel (`cachePolicy="none"`) · açıklama · "Çekim 14:05"
 *   kalan süre halkası + "52 dk kaldı" (saniyede bir; sunucu saati)
 *   süre dolunca görsel KALDIRILIR: "Fotoğrafın süresi doldu" (erişim sunucuda da kapanır, kopyalar silinir)
 *   sahibi: "Fotoğrafı kaldır" (proof_delete) · "Yeniden çek"
 *
 * Arkadaşın fotoğrafı `useFriendProof` ile (önbellek → proof_get; erişim her istekte sunucuda denetlenir) gelir.
 */
import { formatClock, PROOF_TEXT, type EpochMs, type UserId } from '@konum/core';
import { Image } from 'expo-image';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import { proofStore, useFriendProof, useMyProof, useProofStore } from '../../state/proofStore';
import { Button, Icon, IconButton, Overlay, Text, useTheme } from '../../ui';
import { ProgressRing } from '../map/ProgressRing';
import { PROOF_VIEW_TEXT, proofLeft, proofViewState } from './proofModel';

export type ProofViewerTarget =
  | { kind: 'mine' }
  /** `withdrawn`: görüntüleyici açıkken paketten fotoğraf kalktı (süre doldu / silindi) → görsel kaldırılır, "süresi doldu". */
  | { kind: 'friend'; ownerId: UserId; name: string; ref: { photo_id: string; photo_exp: EpochMs }; withdrawn?: boolean };

export interface ProofViewerProps {
  target: ProofViewerTarget | null;
  onClose: () => void;
  /** Sahibi: "Yeniden çek" (kamera yeniden açılır; yenisi eskisinin yerine geçer). */
  onRetake?: () => void;
}

const FG = '#FFFFFF';

export function ProofViewer({ target, onClose, onRetake }: ProofViewerProps) {
  return (
    <Overlay visible={target !== null} onRequestClose={onClose} testID="proof-viewer">
      {target ? <ViewerBody target={target} onClose={onClose} onRetake={onRetake} /> : null}
    </Overlay>
  );
}

function ViewerBody({ target, onClose, onRetake }: { target: ProofViewerTarget; onClose: () => void; onRetake?: () => void }) {
  const { spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const now = useNow(1_000);
  const mine = useMyProof();
  const phase = useProofStore((s) => s.phase);
  const withdrawn = target.kind === 'friend' && target.withdrawn === true;
  const friend = useFriendProof(target.kind === 'friend' && !withdrawn ? target.ownerId : null, target.kind === 'friend' && !withdrawn ? target.ref : null);

  const isMine = target.kind === 'mine';
  const expiresAt = isMine ? (mine?.expires_at ?? 0) : withdrawn ? Math.min(target.ref.photo_exp, now) : (friend?.expires_at ?? target.ref.photo_exp);
  const uri = isMine ? (mine?.uri ?? null) : withdrawn ? null : (friend?.uri ?? null);
  const caption = isMine ? (mine?.caption ?? null) : (friend?.proof?.caption ?? null);
  const capturedAt = isMine ? (mine?.captured_at ?? null) : (friend?.proof?.captured_at ?? null);
  const state = proofViewState({ expiresAt, now, status: isMine ? 'mine' : (friend?.status ?? 'loading'), uri });
  const left = proofLeft(expiresAt, now);
  const title = isMine ? 'Anlık fotoğrafın' : PROOF_TEXT.viewerTitle(target.name);

  const remove = () => {
    Alert.alert(PROOF_TEXT.remove, 'Fotoğraf hemen kaldırılır; konumunu görenler artık göremez.', [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Kaldır',
        style: 'destructive',
        onPress: async () => {
          const r = await proofStore.getState().removePhoto();
          onClose();
          if (!r.ok) Alert.alert(PROOF_TEXT.removed, 'Sunucu fotoğrafı yine de 1 saat dolunca siler.');
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      <View style={[styles.top, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.sm, gap: spacing.xs }]}>
        <Text variant="heading" style={[styles.fg, styles.flex]} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        <IconButton icon="close" accessibilityLabel="Fotoğrafı kapat" onPress={onClose} variant="soft" size={40} />
      </View>

      <View style={styles.center}>
        {state === 'ready' && uri ? (
          <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="contain" cachePolicy="none" transition={0} accessibilityLabel={caption ?? title} />
        ) : state === 'loading' ? (
          <View style={[styles.center, { gap: spacing.sm }]}>
            <ActivityIndicator color={FG} size="large" />
            <Text variant="label" style={styles.fgSoft}>
              {PROOF_VIEW_TEXT.loading}
            </Text>
          </View>
        ) : (
          <View style={[styles.center, { gap: spacing.sm, padding: spacing.lg }]} accessibilityLiveRegion="polite">
            <Icon name="camera" size={44} color={FG} />
            <Text variant="heading" style={[styles.fg, { textAlign: 'center' }]} testID={`proof-viewer-${state}`}>
              {PROOF_VIEW_TEXT[state === 'ready' ? 'unavailable' : state]}
            </Text>
            {state === 'expired' ? (
              <Text variant="label" style={[styles.fgSoft, { textAlign: 'center' }]}>
                {PROOF_TEXT.expiredBody}
              </Text>
            ) : null}
          </View>
        )}
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + spacing.md, paddingHorizontal: spacing.md, gap: spacing.sm }]}>
        <View style={[styles.row, { gap: spacing.sm }]}>
          <ProgressRing progress={left.ratio} size={36} stroke={4} color={left.ratio < 0.15 ? '#F59E0B' : '#22C55E'} />
          <View style={styles.flex}>
            <Text variant="heading" style={styles.fg} accessibilityLiveRegion="polite" testID="proof-viewer-left">
              {left.text}
            </Text>
            <Text variant="caption" style={styles.fgSoft} numberOfLines={2}>
              {[caption, capturedAt ? PROOF_TEXT.takenAt(formatClock(capturedAt)) : null, PROOF_TEXT.ttlHint].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </View>
        {isMine && mine ? (
          <View style={[styles.row, { gap: spacing.sm }]}>
            {onRetake ? <Button title={PROOF_TEXT.retake} variant="secondary" onPress={onRetake} style={[styles.flex, { borderRadius: radius.md }]} block={false} /> : null}
            <Button title={PROOF_TEXT.remove} variant="danger" onPress={remove} loading={phase === 'deleting'} style={styles.flex} block={false} testID="proof-remove" />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  top: { flexDirection: 'row', alignItems: 'center', paddingBottom: 8 },
  bottom: { paddingTop: 12, backgroundColor: 'rgba(0,0,0,0.6)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  fg: { color: FG },
  fgSoft: { color: 'rgba(255,255,255,0.85)' },
});
