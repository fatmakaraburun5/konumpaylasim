/**
 * Harita alt kartı: seçili hedefe (arkadaş ya da bırakılan nokta) rota özeti.
 *
 *   başlık (ad / "Seçilen nokta") + adres satırı (ters geocode, önbellekli)
 *   ulaşım modu çipleri: Araç | Yürüyüş | Bisiklet
 *   ETA (core `formatEtaDuration`) · kalan mesafe (core `formatDistanceTr`)
 *     ya da sakin durum metni (konum yok / hesaplanıyor / servis yok / kota doldu)
 *   "Rotayı kapat"
 *
 * Kart açık değilken rota ve adres ÇAĞRILMAZ (bkz. useEta + routesRepo/geocodeRepo).
 */
import { formatDistanceTr, formatEtaDuration, TRAVEL_MODES, type TravelMode } from '@konum/core';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Avatar, Button, cardShadow, Chip, Text, useTheme } from '../../ui';
import type { AddressState, EtaState, EtaTarget } from './useEta';

/** Çip etiketleri (kısa). Core `TRAVEL_MODE_TEXT` ("Araçla" …) erişilebilirlik ipucunda kullanılır. */
export const TRAVEL_MODE_CHIP: Record<TravelMode, string> = { DRIVE: 'Araç', WALK: 'Yürüyüş', BICYCLE: 'Bisiklet' };

export interface EtaCardProps {
  target: EtaTarget;
  /** Arkadaş için tazelik metni ("Canlı", "3 dk önce"). */
  subtitle?: string | null;
  mode: TravelMode;
  onModeChange: (m: TravelMode) => void;
  eta: EtaState;
  address: AddressState;
  onClose: () => void;
}

export function EtaCard({ target, subtitle, mode, onModeChange, eta, address, onClose }: EtaCardProps) {
  const { colors, spacing, radius } = useTheme();
  const result = eta.entry?.result ?? null;
  const error = eta.entry?.error ?? null;

  let body: ReactNode;
  if (eta.status === 'no_origin') {
    body = (
      <Text variant="label" color="textSecondary">
        Varış süresi için kendi konumun gerekli. Konum iznini açınca hesaplanır.
      </Text>
    );
  } else if (error) {
    body = (
      <Text variant="label" color="textSecondary" accessibilityLiveRegion="polite">
        {error.message}
      </Text>
    );
  } else if (result) {
    body = (
      <View style={[styles.row, { gap: spacing.xs }]} accessible accessibilityLabel={`Tahmini varış ${formatEtaDuration(result.duration_s)}, kalan mesafe ${formatDistanceTr(result.distance_m)}`}>
        <Text variant="title">{formatEtaDuration(result.duration_s)}</Text>
        <Text variant="heading" color="textSecondary">
          · {formatDistanceTr(result.distance_m)}
        </Text>
      </View>
    );
  } else if (eta.status === 'loading') {
    body = (
      <View style={[styles.row, { gap: spacing.xs }]}>
        <ActivityIndicator color={colors.textSecondary} size="small" />
        <Text variant="label" color="textSecondary">
          Rota hesaplanıyor…
        </Text>
      </View>
    );
  } else {
    body = (
      <Text variant="label" color="textSecondary">
        Varış süresi birazdan hesaplanacak.
      </Text>
    );
  }

  return (
    <View style={[cardShadow, { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.md, gap: spacing.sm }]} accessibilityLabel="Rota kartı">
      <View style={[styles.row, { gap: spacing.sm }]}>
        {target.kind === 'friend' ? (
          <Avatar name={target.title} size={36} />
        ) : (
          <View style={[styles.pinBadge, { backgroundColor: colors.primarySoft }]}>
            <View style={[styles.pinDot, { backgroundColor: colors.primary }]} />
          </View>
        )}
        <View style={styles.flex}>
          <Text variant="heading" numberOfLines={1} accessibilityRole="header">
            {target.title}
          </Text>
          {address.text ? (
            <Text variant="caption" color="textSecondary" numberOfLines={1}>
              {subtitle ? `${subtitle} · ${address.text}` : address.text}
            </Text>
          ) : address.pending ? (
            <Text variant="caption" color="textSecondary" numberOfLines={1}>
              {subtitle ? `${subtitle} · Adres aranıyor…` : 'Adres aranıyor…'}
            </Text>
          ) : subtitle ? (
            <Text variant="caption" color="textSecondary" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={[styles.row, { gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel="Ulaşım şekli">
        {TRAVEL_MODES.map((m) => (
          <Chip key={m} label={TRAVEL_MODE_CHIP[m]} selected={m === mode} onPress={() => onModeChange(m)} style={styles.flex} />
        ))}
      </View>

      <View style={{ minHeight: 32, justifyContent: 'center' }}>{body}</View>

      <Button title="Rotayı kapat" variant="secondary" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  pinBadge: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  pinDot: { width: 12, height: 12, borderRadius: 6 },
});
