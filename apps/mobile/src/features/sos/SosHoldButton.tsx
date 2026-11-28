/**
 * Haritanın sağ altındaki kırmızı SOS düğmesi: BASILI TUT (`HOLD_MS`) → halka dolar → %100'de tek sefer tetikler.
 *
 * Sağlamlaştırma (Faz 4 düğmesinin dokunma hataları):
 *  - Metin seçimi / kopyalama menüsü YOK: "SOS" yazısı `selectable={false}` ve dokunma almayan (`pointerEvents="none"`)
 *    bir katmanda; web / WebView'da düğme köküne `user-select: none`, `-webkit-touch-callout: none`,
 *    `touch-action: none` uygulanır, `contextmenu` / `selectstart` / `dragstart` engellenir. Uzun basış sistem
 *    seçicisini açıp dokunmayı iptal ETMEZ.
 *  - İzole jest: `cancelable={false}` → üst kaydırma / sürükleme (ScrollView, kitapçık, sayfa) dokunmayı devralamaz;
 *    `pressRetentionOffset` = `HOLD_SLOP` → parmak sınırdan biraz kaysa da basılı tutma sürer; `hitSlop` dokunma
 *    alanını büyütür. Harita (Google Maps) düğmenin kardeşi olduğu için dokunmayı zaten alamaz.
 *  - İlerleme bileşenin İÇİNDE, zamana bağlı ve `requestAnimationFrame` ile: başlangıç anı ref'te tutulur, üst
 *    bileşenin yeniden çizilmesi ilerlemeyi sıfırlamaz. Erken bırakmada akıcı geri sarma; geri sararken yeniden
 *    basılırsa kalan yerden devam.
 *  - %100'de `onTrigger` TEK SEFER çağrılır (+ güçlü titreşim). `locked` (akış boşta değil) ve `COOLDOWN_MS`
 *    yeni tetiklemeyi engeller.
 * Ekran okuyucu: `activate` eylemi doğrudan tetikler (güvenlik geri sayımdadır).
 */
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, StyleSheet, Vibration, View, type ViewStyle } from 'react-native';
import { SOS_LIMITS } from '@konum/core';
import { lightColors, Text, useTheme } from '../../ui';
import { ProgressRing } from '../map/ProgressRing';
import { canStartHold, HOLD_HIT_SLOP, HOLD_SLOP, holdProgressAt, resumeStart, rewindProgressAt } from './holdModel';
import { SOS_FG } from './sosModel';

export interface SosHoldButtonProps {
  /** %100'de bir kez çağrılır. */
  onTrigger: () => void;
  /** Erken bırakma (ipucu için). */
  onEarlyRelease?: () => void;
  /** Akış boşta değil (geri sayım / gönderim / aktif): basış yok sayılır. */
  locked?: boolean;
  /** Erken bırakma ipucu görünüyor mu. */
  hint: boolean;
  size?: number;
}

type Mode = 'idle' | 'holding' | 'rewinding' | 'fired';

/** Yalnızca web / WebView: seçim, uzun basış menüsü, sürükleme ve tarayıcı kaydırması kapalı. */
const WEB_NO_SELECT = (Platform.OS === 'web'
  ? { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'none', cursor: 'pointer' }
  : {}) as unknown as ViewStyle;

function triggerHaptics() {
  try {
    if (Platform.OS === 'web') {
      Vibration.vibrate([0, 120, 60, 220]);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    if (Platform.OS === 'android') Vibration.vibrate([0, 120, 60, 220]);
  } catch {
    /* titreşim yoksa akış sürer */
  }
}

export function SosHoldButton({ onTrigger, onEarlyRelease, locked = false, hint, size = 60 }: SosHoldButtonProps) {
  const { colors, radius, spacing } = useTheme();
  const ring = size + 12;
  const [progress, setProgress] = useState(0);
  const mode = useRef<Mode>('idle');
  const startedAt = useRef(0);
  const rewindFrom = useRef(0);
  const rewindAt = useRef(0);
  const progressRef = useRef(0);
  const raf = useRef<number | null>(null);
  const lastTriggerAt = useRef<number | null>(null);
  const fingerDown = useRef(false);
  const cb = useRef({ onTrigger, onEarlyRelease, locked });
  cb.current = { onTrigger, onEarlyRelease, locked };
  const root = useRef<ComponentRef<typeof View>>(null);
  const resetTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Tetiklendikten sonra: parmak kalkıp akış boşa dönünce (iptal / bitti) ve bekleme geçince halka sıfırlanır. */
  const armReset = () => {
    if (resetTimer.current) clearInterval(resetTimer.current);
    resetTimer.current = setInterval(() => {
      if (fingerDown.current || cb.current.locked || mode.current !== 'fired') return;
      if (!canStartHold({ locked: false, lastTriggerAt: lastTriggerAt.current, now: Date.now() })) return;
      if (resetTimer.current) clearInterval(resetTimer.current);
      resetTimer.current = null;
      mode.current = 'idle';
      show(0);
    }, 150);
  };

  const stop = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  };
  const show = (p: number) => {
    progressRef.current = p;
    setProgress(p);
  };

  const frame = useCallback(() => {
    raf.current = null;
    const now = Date.now();
    if (mode.current === 'holding') {
      const p = holdProgressAt(startedAt.current, now);
      show(p);
      if (p >= 1) {
        mode.current = 'fired';
        lastTriggerAt.current = now;
        triggerHaptics();
        armReset();
        cb.current.onTrigger();
        return;
      }
    } else if (mode.current === 'rewinding') {
      const p = rewindProgressAt(rewindFrom.current, rewindAt.current, now);
      show(p);
      if (p <= 0) {
        mode.current = 'idle';
        return;
      }
    } else return;
    raf.current = requestAnimationFrame(frame);
  }, []);

  const pressIn = () => {
    fingerDown.current = true;
    const now = Date.now();
    if (mode.current === 'fired' || mode.current === 'holding') return;
    if (!canStartHold({ locked: cb.current.locked, lastTriggerAt: lastTriggerAt.current, now })) return;
    // Geri sarma sırasında yeniden basış: kalan ilerlemeden devam.
    startedAt.current = resumeStart(mode.current === 'rewinding' ? progressRef.current : 0, now);
    mode.current = 'holding';
    try {
      if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    } catch {
      /* yok sayılır */
    }
    stop();
    raf.current = requestAnimationFrame(frame);
  };

  const pressOut = () => {
    fingerDown.current = false;
    if (mode.current !== 'holding') return;
    // Son kare kaçtıysa bırakma anında da tamamlanmış sayılır.
    if (holdProgressAt(startedAt.current, Date.now()) >= 1) {
      stop();
      frame();
      return;
    }
    mode.current = 'rewinding';
    rewindFrom.current = progressRef.current;
    rewindAt.current = Date.now();
    cb.current.onEarlyRelease?.();
    stop();
    raf.current = requestAnimationFrame(frame);
  };

  useEffect(
    () => () => {
      stop();
      if (resetTimer.current) clearInterval(resetTimer.current);
    },
    [],
  );

  // Web / WebView: react-native-web'in Pressable'ı `cancelable` almaz; uzun basışta `contextmenu`, ikinci bir dokunuş
  // ya da başka bir öğenin dokunma isteği basılı tutmayı keser. Bu yüzden web'de dokunma DOĞRUDAN işaretçi
  // olaylarıyla izlenir (setPointerCapture: parmak düğmeden kaysa da olaylar düğmeye gelir; `HOLD_SLOP` dışına
  // çıkınca bırakılmış sayılır). Bağlam menüsü, metin seçimi ve sürükleme engellenir.
  const handlers = useRef({ pressIn: () => {}, pressOut: () => {} });
  handlers.current = { pressIn, pressOut };
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = root.current as unknown as HTMLElement | null;
    if (!el || typeof el.addEventListener !== 'function') return;
    let pointerId: number | null = null;
    const block = (e: Event) => e.preventDefault();
    const down = (e: PointerEvent) => {
      if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      pointerId = e.pointerId;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* eski tarayıcı */
      }
      e.preventDefault();
      handlers.current.pressIn();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      handlers.current.pressOut();
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const r = el.getBoundingClientRect();
      const out = e.clientX < r.left - HOLD_SLOP || e.clientX > r.right + HOLD_SLOP || e.clientY < r.top - HOLD_SLOP || e.clientY > r.bottom + HOLD_SLOP;
      if (out) up(e);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointermove', move);
    el.addEventListener('contextmenu', block);
    el.addEventListener('selectstart', block);
    el.addEventListener('dragstart', block);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('contextmenu', block);
      el.removeEventListener('selectstart', block);
      el.removeEventListener('dragstart', block);
    };
  }, []);

  const holding = progress > 0;
  return (
    <View style={[styles.wrap, WEB_NO_SELECT]} pointerEvents="box-none">
      {hint ? (
        <View
          accessibilityLiveRegion="assertive"
          pointerEvents="none"
          style={[styles.hint, { backgroundColor: colors.text, borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xxs, right: 0, bottom: ring + 6 }]}
        >
          <Text variant="label" selectable={false} style={{ color: colors.bg }} numberOfLines={1}>
            Göndermek için basılı tut
          </Text>
        </View>
      ) : null}
      <View style={{ width: ring, height: ring, alignItems: 'center', justifyContent: 'center' }} pointerEvents="box-none">
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {holding ? <ProgressRing progress={progress} size={ring} stroke={5} color={lightColors.danger} /> : null}
        </View>
        <Pressable
          ref={root}
          onPressIn={Platform.OS === 'web' ? undefined : pressIn}
          onPressOut={Platform.OS === 'web' ? undefined : pressOut}
          cancelable={false}
          pressRetentionOffset={HOLD_SLOP}
          hitSlop={HOLD_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Acil durum SOS"
          accessibilityHint={`Acil durum kişilerine tam konumunla uyarı göndermek için ${(SOS_LIMITS.holdMs / 1000).toLocaleString('tr-TR')} saniye basılı tut. Gönderilmeden önce ${SOS_LIMITS.countdownS} saniye iptal süresi vardır.`}
          accessibilityActions={[{ name: 'activate', label: 'Acil durum geri sayımını başlat' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName !== 'activate') return;
            const now = Date.now();
            if (!canStartHold({ locked: cb.current.locked, lastTriggerAt: lastTriggerAt.current, now })) return;
            lastTriggerAt.current = now;
            cb.current.onTrigger();
          }}
          testID="sos-button"
          style={[
            styles.btn,
            WEB_NO_SELECT,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: lightColors.danger,
              borderColor: SOS_FG,
              transform: [{ scale: holding ? 0.94 : 1 }],
              boxShadow: '0px 6px 18px rgba(185, 28, 28, 0.45)',
            },
          ]}
        >
          <View pointerEvents="none" style={WEB_NO_SELECT}>
            <Text
              variant="heading"
              selectable={false}
              suppressHighlighting
              accessible={false}
              style={[{ color: SOS_FG, fontWeight: '800', letterSpacing: 1 }, WEB_NO_SELECT]}
              maxFontSizeMultiplier={1}
            >
              SOS
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'flex-end' },
  hint: { position: 'absolute' },
  btn: { alignItems: 'center', justifyContent: 'center', borderWidth: 3 },
});
