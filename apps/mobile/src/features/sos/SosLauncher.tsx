/**
 * Faz 4: SOS tetikleme akışının kapsayıcısı (MapHome sağ alt). Yanlış basmayı azaltan ama acil anda hız
 * kaybettirmeyen akış (core `sosFlowReduce`):
 *
 *   SosHoldButton (basılı tut `holdMs`, halka dolar; erken bırakma → idle + ipucu)
 *     → acil kişi yoksa EmergencyContactsSheet (kaydet → doğrudan geri sayım)
 *     → SosCountdown (5 → 1; "İptal" / "Hemen gönder"; bu sırada `sosStore.prepare()` taze ölçümü başlatır)
 *     → `sosStore.send({ route })` (tam konum, adres, pil, varsa rota)
 *     → SosActiveScreen ("Uyarı gönderildi", acks, 112, "Güvendeyim")
 *
 * Aktif SOS varken düğme "SOS aktif" olur ve ekranı yeniden açar (yeni uyarı açılmaz).
 */
import { isSosActive, sosCountdownLeft, sosFlowReduce, sosHoldProgress, type SosFlowEvent, type SosFlowState, type SosRoute } from '@konum/core';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useFriendNames } from '../../state/friendsStore';
import { useLocationStore } from '../../state/locationStore';
import { sosStore, useSosStore } from '../../state/sosStore';
import { lightColors, MIN_TOUCH, Text, useTheme } from '../../ui';
import { EmergencyContactsSheet, type EmergencyContactsSheetHandle } from './EmergencyContactsSheet';
import { SosActiveScreen } from './SosActiveScreen';
import { SosCountdown } from './SosCountdown';
import { SosHoldButton } from './SosHoldButton';
import { isEarlyRelease, SOS_FG } from './sosModel';

export interface SosLauncherProps {
  /** Haritada açık rota (varsa SOS paketine eklenir). */
  route: SosRoute | null;
}

const HINT_MS = 2_500;

export function SosLauncher({ route }: SosLauncherProps) {
  const { radius, spacing } = useTheme();
  const [flow, dispatch] = useReducer(sosFlowReduce, { phase: 'idle' } as SosFlowState);
  const [now, setNow] = useState(() => Date.now());
  const [hint, setHint] = useState(false);
  const [screenOpen, setScreenOpen] = useState(false);
  const contactsSheet = useRef<EmergencyContactsSheetHandle>(null);
  const routeRef = useRef(route);
  routeRef.current = route;

  const names = useFriendNames();
  const contacts = useSosStore((s) => s.emergencyContacts);
  const outgoing = useSosStore((s) => s.outgoing);
  const storePhase = useSosStore((s) => s.phase);
  const storeError = useSosStore((s) => s.error);
  const accuracy = useLocationStore((s) => s.myPosition?.accuracy ?? null);
  const sosActive = outgoing !== null && isSosActive(outgoing);

  const send = useCallback((e: SosFlowEvent) => {
    if (e.type === 'press_in' || e.type === 'press_out' || e.type === 'a11y_activate' || e.type === 'tick') setNow(e.at);
    dispatch(e);
  }, []);

  // Basılı tutma ve geri sayım saati (yerel saat; akış süreleri cihazda ölçülür).
  useEffect(() => {
    if (flow.phase !== 'holding' && flow.phase !== 'countdown') return;
    const id = setInterval(() => send({ type: 'tick', at: Date.now() }), flow.phase === 'holding' ? 32 : 200);
    return () => clearInterval(id);
  }, [flow.phase, send]);

  // Evre geçişlerinin yan etkileri.
  const prevPhase = useRef<SosFlowState['phase']>(flow.phase);
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = flow.phase;
    if (prev === flow.phase) return;
    if (isEarlyRelease(prev, flow.phase)) setHint(true);
    if (flow.phase === 'countdown') {
      setHint(false);
      const st = sosStore.getState();
      if (st.contactsLoaded && st.emergencyContacts.length === 0) {
        // Kişi yok: akış durur, seçim sayfası açılır; kaydedince doğrudan geri sayım.
        // (Liste henüz yüklenmediyse geri sayım sürer; karar sunucuda, yoksa `no_emergency_contacts` → seçim sayfası.)
        dispatch({ type: 'cancel' });
        contactsSheet.current?.present(true);
        return;
      }
      sosStore.getState().prepare();
    }
    if (flow.phase === 'sending') {
      void sosStore
        .getState()
        .send({ route: routeRef.current })
        .then((r) => {
          if (r.ok) {
            dispatch({ type: 'sent', sos_id: r.sos_id });
            setScreenOpen(true);
            return;
          }
          dispatch({ type: 'failed', message: r.error.message });
          if (r.error.code === 'no_emergency_contacts') {
            dispatch({ type: 'cancel' });
            contactsSheet.current?.present(true);
          }
        });
    }
  }, [flow.phase]);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(t);
  }, [hint]);

  // Uyarı çözüldü (bu cihazdan ya da başka yerden): yerel akış başa döner.
  useEffect(() => {
    if (flow.phase === 'active' && !sosActive) dispatch({ type: 'resolved' });
  }, [flow.phase, sosActive]);

  const onContactsSaved = useCallback(
    (fromSos: boolean) => {
      if (fromSos) send({ type: 'a11y_activate', at: Date.now() });
    },
    [send],
  );

  const recipients = contacts.map((u) => names[u] ?? 'Arkadaş');

  return (
    <View pointerEvents="box-none">
      {sosActive ? (
        <Pressable
          onPress={() => setScreenOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Acil durum uyarın aktif. Ayrıntılar için dokun."
          testID="sos-active-pill"
          style={({ pressed }) => [
            styles.activePill,
            { backgroundColor: pressed ? lightColors.text : lightColors.danger, borderRadius: radius.pill, paddingHorizontal: spacing.md, borderColor: SOS_FG },
          ]}
        >
          <View style={[styles.dot, { backgroundColor: SOS_FG }]} />
          <Text variant="heading" style={{ color: SOS_FG }} numberOfLines={1}>
            SOS aktif
          </Text>
        </Pressable>
      ) : (
        <SosHoldButton progress={sosHoldProgress(flow, now)} onEvent={send} hint={hint} />
      )}

      <SosCountdown
        flow={flow}
        secondsLeft={sosCountdownLeft(flow, now)}
        recipients={recipients}
        accuracyM={accuracy}
        onCancel={() => dispatch({ type: 'cancel' })}
        onSendNow={() => dispatch({ type: 'send_now' })}
        onRetry={() => {
          send({ type: 'a11y_activate', at: Date.now() });
          dispatch({ type: 'send_now' });
        }}
      />

      <SosActiveScreen
        visible={screenOpen && outgoing !== null && flow.phase !== 'countdown' && flow.phase !== 'sending'}
        alert={outgoing}
        resolving={storePhase === 'resolving'}
        error={sosActive ? storeError : null}
        names={names}
        onResolve={() => void sosStore.getState().resolve()}
        onClose={() => setScreenOpen(false)}
      />

      <EmergencyContactsSheet ref={contactsSheet} onSaved={onContactsSaved} />
    </View>
  );
}

const styles = StyleSheet.create({
  activePill: { minHeight: MIN_TOUCH + 12, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 2, boxShadow: '0px 6px 18px rgba(185, 28, 28, 0.45)' },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
