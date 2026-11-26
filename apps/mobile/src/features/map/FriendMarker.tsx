import { genderRingColor, type EpochMs, type Freshness, type ReceiverStatus, type UserId } from '@konum/core';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { MarkerAnimated, type AnimatedRegion, type MapMarkerProps } from 'react-native-maps';
import { friendAvatarProps, useFriendsById } from '../../state/friendsStore';
import { Avatar, avatarOuterSize, lightColors, PulseRing, Text, useTheme } from '../../ui';
import { useMarkerMotion } from './useMarkerMotion';

export interface FriendMarkerProps {
  id: string;
  /** Faz 6: paylaşanın uid'i → fotoğraf (160 px) ve cinsiyet çerçevesi (arkadaş listesi kopyasından). */
  uid?: UserId;
  name: string;
  lat: number;
  lng: number;
  freshness: Freshness;
  batteryPct: number | null;
  onPress?: () => void;
  /** Konum örneğinin alındığı an (paketteki `timestamp`): iki örnek arası kayma süresi buradan. */
  timestamp?: EpochMs;
  /** Seçili (ETA kartı açık) pin: etiket vurgulanır. */
  selected?: boolean;
  /** Faz 3: core alıcı durumu; "Bağlantısı kopmuş olabilir" / uzun sessizlikte pin soluklaşır. */
  status?: ReceiverStatus;
  /** Faz 4: arkadaşın durum notu ("☕ Kahve molasındayım"); pinin altında küçük balon. */
  note?: string | null;
  /** Faz 4: nabız halkası — `ping` (yeni "Buradayım/Yoldayım", birincil renk) ya da `sos` (aktif SOS, kırmızı). */
  pulse?: 'ping' | 'sos' | null;
  /** Faz 9: etkin anlık fotoğraf → avatarın sağ üstünde küçük 📷 rozeti (görsel bit eşleme girmez). */
  photo?: boolean;
  /** Faz 9: hedef durumu satırı (core `destBadgeText`, ör. "Neredeyse vardı · Ev · ~1 dk"). */
  dest?: string | null;
  /** Faz 9: hedefe 200 m kala (`near`) satır vurgulanır. */
  destNear?: boolean;
}

const DIM: ReadonlySet<ReceiverStatus> = new Set(['offline_suspected', 'stale']);

/** `MarkerAnimated` tipinde `children` eksik; koordinat AnimatedRegion alır. */
type AnimatedMarkerProps = Omit<MapMarkerProps, 'coordinate'> & { coordinate: AnimatedRegion; children?: ReactNode };
export const AnimatedMarker = MarkerAnimated as unknown as ComponentType<AnimatedMarkerProps>;

// --- Pin geometrisi (çapa = kuyruğun ucu) -------------------------------------------------------------
const AVATAR = 36;
/** Avatar + cinsiyet şeridi + beyaz boşluk. */
const FRAMED = avatarOuterSize(AVATAR);
/** Dış kontur (seçili: birincil, SOS: kırmızı, aksi halde yüzey) kalınlığı. */
const OUTLINE = 2;
const BUBBLE = FRAMED + OUTLINE * 2;
const TAIL_H = 7;
const PULSE_BOX = 72;
/** Etiket: marginTop 2 + dikey dolgu 2 + caption satırı 16 (yazı ölçeği 1'e sabit). */
const LABEL_H = 20;
/** Not balonu: marginTop 2 + dolgu 2 + satır 14 + kenarlık 2. */
const NOTE_H = 20;
/** Faz 9: hedef satırı (not balonuyla aynı ölçü). */
const DEST_H = 20;
/** Faz 9: 📷 rozeti. */
const PHOTO_BADGE = 18;
/** [Varsayım] Fotoğraf yüklenmezse bit eşlem izlemesi en geç bu sürede kapanır (harita yavaşlamasın). */
const PHOTO_WAIT_MAX_MS = 5_000;
const SETTLE_MS = 600;

/** Çapa: kuyruk ucu (konum) / toplam yükseklik. Saf; testte de kullanılır. */
export function friendMarkerAnchor(opts: { pulse: boolean; note: boolean; dest?: boolean }): { x: number; y: number } {
  const box = opts.pulse ? PULSE_BOX : BUBBLE + TAIL_H;
  const bubbleTop = opts.pulse ? (PULSE_BOX - BUBBLE) / 2 : 0;
  const tip = bubbleTop + BUBBLE + TAIL_H - 1;
  const total = box + LABEL_H + (opts.note ? NOTE_H : 0) + (opts.dest ? DEST_H : 0);
  return { x: 0.5, y: Math.min(1, tip / total) };
}

/**
 * Arkadaş işaretçisi (Faz 6): çerçeveli avatar pini — cinsiyet şeridi (pembe / mavi / gri) + fotoğraf ya da baş
 * harfler + küçük kuyruk (ucu konumu gösterir), altında ad etiketi; tazelik durum noktası, pil rozeti.
 *
 * Özel görünümlü işaretçiler bit eşlem olarak çizilir. `tracksViewChanges`:
 *  - Fotoğraf varsa resim `onLoad` (ya da `onError` → baş harfler) olana kadar AÇIK; ardından 600 ms daha.
 *  - Her görsel değişimden (seçim, tazelik, pil, not, nabız, fotoğraf) sonra 600 ms açık, sonra kapalı
 *    (sürekli açık olması haritayı yavaşlatır). Nabız canlandığı sürece açık.
 * Konum değişimi bit eşlemi yeniden çizdirmez: pin `useMarkerMotion` ile yeni konuma kayar.
 * Küçük boylar f6Services'te `Image.prefetch` ile önceden diske alınır: ilk çizim beklemesi kısalır.
 */
export function FriendMarker({
  id,
  uid,
  name,
  lat,
  lng,
  freshness,
  batteryPct,
  onPress,
  timestamp,
  selected = false,
  status,
  note = null,
  pulse = null,
  photo = false,
  dest = null,
  destNear = false,
}: FriendMarkerProps) {
  const dim = status !== undefined && DIM.has(status);
  const { colors, radius } = useTheme();
  const coordinate = useMarkerMotion(lat, lng, timestamp);
  const friend = useFriendsById()[uid ?? ''];
  const av = friend ? friendAvatarProps(friend) : { name, photoUrl: null, gender: null, recyclingKey: null };
  const photoUrl = av.photoUrl;
  const [photoReady, setPhotoReady] = useState(!photoUrl);
  const [tracks, setTracks] = useState(true);

  useEffect(() => {
    setPhotoReady(!photoUrl);
  }, [photoUrl]);

  useEffect(() => {
    setTracks(true);
    // Fotoğraf henüz çizilmediyse onLoad beklenir (en çok PHOTO_WAIT_MAX_MS).
    const t = setTimeout(() => setTracks(false), photoReady ? SETTLE_MS : PHOTO_WAIT_MAX_MS);
    return () => clearTimeout(t);
  }, [freshness, batteryPct, name, selected, colors, dim, note, pulse, photoUrl, av.gender, photoReady, photo, dest, destNear]);

  const sos = pulse === 'sos';
  const outline = sos ? lightColors.danger : selected ? colors.primary : colors.surface;
  const ring = genderRingColor(av.gender);
  const tailColor = sos ? lightColors.danger : selected ? colors.primary : ring;
  const anchor = friendMarkerAnchor({ pulse: pulse !== null, note: !!note, dest: !!dest });
  const badgeInset = pulse ? (PULSE_BOX - BUBBLE) / 2 - 4 : 0;

  return (
    <AnimatedMarker
      identifier={id}
      coordinate={coordinate}
      anchor={anchor}
      // Nabız halkası canlandığı sürece bit eşlem yeniden çizilmeli.
      tracksViewChanges={tracks || pulse !== null}
      onPress={onPress}
      accessibilityLabel={`${sos ? 'Acil durum: ' : ''}${name} konumu${dim ? ', bağlantısı kopmuş olabilir' : ''}${note ? `, not: ${note}` : ''}${dest ? `, ${dest}` : ''}${photo ? ', anlık fotoğraf var' : ''}`}
      zIndex={sos ? 4 : selected ? 2 : 1}
    >
      <View style={[styles.wrap, dim && !selected && !sos ? styles.dim : null]}>
        <View style={pulse ? styles.pulseBox : styles.box}>
          {pulse ? <PulseRing size={44} color={sos ? lightColors.danger : colors.primary} /> : null}
          <View style={[styles.bubble, { backgroundColor: outline, marginTop: pulse ? (PULSE_BOX - BUBBLE) / 2 : 0 }]}>
            <Avatar
              name={name}
              size={AVATAR}
              photoUrl={photoUrl}
              gender={av.gender}
              recyclingKey={av.recyclingKey}
              freshness={freshness}
              batteryPct={batteryPct}
              transition={0}
              onPhotoSettled={() => setPhotoReady(true)}
            />
          </View>
          <View style={[styles.tail, { borderTopColor: tailColor }]} />
          {photo ? (
            <View style={[styles.photoBadge, { top: badgeInset, right: badgeInset, backgroundColor: colors.surface, borderColor: colors.live }]}>
              <Text style={styles.photoGlyph} maxFontSizeMultiplier={1}>
                📷
              </Text>
            </View>
          ) : null}
        </View>
        <View style={[styles.label, { backgroundColor: sos ? lightColors.danger : selected ? colors.primary : colors.surface, borderRadius: radius.sm }]}>
          <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={selected || sos ? { color: colors.onPrimary, fontWeight: sos ? '700' : undefined } : undefined}>
            {sos ? `SOS · ${name.split(' ')[0]}` : name.split(' ')[0]}
          </Text>
        </View>
        {note ? (
          <View style={[styles.note, { backgroundColor: colors.warningSoft, borderColor: colors.warning, borderRadius: radius.sm }]}>
            <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={{ color: colors.text, fontSize: 11, lineHeight: 14 }}>
              {note}
            </Text>
          </View>
        ) : null}
        {dest ? (
          <View style={[styles.note, { backgroundColor: destNear ? colors.liveSoft : colors.surface, borderColor: destNear ? colors.live : colors.border, borderRadius: radius.sm }]}>
            <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={{ color: destNear ? colors.live : colors.text, fontSize: 11, lineHeight: 14, fontWeight: destNear ? '700' : undefined }}>
              {`🏁 ${dest}`}
            </Text>
          </View>
        ) : null}
      </View>
    </AnimatedMarker>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  dim: { opacity: 0.55 },
  box: { width: BUBBLE + 8, height: BUBBLE + TAIL_H, alignItems: 'center' },
  // Nabız alanı simetrik büyür: avatar merkezinin çapaya göre konumu değişmez.
  pulseBox: { width: PULSE_BOX, height: PULSE_BOX, alignItems: 'center' },
  bubble: { width: BUBBLE, height: BUBBLE, borderRadius: BUBBLE / 2, alignItems: 'center', justifyContent: 'center' },
  tail: {
    width: 0,
    height: 0,
    marginTop: -1,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: TAIL_H,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  label: { marginTop: 2, paddingHorizontal: 6, paddingVertical: 1, maxWidth: 96 },
  note: { marginTop: 2, paddingHorizontal: 5, paddingVertical: 1, maxWidth: 150, borderWidth: 1 },
  photoBadge: {
    position: 'absolute',
    width: PHOTO_BADGE,
    height: PHOTO_BADGE,
    borderRadius: PHOTO_BADGE / 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoGlyph: { fontSize: 10, lineHeight: 12 },
});
