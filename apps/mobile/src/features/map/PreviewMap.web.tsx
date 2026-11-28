/**
 * Web önizleme haritası (YALNIZCA tarayıcı paketi): Google Maps yerine react-native-svg ile çizilen basit vektör
 * harita (Kadıköy / Moda). Ana ekran (`MapCanvas.web.tsx`) ve QR izleyicisi (`LinkViewerMap.web.tsx`) bunu
 * kullanır. Telefonda harita her zaman yerel Google Maps SDK'dır (react-native-maps, PROVIDER_GOOGLE).
 *
 *  - İzdüşüm: Web Mercator (256 px karo, z15 temel ölçek). Geometri (`demo/web/mapGeometry.ts`) bir kez temel
 *    ölçekte üretilir; kaydırma/yakınlaştırma yalnızca <G transform> değiştirir.
 *  - Etkileşim: sürükleyerek kaydırma, tekerlek / iki parmak / çift tık ile yakınlaştırma, UZUN BASIŞ (ya da sağ
 *    tık) → `onLongPress(nokta)` (native `MapView.onLongPress` karşılığı: rota hedefi bırakma).
 *  - Rota: `route` (core `decodePolyline` sonucu) caddelerin üstünde kenarlıklı çizgi olarak çizilir.
 *  - Dolgu (`padding`): Google Maps `mapPadding` gibi; `centerOn` / `fitTo` görünür alanın ortasını kullanır.
 *  - Üst katman (`children`): `MapProjectionContext` ile ekran koordinatına yerleşen görünümler (pinler).
 *  - Faz 5: `getCenter()` ve `onCameraChange` (bölge düzenleyicide merkez = harita ortası artı işareti).
 */
import type { LatLng } from '@konum/core';
import {
  createContext,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
  type Ref,
} from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import type { EdgePadding } from 'react-native-maps';
import Svg, { ClipPath, Defs, G, Path, Rect } from 'react-native-svg';
import { HOME, LABELS, LAND, PARKS, PIERS, ROADS, type LL } from '../../demo/web/mapGeometry';
import { Text, useTheme } from '../../ui';

/** Harita → ekran izdüşümü (önizleme haritası sağlar; pinler kullanır). */
export type ProjectFn = (lat: number, lng: number) => { x: number; y: number };
export const MapProjectionContext = createContext<ProjectFn | null>(null);
/** Harita görünümünün piksel boyutu (pin etiketleri kenarda taşmasın diye). */
export const MapSizeContext = createContext<{ w: number; h: number } | null>(null);

export interface PreviewMapHandle {
  /** Noktayı dolgu dışındaki görünür alanın ortasına getirir (en az `zoom`, varsayılan 15.6). */
  centerOn: (lat: number, lng: number, zoom?: number) => void;
  /** Noktaları kenar boşluğuyla sığdırır (native `fitToCoordinates`). */
  fitTo: (points: readonly LatLng[], margin?: number) => void;
  /** Faz 5: görünümün (ekranın) ortasındaki nokta (bölge düzenleyici artı işareti). */
  getCenter: () => LatLng;
}

export interface PreviewMapProps {
  padding: EdgePadding;
  /** Rota çizgisi (enlem/boylam dizisi). */
  route?: readonly LatLng[] | null;
  /** Uzun basış / sağ tık: haritadaki nokta. */
  onLongPress?: (p: LatLng) => void;
  /** Kullanıcı haritayı kaydırdı ya da yakınlaştırdı (izleyici "takip"i bırakır). */
  onUserPan?: () => void;
  /** Faz 5: kamera her değiştiğinde görünüm ortası (native `onRegionChange` karşılığı). */
  onCameraChange?: (center: LatLng) => void;
  /** Konum gösterilmiyorken harita soluk (izleyici: "Paylaşım sona erdi"). */
  dimmed?: boolean;
  initialZoom?: number;
  accessibilityLabel?: string;
  children?: ReactNode;
  ref?: Ref<PreviewMapHandle>;
}

// ── İzdüşüm ────────────────────────────────────────────────────────────────────────────────────

const Z0 = 15;
const WORLD = 256 * 2 ** Z0;
const MIN_Z = 13.5;
const MAX_Z = 18;
const FOCUS_Z = 15.6;
const FIT_MAX_Z = 16.8;
const INITIAL_Z = 14.7;
const LONG_PRESS_MS = 550;
const LONG_PRESS_SLOP_PX = 8;

const mx = (lng: number) => ((lng + 180) / 360) * WORLD;
const my = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2) * WORLD;
};
const OX = mx(HOME[1]);
const OY = my(HOME[0]);
/** Temel ölçekte (z15) dünya pikseli, HOME orijinli. */
const wx = (lng: number) => mx(lng) - OX;
const wy = (lat: number) => my(lat) - OY;
/** Dünya pikseli → enlem/boylam (uzun basış). */
const unproject = (x: number, y: number): LatLng => {
  const lng = ((x + OX) / WORLD) * 360 - 180;
  const n = Math.PI * (1 - (2 * (y + OY)) / WORLD);
  const lat = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
};

const toD = (pts: readonly LL[], close = false) =>
  pts.map(([la, ln], i) => `${i ? 'L' : 'M'}${wx(ln).toFixed(1)},${wy(la).toFixed(1)}`).join('') + (close ? 'Z' : '');

/** Yerleşim içi ara sokaklar: hafif döndürülmüş, yer yer kesik ızgara (deterministik, yalnızca görsel). Kara ile kırpılır. */
function minorStreets(): string {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const span = 2600;
  const step = 30;
  const a = (-14 * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const rot = (x: number, y: number) => `${(x * ca - y * sa + 500).toFixed(1)},${(x * sa + y * ca - 300).toFixed(1)}`;
  const parts: string[] = [];
  for (let dir = 0; dir < 2; dir++) {
    for (let k = -span; k <= span; k += step + Math.round(rnd() * 14) - 7) {
      let t = -span;
      while (t < span) {
        const len = 40 + rnd() * 170;
        if (rnd() > 0.22) {
          const [x1, y1, x2, y2] = dir === 0 ? [t, k, t + len, k] : [k, t, k, t + len];
          parts.push(`M${rot(x1, y1)}L${rot(x2, y2)}`);
        }
        t += len + (rnd() > 0.7 ? step : 0);
      }
    }
  }
  return parts.join('');
}

let geometryCache: { land: string; piers: string; parks: string; major: string; secondary: string; minor: string } | null = null;
function geometry() {
  geometryCache ??= {
    land: toD(LAND, true),
    piers: PIERS.map((p) => toD(p, true)).join(''),
    parks: PARKS.map((p) => toD(p.ring, true)).join(''),
    major: ROADS.filter((r) => r.major).map((r) => toD(r.line)).join(''),
    secondary: ROADS.filter((r) => !r.major).map((r) => toD(r.line)).join(''),
    minor: minorStreets(),
  };
  return geometryCache;
}

// ── Bileşen ────────────────────────────────────────────────────────────────────────────────────

interface Camera {
  /** Ekran ortasındaki nokta, temel ölçekte dünya pikseli. */
  cx: number;
  cy: number;
  z: number;
}

const clampZ = (z: number) => Math.min(MAX_Z, Math.max(MIN_Z, z));

export function PreviewMap({ padding, route, onLongPress, onUserPan, onCameraChange, dimmed = false, initialZoom = INITIAL_Z, accessibilityLabel = 'Harita', children, ref }: PreviewMapProps) {
  const theme = useTheme();
  const { colors } = theme;
  const dark = theme.scheme === 'dark';

  const [size, setSize] = useState({ w: 390, h: 844 });
  const [cam, setCam] = useState<Camera>({ cx: 0, cy: 0, z: initialZoom });
  const camRef = useRef(cam);
  camRef.current = cam;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  const longPressRef = useRef(onLongPress);
  longPressRef.current = onLongPress;
  const userPanRef = useRef(onUserPan);
  userPanRef.current = onUserPan;
  const cameraChangeRef = useRef(onCameraChange);
  cameraChangeRef.current = onCameraChange;
  const anim = useRef<number | null>(null);
  const root = useRef<ComponentRef<typeof View>>(null);
  const geo = useMemo(geometry, []);

  const stopAnim = () => {
    if (anim.current !== null) cancelAnimationFrame(anim.current);
    anim.current = null;
  };

  const animateTo = useCallback((target: Camera, ms = 450) => {
    stopAnim();
    const from = camRef.current;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - (1 - k) ** 3;
      setCam({ cx: from.cx + (target.cx - from.cx) * e, cy: from.cy + (target.cy - from.cy) * e, z: from.z + (target.z - from.z) * e });
      anim.current = k < 1 ? requestAnimationFrame(step) : null;
    };
    anim.current = requestAnimationFrame(step);
  }, []);

  /** Görünür alan (dolgu dışı) ortasının ekran ortasına göre kayması. */
  const viewportShift = () => {
    const { w, h } = sizeRef.current;
    const p = paddingRef.current;
    return { vx: (p.left + w - p.right) / 2 - w / 2, vy: (p.top + h - p.bottom) / 2 - h / 2 };
  };

  useImperativeHandle(
    ref,
    () => ({
      centerOn: (lat, lng, zoom = FOCUS_Z) => {
        const z = Math.max(camRef.current.z, zoom);
        const s = 2 ** (z - Z0);
        const { vx, vy } = viewportShift();
        animateTo({ cx: wx(lng) - vx / s, cy: wy(lat) - vy / s, z });
      },
      fitTo: (points, margin = 48) => {
        if (points.length === 0) return;
        const xs = points.map((p) => wx(p.lng));
        const ys = points.map((p) => wy(p.lat));
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const { w, h } = sizeRef.current;
        const p = paddingRef.current;
        const availW = Math.max(80, w - p.left - p.right - margin * 2);
        const availH = Math.max(80, h - p.top - p.bottom - margin * 2);
        const fit = Math.min(availW / Math.max(1, maxX - minX), availH / Math.max(1, maxY - minY));
        const z = clampZ(Math.min(FIT_MAX_Z, Z0 + Math.log2(fit)));
        const s = 2 ** (z - Z0);
        const { vx, vy } = viewportShift();
        animateTo({ cx: (minX + maxX) / 2 - vx / s, cy: (minY + maxY) / 2 - vy / s, z }, 550);
      },
      getCenter: () => unproject(camRef.current.cx, camRef.current.cy),
    }),
    [animateTo],
  );

  useEffect(() => {
    cameraChangeRef.current?.(unproject(cam.cx, cam.cy));
  }, [cam]);

  // Google Maps `mapPadding` gibi: alt/üst dolgu değişince (paylaşım kartı, ETA kartı) görünür alanın
  // ortası kayar; içerik de dolgu farkının yarısı kadar kayar, böylece işaretçiler kartların altında kalmaz.
  // İlk yerleşim (alt dolgu henüz ölçülmemişken) atlanır: açılış çerçevesi değişmez.
  const lastPad = useRef({ top: padding.top, bottom: padding.bottom });
  useEffect(() => {
    const prev = lastPad.current;
    lastPad.current = { top: padding.top, bottom: padding.bottom };
    if (prev.bottom <= 8) return;
    const dy = (padding.bottom - prev.bottom - (padding.top - prev.top)) / 2;
    if (Math.abs(dy) < 1) return;
    const c = camRef.current;
    const k = dy / 2 ** (c.z - Z0);
    if (anim.current === null) animateTo({ ...c, cy: c.cy + k }, 220);
    else setCam({ ...c, cy: c.cy + k });
  }, [padding.top, padding.bottom, animateTo]);

  // Sürükleme, tekerlek, iki parmak, çift tık ve uzun basış: DOM olayları (yalnızca web).
  useEffect(() => {
    const el = root.current as unknown as HTMLElement | null;
    if (!el || typeof el.addEventListener !== 'function') return;
    el.style.touchAction = 'none';
    el.style.cursor = 'grab';
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; z: number } | null = null;
    let press: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
    let panned = false;

    const cancelPress = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    const pointAt = (px: number, py: number): LatLng => {
      const c = camRef.current;
      const { w, h } = sizeRef.current;
      const s = 2 ** (c.z - Z0);
      return unproject(c.cx + (px - w / 2) / s, c.cy + (py - h / 2) / s);
    };
    const userMoved = () => {
      if (panned) return;
      panned = true;
      userPanRef.current?.();
    };
    const zoomAt = (nextZ: number, px: number, py: number) => {
      const c = camRef.current;
      const { w, h } = sizeRef.current;
      const z = clampZ(nextZ);
      const s0 = 2 ** (c.z - Z0);
      const s1 = 2 ** (z - Z0);
      // İmlecin altındaki dünya noktası yerinde kalsın.
      const wxp = c.cx + (px - w / 2) / s0;
      const wyp = c.cy + (py - h / 2) / s0;
      setCam({ cx: wxp - (px - w / 2) / s1, cy: wyp - (py - h / 2) / s1, z });
    };
    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      // Kabuk telefon çerçevesini küçültmüş olabilir (CSS scale): ekran pikselini düzen pikseline çevir.
      const k = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
      return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
    };
    const onButton = (e: Event) => {
      const target = e.target as HTMLElement | null;
      return !!target && !!target.closest('[role="button"]');
    };

    const onDown = (e: PointerEvent) => {
      // İşaretçilere ve haritanın üstündeki düğmelere dokunuş sürükleme başlatmasın.
      if (onButton(e)) return;
      if (e.button !== undefined && e.button > 0) return; // sağ tık: contextmenu
      stopAnim();
      const p = local(e);
      pointers.set(e.pointerId, p);
      el.setPointerCapture?.(e.pointerId);
      el.style.cursor = 'grabbing';
      panned = false;
      cancelPress();
      if (pointers.size === 1 && longPressRef.current) {
        const id = e.pointerId;
        press = {
          id,
          x: p.x,
          y: p.y,
          timer: setTimeout(() => {
            if (!press || press.id !== id) return;
            const at = pointAt(press.x, press.y);
            press = null;
            pointers.delete(id);
            el.style.cursor = 'grab';
            longPressRef.current?.(at);
          }, LONG_PRESS_MS),
        };
      }
      if (pointers.size === 2) {
        cancelPress();
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: camRef.current.z };
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      if (press && press.id === e.pointerId && Math.hypot(p.x - press.x, p.y - press.y) > LONG_PRESS_SLOP_PX) cancelPress();
      pointers.set(e.pointerId, p);
      if (pointers.size >= 2 && pinch) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.d > 0) zoomAt(pinch.z + Math.log2(d / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
        userMoved();
        return;
      }
      if (press) return; // uzun basış bekleniyor: küçük titreme kaydırmasın
      const c = camRef.current;
      const s = 2 ** (c.z - Z0);
      if (p.x !== prev.x || p.y !== prev.y) userMoved();
      setCam({ cx: c.cx - (p.x - prev.x) / s, cy: c.cy - (p.y - prev.y) / s, z: c.z });
    };
    const onUp = (e: PointerEvent) => {
      if (press && press.id === e.pointerId) cancelPress();
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) el.style.cursor = 'grab';
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopAnim();
      const p = local(e);
      userMoved();
      panned = false;
      zoomAt(camRef.current.z - e.deltaY * 0.0025, p.x, p.y);
    };
    const onDbl = (e: MouseEvent) => {
      if (onButton(e)) return;
      const p = local(e);
      userMoved();
      panned = false;
      zoomAt(camRef.current.z + 1, p.x, p.y);
    };
    const onContext = (e: MouseEvent) => {
      if (!longPressRef.current || onButton(e)) return;
      e.preventDefault();
      const p = local(e);
      longPressRef.current(pointAt(p.x, p.y));
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDbl);
    el.addEventListener('contextmenu', onContext);
    // overflow:hidden kutu yine de programla kaydırılabilir (klavye odağı / scrollIntoView kenardaki bir pini
    // görünür yapmaya çalışınca): harita katmanı kayıp kenarda su rengi şerit açılmasın, hep 0'da kalsın.
    const onScroll = () => {
      if (el.scrollLeft || el.scrollTop) el.scrollTo(0, 0);
    };
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDbl);
      el.removeEventListener('contextmenu', onContext);
      cancelPress();
      stopAnim();
    };
  }, []);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setSize({ w: width, h: height });
  };

  const s = 2 ** (cam.z - Z0);
  const tx = size.w / 2 - cam.cx * s;
  const ty = size.h / 2 - cam.cy * s;
  const project = useCallback<ProjectFn>((lat, lng) => ({ x: tx + wx(lng) * s, y: ty + wy(lat) * s }), [tx, ty, s]);

  // Çizgi kalınlıkları yakınlaştırmayla yumuşakça büyür (ekran pikseli → dünya pikseli için / s).
  const grow = Math.pow(s, 0.6);
  const sw = (px: number) => (px * grow) / s;

  // Faz 7 açık/koyu görünümü birebir korunur; Faz 11 paketleri (nude/blush/charcoal) native stille aynı belirteçleri
  // kullanır: cadde = mapRoad, ana yol = mapHighway, sokak = mapRoadMinor.
  const legacy = theme.id === 'light' || theme.id === 'dark';
  const palette = {
    land: colors.mapLand,
    water: colors.mapWater,
    park: colors.mapPark,
    road: colors.mapRoad,
    highway: legacy ? colors.mapRoad : colors.mapHighway,
    casing: legacy ? (dark ? '#2A3A57' : colors.border) : colors.mapRoadStroke,
    minor: legacy ? (dark ? '#1A263C' : '#FFFFFF') : colors.mapRoadMinor,
    minorCasing: legacy ? (dark ? '#152033' : '#E7ECF2') : colors.mapRoadStroke,
    shore: colors.mapShore,
    waterLabel: legacy ? (dark ? '#5B86B5' : '#5E8DBD') : colors.mapLabel,
    parkLabel: legacy ? (dark ? '#4C9A6A' : '#3F8A55') : colors.live,
  };

  // Örnek başına kimlik: ana harita yığında (gizli) dururken izleyicinin haritası aynı kimliğe başvurursa tarayıcı
  // gizli ağaçtaki kırpma yolunu uygulamaz ve sokaklar denizin üstüne taşar.
  const reactId = useId();
  const clipId = `konum-land-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const routeD = useMemo(() => (route && route.length > 1 ? toD(route.map((p) => [p.lat, p.lng] as const)) : null), [route]);

  return (
    <View
      ref={root}
      style={[StyleSheet.absoluteFill, { backgroundColor: palette.water, overflow: 'hidden' }]}
      onLayout={onLayout}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={onLongPress ? 'Rota için bir noktaya uzun bas' : undefined}
    >
      <Svg width={size.w} height={size.h} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <ClipPath id={clipId}>
            <Path d={geo.land} />
          </ClipPath>
        </Defs>
        <Rect x={0} y={0} width={size.w} height={size.h} fill={palette.water} />
        <G transform={`translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(5)})`}>
          <Path d={geo.land} fill={palette.land} stroke={palette.shore} strokeWidth={sw(1.5)} strokeLinejoin="round" />
          <Path d={geo.piers} fill={palette.land} />
          <Path d={geo.parks} fill={palette.park} />
          <G clipPath={`url(#${clipId})`}>
            <Path d={geo.minor} stroke={palette.minorCasing} strokeWidth={sw(4.5)} strokeLinecap="round" fill="none" />
            <Path d={geo.minor} stroke={palette.minor} strokeWidth={sw(3)} strokeLinecap="round" fill="none" />
          </G>
          <Path d={geo.secondary} stroke={palette.casing} strokeWidth={sw(7)} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <Path d={geo.major} stroke={palette.casing} strokeWidth={sw(10)} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <Path d={geo.secondary} stroke={palette.road} strokeWidth={sw(5)} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <Path d={geo.major} stroke={palette.highway} strokeWidth={sw(7.5)} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          {routeD ? (
            <>
              <Path d={routeD} stroke={legacy ? (dark ? '#0B1220' : '#FFFFFF') : colors.ringGap} strokeWidth={sw(10)} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={0.95} />
              <Path d={routeD} stroke={colors.primary} strokeWidth={sw(6)} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </>
          ) : null}
        </G>
      </Svg>

      {LABELS.map((l) => {
        const p = project(l.at[0], l.at[1]);
        if (p.x < -120 || p.y < -40 || p.x > size.w + 120 || p.y > size.h + 40) return null;
        const style =
          l.kind === 'district'
            ? { color: colors.textSecondary, opacity: dark ? 0.75 : 0.62, letterSpacing: 2, fontSize: 11, fontWeight: '700' as const }
            : l.kind === 'water'
              ? { color: palette.waterLabel, fontStyle: 'italic' as const, fontSize: 12 }
              : { color: palette.parkLabel, fontSize: 11 };
        return (
          <View key={l.text} pointerEvents="none" style={[styles.label, { left: p.x - 80, top: p.y - 8 }]}>
            <Text variant="caption" numberOfLines={1} style={style} maxFontSizeMultiplier={1}>
              {l.text}
            </Text>
          </View>
        );
      })}

      {dimmed ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: legacy ? (dark ? 'rgba(11, 18, 32, 0.45)' : 'rgba(246, 247, 249, 0.5)') : `${colors.bg}80` }]} /> : null}

      <MapProjectionContext.Provider value={project}>
        <MapSizeContext.Provider value={size}>{children}</MapSizeContext.Provider>
      </MapProjectionContext.Provider>

      <View
        pointerEvents="none"
        style={[styles.preview, { bottom: padding.bottom + 4, left: padding.left + 10, backgroundColor: dark ? 'rgba(17, 26, 46, 0.78)' : 'rgba(255, 255, 255, 0.82)' }]}
      >
        <Text variant="caption" style={{ color: colors.textSecondary, fontSize: 10, lineHeight: 13 }} maxFontSizeMultiplier={1}>
          Önizleme haritası
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { position: 'absolute', width: 160, alignItems: 'center' },
  preview: { position: 'absolute', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
});
