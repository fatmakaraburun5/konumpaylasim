/**
 * Web önizleme · Faz 5 (yalnızca tarayıcı paketi): "FAZ 5 SENARYOLARI" panel grubu.
 *
 *  - "Ev bölgemi buraya kaydet (demo)": telefonun yerinde 150 m Ev + "Vardığımda Ayşe'ye bildir" + "Çıkınca Ayşe ile
 *    1 saat paylaş". Telefon orada bekler.
 *  - "Evden çık" / "Eve var": yürüyüş zaman atlamalı oynatılır (demo/web/zoneSim.ts) → GERÇEK sapma filtresi →
 *    `zone_event_report` → (çıkışta) paylaşım başlar, (varışta) Ayşe'ye bildirim.
 *  - "GPS sapması (tek sıçrama)": kötü doğruluklu örnek + sahte OS "çıktı" + 1,5 km sıçrama → tetik YOK.
 *  - "Ayşe eve vardı": Ayşe'nin kuralı → sana `zone_event` push'u. "Ayşe buluşma noktası önersin": sana öneri → kart.
 * Altta son filtre kararları ve gerekçeleri canlı gösterilir.
 */
import { ZONE_FILTER, type ZoneFilterReason } from '@konum/core';
import { useEffect, useState, type ReactElement } from 'react';
import { View } from 'react-native';
import type { ZoneDecision } from '../../services/location/zoneMonitorCore';
import { useZonesStore } from '../../state/zonesStore';
import { Text } from '../../ui';
import { demoControls, type DemoSnapshot } from '../controls';
import { demoZoneArrive, demoZoneDecisions, demoZoneGlitch, demoZoneLeave, demoZoneState, onDemoZoneDecision, type DemoZone } from '../web/zoneSim';
import type { ControlRow } from './Faz3.web';

interface Faz5Props {
  snap: DemoSnapshot | null;
  renderRow: (r: ControlRow) => ReactElement;
}

export const ZONE_REASON_TEXT: Record<ZoneFilterReason, string> = {
  initial: 'ilk durum kuruldu (tetik yok)',
  confirmed_dwell: 'ONAYLANDI: bekleme süresi doldu',
  confirmed_samples: 'ONAYLANDI: 2 güvenli örnek (≥ 20 sn arayla)',
  far_escape: 'ONAYLANDI: bölgeden çok uzaklaştı',
  low_accuracy: 'yok sayıldı: doğruluk düşük',
  teleport: 'yok sayıldı: ışınlanma (hız > 70 m/sn)',
  grey_band: 'gri bant: karar verilmedi',
  no_change: 'değişiklik yok',
  pending: 'bekliyor: onay için ikinci güvenli örnek',
  min_stay: 'bekliyor: ters geçiş için 3 dk dolmalı',
  same_cooldown: 'bastırıldı: aynı yön 10 dk içinde',
  os_candidate: 'OS olayı: aday (taze konumla doğrulanacak)',
};

const SUPPRESSED_TEXT: Record<string, string> = {
  cooldown: 'soğuma (5 dk)',
  stale: 'eski olay',
  outside_window: 'kural saati dışında',
  disabled: 'bölge kapalı',
  daily_limit: 'günlük sınır',
  queued: 'çevrimdışı: sırada',
  dropped: 'gönderilemedi',
};

const MONITORING_TEXT = { off: 'kapalı (etkin bölge yok)', active: 'etkin', needs_permission: "izin gerekli ('Her zaman')", unsupported: 'desteklenmiyor' } as const;

const clock = (t: number) => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function useDecisions(): ZoneDecision[] {
  const [list, setList] = useState<ZoneDecision[]>(() => demoZoneDecisions());
  useEffect(() => onDemoZoneDecision(() => setList(demoZoneDecisions())), []);
  return list;
}

export function Faz5Section({ snap, renderRow }: Faz5Props) {
  const f5 = snap?.f5 ?? null;
  const home = f5?.homeZone ?? null;
  const zone: DemoZone | null = home ? { zone_id: home.zone_id, center: home.center, radius_m: home.radius_m } : null;
  const monitoring = useZonesStore((s) => s.monitoring);
  const presence = useZonesStore((s) => (home ? s.presence[home.zone_id] : undefined));
  const decisions = useDecisions();
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1_000);
    return () => clearInterval(t);
  }, []);

  const needZone = 'Önce "Ev bölgemi buraya kaydet" de.';
  const rows: ControlRow[] = [
    {
      key: 'f5-save-home',
      title: 'Ev bölgemi buraya kaydet (demo)',
      hint: "150 m · 'Vardığımda Ayşe'ye bildir' + 'Çıkınca Ayşe ile 1 saat paylaş'. Telefon burada bekler.",
      run: () => (demoControls.saveHomeZoneHere() ? 'Ev bölgen kaydedildi (150 m, 2 kural).' : 'Ayşe ile arkadaş değilsin.'),
    },
    {
      key: 'f5-leave',
      title: 'Evden çık',
      hint: 'Bölge dışına ~70 sn yürüyüş (zaman atlamalı) → filtre → olay → Ayşe ile paylaşım başlar.',
      run: async () => (zone && (await demoZoneLeave(zone)) ? 'Evden çıktın: filtre kararı aşağıda.' : needZone),
    },
    {
      key: 'f5-arrive',
      title: 'Eve var',
      hint: 'Merkeze yürüyüş → varış onayı → Ayşe\'ye "Ev konumuna vardı" bildirimi.',
      run: async () => (zone && (await demoZoneArrive(zone)) ? 'Eve vardın: filtre kararı aşağıda.' : needZone),
    },
    {
      key: 'f5-glitch',
      title: 'GPS sapması (tek sıçrama)',
      hint: 'Kötü doğruluklu örnek + sahte OS "çıktı" + 1,5 km sıçrama → tetik YOK.',
      run: async () => (zone && (await demoZoneGlitch(zone)) ? 'Sapma örnekleri filtreye verildi: tetik beklenmiyor.' : needZone),
    },
    {
      key: 'f5-ayse-home',
      title: 'Ayşe eve vardı',
      hint: 'Ayşe\'nin kuralı: "Vardığımda Deniz\'e bildir" → sana bildirim (konum yok, yalnızca bölge adı).',
      run: () => {
        const n = demoControls.ayseArrivedHome();
        return n === null ? 'Ayşe ile arkadaş değilsin.' : n > 0 ? 'Ayşe "Ev konumuna vardı" bildirimi gönderdi.' : 'Bildirim bastırıldı (soğuma / kural).';
      },
    },
    {
      key: 'f5-ayse-meetup',
      title: 'Ayşe buluşma noktası önersin',
      hint: 'Ayşe ile senin aranda bir kafe → sana öneri kartı (herkesin varış süresiyle).',
      run: () => (demoControls.ayseSuggestMeetup() ? 'Ayşe bir buluşma noktası önerdi.' : 'Öneri yapılamadı (arkadaş değil / yer bulunamadı).'),
    },
  ];

  const st = home ? demoZoneState(home.zone_id) : null;
  const cand = st?.candidate ?? null;
  const now = Date.now();
  const lastT = st?.last_transition ?? null;
  const minStayLeft = lastT && cand && cand.to !== lastT.to ? Math.max(0, lastT.at + ZONE_FILTER.minStayMs - now) : 0;
  const ev = f5?.lastZoneEvent ?? null;
  const lines = [
    home
      ? `Ev bölgesi: ${home.radius_m} m · ${home.rules} kural · şu an: ${presence === 'inside' ? 'içeride' : presence === 'outside' ? 'dışarıda' : 'bilinmiyor'} · izleme: ${MONITORING_TEXT[monitoring]}`
      : 'Ev bölgen yok.',
    cand
      ? `Aday: ${cand.to === 'inside' ? 'varış' : 'ayrılış'} · ${cand.samples} güvenli örnek · ${Math.round((now - cand.since) / 1000)} sn${minStayLeft > 0 ? ` · ters geçişe ${Math.ceil(minStayLeft / 1000)} sn` : ''}`
      : null,
    ev
      ? `Son olay: ${ev.zone_name} · ${ev.transition === 'arrive' ? 'vardın' : 'çıktın'} · ${clock(ev.at)} · ${ev.suppressed ? `bastırıldı: ${SUPPRESSED_TEXT[ev.suppressed] ?? ev.suppressed}` : `${ev.notified} kişiye bildirildi`}`
      : null,
    f5 ? `Buluşma önerisi: ${f5.activeMeetups} aktif · bugün ${f5.meetupQueries}/${f5.meetupLimit} sorgu${f5.meetupHits ? ` · ${f5.meetupHits} önbellek` : ''}` : null,
  ].filter((l): l is string => l !== null);

  const recent = decisions.filter((d) => !home || d.zone_id === home.zone_id).slice(0, 6);

  return (
    <View style={{ gap: 6 }} testID="faz5-section">
      <Text variant="caption" color="textSecondary" style={{ letterSpacing: 1 }}>
        FAZ 5 SENARYOLARI
      </Text>
      {rows.map(renderRow)}
      {lines.map((l) => (
        <Text key={l} variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          {l}
        </Text>
      ))}
      <View style={{ gap: 2 }} testID="faz5-decisions">
        <Text variant="caption" color="textSecondary" style={{ letterSpacing: 1 }}>
          SON FİLTRE KARARLARI
        </Text>
        {recent.length === 0 ? (
          <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
            Henüz karar yok.
          </Text>
        ) : (
          recent.map((d, i) => (
            <Text key={`${d.at}-${i}`} variant="caption" color={i === 0 ? 'text' : 'textSecondary'} style={{ fontWeight: i === 0 ? '600' : '400' }}>
              {`${clock(d.at)} · ${d.input === 'os_event' ? 'OS' : d.source === 'demo' ? 'yürüyüş' : d.source === 'os_fix' ? 'taze konum' : 'örnek'}${d.distance_m !== null ? ` · ${d.distance_m} m` : ''}${d.accuracy !== null ? ` ±${Math.round(d.accuracy)}` : ''} → ${ZONE_REASON_TEXT[d.reason]}${d.emit ? ` (${d.emit === 'arrive' ? 'VARIŞ' : 'AYRILIŞ'})` : ''}`}
            </Text>
          ))
        )}
      </View>
    </View>
  );
}
