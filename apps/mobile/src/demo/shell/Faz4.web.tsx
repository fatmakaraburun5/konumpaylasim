/**
 * Web önizleme · Faz 4 (yalnızca tarayıcı paketi): "FAZ 4 SENARYOLARI" panel grubu.
 *
 *  - Ayşe "📍 Buradayım" (konumlu) / Mehmet "🚶 Yoldayım" (12 dk): uygulamada üstte ping kartı + pin nabzı;
 *    ekran kilitliyken kilit ekranında bildirim.
 *  - Ayşe durum notu "☕ Kahve molasındayım": Ayşe'nin canlı paketlerine `note` + `note_exp` eklenir.
 *  - Ayşe park yeri notu: Firestore `place_notes` (yalnızca bana görünür, 4 saat).
 *  - Ayşe SOS / Ayşe güvende: `sos_alerts` + yüksek öncelikli push → tam ekran acil durum kartı.
 * Benim acil kişilerim boş başlar: ilk SOS'ta kişi seçim ekranı görünür. Bot alıcılar SOS'umu birkaç saniyede "görür".
 */
import type { ReactElement } from 'react';
import { View } from 'react-native';
import { Text } from '../../ui';
import { demoControls, type DemoSnapshot } from '../controls';
import type { ControlRow } from './Faz3.web';

interface Faz4Props {
  snap: DemoSnapshot | null;
  renderRow: (r: ControlRow) => ReactElement;
}

export function Faz4Section({ snap, renderRow }: Faz4Props) {
  const f4 = snap?.f4 ?? null;
  const noteOn = f4?.ayseNote ?? false;

  const rows: ControlRow[] = [
    {
      key: 'f4-ping-here',
      title: "Ayşe 'Buradayım' göndersin",
      hint: 'Konumlu sinyal: üstte kart, Ayşe\'nin pininde nabız halkası. Önce Ayşe\'ye ping izni ver (Kişi izinleri).',
      run: () => (demoControls.aysePingHere() ? 'Ayşe "📍 Buradayım" gönderdi.' : 'Gönderilemedi: Ayşe\'ye ping izni vermedin.'),
    },
    {
      key: 'f4-ping-onway',
      title: "Mehmet 'Yoldayım' (12 dk)",
      hint: 'Yaklaşık varış süresiyle; ekran kilitliyken bildirim olarak gelir. Önce Mehmet\'e ping izni ver.',
      run: () => (demoControls.mehmetPingOnWay(12) ? 'Mehmet "🚶 Yoldayım · ~12 dk" gönderdi.' : 'Gönderilemedi: Mehmet\'e ping izni vermedin.'),
    },
    {
      key: 'f4-ayse-note',
      title: noteOn ? 'Ayşe\'nin durum notu kalksın' : 'Ayşe durum notu: ☕ Kahve molasındayım',
      hint: 'Not, Ayşe\'nin konum paketine eklenir; pinin altında balon olarak görünür.',
      run: () => {
        const r = demoControls.toggleAyseStatusNote();
        if (!r.sharing) return r.on ? 'Not eklendi; Ayşe şu an seninle paylaşmadığı için görünmez.' : 'Ayşe\'nin notu kaldırıldı.';
        return r.on ? 'Ayşe: "☕ Kahve molasındayım" (1 saat).' : 'Ayşe\'nin notu kaldırıldı.';
      },
    },
    {
      key: 'f4-ayse-place',
      title: 'Ayşe park yeri notu paylaşsın',
      hint: '🅿️ "Park yeri burası" · 4 saat · yalnızca sana görünür.',
      run: () => (demoControls.aysePlaceNote() ? 'Ayşe haritaya "🅿️ Park yeri burası" notu bıraktı.' : 'Ayşe ile arkadaş değilsin.'),
    },
    {
      key: 'f4-ayse-sos',
      title: 'Ayşe SOS göndersin',
      hint: 'Acil kişisi sensin: tam konum, adres, pil %23, rota → tam ekran acil durum kartı.',
      tone: 'danger',
      run: () => (demoControls.ayseSos() ? 'ACİL: Ayşe tehlikede olduğunu bildirdi.' : 'Ayşe ile arkadaş değilsin.'),
    },
    {
      key: 'f4-ayse-safe',
      title: 'Ayşe güvende',
      hint: 'Uyarı kapanır; kart yeşil "güvende" durumuna geçer.',
      run: () => (demoControls.ayseSafe() ? 'Ayşe "Güvendeyim" dedi.' : 'Ayşe\'nin aktif acil durum uyarısı yok.'),
    },
  ];

  const contacts = f4?.myEmergencyContacts ?? [];
  const mine = f4?.mySos ?? null;
  const lines = [
    contacts.length ? `Acil kişilerin: ${contacts.join(', ')}` : 'Acil kişin yok: ilk SOS\'ta seçim ekranı açılır.',
    mine
      ? `Son SOS'un: ${mine.status === 'active' ? 'aktif' : 'kapandı'} · ${mine.acks}/${mine.recipients} gördü${mine.updates ? ` · ${mine.updates} konum güncellemesi` : ''}`
      : null,
    f4 ? `Sana görünür yer notu: ${f4.placeNotesForMe} · bekleyen ping: ${f4.pingsForMe}` : null,
  ].filter((l): l is string => l !== null);

  return (
    <View style={{ gap: 6 }} testID="faz4-section">
      <Text variant="caption" color="textSecondary" style={{ letterSpacing: 1 }}>
        FAZ 4 SENARYOLARI
      </Text>
      {rows.map(renderRow)}
      {lines.map((l) => (
        <Text key={l} variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          {l}
        </Text>
      ))}
    </View>
  );
}
