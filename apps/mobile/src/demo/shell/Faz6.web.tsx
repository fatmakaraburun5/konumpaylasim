/**
 * Web önizleme · Faz 6 (yalnızca tarayıcı paketi): "FAZ 6 · WIDGET'LAR" panel grubu.
 *
 *  - Widget galerisi: core `buildWidgetSnapshot` çıktısıyla (demo/web/widgetSim.ts) çizilen iOS systemSmall /
 *    systemMedium, kilit ekranı accessoryCircular / Rectangular / Inline (kilitli görünüm + gizlilik örtüsü),
 *    Android 2x2 / 4x2 ve Android hızlı ayar kutucuğu. Çerçeve rengi snapshot'taki `ring` (kadın pembe, erkek mavi,
 *    bilinmiyor gri); fotoğrafsız kişi baş harflerle görünür (Can).
 *  - "1 sa" düğmesi demo sunucusunda OTURUMSUZ `widget_quick_share` çağırır (yalnızca widget token'ı); başarıda
 *    geri sayım görünür, gönderenin "Ayşe ile 1 saatlik paylaşım başladı" bildirimi galeri afişinde çıkar.
 *    Arka planda başlatılamıyorsa (core `quickShareRoute` / `quickShareErrorAction`) uygulama derin bağlantıyla
 *    (`konum://quick-share?to=…&src=…`) açılır.
 *  - Senaryolar: token'ın sunucuda süresi dolsun, "Her Zaman" izni kapansın, bağlantı kesilsin, hız sınırı dolsun,
 *    favorileri boşalt, iOS 16 gibi davran.
 */
import {
  effectiveWidgetStatus,
  formatCountdown,
  GENDER_TEXT,
  HOUR,
  parseQuickShareDeepLink,
  WIDGET_LIMITS,
  widgetStatusText,
  type QuickShareSource,
  type WidgetFavorite,
  type WidgetSnapshot,
} from '@konum/core';
import { router } from 'expo-router';
import { useEffect, useState, type ReactElement } from 'react';
import { Image, Pressable, Text as RNText, ScrollView, StyleSheet, View, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { permissionsStore } from '../../state/permissionsStore';
import { Text, useTheme } from '../../ui';
import { demoControls, type DemoSnapshot } from '../controls';
import { demoOnline, onDemoNetworkChange, setDemoOnline } from '../web/network';
import { demoPerms, onDemoPermsChange, setDemoPerms } from '../web/permissions';
import { demoScreenLocked } from '../web/screen';
import { firstName, SOURCE_TEXT } from '../web/widgetModel';
import {
  onWidgetSimChange,
  pressQuickShare,
  setWidgetSimOptions,
  widgetSimState,
  widgetSimTick,
  type QuickShareOutcome,
  type WidgetFlash,
  type WidgetSimState,
} from '../web/widgetSim';
import type { ControlRow } from './Faz3.web';

interface Faz6Props {
  snap: DemoSnapshot | null;
  renderRow: (r: ControlRow) => ReactElement;
  /** Uygulama ekranı açıldı (dar ekranda alttan açılan panel kapanır). */
  onNavigate?: () => void;
}

type Tab = 'ios' | 'lock' | 'android';
const TABS: { id: Tab; label: string }[] = [
  { id: 'ios', label: 'iOS ana ekran' },
  { id: 'lock', label: 'Kilit ekranı' },
  { id: 'android', label: 'Android' },
];

/** Yalnızca tarayıcı stilleri (react-native-web geçirir). */
const css = (s: Record<string, string | number>) => s as unknown as ViewStyle;
const GRAY_PHOTO = { filter: 'grayscale(1) contrast(1.1)' } as unknown as ImageStyle;

const LIVE = '#22C55E';
const STALE = '#94A3B8';
const PAUSED = '#F59E0B';
const IOS_BLUE = '#007AFF';
const SMALL = 142;
const WIDE = 304;

// ── yardımcılar ───────────────────────────────────────────────────────────────────────────────

function useWidgetSim(): WidgetSimState {
  const [st, setSt] = useState<WidgetSimState>(widgetSimState);
  useEffect(() => {
    const un = onWidgetSimChange(() => setSt(widgetSimState()));
    widgetSimTick();
    const id = setInterval(() => widgetSimTick(), 1_000);
    const unNet = onDemoNetworkChange(() => widgetSimTick());
    const unPerm = onDemoPermsChange(() => widgetSimTick());
    return () => {
      clearInterval(id);
      un();
      unNet();
      unPerm();
    };
  }, []);
  return st;
}

/** Derin bağlantıyı uygulamada açar (kilit ekranı açıksa önce kilit açılır; Face ID / unlockAndRun sonrası). */
function openHref(href: string): void {
  if (demoScreenLocked()) demoControls.setScreenLocked(false);
  const q = parseQuickShareDeepLink(href);
  router.push(q ? `/quick-share?to=${encodeURIComponent(q.to)}&src=${encodeURIComponent(q.src)}` : '/friends');
}

const statusDot = (f: WidgetFavorite, now: number): string | null => {
  const st = effectiveWidgetStatus(f, now);
  return st === 'sharing_live' ? LIVE : st === 'sharing_stale' ? STALE : st === 'paused' ? PAUSED : null;
};

/** Dar sütun için kısa durum: "şimdi" · "3 dk" · "Bağlantı yok" · "—". */
function shortStatus(f: WidgetFavorite, now: number): string {
  const full = widgetStatusText(f, now, true);
  if (full.startsWith('Paylaşıyor · ')) return full.slice('Paylaşıyor · '.length);
  if (full.startsWith('Bağlantı yok')) return 'Bağlantı yok';
  if (full === 'Paylaşmıyor') return '—';
  return full;
}

/** Benim ona paylaşımım: geri sayım metni ya da null. */
function myShareText(f: WidgetFavorite, now: number): string | null {
  if (!f.my_share_active && f.my_share_expires_at === null) return null;
  if (f.my_share_expires_at === null) return 'Süresiz';
  const left = f.my_share_expires_at - now;
  return left > 0 ? formatCountdown(left) : null;
}

/** Android `Chronometer` (geri sayım) görünümü: "59:12" / "1:05:00". */
function chrono(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const defaultFav = (s: WidgetSnapshot | null): WidgetFavorite | null => s?.favorites.find((f) => f.uid === s.default_uid) ?? s?.favorites[0] ?? null;

// ── avatar (çerçeve + fotoğraf / baş harfler) ────────────────────────────────────────────────────

function WAvatar({ f, size, photo, now, mono, dot = true }: { f: WidgetFavorite; size: number; photo: string | null; now: number; mono?: boolean; dot?: boolean }) {
  const ring = Math.max(2, Math.round(size * 0.075));
  const gap = Math.max(1, Math.round(size * 0.03));
  const inner = size - ring * 2 - gap * 2;
  const d = dot ? statusDot(f, now) : null;
  const dotSize = Math.max(8, Math.round(size * 0.26));
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          padding: ring,
          backgroundColor: mono ? 'rgba(255,255,255,0.85)' : f.ring,
        }}
      >
        <View style={{ flex: 1, borderRadius: size / 2, padding: gap, backgroundColor: mono ? 'rgba(20,24,36,0.9)' : '#FFFFFF' }}>
          {photo ? (
            <Image source={{ uri: photo }} style={[{ width: inner, height: inner, borderRadius: inner / 2 }, mono ? GRAY_PHOTO : null]} />
          ) : (
            <View style={{ width: inner, height: inner, borderRadius: inner / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: mono ? 'rgba(255,255,255,0.12)' : '#E2E8F0' }}>
              <RNText style={{ fontSize: inner * 0.38, fontWeight: '700', color: mono ? '#FFFFFF' : '#334155' }}>{f.initials}</RNText>
            </View>
          )}
        </View>
      </View>
      {d ? (
        <View
          style={{
            position: 'absolute',
            right: -1,
            bottom: -1,
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: mono ? '#FFFFFF' : d,
            borderWidth: 2,
            borderColor: mono ? 'rgba(20,24,36,0.9)' : '#FFFFFF',
          }}
        />
      ) : null}
    </View>
  );
}

function Battery({ pct, low, color }: { pct: number; low: boolean; color: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
      <View style={{ width: 16, height: 8, borderRadius: 2, borderWidth: 1, borderColor: color, padding: 1 }}>
        <View style={{ width: `${Math.max(8, pct)}%`, height: '100%', borderRadius: 1, backgroundColor: low ? '#F59E0B' : color }} />
      </View>
      <RNText style={{ fontSize: 10, fontWeight: '600', color: low ? '#F59E0B' : color }}>{`%${pct}`}</RNText>
    </View>
  );
}

// ── düğme + geri bildirim ──────────────────────────────────────────────────────────────────────

interface PressCtx {
  sim: WidgetSimState;
  now: number;
  press: (key: string, to: string | null, src: QuickShareSource) => void;
  dark: boolean;
}

function flashText(f: WidgetFlash | undefined): { text: string; tone: 'pending' | 'ok' | 'error' | 'open' } | null {
  if (!f) return null;
  if (f.kind === 'pending') return { text: 'Başlatılıyor…', tone: 'pending' };
  return { text: f.text, tone: f.kind };
}

const TONE_COLOR = { pending: '#64748B', ok: '#15803D', error: '#DC2626', open: IOS_BLUE } as const;

/** iOS 17 `Button(intent:)` / Android `PendingIntent`: "1 sa paylaş" ya da geri sayım. */
function QuickButton({
  ctx,
  wkey,
  f,
  src,
  compact,
  android,
}: {
  ctx: PressCtx;
  wkey: string;
  f: WidgetFavorite;
  src: QuickShareSource;
  compact?: boolean;
  android?: boolean;
}) {
  const fl = flashText(ctx.sim.flashes[wkey]);
  const mine = myShareText(f, ctx.now);
  const chronoText = android && f.my_share_expires_at && f.my_share_expires_at > ctx.now ? chrono(f.my_share_expires_at - ctx.now) : null;
  const interactive = android || ctx.sim.options.interactive;
  const label = fl ? fl.text : mine ? (compact ? (chronoText ?? mine) : `${chronoText ? `⏱ ${chronoText}` : mine} · +1 sa`) : compact ? '1 sa' : interactive ? '1 sa paylaş' : 'Uygulamada paylaş';
  const active = !fl && !!mine;
  const bg = fl
    ? ctx.dark
      ? 'rgba(255,255,255,0.08)'
      : '#F1F5F9'
    : active
      ? ctx.dark
        ? 'rgba(34,197,94,0.18)'
        : '#DCFCE7'
      : android
        ? ctx.dark
          ? '#2D4A7A'
          : '#D3E3FD'
        : IOS_BLUE;
  const fg = fl ? TONE_COLOR[fl.tone] : active ? (ctx.dark ? '#4ADE80' : '#15803D') : android ? (ctx.dark ? '#D3E3FD' : '#041E49') : '#FFFFFF';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${f.name}: ${mine ? `paylaşım ${mine} · 1 saate uzat` : '1 saatlik paylaşım başlat'} (${SOURCE_TEXT[src]})`}
      onPress={() => ctx.press(wkey, f.uid, src)}
      style={({ pressed }: { pressed: boolean }) => [
        styles.qbtn,
        { backgroundColor: bg, opacity: pressed ? 0.8 : 1, minHeight: compact ? 24 : 28, paddingHorizontal: compact ? 6 : 10, borderRadius: android ? 14 : 999 },
      ]}
    >
      {!fl && !mine && !compact ? (
        <Svg width={11} height={11} viewBox="0 0 24 24">
          <Path d="M21 3 3 10.5l7.5 3 3 7.5L21 3Z" fill={fg} />
        </Svg>
      ) : active ? (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: fg }} />
      ) : null}
      <RNText numberOfLines={1} style={{ fontSize: compact ? 11 : 12, fontWeight: '700', color: fg, flexShrink: 1 }}>
        {label}
      </RNText>
    </Pressable>
  );
}

// ── iOS ana ekran ──────────────────────────────────────────────────────────────────────────────

function iosCard(dark: boolean, w: number, h: number): ViewStyle {
  return { width: w, height: h, borderRadius: 22, padding: 12, overflow: 'hidden', backgroundColor: dark ? '#1C1C1E' : '#FFFFFF', boxShadow: '0px 6px 18px rgba(0,0,0,0.18)' } as ViewStyle;
}

function Placeholder({ ctx, snap, w, h, android }: { ctx: PressCtx; snap: WidgetSnapshot | null; w: number; h: number; android?: boolean }) {
  const signedOut = !snap?.signed_in;
  const ink = ctx.dark ? '#FFFFFF' : '#0F172A';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={signedOut ? 'Konum: giriş yap' : 'Konum: favori ekle'}
      onPress={() => ctx.press(android ? 'android_empty' : 'ios_empty', null, android ? 'android_widget' : 'ios_widget')}
      style={[iosCard(ctx.dark, w, h), android ? { borderRadius: 24, backgroundColor: ctx.dark ? '#2B2930' : '#FFFBFE' } : null, { justifyContent: 'center', alignItems: 'center', gap: 6 }]}
    >
      <View style={[styles.emptyPlus, { borderColor: ctx.dark ? 'rgba(255,255,255,0.35)' : '#CBD5E1' }]}>
        <RNText style={{ fontSize: 20, color: ctx.dark ? 'rgba(255,255,255,0.7)' : '#64748B' }}>{signedOut ? '→' : '+'}</RNText>
      </View>
      <RNText style={{ fontSize: 13, fontWeight: '700', color: ink, textAlign: 'center' }}>{signedOut ? 'Giriş yap' : 'Favori ekle'}</RNText>
      <RNText style={{ fontSize: 11, color: ctx.dark ? 'rgba(255,255,255,0.6)' : '#64748B', textAlign: 'center' }}>
        {signedOut ? 'Dokun: uygulama açılır' : 'Arkadaşlar ekranında ★'}
      </RNText>
    </Pressable>
  );
}

function IosSmall({ ctx, snap }: { ctx: PressCtx; snap: WidgetSnapshot | null }) {
  const f = defaultFav(snap);
  if (!snap?.signed_in || !f) return <Placeholder ctx={ctx} snap={snap} w={SMALL} h={SMALL} />;
  const ink = ctx.dark ? '#FFFFFF' : '#0F172A';
  const sub = ctx.dark ? 'rgba(235,235,245,0.6)' : '#64748B';
  return (
    <View style={iosCard(ctx.dark, SMALL, SMALL)} testID="widget-ios-small">
      <View style={styles.rowBetween}>
        <WAvatar f={f} size={42} photo={f.avatar_file ? (ctx.sim.files[f.avatar_file] ?? null) : null} now={ctx.now} />
        {f.battery_pct !== null ? <Battery pct={f.battery_pct} low={f.battery_low} color={sub} /> : null}
      </View>
      <RNText numberOfLines={1} style={[styles.wName, { color: ink, marginTop: 6 }]}>
        {f.name}
      </RNText>
      <RNText numberOfLines={1} style={[styles.wSub, { color: sub }]}>
        {widgetStatusText(f, ctx.now, false)}
      </RNText>
      <RNText numberOfLines={1} style={[styles.wSub, { color: sub }]}>
        {f.place ?? ' '}
      </RNText>
      <View style={{ flex: 1 }} />
      <QuickButton ctx={ctx} wkey="ios_small" f={f} src="ios_widget" />
    </View>
  );
}

function FavColumn({ ctx, f, wkey, src, android }: { ctx: PressCtx; f: WidgetFavorite; wkey: string; src: QuickShareSource; android?: boolean }) {
  const ink = ctx.dark ? '#FFFFFF' : '#0F172A';
  const sub = ctx.dark ? 'rgba(235,235,245,0.6)' : '#64748B';
  return (
    <View style={styles.favCol}>
      <WAvatar f={f} size={40} photo={f.avatar_file ? (ctx.sim.files[f.avatar_file] ?? null) : null} now={ctx.now} />
      <RNText numberOfLines={1} style={{ fontSize: 12, fontWeight: '700', color: ink, marginTop: 4 }}>
        {firstName(f.name)}
      </RNText>
      <RNText numberOfLines={1} style={{ fontSize: 10, color: sub, marginBottom: 4 }}>
        {shortStatus(f, ctx.now)}
      </RNText>
      <QuickButton ctx={ctx} wkey={wkey} f={f} src={src} compact android={android} />
    </View>
  );
}

function IosMedium({ ctx, snap }: { ctx: PressCtx; snap: WidgetSnapshot | null }) {
  if (!snap?.signed_in || snap.favorites.length === 0) return <Placeholder ctx={ctx} snap={snap} w={WIDE} h={SMALL} />;
  const ink = ctx.dark ? '#FFFFFF' : '#0F172A';
  const empty = Math.max(0, WIDGET_LIMITS.maxFavorites - snap.favorites.length);
  return (
    <View style={iosCard(ctx.dark, WIDE, SMALL)} testID="widget-ios-medium">
      <View style={[styles.rowBetween, { marginBottom: 6 }]}>
        <RNText style={{ fontSize: 12, fontWeight: '700', color: ink }}>Favoriler</RNText>
        <RNText style={{ fontSize: 11, fontWeight: '600', color: IOS_BLUE }}>Konum</RNText>
      </View>
      <View style={{ flexDirection: 'row', flex: 1 }}>
        {snap.favorites.map((f) => (
          <FavColumn key={f.uid} ctx={ctx} f={f} wkey={`ios_medium_${f.uid}`} src="ios_widget" />
        ))}
        {Array.from({ length: empty }, (_, i) => (
          <View key={`e${i}`} style={styles.favCol}>
            <View style={[styles.emptyPlus, { width: 40, height: 40, borderColor: ctx.dark ? 'rgba(255,255,255,0.25)' : '#CBD5E1' }]}>
              <RNText style={{ fontSize: 16, color: ctx.dark ? 'rgba(255,255,255,0.5)' : '#94A3B8' }}>+</RNText>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── kilit ekranı (aksesuarlar) ───────────────────────────────────────────────────────────────

function LockGallery({ ctx, snap, locked, onAuth }: { ctx: PressCtx; snap: WidgetSnapshot | null; locked: boolean; onAuth: (run: () => void) => void }) {
  const f = defaultFav(snap);
  const details = !locked || (snap?.privacy.lock_screen_details ?? false);
  const now = new Date(ctx.now);
  const mine = f ? myShareText(f, ctx.now) : null;
  const left = f?.my_share_expires_at ? Math.max(0, f.my_share_expires_at - ctx.now) : 0;
  const frac = f?.my_share_expires_at ? Math.min(1, left / HOUR) : 0;
  const run = () => onAuth(() => ctx.press('ios_lock', f?.uid ?? null, 'ios_lock'));
  const inline = !snap?.signed_in ? 'Konum · giriş yap' : !f ? 'Konum · favori ekle' : mine ? `${firstName(f.name)} ile paylaşıyorsun · ${mine}` : `${firstName(f.name)} · ${widgetStatusText(f, ctx.now, true)}`;
  const fl = flashText(ctx.sim.flashes.ios_lock);
  const R = 29;
  const C = 2 * Math.PI * R;
  return (
    <View style={styles.lockWall} testID="widget-lock">
      {/* accessoryInline: saatin üstünde tek satır metin (etkileşimsiz). */}
      <RNText numberOfLines={1} style={styles.lockInline}>
        {inline}
      </RNText>
      <RNText style={styles.lockTime}>{`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`}</RNText>
      <View style={styles.lockRow}>
        {/* accessoryCircular */}
        <Pressable accessibilityRole="button" accessibilityLabel="Kilit ekranı yuvarlak widget" onPress={run} style={styles.lockCircle} testID="widget-lock-circular">
          {f && snap?.signed_in ? (
            <>
              <WAvatar f={f} size={46} photo={f.avatar_file ? (ctx.sim.files[f.avatar_file] ?? null) : null} now={ctx.now} mono dot={false} />
              {frac > 0 ? (
                <Svg width={64} height={64} viewBox="0 0 64 64" style={StyleSheet.absoluteFill as never}>
                  <Circle cx={32} cy={32} r={R} stroke="rgba(255,255,255,0.22)" strokeWidth={3} fill="none" />
                  <Circle
                    cx={32}
                    cy={32}
                    r={R}
                    stroke="#FFFFFF"
                    strokeWidth={3}
                    fill="none"
                    strokeDasharray={`${C * frac} ${C}`}
                    strokeLinecap="round"
                    transform="rotate(-90 32 32)"
                  />
                </Svg>
              ) : (
                <View style={styles.lockBadge}>
                  <RNText style={{ fontSize: 9, fontWeight: '800', color: '#0E1B33' }}>1 sa</RNText>
                </View>
              )}
            </>
          ) : (
            <RNText style={{ color: '#FFFFFF', fontSize: 18 }}>+</RNText>
          )}
        </Pressable>
        {/* accessoryRectangular */}
        <Pressable accessibilityRole="button" accessibilityLabel="Kilit ekranı dikdörtgen widget" onPress={run} style={styles.lockRect} testID="widget-lock-rectangular">
          {f && snap?.signed_in ? (
            <>
              <RNText numberOfLines={1} style={styles.lockRectName}>
                {f.name}
              </RNText>
              <RNText numberOfLines={1} style={styles.lockRectLine}>
                {fl ? fl.text : mine ? `Paylaşıyorsun · ${mine}` : widgetStatusText(f, ctx.now, true)}
              </RNText>
              {details ? (
                <RNText numberOfLines={1} style={styles.lockRectLine}>
                  {[f.place, f.battery_pct !== null ? `%${f.battery_pct}` : null].filter(Boolean).join(' · ') || ' '}
                </RNText>
              ) : (
                // `.privacySensitive()`: kilitliyken yer ve pil örtülür.
                <View style={{ flexDirection: 'row', gap: 4, marginTop: 3 }} testID="lock-redacted">
                  <View style={[styles.redact, { width: 62 }]} />
                  <View style={[styles.redact, { width: 26 }]} />
                </View>
              )}
            </>
          ) : (
            <RNText style={styles.lockRectLine}>{!snap?.signed_in ? 'Giriş yap' : 'Favori ekle'}</RNText>
          )}
        </Pressable>
      </View>
      <RNText style={styles.lockNote}>
        {locked
          ? `Kilitli · ${details ? 'ayrıntılar açık' : 'yer ve pil gizli'} · dokununca Face ID istenir`
          : 'Kilit açık · ayrıntılar görünür'}
      </RNText>
    </View>
  );
}

// ── Android ───────────────────────────────────────────────────────────────────────────────────

function androidCard(dark: boolean, w: number, h: number): ViewStyle {
  return { ...iosCard(dark, w, h), borderRadius: 24, padding: 12, backgroundColor: dark ? '#2B2930' : '#FFFBFE' } as ViewStyle;
}

function Android2x2({ ctx, snap }: { ctx: PressCtx; snap: WidgetSnapshot | null }) {
  const f = defaultFav(snap);
  if (!snap?.signed_in || !f) return <Placeholder ctx={ctx} snap={snap} w={SMALL} h={SMALL} android />;
  const ink = ctx.dark ? '#E6E1E5' : '#1C1B1F';
  const sub = ctx.dark ? '#CAC4D0' : '#49454F';
  return (
    <View style={androidCard(ctx.dark, SMALL, SMALL)} testID="widget-android-2x2">
      <View style={styles.rowBetween}>
        <WAvatar f={f} size={44} photo={f.avatar_file ? (ctx.sim.files[f.avatar_file] ?? null) : null} now={ctx.now} />
        {f.battery_pct !== null ? <Battery pct={f.battery_pct} low={f.battery_low} color={sub} /> : null}
      </View>
      <RNText numberOfLines={1} style={[styles.wName, { color: ink, marginTop: 6 }]}>
        {f.name}
      </RNText>
      <RNText numberOfLines={1} style={[styles.wSub, { color: sub }]}>
        {widgetStatusText(f, ctx.now, false)}
      </RNText>
      <View style={{ flex: 1 }} />
      <QuickButton ctx={ctx} wkey="android_2x2" f={f} src="android_widget" android />
    </View>
  );
}

function Android4x2({ ctx, snap }: { ctx: PressCtx; snap: WidgetSnapshot | null }) {
  if (!snap?.signed_in || snap.favorites.length === 0) return <Placeholder ctx={ctx} snap={snap} w={WIDE} h={SMALL} android />;
  const ink = ctx.dark ? '#E6E1E5' : '#1C1B1F';
  return (
    <View style={androidCard(ctx.dark, WIDE, SMALL)} testID="widget-android-4x2">
      <RNText style={{ fontSize: 12, fontWeight: '700', color: ink, marginBottom: 6 }}>Konum · Favoriler</RNText>
      <View style={{ flexDirection: 'row', flex: 1 }}>
        {snap.favorites.map((f) => (
          <FavColumn key={f.uid} ctx={ctx} f={f} wkey={`android_4x2_${f.uid}`} src="android_widget" android />
        ))}
      </View>
    </View>
  );
}

function QuickTile({ ctx, snap, onUnlock }: { ctx: PressCtx; snap: WidgetSnapshot | null; onUnlock: (run: () => void) => void }) {
  const f = defaultFav(snap);
  const mine = f ? myShareText(f, ctx.now) : null;
  const fl = flashText(ctx.sim.flashes.android_tile);
  const on = !!mine;
  const subtitle = fl ? fl.text : !snap?.signed_in ? 'Giriş yap' : !f ? 'Favori seç' : mine ? `${firstName(f.name)} · ${mine}` : firstName(f.name);
  return (
    <View style={styles.qsShade} testID="widget-android-tile">
      <RNText style={styles.qsTitle}>Hızlı ayarlar</RNText>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hızlı ayar: Konum 1 sa paylaş"
          onPress={() => onUnlock(() => ctx.press('android_tile', f?.uid ?? null, 'android_tile'))}
          style={[styles.qsTile, { flex: 2, backgroundColor: on ? '#A8C7FA' : '#3A3A3C' }]}
        >
          <View style={[styles.qsIcon, { backgroundColor: on ? '#0B57D0' : '#55555A' }]}>
            <Svg width={14} height={14} viewBox="0 0 24 24">
              <Path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 1 1 13 0C18.5 14.8 12 21 12 21Z" fill="#FFFFFF" />
            </Svg>
          </View>
          <View style={{ flexShrink: 1 }}>
            <RNText numberOfLines={1} style={{ fontSize: 12, fontWeight: '700', color: on ? '#041E49' : '#FFFFFF' }}>
              Konum: 1 sa paylaş
            </RNText>
            <RNText numberOfLines={1} style={{ fontSize: 11, color: fl ? TONE_COLOR[fl.tone] : on ? '#0B3A82' : 'rgba(255,255,255,0.7)' }}>
              {subtitle}
            </RNText>
          </View>
        </Pressable>
        <View style={[styles.qsTile, { flex: 1, backgroundColor: '#3A3A3C', opacity: 0.6 }]}>
          <RNText style={{ fontSize: 12, fontWeight: '600', color: '#FFFFFF' }}>Wi‑Fi</RNText>
        </View>
      </View>
    </View>
  );
}

// ── galeri ────────────────────────────────────────────────────────────────────────────────────

function PushNotice({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.pushNotice} testID="widget-push">
      <View style={styles.pushIcon}>
        <Svg width={12} height={12} viewBox="0 0 24 24">
          <Path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 1 1 13 0C18.5 14.8 12 21 12 21Z" fill="#FFFFFF" />
        </Svg>
      </View>
      <View style={{ flex: 1 }}>
        <RNText numberOfLines={1} style={{ fontSize: 12, fontWeight: '700', color: '#0F172A' }}>
          {title}
        </RNText>
        <RNText numberOfLines={2} style={{ fontSize: 12, color: '#334155' }}>
          {body}
        </RNText>
      </View>
      <RNText style={{ fontSize: 10, color: '#64748B' }}>şimdi</RNText>
    </View>
  );
}

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const { colors, radius } = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.toggle, { borderRadius: radius.sm, borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primarySoft : colors.surface }]}
    >
      <Text variant="caption" style={{ color: on ? colors.primary : colors.textSecondary, fontWeight: '600' }}>
        {`${on ? '✓ ' : ''}${label}`}
      </Text>
    </Pressable>
  );
}

export function Faz6Section({ snap, renderRow, onNavigate }: Faz6Props) {
  const { colors, radius, scheme } = useTheme();
  const dark = scheme === 'dark';
  const sim = useWidgetSim();
  const [tab, setTab] = useState<Tab>('ios');
  const [lockedLook, setLockedLook] = useState(true);
  const [gate, setGate] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [, setPerm] = useState(0);
  useEffect(() => onDemoPermsChange(() => setPerm((x) => x + 1)), []);
  const now = Date.now();
  const s = sim.snapshot;
  const f6 = snap?.f6 ?? null;

  const handle = (o: QuickShareOutcome) => {
    if (o.kind !== 'open_app') return;
    // Kısa geri bildirimden sonra uygulama açılır (widgetURL / Link / etkinlik niyeti).
    setTimeout(() => {
      openHref(o.href);
      onNavigate?.();
    }, 700);
  };
  const ctx: PressCtx = {
    sim,
    now,
    dark,
    press: (key, to, src) => {
      void pressQuickShare(key, to, src).then(handle).catch(() => undefined);
    },
  };
  /** iOS `authenticationPolicy = .requiresAuthentication` / Android `unlockAndRun`: kilitliyken önce kimlik. */
  const authThen = (text: string, needed: boolean) => (run: () => void) => {
    if (!needed) return run();
    setGate(text);
    setTimeout(() => {
      setGate(null);
      run();
    }, 900);
  };

  const bgOk = demoPerms().background === 'granted';
  const online = demoOnline();
  const favCount = s?.favorites.length ?? 0;
  const rows: ControlRow[] = [
    {
      key: 'f6-token-expire',
      title: 'Widget oturumu sunucuda dolsun',
      hint: "Sonraki dokunuş 'token_expired' alır → uygulama derin bağlantıyla açılır, token yenilenir.",
      run: () => (demoControls.widgetExpireToken() > 0 ? 'Widget token\'ının süresi sunucuda doldu. Şimdi "1 sa"ya bas.' : 'Aktif widget token\'ı yok (favori ve oturum gerekir).'),
    },
    {
      key: 'f6-bg',
      title: bgOk ? "'Her Zaman' konum izni kapansın" : "'Her Zaman' izni geri gelsin",
      hint: bgOk ? 'Widget arka planda başlatamaz → uygulama açılır (izin akışı).' : 'Arka planda hızlı paylaşım yeniden mümkün.',
      run: async () => {
        setDemoPerms({ background: bgOk ? 'denied' : 'granted' });
        await permissionsStore.getState().refresh().catch(() => undefined);
        return bgOk ? "'Her Zaman' izni kapalı: widget dokunuşu uygulamayı açar." : "'Her Zaman' izni verildi.";
      },
    },
    {
      key: 'f6-offline',
      title: online ? 'Bağlantı kesilsin' : 'Bağlantı gelsin',
      hint: online ? "Widget çağrısı ulaşmaz → widget'ta kısa hata: 'Bağlantı yok'." : 'Simüle bağlantı geri gelir.',
      run: () => {
        setDemoOnline(!online);
        return online ? 'Bağlantı yok: widget düğmesi "Bağlantı yok" der.' : 'Bağlantı geri geldi.';
      },
    },
    {
      key: 'f6-rate',
      title: 'Hız sınırı dolsun (saatte 6)',
      hint: "Sonraki dokunuş 'rate_limited' → widget'ta 'Çok sık denendi, bekle'.",
      run: () => (demoControls.widgetRateLimit() > 0 ? 'Bu saatlik hızlı paylaşım hakkı doldu.' : 'Aktif widget token\'ı yok.'),
    },
    {
      key: 'f6-fav',
      title: favCount > 0 ? 'Favorileri boşalt' : 'Favorileri geri yükle',
      hint: favCount > 0 ? "Favori yokken widget 'Favori ekle' der; dokununca uygulama açılır." : 'Ayşe, Mehmet, Zeynep (sıra = widget sırası).',
      run: () => {
        if (favCount > 0) {
          demoControls.setMyFavorites([]);
          return 'Favoriler boşaltıldı.';
        }
        const list = demoControls.restoreMyFavorites();
        return list.length ? 'Favoriler geri yüklendi.' : 'Önce bu kişilerle arkadaş olmalısın.';
      },
    },
  ];

  const tokenText = sim.credential
    ? `geçerli (${Math.max(0, Math.round((sim.credential.expires_at - now) / 86_400_000))} gün)`
    : (s?.signed_in ?? false)
      ? favCount > 0
        ? 'alınıyor…'
        : 'yok (favori yok)'
      : 'yok (oturum kapalı)';
  const lines = [
    s
      ? `Snapshot v${s.v} · ${sim.bytes.toLocaleString('tr-TR')} / ${WIDGET_LIMITS.maxBytes.toLocaleString('tr-TR')} B · ${s.favorites.length} favori · token: ${tokenText} · arka plan konumu: ${s.quick.bg_location_ok ? 'var' : 'yok'}`
      : 'Snapshot henüz yazılmadı.',
    `Yazma ${sim.writes} · yenileme ${sim.reloads}${sim.lastChange ? ` · son değişim: ${sim.lastChange === 'major' ? 'büyük (hemen yenile)' : sim.lastChange === 'minor' ? 'küçük (kısıtlı yenileme)' : 'yok'}` : ''}`,
    f6
      ? `Cinsiyetim: ${f6.myGender ? GENDER_TEXT[f6.myGender] : 'seçilmedi'} · fotoğrafım: ${f6.myPhoto ? 'var' : 'yok'} · favoriler: ${f6.favorites.length ? f6.favorites.join(', ') : '—'} · bu saat ${f6.quickSharesThisHour}/6`
      : null,
  ].filter((l): l is string => l !== null);

  const wall: ViewStyle = css({
    backgroundImage: tab === 'android' ? 'linear-gradient(160deg, #134E4A 0%, #3B0764 100%)' : 'linear-gradient(160deg, #1E3A8A 0%, #7C3AED 55%, #DB2777 100%)',
  });

  return (
    <View style={{ gap: 6 }} testID="faz6-section">
      <Text variant="caption" color="textSecondary" style={{ letterSpacing: 1 }}>
        {"FAZ 6 · WIDGET'LAR"}
      </Text>
      <View style={[styles.tabs, { borderColor: colors.border, borderRadius: radius.md }]}>
        {TABS.map((t) => (
          <Pressable
            key={t.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.id }}
            onPress={() => setTab(t.id)}
            style={[styles.tab, { borderRadius: radius.sm, backgroundColor: tab === t.id ? colors.primarySoft : 'transparent' }]}
          >
            <Text variant="caption" style={{ color: tab === t.id ? colors.primary : colors.textSecondary, fontWeight: '600' }}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={[styles.gallery, wall]} testID="widget-gallery">
        {sim.push && tab !== 'lock' ? <PushNotice title={sim.push.title} body={sim.push.body} /> : null}
        {tab === 'ios' ? (
          <>
            <View style={{ flexDirection: 'row', gap: 20, alignItems: 'flex-start' }}>
              <IosSmall ctx={ctx} snap={s} />
              <View style={{ width: SMALL, gap: 6, paddingTop: 4 }}>
                <RNText style={styles.wallNote}>systemSmall · ilk favori</RNText>
                <RNText style={styles.wallNote}>{sim.options.interactive ? 'iOS 17+: düğme widget içinde çalışır (App Intent).' : 'iOS 16: düğme yok, dokunuş uygulamayı açar.'}</RNText>
              </View>
            </View>
            <IosMedium ctx={ctx} snap={s} />
            <RNText style={styles.wallNote}>systemMedium · en çok 4 favori (sıra = favori sırası)</RNText>
          </>
        ) : tab === 'lock' ? (
          <>
            {sim.push ? <PushNotice title={sim.push.title} body={sim.push.body} /> : null}
            <LockGallery ctx={ctx} snap={s} locked={lockedLook} onAuth={authThen('Face ID…', lockedLook)} />
            <RNText style={styles.wallNote}>Kilit ekranında iOS widget'ları tek renk (vibrant) çizer; cinsiyet çerçevesi ana ekranda ve Android'de renklidir.</RNText>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 20, alignItems: 'flex-start' }}>
              <Android2x2 ctx={ctx} snap={s} />
              <View style={{ width: SMALL, gap: 6, paddingTop: 4 }}>
                <RNText style={styles.wallNote}>2x2 · ilk favori</RNText>
                <RNText style={styles.wallNote}>Geri sayım: Chronometer (RemoteViews)</RNText>
              </View>
            </View>
            <Android4x2 ctx={ctx} snap={s} />
            <QuickTile ctx={ctx} snap={s} onUnlock={authThen('Kilidi aç (unlockAndRun)…', demoScreenLocked())} />
          </>
        )}
        {gate ? (
          <View style={styles.gate} testID="widget-auth-gate">
            <RNText style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '700' }}>{gate}</RNText>
          </View>
        ) : null}
      </View>

      <View style={styles.toggles}>
        {tab === 'lock' ? <Toggle label="Kilitli görünüm" on={lockedLook} onPress={() => setLockedLook((v) => !v)} /> : null}
        <Toggle
          label="Kilit ekranında ayrıntı göster"
          on={sim.options.lock_screen_details}
          onPress={() => setWidgetSimOptions({ lock_screen_details: !sim.options.lock_screen_details })}
        />
        <Toggle label="iOS 16 gibi (etkileşimsiz)" on={!sim.options.interactive} onPress={() => setWidgetSimOptions({ interactive: !sim.options.interactive })} />
      </View>

      {sim.events.slice(0, 3).map((e, i) => (
        <Text
          key={`${e.at}-${i}`}
          variant="caption"
          style={{
            fontWeight: i === 0 ? '600' : '400',
            color: e.tone === 'error' ? colors.danger : e.tone === 'ok' ? colors.live : e.tone === 'open' ? colors.primary : colors.textSecondary,
          }}
        >
          {`${new Date(e.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${e.text}`}
        </Text>
      ))}

      {rows.map(renderRow)}
      {lines.map((l) => (
        <Text key={l} variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          {l}
        </Text>
      ))}
      <Pressable accessibilityRole="button" onPress={() => setShowJson((v) => !v)}>
        <Text variant="caption" style={{ color: colors.primary, fontWeight: '600' }}>
          {showJson ? "Snapshot JSON'unu gizle" : "Snapshot JSON'unu göster (yerel kodun okuduğu)"}
        </Text>
      </Pressable>
      {showJson && s ? (
        <ScrollView style={[styles.json, { borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.bg }]} nestedScrollEnabled>
          <RNText selectable style={[styles.jsonText, { color: colors.text } as TextStyle]}>
            {JSON.stringify(s, null, 1)}
          </RNText>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rowBetween: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  wName: { fontSize: 14, fontWeight: '700' },
  wSub: { fontSize: 11, lineHeight: 14 },
  qbtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, cursor: 'pointer' },
  favCol: { flex: 1, alignItems: 'center', paddingHorizontal: 2 },
  emptyPlus: { width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', borderWidth: 1, padding: 3, gap: 3 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 5, cursor: 'pointer' },
  gallery: { borderRadius: 20, padding: 12, gap: 10, overflow: 'hidden', position: 'relative', minHeight: 200 },
  wallNote: { fontSize: 11, lineHeight: 14, color: 'rgba(255,255,255,0.85)' },
  lockWall: { borderRadius: 16, paddingVertical: 12, paddingHorizontal: 10, backgroundColor: 'rgba(8,14,30,0.55)', alignItems: 'center', gap: 4 },
  lockInline: { fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.9)', maxWidth: 280 },
  lockTime: { fontSize: 54, lineHeight: 58, fontWeight: '700', color: '#FFFFFF', letterSpacing: -1 },
  lockRow: { flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 2 },
  lockCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  lockBadge: { position: 'absolute', bottom: 2, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.92)' },
  lockRect: { width: 160, height: 64, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: 'rgba(255,255,255,0.16)', justifyContent: 'center', cursor: 'pointer' },
  lockRectName: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },
  lockRectLine: { fontSize: 11, lineHeight: 14, color: 'rgba(255,255,255,0.85)' },
  lockNote: { fontSize: 10, color: 'rgba(255,255,255,0.65)', marginTop: 4, textAlign: 'center' },
  redact: { height: 9, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.35)' },
  qsShade: { borderRadius: 20, padding: 10, gap: 8, backgroundColor: 'rgba(28,28,30,0.92)' },
  qsTitle: { fontSize: 11, color: 'rgba(255,255,255,0.7)', fontWeight: '600' },
  qsTile: { minHeight: 56, borderRadius: 20, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8, cursor: 'pointer' },
  qsIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  pushNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.95)',
    boxShadow: '0px 6px 18px rgba(0,0,0,0.25)',
  },
  pushIcon: { width: 22, height: 22, borderRadius: 6, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center' },
  gate: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  toggles: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  toggle: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4, cursor: 'pointer' },
  json: { maxHeight: 220, borderWidth: 1, padding: 8 },
  jsonText: { fontFamily: 'monospace', fontSize: 10, lineHeight: 13 },
});
