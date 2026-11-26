/**
 * Alt kitapçık (stacked deck): giden paylaşımlar (kişi oturumları + QR bağlantıları) ekranın altında TEK bir
 * kompakt kart destesinde durur. Eskiden her paylaşım için ayrı büyük kart alt alta diziliyordu; 4 kişide
 * haritanın yalnızca %14'ü görünüyordu.
 *
 *   ┌ arka katman 2 ─────────────────────┐  ← kitapçık sırtı (her biri 6 pt; dokununca sonraki kart)
 *   ├ arka katman 1 ─────────────────────┤
 *   │ ▬▬ (tutamaç: dokun / aşağı sürükle → küçült)                │
 *   │ (◯AY) Ayşe Yılmaz                     [1/4 ⌃] ← tüm liste   │
 *   │       ● Konumun paylaşılıyor                                │
 *   │       18:09'a kadar · 60 dk kaldı                           │
 *   │ [ Süreyi uzat ]  [ Durdur ]                                 │
 *   └▔▔▔▔▔▔▔▔▔ kalan süre çizgisi ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔┘
 *
 * Üç görünüm:
 *  - deck      : öndeki tek kart + arkada en çok 2 katman. Sola / sağa kaydır → sonraki / önceki kart (halka).
 *                Aşağı sürükle ya da tutamaca dokun → küçült. Yukarı sürükle ya da "1/4" → liste.
 *  - list      : "Tüm aktif paylaşımlar (n)" mini listesi (ekranın en çok ~%30'u, kaydırılabilir); satıra
 *                dokun → o kart öne gelir. Altta "Yeni paylaşım" ve iki adımlı "Tümünü durdur".
 *  - collapsed : 44 pt ince durum çubuğu ("3 paylaşım sürüyor · ilk bitiş 18:09"); dokun / yukarı sürükle → aç.
 *
 * Kendiliğinden öne gelme: yeni başlatılan paylaşım ve süresi dolmak üzere olan paylaşım öne gelir ve
 * kitapçık açılır (küçültülmüşse). Süresi dolmak üzere olan kartta +30 dk / +1 saat çipleri doğrudan görünür
 * (ayrı "bitmek üzere" afişi kitapçık görünürken gösterilmez; yer kaplamasın).
 *
 * Harita: kapsayıcı `box-none`; kartların dışındaki her nokta haritaya gider (kaydır / yakınlaştır / pin).
 * Animasyon: RN Animated + PanResponder (native ve web'de aynı); native'de transform'lar yerel sürücüde.
 */
import { EXTENSION_STEPS, type EpochMs, type ExtensionMinutes, type ShareSession, type UserId } from '@konum/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { LinkId } from '@konum/core';
import type { LinkSession } from '../../state/linkStore';
import { Button, cardShadow, Chip, Icon, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';
import { FriendAvatar } from '../profile/FriendAvatar';
import {
  buildDeckItems,
  collapsedSummary,
  cycle,
  focusIndex,
  itemProgress,
  itemStatus,
  itemTime,
  itemTitle,
  peekCount,
  receiversOf,
  stoppable,
  type DeckItem,
  type DeckTone,
} from './shareDeckModel';

export type DeckMode = 'deck' | 'list' | 'collapsed';

/** Ana ekran yeniden kurulsa (ör. rota kartından dönüş) kullanıcının seçtiği görünüm korunur. */
let rememberedMode: DeckMode | null = null;
/**
 * Kısa ekran (ör. iPhone SE 667 pt, 360×640 Android): üst çubuk ve "bana paylaşanlar" şeridi zaten ekranın ~%30'unu
 * kaplıyor; açık deste haritayı %55'e indirir. Bu ekranlarda kitapçık ince çubuk olarak başlar.
 */
const SHORT_SCREEN_H = 720;

/** Kitapçık sırtı: arka katman başına görünen şerit (pt) ve yan içe çekilme. */
export const DECK_PEEK = 6;
const DECK_INSET = 10;
/** Tam genişlikte (masaüstü web) kart en çok bu kadar geniş. */
const DECK_MAX_W = 560;
/** Liste görünümü ekranın en çok bu oranını kaplar (başlık + satırlar + alt düğmeler). */
const LIST_MAX_SHARE = 0.28;
const LIST_ROW_H = 56;
/** Satırlar dışındaki sabit yükseklik: 8+8 dikey dolgu + 44 başlık + 8+44 alt satır (ölçüldü). */
const LIST_CHROME_H = 114;

const ND = Platform.OS !== 'web';

export interface ShareDeckActions {
  extend: (sessionId: string, minutes: ExtensionMinutes) => void;
  stop: (sessionId: string) => void;
  dismiss: (sessionId: string) => void;
  linkExtend: (linkId: LinkId, minutes: ExtensionMinutes) => void;
  linkShowQr: (linkId: LinkId) => void;
  /** Tek bağlantıyı durdur (ana ekran onay sorar). */
  linkStop: (linkId: LinkId) => void;
  /** Başarısız durdurmayı yeniden dene (onay yeniden sorulmaz). */
  linkRetryStop: (linkId: LinkId) => void;
  linkDismiss: (linkId: LinkId) => void;
  /** "Tümünü durdur" (onay kitapçıkta iki adımda alındı). Durdurulan kartlar kapatılır. */
  stopAll: (items: DeckItem[]) => void;
  newShare: () => void;
}

export interface ShareDeckProps {
  sessions: readonly ShareSession[];
  links: readonly LinkSession[];
  names: Record<UserId, string>;
  shareNow: EpochMs;
  linkNow: EpochMs;
  trackingError: string | null;
  actions: ShareDeckActions;
  style?: StyleProp<ViewStyle>;
}

export function ShareDeck({ sessions, links, names, shareNow, linkNow, trackingError, actions, style }: ShareDeckProps) {
  const { height: winH } = useWindowDimensions();
  const items = useMemo(() => buildDeckItems(sessions, links), [sessions, links]);
  const short = winH < SHORT_SCREEN_H;
  const [mode, setModeState] = useState<DeckMode>(() => rememberedMode ?? (short ? 'collapsed' : 'deck'));
  const shortRef = useRef(short);
  shortRef.current = short;
  const setMode = useCallback((m: DeckMode) => {
    rememberedMode = m;
    setModeState(m);
  }, []);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const n = items.length;
  const idx = focusIndex(items, focusKey);

  // Görünüm geçişi (açılma / küçülme / liste): kısa kayma + belirme.
  const appear = useRef(new Animated.Value(1)).current;
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    appear.setValue(0);
    Animated.timing(appear, { toValue: 1, duration: 200, useNativeDriver: ND }).start();
  }, [mode, appear]);

  // Yeni paylaşım ya da "bitmek üzere"ye geçen paylaşım: öne getir, kitapçığı aç.
  const seen = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    const prev = seen.current;
    const next = new Map(items.map((it) => [it.key, it.expiring] as const));
    seen.current = next;
    if (!prev) return; // ilk kurulum: kendiliğinden öne getirme yok
    const bring = items.find((it) => !prev.has(it.key) || (it.expiring && prev.get(it.key) === false));
    if (bring) {
      setFocusKey(bring.key);
      // Kısa ekranda yalnızca "bitmek üzere" açar; yeni paylaşım çubukta görünür ("Ayşe ile paylaşılıyor").
      if (rememberedMode !== 'deck' && (!shortRef.current || bring.expiring)) setMode('deck');
    }
  }, [items, setMode]);

  const nowOf = (it: DeckItem) => (it.kind === 'link' ? linkNow : shareNow);

  if (n === 0) return null;

  // Web: fareyle sürüklerken sayfa metni seçilmesin (seçim, sonraki sürüklemeleri tarayıcının metin sürüklemesine çeviriyordu).
  const outer: StyleProp<ViewStyle> = [styles.outer, Platform.OS === 'web' ? ({ userSelect: 'none' } as ViewStyle) : null, style];
  const anim = {
    opacity: appear,
    transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
  };

  if (mode === 'collapsed') {
    return (
      <Animated.View style={[outer, anim]} pointerEvents="box-none">
        <CollapsedBar items={items} names={names} now={shareNow} onOpen={() => setMode('deck')} />
      </Animated.View>
    );
  }

  if (mode === 'list') {
    // Yarım görünen satır kaydırılabildiğini belli eder.
    const rowsMax = Math.max(Math.round(1.5 * LIST_ROW_H), Math.round(winH * LIST_MAX_SHARE) - LIST_CHROME_H);
    return (
      <Animated.View style={[outer, anim]} pointerEvents="box-none">
        <DeckList
          items={items}
          names={names}
          nowOf={nowOf}
          trackingError={trackingError}
          rowsMaxHeight={rowsMax}
          focusedKey={items[idx]?.key ?? null}
          actions={actions}
          onPick={(key) => {
            setFocusKey(key);
            setMode('deck');
          }}
          onClose={() => setMode('deck')}
        />
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[outer, anim]} pointerEvents="box-none">
      <Deck
        items={items}
        idx={idx}
        names={names}
        nowOf={nowOf}
        trackingError={trackingError}
        actions={actions}
        onFocus={setFocusKey}
        onCollapse={() => setMode('collapsed')}
        onOpenList={() => setMode('list')}
      />
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Deste

interface DeckViewProps {
  items: DeckItem[];
  idx: number;
  names: Record<UserId, string>;
  nowOf: (it: DeckItem) => EpochMs;
  trackingError: string | null;
  actions: ShareDeckActions;
  onFocus: (key: string) => void;
  onCollapse: () => void;
  onOpenList: () => void;
}

function Deck({ items, idx, names, nowOf, trackingError, actions, onFocus, onCollapse, onOpenList }: DeckViewProps) {
  const { colors, radius } = useTheme();
  const n = items.length;
  const layers = peekCount(n);
  const front = items[idx]!;
  const [frontH, setFrontH] = useState(0);
  const [width, setWidth] = useState(0);

  const dragX = useRef(new Animated.Value(0)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  const enter = useRef(new Animated.Value(1)).current;
  const running = items.filter((it) => it.running).length;
  /** Öndeki dışında süresi dolmak üzere kart var mı (sayfa göstergesi ve sırt turuncu olur). */
  const behindExpiring = items.some((it, i) => i !== idx && it.expiring);

  // Web: fareyle kaydırma bir düğmenin üstünde başlarsa, bırakınca tarayıcının "click"i o düğmeye gider
  // (ör. kaydırılan kartın "Durdur"u). Sürükleme olduysa o tıklama yutulur. Native'de responder devri bunu önler.
  const dragged = useRef(false);
  const frontRef = useRef<React.ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = frontRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== 'function') return;
    const swallow = (e: Event) => {
      if (dragged.current) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    node.addEventListener('click', swallow, true);
    return () => node.removeEventListener('click', swallow, true);
  }, []);

  // PanResponder bir kez kurulur; güncel değerleri ref'ten okur.
  const live = useRef({ items, idx, width, onFocus, onCollapse, onOpenList });
  live.current = { items, idx, width, onFocus, onCollapse, onOpenList };

  const go = useCallback(
    (delta: number) => {
      const { items: its, idx: i } = live.current;
      if (its.length < 2) return;
      const next = its[cycle(i, delta, its.length)];
      if (!next) return;
      live.current.onFocus(next.key);
      enter.setValue(0);
      Animated.spring(enter, { toValue: 1, useNativeDriver: ND, speed: 20, bounciness: 5 }).start();
    },
    [enter],
  );

  const pan = useMemo(() => {
    let axis: 'x' | 'y' | null = null;
    const settle = () => {
      Animated.parallel([
        Animated.spring(dragX, { toValue: 0, useNativeDriver: ND, speed: 22, bounciness: 6 }),
        Animated.spring(dragY, { toValue: 0, useNativeDriver: ND, speed: 22, bounciness: 6 }),
      ]).start();
    };
    return PanResponder.create({
      // Yalnızca belirgin bir sürüklemede devral: düğmelere dokunmak normal çalışsın.
      onMoveShouldSetPanResponderCapture: (_e, g) => {
        const ax = Math.abs(g.dx);
        const ay = Math.abs(g.dy);
        return (ax > 10 && ax > ay * 1.2) || (ay > 10 && ay > ax * 1.2);
      },
      onPanResponderGrant: () => {
        axis = null;
        dragged.current = true;
      },
      onPanResponderMove: (_e, g) => {
        if (!axis) axis = Math.abs(g.dx) > Math.abs(g.dy) ? 'x' : 'y';
        const many = live.current.items.length > 1;
        if (axis === 'x') dragX.setValue(many ? g.dx : g.dx * 0.15);
        else dragY.setValue(g.dy > 0 ? g.dy : g.dy * 0.25);
      },
      onPanResponderRelease: (_e, g) => {
        setTimeout(() => {
          dragged.current = false;
        }, 0);
        const many = live.current.items.length > 1;
        if (axis === 'x' && many && (Math.abs(g.dx) > 64 || Math.abs(g.vx) > 0.45)) {
          const dir = g.dx < 0 ? 1 : -1; // sola kaydır → sonraki
          const w = live.current.width || 360;
          Animated.timing(dragX, { toValue: -dir * (w + 32), duration: 150, useNativeDriver: ND }).start(() => {
            dragX.setValue(0);
            go(dir);
          });
          return;
        }
        if (axis === 'y' && (g.dy > 56 || g.vy > 0.7)) {
          dragY.setValue(0);
          live.current.onCollapse();
          return;
        }
        // Tek kartta da liste açılır ("+ Yeni paylaşım" orada da var; harita "Konumumu paylaş" düğmesi de her zaman görünür).
        if (axis === 'y' && (g.dy < -40 || g.vy < -0.7)) {
          dragY.setValue(0);
          live.current.onOpenList();
          return;
        }
        settle();
      },
      onPanResponderTerminate: () => {
        setTimeout(() => {
          dragged.current = false;
        }, 0);
        settle();
      },
      onPanResponderTerminationRequest: () => false,
    });
  }, [dragX, dragY, go]);

  // Animated düğümleri bir kez kurulur (her saniyelik yeniden çizimde native düğüm kurulup atılmasın).
  const frontStyle = useMemo(
    () => ({
      transform: [
        { translateX: dragX },
        { translateY: Animated.add(dragY, enter.interpolate({ inputRange: [0, 1], outputRange: [-DECK_PEEK, 0] })) },
        { rotate: dragX.interpolate({ inputRange: [-400, 0, 400], outputRange: ['-5deg', '0deg', '5deg'] }) },
        { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
      ],
      opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }),
    }),
    [dragX, dragY, enter],
  );
  // Öndeki kart kaydırıldıkça birinci arka katman bir adım öne yaklaşır (iner ve önündeki kartın genişliğine açılır).
  const pullStyle = useMemo(() => {
    const pull = dragX.interpolate({ inputRange: [-160, 0, 160], outputRange: [1, 0, 1], extrapolate: 'clamp' });
    const w = Math.max(width - 2 * DECK_INSET, 1);
    return {
      transform: [
        { translateY: pull.interpolate({ inputRange: [0, 1], outputRange: [0, DECK_PEEK] }) },
        { scaleX: pull.interpolate({ inputRange: [0, 1], outputRange: [1, (w + 2 * DECK_INSET) / w] }) },
      ],
    };
  }, [dragX, width]);
  /** Sırtın dokunma alanı en az 22 pt (görünen şerit 7 / 14 pt; fazlası haritanın üstüne taşar). */
  const spineH = Math.max(22, layers * DECK_PEEK);

  return (
    <View
      style={{ paddingTop: layers * DECK_PEEK }}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessibilityLabel={n > 1 ? `Aktif paylaşımlar, ${n} kart. Öndeki: ${itemTitle(front, names)}` : undefined}
    >
      {/* Kitapçık sırtı: arka katmanlar (en arkadaki önce çizilir). */}
      {frontH > 0
        ? Array.from({ length: layers }, (_, k) => layers - k).map((i) => {
            const warn = items[cycle(idx, i, n)]?.expiring;
            return (
              <Animated.View
                key={`layer${i}`}
                pointerEvents="none"
                style={[
                  styles.layer,
                  {
                    top: (layers - i) * DECK_PEEK,
                    height: frontH,
                    left: i * DECK_INSET,
                    right: i * DECK_INSET,
                    borderRadius: radius.xl,
                    backgroundColor: colors.surface,
                    borderColor: warn ? colors.warning : colors.border,
                    borderWidth: warn ? 1.5 : StyleSheet.hairlineWidth,
                    opacity: i === 1 ? 0.96 : 0.88,
                  },
                  i === 1 ? pullStyle : null,
                ]}
              />
            );
          })
        : null}
      {layers > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sonraki paylaşım kartı"
          onPress={() => go(1)}
          style={[styles.spine, { top: layers * DECK_PEEK - spineH, height: spineH, left: DECK_INSET, right: DECK_INSET }]}
        />
      ) : null}

      <Animated.View ref={frontRef} {...pan.panHandlers} style={frontStyle} onLayout={(e: LayoutChangeEvent) => setFrontH(e.nativeEvent.layout.height)}>
        <DeckCard
          key={front.key}
          item={front}
          position={n > 0 ? { index: idx, count: n, running, behindExpiring } : null}
          names={names}
          now={nowOf(front)}
          trackingError={trackingError}
          actions={actions}
          onCollapse={() => live.current.onCollapse()}
          onOpenList={() => live.current.onOpenList()}
        />
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Kart

const toneColor = (tone: DeckTone, c: ReturnType<typeof useTheme>['colors']) =>
  tone === 'live' ? c.live : tone === 'warning' ? c.warning : tone === 'danger' ? c.danger : c.stale;

interface DeckCardProps {
  item: DeckItem;
  position: { index: number; count: number; running: number; behindExpiring: boolean } | null;
  names: Record<UserId, string>;
  now: EpochMs;
  trackingError: string | null;
  actions: ShareDeckActions;
  onCollapse: () => void;
  onOpenList: () => void;
}

function DeckCard({ item, position, names, now, trackingError, actions, onCollapse, onOpenList }: DeckCardProps) {
  const { colors, spacing, radius } = useTheme();
  const status = itemStatus(item, names, trackingError);
  const title = itemTitle(item, names);
  const tc = toneColor(status.tone, colors);
  const progress = itemProgress(item, now);

  return (
    <View
      style={[
        cardShadow,
        styles.card,
        { backgroundColor: colors.surface, borderRadius: radius.xl, borderColor: colors.border, paddingHorizontal: spacing.sm + 2, gap: spacing.xs },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Paylaşım kartlarını küçült"
        accessibilityHint="Kartlar ince bir durum çubuğuna iner; harita tamamen açılır"
        onPress={onCollapse}
        hitSlop={{ top: 0, bottom: 16, left: 16, right: 16 }}
        style={styles.handleHit}
      >
        <View style={[styles.handle, { backgroundColor: colors.border }]} />
      </Pressable>

      <View style={[styles.row, { gap: spacing.sm }]}>
        <Lead item={item} names={names} size={36} />
        <View style={styles.flex}>
          <Text variant="heading" numberOfLines={1}>
            {title}
          </Text>
          <View style={[styles.row, { gap: 6 }]} accessibilityLiveRegion="polite">
            <View style={[styles.dot, { backgroundColor: tc }]} />
            <Text variant="caption" style={[styles.flex, { color: tc }]} numberOfLines={1}>
              {status.text}
            </Text>
          </View>
          <Text variant="label" color="textSecondary" numberOfLines={1}>
            {itemTime(item, now)}
          </Text>
        </View>
        {position ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${position.index + 1}/${position.count}, tüm aktif paylaşımlar (${position.running})`}
            accessibilityHint={position.behindExpiring ? 'Listeyi açar. Süresi dolmak üzere bir paylaşım var' : 'Listeyi açar'}
            onPress={onOpenList}
            style={({ pressed }) => [
              styles.pager,
              {
                backgroundColor: position.behindExpiring ? colors.warningSoft : pressed ? colors.border : colors.surfaceAlt,
                borderColor: position.behindExpiring ? colors.warning : 'transparent',
                borderRadius: radius.pill,
              },
            ]}
          >
            <Text variant="caption" style={{ color: position.behindExpiring ? colors.warning : colors.textSecondary }}>
              {`${position.index + 1}/${position.count}`}
            </Text>
            <Icon name="chevronUp" size={14} color={position.behindExpiring ? colors.warning : colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      <CardActions item={item} actions={actions} />

      {item.expiresAt !== null && !item.finished ? (
        <View style={[styles.progressTrack, { backgroundColor: colors.surfaceAlt }]} pointerEvents="none">
          <View style={{ width: `${Math.round(progress * 1000) / 10}%`, height: '100%', backgroundColor: item.expiring ? colors.warning : colors.live }} />
        </View>
      ) : null}
    </View>
  );
}

/** Avatar(lar) ya da QR rozeti. Cinsiyet çerçevesi Avatar'dan gelir (kadın pembe, erkek mavi). */
function Lead({ item, names, size }: { item: DeckItem; names: Record<UserId, string>; size: number }) {
  const { colors } = useTheme();
  if (item.kind === 'link') {
    const outer = size + 10;
    return (
      <View style={[styles.qr, { width: outer, height: outer, borderRadius: outer / 2, backgroundColor: colors.surfaceAlt }]}>
        <Icon name="qr" size={Math.round(size * 0.55)} color={colors.text} />
      </View>
    );
  }
  const ids = receiversOf(item.session);
  const first = ids[0];
  return (
    <View>
      {first ? <FriendAvatar uid={first} fallbackName={names[first] ?? 'Arkadaş'} size={size} /> : <View style={{ width: size + 10, height: size + 10 }} />}
      {ids.length > 1 ? (
        <View style={[styles.more, { backgroundColor: colors.text, borderColor: colors.surface }]}>
          <Text variant="caption" style={{ color: colors.surface, fontSize: 10, lineHeight: 12 }}>
            {`+${ids.length - 1}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function CardActions({ item, actions }: { item: DeckItem; actions: ShareDeckActions }) {
  const { spacing } = useTheme();
  // Kart değişince sıfırlanır: DeckCard `key={item.key}` ile yeniden kurulur.
  const [extendOpen, setExtendOpen] = useState(false);
  const row = [styles.row, { gap: spacing.xs }];

  if (item.kind === 'link') {
    const l = item.link;
    if (item.finished) return <Button title="Kapat" variant="secondary" onPress={() => actions.linkDismiss(l.link_id)} />;
    const stopping = l.phase === 'stopping' && !l.error;
    const stop = (
      <Button
        title={l.phase === 'stopping' && l.error ? 'Tekrar dene' : 'Durdur'}
        variant="danger"
        block={false}
        style={styles.flex}
        disabled={stopping}
        loading={stopping}
        onPress={() => (l.phase === 'stopping' ? actions.linkRetryStop(l.link_id) : actions.linkStop(l.link_id))}
      />
    );
    if (item.expiring) {
      return (
        <View style={row}>
          {EXTENSION_STEPS.map((s) => (
            <Chip key={s.minutes} label={s.label} tone="warning" onPress={() => actions.linkExtend(l.link_id, s.minutes)} style={styles.flex} />
          ))}
          {stop}
        </View>
      );
    }
    return (
      <View style={row}>
        <Button title="QR'ı göster" variant="secondary" block={false} style={styles.flex} disabled={l.phase === 'stopping'} onPress={() => actions.linkShowQr(l.link_id)} />
        {stop}
      </View>
    );
  }

  const s = item.session;
  if (item.finished) return <Button title="Kapat" variant="secondary" onPress={() => actions.dismiss(s.session_id)} />;
  const canExtend = (s.phase === 'active' || s.phase === 'expiring_soon') && s.expires_at !== null;
  const stopLoading = s.phase === 'stopping' && !s.error;
  const stop = (
    <Button
      title={s.phase === 'stopping' && s.error ? 'Tekrar dene' : 'Durdur'}
      variant="danger"
      block={false}
      style={styles.flex}
      disabled={s.phase === 'starting' || stopLoading}
      loading={stopLoading}
      onPress={() => actions.stop(s.session_id)}
    />
  );
  if ((extendOpen || item.expiring) && canExtend) {
    return (
      <View style={row}>
        {EXTENSION_STEPS.map((step) => (
          <Chip
            key={step.minutes}
            label={step.label}
            tone={item.expiring ? 'warning' : 'default'}
            onPress={() => {
              setExtendOpen(false);
              actions.extend(s.session_id, step.minutes);
            }}
            style={styles.flex}
          />
        ))}
        {item.expiring ? stop : <IconButton icon="close" accessibilityLabel="Uzatmadan vazgeç" variant="soft" onPress={() => setExtendOpen(false)} />}
      </View>
    );
  }
  return (
    <View style={row}>
      {s.expires_at !== null ? (
        <Button
          title="Süreyi uzat"
          variant="secondary"
          block={false}
          style={styles.flex}
          disabled={!canExtend}
          loading={s.phase === 'extending'}
          onPress={() => setExtendOpen(true)}
        />
      ) : null}
      {stop}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Küçültülmüş çubuk

function CollapsedBar({ items, names, now, onOpen }: { items: DeckItem[]; names: Record<UserId, string>; now: EpochMs; onOpen: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const sum = collapsedSummary(items, names, now);
  const tc = toneColor(sum.tone, colors);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  // Sürükleme sarmalayıcıda: Pressable kendi responder işleyicilerini verilenlerin ÜSTÜNE yazdığı için
  // pan işleyicileri doğrudan Pressable'a verilemez.
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_e, g) => g.dy < -10 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_e, g) => {
          if (g.dy < -20 || g.vy < -0.4) openRef.current();
        },
      }),
    [],
  );
  const shown = items.slice(0, 3);
  return (
    <View {...pan.panHandlers}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${sum.text}. Paylaşım kartlarını aç`}
        onPress={onOpen}
        style={({ pressed }) => [
          cardShadow,
          styles.bar,
          {
            backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
            borderColor: sum.tone === 'warning' ? colors.warning : colors.border,
            borderRadius: radius.pill,
            paddingHorizontal: spacing.sm,
            gap: spacing.xs,
          },
        ]}
      >
        <View style={[styles.dot, { backgroundColor: tc }]} />
        <Text variant="label" numberOfLines={1} style={[styles.flex, { color: sum.tone === 'warning' ? colors.warning : colors.text }]}>
          {sum.text}
        </Text>
        <View style={styles.row} pointerEvents="none">
          {shown.map((it, i) => (
            <View key={it.key} style={{ marginLeft: i === 0 ? 0 : -8, zIndex: 10 - i }}>
              <MiniLead item={it} names={names} />
            </View>
          ))}
        </View>
        <Icon name="chevronUp" size={18} color={colors.textSecondary} />
      </Pressable>
    </View>
  );
}

function MiniLead({ item, names }: { item: DeckItem; names: Record<UserId, string> }) {
  const { colors } = useTheme();
  if (item.kind === 'link') {
    return (
      <View style={[styles.qr, { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surfaceAlt, borderWidth: 2, borderColor: colors.surface }]}>
        <Icon name="qr" size={14} color={colors.text} />
      </View>
    );
  }
  const id = receiversOf(item.session)[0];
  // Çerçeveli (cinsiyet rengi + yüzey rengi boşluk): koyu temada baş harfli avatar da çubuktan ayrışır.
  return id ? <FriendAvatar uid={id} fallbackName={names[id] ?? 'Arkadaş'} size={20} /> : null;
}

// ---------------------------------------------------------------------------------------------------------
// Liste ("Tüm aktif paylaşımlar")

interface DeckListProps {
  items: DeckItem[];
  names: Record<UserId, string>;
  nowOf: (it: DeckItem) => EpochMs;
  trackingError: string | null;
  rowsMaxHeight: number;
  focusedKey: string | null;
  actions: ShareDeckActions;
  onPick: (key: string) => void;
  onClose: () => void;
}

function DeckList({ items, names, nowOf, trackingError, rowsMaxHeight, focusedKey, actions, onPick, onClose }: DeckListProps) {
  const { colors, spacing, radius } = useTheme();
  const [confirm, setConfirm] = useState(false);
  /** İlk dokunuştan hemen sonraki ikinci dokunuş (çift dokunma) onay sayılmaz. */
  const armedAt = useRef(0);
  const toStop = stoppable(items);
  const running = items.filter((it) => it.running).length;
  const allFinished = items.every((it) => it.finished);
  // Onay 6 sn içinde verilmezse kendiliğinden kapanır (yanlışlıkla ikinci dokunuş olmasın).
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 6000);
    return () => clearTimeout(t);
  }, [confirm]);
  useEffect(() => {
    if (toStop.length === 0) setConfirm(false);
  }, [toStop.length]);

  return (
    <View style={[cardShadow, styles.card, { backgroundColor: colors.surface, borderRadius: radius.xl, borderColor: colors.border, paddingVertical: spacing.xs }]}>
      <View style={[styles.row, { paddingLeft: spacing.md, paddingRight: spacing.xxs, minHeight: MIN_TOUCH }]}>
        <Text variant="heading" accessibilityRole="header" style={styles.flex} numberOfLines={1}>
          {running > 0 ? `Tüm aktif paylaşımlar (${running})` : `Biten paylaşımlar (${items.length})`}
        </Text>
        <IconButton icon="chevronDown" accessibilityLabel="Listeyi kapat" onPress={onClose} />
      </View>

      <ScrollView style={{ maxHeight: rowsMaxHeight }} bounces={false} keyboardShouldPersistTaps="handled">
        {items.map((it) => (
          <ListRow key={it.key} item={it} names={names} now={nowOf(it)} trackingError={trackingError} focused={it.key === focusedKey} actions={actions} onPick={() => onPick(it.key)} />
        ))}
      </ScrollView>

      <View
        style={[
          styles.row,
          { flexWrap: 'wrap', justifyContent: 'flex-end', paddingHorizontal: spacing.sm, paddingTop: spacing.xs, gap: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
        ]}
      >
        {confirm ? (
          <>
            <Text variant="label" style={{ width: '100%', color: colors.danger, paddingHorizontal: spacing.xxs }} numberOfLines={1} accessibilityLiveRegion="assertive">
              {`${toStop.length} paylaşım durdurulsun mu?`}
            </Text>
            {/* Sıra bilerek böyle: ilk dokunuşun yerine "Vazgeç" gelir. */}
            <Button
              title="Evet, durdur"
              variant="danger"
              block={false}
              onPress={() => {
                if (Date.now() - armedAt.current < 600) return;
                setConfirm(false);
                actions.stopAll(toStop);
                onClose();
              }}
            />
            <Button title="Vazgeç" variant="ghost" block={false} onPress={() => setConfirm(false)} />
          </>
        ) : allFinished ? (
          <Button
            title={`Tümünü kapat (${items.length})`}
            variant="secondary"
            block={false}
            style={styles.flex}
            onPress={() => items.forEach((it) => (it.kind === 'link' ? actions.linkDismiss(it.link.link_id) : actions.dismiss(it.session.session_id)))}
          />
        ) : (
          <>
            <Button title="+ Yeni paylaşım" variant="secondary" block={false} style={styles.flex} onPress={actions.newShare} />
            {toStop.length >= 2 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Tümünü durdur (${toStop.length})`}
                accessibilityHint="Onay ister"
                onPress={() => {
                  armedAt.current = Date.now();
                  setConfirm(true);
                }}
                style={({ pressed }) => [styles.textBtn, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Text variant="label" style={{ color: colors.danger, fontWeight: '600' }}>
                  {`Tümünü durdur (${toStop.length})`}
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

function ListRow({
  item,
  names,
  now,
  trackingError,
  focused,
  actions,
  onPick,
}: {
  item: DeckItem;
  names: Record<UserId, string>;
  now: EpochMs;
  trackingError: string | null;
  focused: boolean;
  actions: ShareDeckActions;
  onPick: () => void;
}) {
  const { colors, spacing } = useTheme();
  const status = itemStatus(item, names, trackingError);
  const tc = toneColor(status.tone, colors);
  const title = itemTitle(item, names);
  const stopping = item.kind === 'share' ? item.session.phase === 'stopping' && !item.session.error : item.link.phase === 'stopping' && !item.link.error;
  const starting = item.kind === 'share' && item.session.phase === 'starting';
  return (
    <View style={[styles.row, { minHeight: LIST_ROW_H, paddingLeft: spacing.sm, paddingRight: spacing.xs, gap: spacing.xs, backgroundColor: focused ? colors.surfaceAlt : 'transparent' }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${status.text}, ${itemTime(item, now)}`}
        accessibilityHint="Kartı öne getirir"
        onPress={onPick}
        style={[styles.row, styles.flex, { gap: spacing.sm, minHeight: LIST_ROW_H }]}
      >
        <Lead item={item} names={names} size={28} />
        <View style={styles.flex}>
          <Text variant="label" numberOfLines={1} style={{ fontWeight: '600' }}>
            {title}
          </Text>
          <View style={[styles.row, { gap: 6 }]}>
            <View style={[styles.dot, { backgroundColor: tc }]} />
            <Text variant="caption" color="textSecondary" numberOfLines={1} style={styles.flex}>
              {itemTime(item, now)}
            </Text>
          </View>
        </View>
      </Pressable>
      {item.finished ? (
        <Button
          title="Kapat"
          variant="ghost"
          block={false}
          style={{ paddingHorizontal: spacing.sm }}
          onPress={() => (item.kind === 'link' ? actions.linkDismiss(item.link.link_id) : actions.dismiss(item.session.session_id))}
        />
      ) : (
        <Button
          title="Durdur"
          variant="danger"
          block={false}
          disabled={starting || stopping}
          loading={stopping}
          accessibilityLabel={`${title}: durdur`}
          style={{ paddingHorizontal: spacing.sm }}
          onPress={() =>
            item.kind === 'link'
              ? item.link.phase === 'stopping'
                ? actions.linkRetryStop(item.link.link_id)
                : actions.linkStop(item.link.link_id)
              : actions.stop(item.session.session_id)
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { width: '100%', maxWidth: DECK_MAX_W, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1, minWidth: 0 },
  card: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', paddingTop: 12, paddingBottom: 9 },
  layer: { position: 'absolute', borderWidth: StyleSheet.hairlineWidth, boxShadow: '0px 4px 12px rgba(15, 23, 42, 0.10)' },
  spine: { position: 'absolute', top: 0, zIndex: 2 },
  handleHit: { position: 'absolute', top: 0, left: '50%', marginLeft: -48, width: 96, height: 28, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 5, zIndex: 3 },
  handle: { width: 36, height: 4, borderRadius: 2 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 12, minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, borderWidth: 1 },
  progressTrack: { position: 'absolute', left: 28, right: 28, bottom: 3, height: 3, borderRadius: 2, overflow: 'hidden' },
  qr: { alignItems: 'center', justifyContent: 'center' },
  more: { position: 'absolute', right: -4, bottom: -2, minWidth: 20, height: 18, borderRadius: 9, borderWidth: 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  textBtn: { minHeight: MIN_TOUCH, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center', minHeight: MIN_TOUCH, borderWidth: StyleSheet.hairlineWidth },
});
