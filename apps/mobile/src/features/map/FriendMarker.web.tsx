/**
 * Web önizlemesi: arkadaş işaretçisi (native `FriendMarker.tsx` ile aynı görünüm ve aynı props).
 * react-native-maps web'de çalışmadığı için işaretçi, önizleme haritasının (PreviewMap.web) verdiği
 * izdüşümle (Web Mercator) ekran koordinatına yerleştirilen sıradan bir View'dur.
 *
 * Faz 2: yeni konum gelince pin sıçramaz, `useAnimatedLatLng` (core `markerTransition` + `interpolateLatLng`)
 * ile kayar; `selected` (ETA kartı açık) iken avatar halkası ve etiket birincil renkte vurgulanır.
 * Faz 3 (native ile aynı): `status` "Bağlantısı kopmuş olabilir" / uzun sessizlikte pin soluklaşır; web etiketinde
 * durum cümlesi ve ikinci satırda son doğrulanmış konum ("Son doğrulanmış konum · 14:05 · %42") yazar.
 * Faz 6 (native ile aynı): çerçeveli avatar pini — cinsiyet şeridi (kadın pembe, erkek mavi, bilinmiyorsa gri),
 * fotoğraf (160 px küçük boy) ya da baş harfler, küçük kuyruk; kuyruğun ucu konumdur. Tazelik durum noktasıdır.
 */
import { formatAgo, FRESHNESS_TEXT, genderRingColor, RECEIVER_STATUS_TEXT, type EpochMs, type Freshness, type ReceiverStatus, type UserId } from '@konum/core';
import { useContext } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { now as serverNow } from '../../lib/clock';
import { friendAvatarProps, useFriendsById } from '../../state/friendsStore';
import { Avatar, avatarOuterSize, lightColors, PulseRing, Text, useTheme } from '../../ui';
import { MapProjectionContext, MapSizeContext } from './PreviewMap.web';
import { useAnimatedLatLng } from './useAnimatedLatLng.web';

export { MapProjectionContext, type ProjectFn } from './PreviewMap.web';

export interface FriendMarkerProps {
  id: string;
  /** Faz 6: paylaşanın uid'i → fotoğraf ve cinsiyet çerçevesi. */
  uid?: UserId;
  name: string;
  lat: number;
  lng: number;
  freshness: Freshness;
  batteryPct: number | null;
  onPress?: () => void;
  /** Konum örneğinin alındığı an (paketteki `timestamp`): iki örnek arası kayma süresi buradan. */
  timestamp?: EpochMs;
  /** Seçili (ETA kartı açık) pin: halka ve etiket vurgulanır. */
  selected?: boolean;
  /** Yalnızca web: "2 sa önce" etiketi için son konumun zamanı (verilmezse `timestamp`). */
  updatedAt?: EpochMs;
  /** Faz 3: core alıcı durumu; "Bağlantısı kopmuş olabilir" / uzun sessizlikte pin soluklaşır. */
  status?: ReceiverStatus;
  /** Yalnızca web, Faz 3: uyarı durumunda etiketin ikinci satırı (core `lastVerifiedLocation().label`). */
  verifiedLabel?: string | null;
  /** Faz 4: arkadaşın durum notu; etiketin altında küçük balon. */
  note?: string | null;
  /** Faz 4: nabız halkası — `ping` (birincil renk) ya da `sos` (aktif SOS, kırmızı pin). */
  pulse?: 'ping' | 'sos' | null;
  /** Faz 9: etkin anlık fotoğraf → avatarın sağ üstünde küçük 📷 rozeti. */
  photo?: boolean;
  /** Faz 9: hedef durumu satırı (core `destBadgeText`). */
  dest?: string | null;
  /** Faz 9: hedefe 200 m kala (`near`) satır vurgulanır. */
  destNear?: boolean;
}

const DIM: ReadonlySet<ReceiverStatus> = new Set(['offline_suspected', 'stale']);
const WARN: ReadonlySet<ReceiverStatus> = new Set(['delayed', 'offline_suspected', 'stale']);
const WARN_WIDTH = 236;

const AVATAR = 36;
/** Avatar(36) + cinsiyet şeridi ve beyaz boşluk (3+2)*2 + dış kontur 2*2 */
const BUBBLE = avatarOuterSize(AVATAR) + 4;
const TAIL_H = 7;
/** Kuyruk ucu (konum) pinin tepesinden bu kadar aşağıda. */
const TIP = BUBBLE + TAIL_H - 1;
const WIDTH = 160;

/** Üst şeritle (`IncomingStrip`) aynı metin: canlıysa "Canlı", değilse "4 dk önce" / "2 sa önce". */
function statusText(freshness: Freshness, updatedAt: EpochMs | undefined): string {
  if (freshness !== 'live' && updatedAt !== undefined) return formatAgo(updatedAt, serverNow());
  return FRESHNESS_TEXT[freshness];
}

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
  updatedAt,
  status: receiverStatus,
  verifiedLabel,
  note = null,
  pulse = null,
  photo = false,
  dest = null,
  destNear = false,
}: FriendMarkerProps) {
  const { colors, radius } = useTheme();
  const project = useContext(MapProjectionContext);
  const view = useContext(MapSizeContext);
  const pos = useAnimatedLatLng(lat, lng, timestamp);
  const friend = useFriendsById()[uid ?? ''];
  if (!project) return null;
  const av = friend ? friendAvatarProps(friend) : { name, photoUrl: null, gender: null, recyclingKey: null };
  const { x, y } = project(pos.lat, pos.lng);
  const first = name.split(' ')[0] ?? name;
  const warn = receiverStatus !== undefined && WARN.has(receiverStatus);
  const dim = receiverStatus !== undefined && DIM.has(receiverStatus) && !selected;
  const status = warn ? RECEIVER_STATUS_TEXT[receiverStatus] : statusText(freshness, updatedAt ?? timestamp);
  const statusColor = selected ? colors.onPrimary : warn ? colors.warning : freshness === 'live' ? colors.live : freshness === 'recent' ? colors.primary : colors.stale;
  const width = warn ? WARN_WIDTH : WIDTH;
  const sos = pulse === 'sos';
  const ring = sos ? lightColors.danger : selected ? colors.primary : colors.surface;
  const tailColor = sos ? lightColors.danger : selected ? colors.primary : genderRingColor(av.gender);
  // Ekran kenarındaki pinin etiketi içeri kayar (pin yerinde kalır).
  const EDGE = 6;
  const shift = !view ? 0 : x - width / 2 < EDGE ? EDGE - (x - width / 2) : x + width / 2 > view.w - EDGE ? view.w - EDGE - (x + width / 2) : 0;
  const labelBg = sos ? lightColors.danger : selected ? colors.primary : colors.surface;
  const onLabel = selected || sos;

  return (
    <View
      testID={`friend-marker-${id}`}
      pointerEvents="box-none"
      style={[styles.wrap, { width, left: x - width / 2, top: y - TIP, zIndex: sos ? 6 : selected ? 4 : warn ? 3 : 2 }]}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${sos ? 'Acil durum: ' : ''}${name} konumu, ${status}${warn && verifiedLabel ? `, ${verifiedLabel}` : ''}${note ? `, not: ${note}` : ''}${dest ? `, ${dest}` : ''}${photo ? ', anlık fotoğraf var' : ''}`}
        accessibilityState={{ selected }}
        style={styles.press}
      >
        <View style={[styles.bubble, dim && !sos ? styles.dim : null, { backgroundColor: ring, boxShadow: '0px 2px 8px rgba(15, 23, 42, 0.18)' }]}>
          {pulse ? <PulseRing size={BUBBLE} color={sos ? lightColors.danger : colors.primary} /> : null}
          <Avatar
            name={name}
            size={AVATAR}
            photoUrl={av.photoUrl}
            gender={av.gender}
            recyclingKey={av.recyclingKey}
            freshness={freshness}
            batteryPct={batteryPct}
            transition={0}
          />
          {photo ? (
            <View testID={`friend-marker-photo-${id}`} style={[styles.photoBadge, { backgroundColor: colors.surface, borderColor: colors.live }]}>
              <Text style={styles.photoGlyph} maxFontSizeMultiplier={1}>
                📷
              </Text>
            </View>
          ) : null}
        </View>
        <View testID={`friend-marker-tail-${id}`} style={[styles.tail, { borderTopColor: tailColor }]} />
        <View
          style={[
            styles.label,
            { maxWidth: width, backgroundColor: labelBg, borderRadius: radius.sm, boxShadow: '0px 1px 4px rgba(15, 23, 42, 0.14)' },
            shift ? { transform: [{ translateX: shift }] } : null,
          ]}
        >
          <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={onLabel ? { color: colors.onPrimary, fontWeight: sos ? '700' : '600' } : undefined}>
            {sos ? `SOS · ${first}` : first}
            <Text variant="caption" style={{ color: sos ? colors.onPrimary : statusColor, fontWeight: selected ? '400' : warn ? '600' : undefined }} maxFontSizeMultiplier={1}>
              {` · ${status}`}
            </Text>
          </Text>
          {warn && verifiedLabel ? (
            <Text
              variant="caption"
              numberOfLines={1}
              maxFontSizeMultiplier={1}
              style={{ color: selected ? colors.onPrimary : colors.textSecondary, fontSize: 11, lineHeight: 14, textAlign: 'center' }}
            >
              {verifiedLabel}
            </Text>
          ) : null}
        </View>
        {note ? (
          <View
            style={[
              styles.note,
              { backgroundColor: colors.warningSoft, borderColor: colors.warning, borderRadius: radius.sm, boxShadow: '0px 1px 4px rgba(15, 23, 42, 0.14)' },
              shift ? { transform: [{ translateX: shift }] } : null,
            ]}
          >
            <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={{ color: colors.text, fontSize: 11, lineHeight: 14 }}>
              {note}
            </Text>
          </View>
        ) : null}
        {dest ? (
          <View
            testID={`friend-marker-dest-${id}`}
            style={[
              styles.note,
              {
                backgroundColor: destNear ? colors.liveSoft : colors.surface,
                borderColor: destNear ? colors.live : colors.border,
                borderRadius: radius.sm,
                boxShadow: '0px 1px 4px rgba(15, 23, 42, 0.14)',
              },
              shift ? { transform: [{ translateX: shift }] } : null,
            ]}
          >
            <Text
              variant="caption"
              numberOfLines={1}
              maxFontSizeMultiplier={1}
              style={{ color: destNear ? colors.live : colors.text, fontSize: 11, lineHeight: 14, fontWeight: destNear ? '700' : undefined }}
            >
              {`🏁 ${dest}`}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', width: WIDTH, alignItems: 'center' },
  press: { alignItems: 'center', cursor: 'pointer' },
  bubble: { borderRadius: 999, padding: 2 },
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
  dim: { opacity: 0.55 },
  label: { marginTop: 3, paddingHorizontal: 7, paddingVertical: 2, maxWidth: WIDTH },
  note: { marginTop: 2, paddingHorizontal: 6, paddingVertical: 1, maxWidth: WIDTH, borderWidth: 1 },
  photoBadge: { position: 'absolute', top: -2, right: -4, width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  photoGlyph: { fontSize: 10, lineHeight: 12 },
});
