/**
 * Harita alt kartı: seçili hedefe (arkadaş ya da bırakılan nokta) rota özeti.
 *
 *   başlık (ad / "Seçilen nokta") + adres satırı (ters geocode, önbellekli)
 *   ulaşım modu çipleri: Araç | Yürüyüş | Bisiklet
 *   ETA (core `formatEtaDuration`) · kalan mesafe (core `formatDistanceTr`)
 *     ya da sakin durum metni (konum yok / hesaplanıyor / servis yok / kota doldu)
 *   Faz 4: arkadaşın durum notu satırı ("☕ Kahve molasındayım") + eylem yuvası (`children`: arkadaş hedefinde
 *   "📍 Buradayım / 🚶 Yoldayım", nokta hedefinde "Buraya not bırak")
 *   Faz 9: hedef durumu ("🏁 Neredeyse vardı · Ev · ~1 dk") · anlık fotoğraf (küçük resim + "52 dk kaldı" → görüntüleyici)
 *   "Rotayı kapat"
 *
 * Kart açık değilken rota ve adres ÇAĞRILMAZ (bkz. useEta + routesRepo/geocodeRepo).
 */
import { formatDistanceTr, formatEtaDuration, TRAVEL_MODES, type TravelMode } from '@konum/core';
import type { DestState, EpochMs, UserId } from '@konum/core';
import { useRef, type ReactNode } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import { Avatar, Button, cardShadow, Chip, Text, useTheme } from '../../ui';
import { FriendProofRow } from '../proof/FriendProofRow';
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
  /** Kendi konumum yokken: konum iznini iste (rota benim konumumdan çizilir). */
  onRequestLocation?: () => void;
  /** Konum izni kalıcı olarak reddedildi: yalnızca Ayarlar'dan açılabilir. */
  locationBlocked?: boolean;
  /** Faz 4: arkadaşın görünür durum notu. */
  note?: string | null;
  /** Faz 4: "Rotayı kapat" üstündeki eylemler (ping düğmeleri / "Buraya not bırak"). */
  children?: ReactNode;
  /** Faz 9: arkadaşın hedef durumu (core `destBadgeText`). */
  dest?: { text: string; state: DestState } | null;
  /** Faz 9: arkadaşın etkin anlık fotoğrafı (paket referansı). */
  proof?: { ownerId: UserId; ref: { photo_id: string; photo_exp: EpochMs } } | null;
}

export function EtaCard({
  target,
  subtitle,
  mode,
  onModeChange,
  eta,
  address,
  onClose,
  onRequestLocation,
  locationBlocked = false,
  note = null,
  children,
  dest = null,
  proof = null,
}: EtaCardProps) {
  const { colors, spacing, radius } = useTheme();
  // Faz 9: fotoğraf paketten kalkınca açık görüntüleyici kapanmasın ("süresi doldu" göstersin).
  const lastProof = useRef(proof);
  if (proof) lastProof.current = proof;
  const result = eta.entry?.result ?? null;
  const error = eta.entry?.error ?? null;

  let body: ReactNode;
  if (eta.status === 'no_origin') {
    body = (
      <View style={{ gap: spacing.xs }}>
        <Text variant="label" color="textSecondary">
          {locationBlocked
            ? 'Rota için kendi konumun gerekli. Konum iznini Ayarlar’dan açabilirsin.'
            : 'Rota için kendi konumun gerekli. Konumun alınınca rota çizilir.'}
        </Text>
        {locationBlocked ? (
          <Button title="Ayarları aç" variant="secondary" onPress={() => void Linking.openSettings().catch(() => undefined)} />
        ) : onRequestLocation ? (
          <Button title="Konumumu kullan" onPress={onRequestLocation} />
        ) : null}
      </View>
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

      {note ? (
        <View
          style={[styles.note, { backgroundColor: colors.warningSoft, borderColor: colors.warning, borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xxs }]}
          accessible
          accessibilityLabel={`${target.title} notu: ${note}`}
          testID="eta-card-note"
        >
          <Text variant="label" numberOfLines={2}>
            {note}
          </Text>
        </View>
      ) : null}

      {dest ? (
        <View
          style={[
            styles.note,
            {
              backgroundColor: dest.state === 'near' ? colors.liveSoft : colors.surfaceAlt,
              borderColor: dest.state === 'near' ? colors.live : colors.border,
              borderRadius: radius.md,
              paddingHorizontal: spacing.sm,
              paddingVertical: spacing.xxs,
            },
          ]}
          accessible
          accessibilityLabel={`${target.title}: ${dest.text}`}
          testID="eta-card-dest"
        >
          <Text variant="label" numberOfLines={1} style={dest.state === 'near' ? { color: colors.live, fontWeight: '700' } : undefined}>
            {`🏁 ${dest.text}`}
          </Text>
        </View>
      ) : null}

      {proof || lastProof.current ? <FriendProofRow ownerId={(proof ?? lastProof.current)!.ownerId} name={target.title} proofRef={proof?.ref ?? null} /> : null}

      <View style={[styles.row, { gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel="Ulaşım şekli">
        {TRAVEL_MODES.map((m) => (
          <Chip key={m} label={TRAVEL_MODE_CHIP[m]} selected={m === mode} onPress={() => onModeChange(m)} style={styles.flex} />
        ))}
      </View>

      <View style={{ minHeight: 32, justifyContent: 'center' }}>{body}</View>

      {children}

      <Button title="Rotayı kapat" variant="secondary" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  pinBadge: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  pinDot: { width: 12, height: 12, borderRadius: 6 },
  note: { borderWidth: 1 },
});
