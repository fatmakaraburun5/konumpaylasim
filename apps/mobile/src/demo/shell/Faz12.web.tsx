/**
 * Web önizleme · Faz 12 (yalnızca tarayıcı paketi): "FAZ 12 SENARYOLARI".
 *
 *  - Kilit ekranı canlı sayacı: iOS Live Activity kartı (kilit ekranında) + Dynamic Island (kompakt / genişletilmiş)
 *    ve Android canlı bildirim görünümü. Veri f12Services → liveSim (yerel köprünün benzetimi).
 *  - Sık paylaştıkların: cihaz geçmişi tohumlanır → haritada / kitapçık altında 15 dk / 1 saat kısayolları.
 *  - Mola, Görünmez Ol, izin eksikliği senaryoları.
 */
import { compactLabel, MINUTE, remainingFraction, type LiveShareContent } from '@konum/core';
import { useEffect, useState } from 'react';
import { Pressable, Text as RNText, StyleSheet, View } from 'react-native';
import { useStore } from 'zustand';
import { breakStore } from '../../state/breakStore';
import { friendAvatarProps, useFriendsById } from '../../state/friendsStore';
import { shareHistoryStore } from '../../state/shareHistoryStore';
import { invisibleStore } from '../../state/invisibleStore';
import { Avatar, Text } from '../../ui';
import { demoControls } from '../controls';
import { liveSim } from '../web/liveSim';
import type { ControlRow } from './Faz3.web';

const RING: Record<string, string> = { female: '#EC4899', male: '#3B82F6', none: '#9CA3AF' };
const TINT: Record<string, string> = { sharing: '#16A34A', expiring: '#F59E0B', paused: '#CA8A04', ended: '#6B7280' };

function useTick(ms: number) {
  const [t, setT] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

const pad = (n: number) => String(n).padStart(2, '0');
function clock(ms: number): string {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function countdownText(c: LiveShareContent, now: number): string {
  if (c.phase === 'ended') return 'Bitti';
  if (c.phase === 'paused' && c.break_until) return clock(c.break_until - now);
  if (c.ends_at === null) return 'Süresiz';
  return clock(c.ends_at - now);
}

function LeadAvatar({ c, size }: { c: LiveShareContent; size: number }) {
  const byId = useFriendsById();
  const f = byId[c.lead.uid];
  if (f) return <Avatar {...friendAvatarProps(f)} size={size} />;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 3, borderColor: RING[c.lead.ring], backgroundColor: '#E5E7EB', alignItems: 'center', justifyContent: 'center' }}>
      <RNText style={{ fontWeight: '700', color: '#374151' }}>{c.lead.initials}</RNText>
    </View>
  );
}

function ActionPill({ label, danger, onPress, testID }: { label: string; danger?: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" testID={testID} style={[styles.action, { backgroundColor: danger ? 'rgba(220,38,38,0.18)' : 'rgba(255,255,255,0.16)' }]}>
      <RNText style={{ color: danger ? '#FCA5A5' : '#FFFFFF', fontWeight: '600', fontSize: 12 }}>{label}</RNText>
    </Pressable>
  );
}

/** Kilit ekranı: iOS Live Activity kartı ya da Android canlı bildirim (LockScreen listesinin en üstü). */
export function LiveLockCard() {
  const s = useStore(liveSim);
  const now = useTick(1000);
  const c = s.content;
  if (!c) return null;
  const frac = remainingFraction(c, now);
  const tint = TINT[c.phase] ?? '#16A34A';
  const act = (a: 'break15' | 'resume' | 'stop') => {
    // Gerçekte bağlantı uygulamayı açar (Face ID); demoda kilit açılır ve eylem uygulanır.
    demoControls.setScreenLocked(false);
    void import('../../services/f12Services').then((m) => m.handleLiveAction(a, null));
  };
  if (s.platform === 'android') {
    return (
      <View style={[styles.android]} testID="live-android">
        <View style={styles.row}>
          <RNText style={styles.aApp}>Konum · {c.phase === 'ended' ? 'şimdi' : `⏱ ${countdownText(c, now)}`}</RNText>
        </View>
        <View style={[styles.row, { gap: 10 }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <RNText style={styles.aTitle} numberOfLines={1}>
              {c.title}
            </RNText>
            <RNText style={styles.aBody} numberOfLines={1}>
              {c.eta ? `${c.subtitle} · ${c.eta.label} ~${Math.max(1, Math.round((c.eta.arrive_at - now) / MINUTE))} dk` : c.subtitle}
            </RNText>
          </View>
          <LeadAvatar c={c} size={40} />
        </View>
        {frac !== null && c.phase !== 'ended' ? (
          <View style={styles.aTrack}>
            <View style={[styles.aFill, { width: `${Math.round(frac * 100)}%`, backgroundColor: tint }]} />
          </View>
        ) : null}
        {c.phase !== 'ended' ? (
          <View style={[styles.row, { gap: 18, paddingTop: 2 }]}>
            <Pressable onPress={() => act(c.phase === 'paused' ? 'resume' : 'break15')} accessibilityRole="button">
              <RNText style={styles.aAction}>{c.phase === 'paused' ? 'DEVAM ET' : 'MOLA 15 DK'}</RNText>
            </Pressable>
            <Pressable onPress={() => act('stop')} accessibilityRole="button">
              <RNText style={[styles.aAction, { color: '#F87171' }]}>DURDUR</RNText>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.ios} testID="live-ios">
      <View style={[styles.row, { gap: 10 }]}>
        <LeadAvatar c={c} size={44} />
        <View style={{ flex: 1, gap: 2 }}>
          <RNText style={styles.iTitle} numberOfLines={1}>
            {c.title}
          </RNText>
          <RNText style={styles.iBody} numberOfLines={1}>
            {c.subtitle}
          </RNText>
        </View>
        <RNText style={[styles.iClock, { color: tint }]} testID="live-countdown">
          {countdownText(c, now)}
        </RNText>
      </View>
      {frac !== null && c.phase !== 'ended' ? (
        <View style={styles.iTrack}>
          <View style={[styles.iFill, { width: `${Math.round(frac * 100)}%`, backgroundColor: tint }]} />
        </View>
      ) : null}
      {c.phase !== 'ended' ? (
        <View style={[styles.row, { gap: 8 }]}>
          {c.eta ? (
            <RNText style={styles.iEta} numberOfLines={1}>
              {c.eta.kind === 'friend' ? '🚶' : '🏁'} {c.eta.label} · {Math.max(1, Math.round((c.eta.arrive_at - now) / MINUTE))} dk içinde
            </RNText>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          <ActionPill label={c.phase === 'paused' ? 'Devam et' : 'Mola 15 dk'} onPress={() => act(c.phase === 'paused' ? 'resume' : 'break15')} testID="live-break" />
          <ActionPill label="Durdur" danger onPress={() => act('stop')} testID="live-stop" />
        </View>
      ) : null}
    </View>
  );
}

/** Dynamic Island (yalnızca iOS görünümü, kilit açıkken): kompakt; dokununca genişler. */
export function LiveIsland() {
  const s = useStore(liveSim);
  const now = useTick(1000);
  const c = s.content;
  if (!c || s.platform !== 'ios') return null;
  const tint = TINT[c.phase] ?? '#16A34A';
  if (s.islandExpanded) {
    const frac = remainingFraction(c, now);
    return (
      <Pressable onPress={() => liveSim.setState({ islandExpanded: false })} style={styles.islandBig} testID="live-island-expanded">
        <View style={[styles.row, { gap: 10 }]}>
          <LeadAvatar c={c} size={40} />
          <View style={{ flex: 1 }}>
            <RNText style={styles.iTitle} numberOfLines={1}>
              {c.title}
            </RNText>
            <RNText style={styles.iBody} numberOfLines={1}>
              {c.subtitle}
            </RNText>
          </View>
          <RNText style={[styles.iClock, { color: tint, fontSize: 22 }]}>{countdownText(c, now)}</RNText>
        </View>
        {frac !== null && c.phase !== 'ended' ? (
          <View style={styles.iTrack}>
            <View style={[styles.iFill, { width: `${Math.round(frac * 100)}%`, backgroundColor: tint }]} />
          </View>
        ) : null}
      </Pressable>
    );
  }
  return (
    <Pressable onPress={() => liveSim.setState({ islandExpanded: true })} style={styles.island} testID="live-island" accessibilityLabel="Dynamic Island">
      <LeadAvatar c={c} size={22} />
      <View style={{ flex: 1 }} />
      <RNText style={{ color: tint, fontWeight: '700', fontSize: 13 }}>{c.phase === 'paused' ? '☕ ' + compactLabel(c, now).replace('Mola ', '') : compactLabel(c, now)}</RNText>
    </Pressable>
  );
}

const SEED = [
  ['ayse', [1, 2, 3, 6, 9], 15],
  ['mehmet', [2, 5, 12], 60],
  ['can', [4], 60],
  ['zeynep', [20, 30], 60],
] as const;

export function Faz12Section({ renderRow }: { renderRow: (r: ControlRow) => React.ReactElement }) {
  const s = useStore(liveSim);
  const rows: ControlRow[] = [
    {
      key: 'f12-seed',
      title: 'Sık paylaşım geçmişini doldur',
      hint: 'Cihazdaki geçmiş: Ayşe 5× (çoğu 15 dk), Mehmet 3×, Can 1×, Zeynep 2× (eski). Haritanın altında "Sık paylaştıkların" şeridi çıkar; Can’a henüz konum izni vermedin.',
      run: () => {
        const t = Date.now();
        const entries = SEED.flatMap(([uid, days, minutes]) => days.map((d) => ({ share_id: `seed-${uid}-${d}`, receiver_id: uid, started_at: t - d * 86_400_000, minutes })));
        shareHistoryStore.getState().record(entries, t);
        return 'Geçmiş dolduruldu: Ayşe, Mehmet, Can, Zeynep.';
      },
    },
    {
      key: 'f12-lock',
      title: 'Telefonu kilitle (canlı sayacı gör)',
      hint: 'Paylaşım sürerken kilit ekranında canlı kart: kalan süre, ETA, pembe/mavi çerçeveli avatar, Mola / Durdur.',
      run: () => (demoControls.setScreenLocked(true), 'Ekran kilitlendi.'),
    },
    {
      key: 'f12-platform',
      title: s.platform === 'ios' ? 'Android görünümüne geç' : 'iOS görünümüne geç',
      hint: 'iOS: Live Activity + Dynamic Island. Android: kilit ekranı / bildirim panelinde süren canlı bildirim (Chronometer + ilerleme).',
      run: () => {
        const p = s.platform === 'ios' ? 'android' : 'ios';
        liveSim.setState({ platform: p });
        return p === 'ios' ? 'iOS görünümü.' : 'Android görünümü.';
      },
    },
    {
      key: 'f12-break',
      title: '15 dk mola ver',
      hint: 'Yeni konum gitmez, paylaşım süresi işler; arkadaşa "☕ Moladayım" notu gider. Canlı sayaç "Molada" olur.',
      run: () => (breakStore.getState().start(15), 'Mola başladı (15 dk).'),
    },
    {
      key: 'f12-invisible',
      title: 'Görünmez ol (canlı sayaç hemen kalkar)',
      hint: 'Tüm paylaşımlar biter; kilit ekranında iz kalmaz. Kısayollar "Görünür ol" yönlendirmesi gösterir.',
      run: async () => {
        const r = await invisibleStore.getState().setInvisible(true);
        return r.ok ? 'Görünmez moddasın.' : `Olmadı: ${r.message}`;
      },
    },
  ];
  return (
    <View style={{ gap: 6 }} testID="faz12-section">
      <Text variant="caption" color="textSecondary" style={{ letterSpacing: 1 }}>
        FAZ 12 SENARYOLARI
      </Text>
      <Text variant="label" color="textSecondary" style={{ fontWeight: '400' }}>
        {s.content ? `Canlı sayaç açık · ${s.content.phase} · yerel çağrı: başlat ${s.calls.start}, güncelle ${s.calls.update}, bitir ${s.calls.end}` : `Canlı sayaç kapalı · yerel çağrı: başlat ${s.calls.start}, güncelle ${s.calls.update}, bitir ${s.calls.end}`}
      </Text>
      {rows.map(renderRow)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  ios: { backgroundColor: 'rgba(28,28,30,0.78)', borderRadius: 22, padding: 14, gap: 10, backdropFilter: 'blur(18px)' } as never,
  iTitle: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
  iBody: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  iClock: { fontSize: 26, fontWeight: '600', fontVariant: ['tabular-nums'] },
  iTrack: { height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  iFill: { height: 5, borderRadius: 3 },
  iEta: { flex: 1, color: '#FFFFFF', fontSize: 12, fontWeight: '500' },
  action: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, cursor: 'pointer' } as never,
  android: { backgroundColor: 'rgba(32,33,36,0.92)', borderRadius: 20, padding: 14, gap: 8 },
  aApp: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
  aTitle: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
  aBody: { color: 'rgba(255,255,255,0.78)', fontSize: 12 },
  aTrack: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' },
  aFill: { height: 4 },
  aAction: { color: '#8AB4F8', fontWeight: '700', fontSize: 12, letterSpacing: 0.4 },
  island: { position: 'absolute', top: 11, alignSelf: 'center', left: '50%', marginLeft: -100, width: 200, height: 34, borderRadius: 20, backgroundColor: '#000000', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, zIndex: 62, cursor: 'pointer' } as never,
  islandBig: { position: 'absolute', top: 8, left: 10, right: 10, borderRadius: 36, backgroundColor: '#000000', padding: 16, gap: 10, zIndex: 62 },
});
