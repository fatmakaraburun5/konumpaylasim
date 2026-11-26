/**
 * Faz 9: "📷 Anlık fotoğraf" girişi (durum notu sayfası ve paylaşım kitapçığı).
 *
 *  - Fotoğraf yoksa: düğme → kamera (yalnızca kamera) → yükleme ("Ekleniyor…").
 *  - Etkin fotoğraf varsa: küçük resim + kalan süre halkası ("52 dk kaldı") → tam ekran görüntüleyici (kaldır /
 *    yeniden çek).
 */
import { PROOF_TEXT } from '@konum/core';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useNow } from '../../lib/useNow';
import { useMyProof, useProofStore } from '../../state/proofStore';
import { Icon, MIN_TOUCH, Text, useTheme } from '../../ui';
import { ProofCapture } from './ProofCapture';
import { proofLeft } from './proofModel';
import { ProofThumb } from './ProofThumb';
import { ProofViewer } from './ProofViewer';

export interface MyProofButtonProps {
  /** Fotoğraf açıklaması (durum notu metni). */
  caption?: string | null;
  /** Kısa etiket (kitapçık satırı). */
  compact?: boolean;
  testID?: string;
}

export function MyProofButton({ caption = null, compact = false, testID = 'my-proof' }: MyProofButtonProps) {
  const { colors, radius, spacing } = useTheme();
  const mine = useMyProof();
  const phase = useProofStore((s) => s.phase);
  const now = useNow(15_000);
  const [camera, setCamera] = useState(false);
  const [viewer, setViewer] = useState(false);
  const active = mine !== null && mine.expires_at > now;
  const working = phase === 'encoding' || phase === 'uploading';
  const left = active ? proofLeft(mine.expires_at, now) : null;

  const label = working ? PROOF_TEXT.uploading : active ? (compact ? left!.text : `Anlık fotoğraf · ${left!.text}`) : compact ? 'Anlık fotoğraf' : `📷 ${PROOF_TEXT.add}`;

  return (
    <>
      <Pressable
        onPress={() => (active ? setViewer(true) : setCamera(true))}
        disabled={working}
        accessibilityRole="button"
        accessibilityLabel={active ? `Anlık fotoğrafın, ${left!.text}. Görmek için dokun.` : `${PROOF_TEXT.add}. ${PROOF_TEXT.addHint}`}
        testID={testID}
        style={({ pressed }) => [
          styles.row,
          {
            minHeight: MIN_TOUCH,
            gap: spacing.xs,
            paddingHorizontal: active ? spacing.xxs : spacing.sm,
            borderRadius: radius.pill,
            backgroundColor: pressed ? colors.border : colors.surfaceAlt,
            borderColor: active ? colors.live : colors.border,
          },
        ]}
      >
        {working ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : active ? (
          <ProofThumb uri={mine.uri} expiresAt={mine.expires_at} now={now} size={36} />
        ) : compact ? (
          <Icon name="camera" size={18} color={colors.text} />
        ) : null}
        <Text variant="label" numberOfLines={1} style={styles.shrink}>
          {label}
        </Text>
      </Pressable>
      <ProofCapture visible={camera} caption={caption} onClose={() => setCamera(false)} />
      <ProofViewer
        target={viewer ? { kind: 'mine' } : null}
        onClose={() => setViewer(false)}
        onRetake={() => {
          setViewer(false);
          setCamera(true);
        }}
      />
    </>
  );
}

/** Durum notu sayfasındaki açıklama satırı (yalnızca kamera, 1 saat, kimler görür). */
export function ProofHint() {
  return (
    <View>
      <Text variant="caption" color="textSecondary">
        {`${PROOF_TEXT.addHint} ${PROOF_TEXT.ttlHint} ${PROOF_TEXT.audience}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, alignSelf: 'flex-start' },
  shrink: { flexShrink: 1 },
});
