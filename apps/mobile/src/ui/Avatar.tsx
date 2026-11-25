/**
 * Avatar: profil fotoğrafı (expo-image, bellek + disk önbelleği) ya da baş harfler.
 *
 * Faz 6:
 *  - Çerçeve şeridi (3 px) cinsiyete göre renklenir: kadın pembe, erkek mavi, bilinmiyorsa (eski hesap, bekleyen
 *    istek) nötr gri (core `genderRingColor`). Şerit ile fotoğraf arasında beyaz (yüzey rengi) 2 px boşluk.
 *  - Tazelik (Faz 1–5'te halkaydı) artık küçük DURUM NOKTASIDIR: canlı yeşil, yakın zamanda birincil, eski gri.
 *  - Pil rozeti aynen kalır (%15 ve altı uyarı renginde).
 *  - Fotoğraf yoksa ya da yüklenemezse baş harflere düşer. `recyclingKey` = avatar sürümü: liste / pin yeniden
 *    kullanıldığında eski fotoğraf bir kare bile görünmez.
 */
import { genderRingColor, initialsOf, LOW_BATTERY_PCT, type Freshness, type Gender } from '@konum/core';
import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { resolveAvatarUri } from './avatarUri';
import { Text } from './Text';
import { useTheme } from './theme';

/** "Ayşe Yılmaz" → "AY" (Türkçe büyük harf kuralıyla; uygulama core ile aynı işlevi kullanır). */
export { initialsOf };

export interface AvatarProps {
  name: string;
  size?: number;
  /** Faz 6: fotoğraf adresi (liste / pin: 160 px küçük boy; profil: 512 px) ya da yerel dosya (iyimser önizleme). */
  photoUrl?: string | null;
  /** Faz 6: çerçeve rengi bundan (`genderRingColor`); null/undefined → gri. */
  gender?: Gender | null;
  /** Çerçeve şeridi çizilsin mi (varsayılan evet). */
  ring?: boolean;
  /** Önbellek / geri dönüşüm anahtarı (avatar sürümü). */
  recyclingKey?: string | null;
  /** Tazelik → durum noktası: live = yeşil, recent = birincil, stale = gri. Yoksa nokta yok. */
  freshness?: Freshness | null;
  /** Pil yüzdesi; verilirse rozet gösterilir. %15 ve altı uyarı renginde. */
  batteryPct?: number | null;
  /** Ad yerine erişilebilirlik etiketi. */
  accessibilityLabel?: string;
  /** Fotoğraf geçiş animasyonu (ms). Harita pininde 0 (bit eşlem bir kez çizilir). */
  transition?: number;
  /** Fotoğraf çizildi / yüklenemedi (Android pin bit eşlemi bu ana kadar izlenir). */
  onPhotoSettled?: (ok: boolean) => void;
}

const RING = 3;
const GAP = 2;

/** Çerçeveli dış çap (pin / düzen hesapları için). */
export const avatarOuterSize = (size: number, ring = true): number => (ring ? size + (RING + GAP) * 2 : size);

export function Avatar({
  name,
  size = 40,
  photoUrl = null,
  gender = null,
  ring = true,
  recyclingKey = null,
  freshness = null,
  batteryPct = null,
  accessibilityLabel,
  transition = 120,
  onPhotoSettled,
}: AvatarProps) {
  const { colors } = useTheme();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const outer = avatarOuterSize(size, ring);
  const showPhoto = !!photoUrl && failedUrl !== photoUrl;
  const stale = freshness === 'stale';
  const low = batteryPct !== null && batteryPct <= LOW_BATTERY_PCT;
  const dotColor = freshness === 'live' ? colors.live : freshness === 'recent' ? colors.primary : colors.stale;
  const dot = Math.max(8, Math.round(size * 0.28));

  const inner = (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        backgroundColor: stale ? colors.surfaceAlt : colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {showPhoto ? (
        <Image
          source={{ uri: resolveAvatarUri(photoUrl) }}
          style={{ width: size, height: size, opacity: stale ? 0.75 : 1 }}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={recyclingKey ?? photoUrl}
          transition={transition}
          accessible={false}
          onLoad={() => onPhotoSettled?.(true)}
          onError={() => {
            setFailedUrl(photoUrl);
            onPhotoSettled?.(false);
          }}
        />
      ) : (
        <Text variant={size >= 48 ? 'heading' : 'label'} style={{ color: stale ? colors.stale : colors.primary, fontSize: size >= 72 ? 26 : undefined, lineHeight: size >= 72 ? 32 : undefined }} maxFontSizeMultiplier={1}>
          {initialsOf(name)}
        </Text>
      )}
    </View>
  );

  return (
    <View accessible accessibilityLabel={accessibilityLabel ?? name} style={{ width: outer, height: outer, alignItems: 'center', justifyContent: 'center' }}>
      {ring ? (
        <View
          style={{
            width: outer,
            height: outer,
            borderRadius: outer / 2,
            borderWidth: RING,
            borderColor: genderRingColor(gender),
            backgroundColor: colors.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {inner}
        </View>
      ) : (
        inner
      )}
      {freshness ? (
        <View
          testID="avatar-status-dot"
          style={[styles.dot, { width: dot, height: dot, borderRadius: dot / 2, backgroundColor: dotColor, borderColor: colors.surface }]}
        />
      ) : null}
      {batteryPct !== null ? (
        <View
          style={[
            styles.badge,
            {
              backgroundColor: low ? colors.warning : colors.surface,
              borderColor: low ? colors.warning : colors.border,
            },
          ]}
        >
          <Text variant="caption" style={{ color: low ? colors.onPrimary : colors.textSecondary, fontSize: 10, lineHeight: 12 }} maxFontSizeMultiplier={1}>
            {`%${batteryPct}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: { position: 'absolute', right: 0, top: 0, borderWidth: 2 },
  badge: {
    position: 'absolute',
    right: -6,
    bottom: -2,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 999,
    borderWidth: 1,
  },
});
