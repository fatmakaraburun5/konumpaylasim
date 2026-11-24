/**
 * Web önizlemesi: arkadaş işaretçisi (native `FriendMarker.tsx` ile aynı görünüm ve aynı props).
 * react-native-maps web'de çalışmadığı için işaretçi, önizleme haritasının (PreviewMap.web) verdiği
 * izdüşümle (Web Mercator) ekran koordinatına yerleştirilen sıradan bir View'dur.
 *
 * Faz 2: yeni konum gelince pin sıçramaz, `useAnimatedLatLng` (core `markerTransition` + `interpolateLatLng`)
 * ile kayar; `selected` (ETA kartı açık) iken avatar halkası ve etiket birincil renkte vurgulanır.
 * Faz 3 (native ile aynı): `status` "Bağlantısı kopmuş olabilir" / uzun sessizlikte pin soluklaşır; web etiketinde
 * durum cümlesi ve ikinci satırda son doğrulanmış konum ("Son doğrulanmış konum · 14:05 · %42") yazar.
 */
import { formatAgo, FRESHNESS_TEXT, RECEIVER_STATUS_TEXT, type EpochMs, type Freshness, type ReceiverStatus } from '@konum/core';
import { useContext } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { now as serverNow } from '../../lib/clock';
import { Avatar, Text, useTheme } from '../../ui';
import { MapProjectionContext, MapSizeContext } from './PreviewMap.web';
import { useAnimatedLatLng } from './useAnimatedLatLng.web';

export { MapProjectionContext, type ProjectFn } from './PreviewMap.web';

export interface FriendMarkerProps {
  id: string;
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
}

const DIM: ReadonlySet<ReceiverStatus> = new Set(['offline_suspected', 'stale']);
const WARN: ReadonlySet<ReceiverStatus> = new Set(['delayed', 'offline_suspected', 'stale']);
const WARN_WIDTH = 236;

const AVATAR = 36;
/** Avatar(36) + halka (3+2)*2 + beyaz kenar 2*2 */
const BUBBLE = AVATAR + 10 + 4;
const WIDTH = 160;

/** Üst şeritle (`IncomingStrip`) aynı metin: canlıysa "Canlı", değilse "4 dk önce" / "2 sa önce". */
function statusText(freshness: Freshness, updatedAt: EpochMs | undefined): string {
  if (freshness !== 'live' && updatedAt !== undefined) return formatAgo(updatedAt, serverNow());
  return FRESHNESS_TEXT[freshness];
}

export function FriendMarker({ id, name, lat, lng, freshness, batteryPct, onPress, timestamp, selected = false, updatedAt, status: receiverStatus, verifiedLabel }: FriendMarkerProps) {
  const { colors, radius } = useTheme();
  const project = useContext(MapProjectionContext);
  const view = useContext(MapSizeContext);
  const pos = useAnimatedLatLng(lat, lng, timestamp);
  if (!project) return null;
  const { x, y } = project(pos.lat, pos.lng);
  const first = name.split(' ')[0] ?? name;
  const warn = receiverStatus !== undefined && WARN.has(receiverStatus);
  const dim = receiverStatus !== undefined && DIM.has(receiverStatus) && !selected;
  const status = warn ? RECEIVER_STATUS_TEXT[receiverStatus] : statusText(freshness, updatedAt ?? timestamp);
  const statusColor = selected ? colors.onPrimary : warn ? colors.warning : freshness === 'live' ? colors.live : freshness === 'recent' ? colors.primary : colors.stale;
  const width = warn ? WARN_WIDTH : WIDTH;
  const ring = selected ? colors.primary : colors.surface;
  // Ekran kenarındaki pinin etiketi içeri kayar (pin yerinde kalır).
  const EDGE = 6;
  const shift = !view ? 0 : x - width / 2 < EDGE ? EDGE - (x - width / 2) : x + width / 2 > view.w - EDGE ? view.w - EDGE - (x + width / 2) : 0;
  const labelBg = selected ? colors.primary : colors.surface;

  return (
    <View
      testID={`friend-marker-${id}`}
      pointerEvents="box-none"
      style={[styles.wrap, { width, left: x - width / 2, top: y - BUBBLE / 2, zIndex: selected ? 4 : warn ? 3 : 2 }]}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${name} konumu, ${status}${warn && verifiedLabel ? `, ${verifiedLabel}` : ''}`}
        accessibilityState={{ selected }}
        style={styles.press}
      >
        <View style={[styles.bubble, dim ? styles.dim : null, { backgroundColor: ring, boxShadow: '0px 2px 8px rgba(15, 23, 42, 0.18)' }]}>
          <Avatar name={name} size={AVATAR} freshness={freshness} batteryPct={batteryPct} />
        </View>
        <View
          style={[
            styles.label,
            { maxWidth: width, backgroundColor: labelBg, borderRadius: radius.sm, boxShadow: '0px 1px 4px rgba(15, 23, 42, 0.14)' },
            shift ? { transform: [{ translateX: shift }] } : null,
          ]}
        >
          <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1} style={selected ? { color: colors.onPrimary, fontWeight: '600' } : undefined}>
            {first}
            <Text variant="caption" style={{ color: statusColor, fontWeight: selected ? '400' : warn ? '600' : undefined }} maxFontSizeMultiplier={1}>
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
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', width: WIDTH, alignItems: 'center' },
  press: { alignItems: 'center', cursor: 'pointer' },
  bubble: { borderRadius: 999, padding: 2 },
  dim: { opacity: 0.55 },
  label: { marginTop: 3, paddingHorizontal: 7, paddingVertical: 2, maxWidth: WIDTH },
});
