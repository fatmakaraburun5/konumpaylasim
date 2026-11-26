/**
 * Faz 9: kişi alt kartında arkadaşın anlık fotoğrafı — küçük resim + kalan süre ("52 dk kaldı"); dokununca tam ekran
 * görüntüleyici. Görsel `useFriendProof` ile yüklenir (önbellek → `proof_get`); süre dolunca ya da erişim kalkınca
 * görsel gösterilmez. Görüntüleyici açıkken paketten fotoğraf kalkarsa (süre doldu / silindi / paylaşım bitti) satır
 * gizlenir ama görüntüleyici kapanmaz: görseli kaldırıp "Fotoğrafın süresi doldu" der.
 */
import { PROOF_TEXT, type EpochMs, type UserId } from '@konum/core';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useNow } from '../../lib/useNow';
import { useFriendProof } from '../../state/proofStore';
import { Text, useTheme } from '../../ui';
import { PROOF_VIEW_TEXT, proofLeft, proofViewState } from './proofModel';
import { ProofThumb } from './ProofThumb';
import { ProofViewer } from './ProofViewer';

export interface FriendProofRowProps {
  ownerId: UserId;
  name: string;
  /** core `visibleProofRef(location, now)`; null = pakette fotoğraf yok (satır gizlenir, açık görüntüleyici kalır). */
  proofRef: { photo_id: string; photo_exp: EpochMs } | null;
}

export function FriendProofRow({ ownerId, name, proofRef }: FriendProofRowProps) {
  const { colors, radius, spacing } = useTheme();
  const now = useNow(15_000);
  const fp = useFriendProof(ownerId, proofRef);
  const [open, setOpen] = useState(false);
  const lastRef = useRef<{ ownerId: UserId; ref: { photo_id: string; photo_exp: EpochMs } } | null>(null);
  if (proofRef) lastRef.current = { ownerId, ref: proofRef };
  const viewerTarget = open && lastRef.current ? { kind: 'friend' as const, ownerId: lastRef.current.ownerId, name, ref: lastRef.current.ref, withdrawn: proofRef === null } : null;
  const viewer = <ProofViewer target={viewerTarget} onClose={() => setOpen(false)} />;
  if (!proofRef) return open ? viewer : null;
  const expiresAt = fp?.expires_at || proofRef.photo_exp;
  const state = proofViewState({ expiresAt, now, status: fp?.status ?? 'loading', uri: fp?.uri ?? null });
  const left = proofLeft(expiresAt, now);
  const sub = state === 'ready' ? (fp?.proof?.caption ?? PROOF_TEXT.ttlHint) : PROOF_VIEW_TEXT[state];

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${name} anlık fotoğrafı, ${left.text}. Görmek için dokun.`}
        testID="eta-card-proof"
        style={({ pressed }) => [styles.row, { gap: spacing.sm, padding: spacing.xs, borderRadius: radius.md, backgroundColor: pressed ? colors.border : colors.surfaceAlt }]}
      >
        <ProofThumb uri={state === 'ready' ? (fp?.uri ?? null) : null} expiresAt={expiresAt} now={now} size={44} loading={state === 'loading'} />
        <View style={styles.flex}>
          <Text variant="label" numberOfLines={1}>{`${PROOF_TEXT.cameraTitle} · ${left.text}`}</Text>
          <Text variant="caption" color="textSecondary" numberOfLines={1}>
            {sub}
          </Text>
        </View>
      </Pressable>
      {viewer}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
