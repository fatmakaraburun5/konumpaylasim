/**
 * Web önizleme · Faz 8 (yalnızca tarayıcı paketi): "FAZ 8 SENARYOLARI" panel grubu.
 *
 *  - "Can konumunu görmek istiyor": Can'dan `location_view` isteği → bildirim + Arkadaşlar > "İzin istekleri" kartı.
 *  - "Ayşe iznini geri alsın": Ayşe'nin bana verdiği konum izni kalkar; paylaşımı sıradan bir durdurma gibi biter
 *    (uygulama "izni geri aldı" demez). Tekrar basınca Ayşe izni yeniden verir ve paylaşır.
 *  - "Mehmet sana ping izni versin": artık Mehmet'e "Buradayım / Yoldayım" gönderebilirsin.
 *  - "Sözleşme güncellendi (yeniden onay)": onayın eski sürüme çekilir → onay kapısı "Metin güncellendi" ile açılır.
 *  - "Arkadaşlarım beni görüyor mu?": sunucuda konumunun teslim edildiği kişiler (görünmezken 0).
 * Varsayılan: Ayşe / Mehmet / Zeynep sana konum izni vermiş, Can vermemiş; senin kimseye iznin yok.
 */
import type { ReactElement } from 'react';
import { View } from 'react-native';
import { Text } from '../../ui';
import { demoControls, type DemoSnapshot } from '../controls';
import type { ControlRow } from './Faz3.web';

interface Faz8Props {
  snap: DemoSnapshot | null;
  renderRow: (r: ControlRow) => ReactElement;
}

const list = (names: readonly string[]) => (names.length ? names.join(', ') : 'kimse');

export function Faz8Section({ snap, renderRow }: Faz8Props) {
  const f8 = snap?.f8 ?? null;
  const ayseOn = f8?.ayseGrantsMe ?? true;

  const rows: ControlRow[] = [
    {
      key: 'lr-mehmet-request',
      title: 'Mehmet konumunu istiyor',
      hint: 'Konum İste: Onayla / Reddet eylemli bildirim + haritada istek kartı. Onaylayınca süre seçersin. (Sen birinden isteyince Zeynep reddeder, diğerleri 1 saat paylaşır.)',
      run: () => (demoControls.friendRequestsMyLocation('mehmet') ? 'Mehmet konumunu paylaşmanı istiyor.' : 'Mehmet ile arkadaş değilsin.'),
    },
    {
      key: 'f8-can-request',
      title: 'Can konumunu görmek istiyor',
      hint: 'Can\'dan izin isteği: bildirim + Arkadaşlar ekranında "İzin istekleri" kartı.',
      run: () => (demoControls.canRequestsMyLocation() ? 'Can senden konumunu görmek istiyor.' : 'Can konumunu zaten görebiliyor.'),
    },
    {
      key: 'f8-ayse-revoke',
      title: ayseOn ? 'Ayşe iznini geri alsın' : 'Ayşe iznini yeniden versin',
      hint: ayseOn ? 'Ayşe\'nin paylaşımı sıradan bir durdurma gibi biter; uygulama nedenini söylemez.' : 'Ayşe sana konum izni verir ve 1 saat paylaşır.',
      run: () => {
        const r = demoControls.ayseRevokes();
        if (r === 'revoked') return 'Ayşe konumunu artık seninle paylaşmıyor.';
        if (r === 'granted') return 'Ayşe konumunu yeniden paylaşıyor.';
        return 'Ayşe ile arkadaş değilsin.';
      },
    },
    {
      key: 'f8-mehmet-ping',
      title: 'Mehmet sana ping izni versin',
      hint: 'Sonra Mehmet\'e "Buradayım / Yoldayım" gönderebilirsin.',
      run: () => (demoControls.mehmetGrantsPing() ? 'Mehmet sana ping izni verdi.' : 'Mehmet bu izni zaten vermiş.'),
    },
    {
      key: 'f8-consent-bump',
      title: 'Sözleşme güncellendi (yeniden onay)',
      hint: 'Onay kapısı "Metin güncellendi" ile açılır; onaylayana kadar konum gönderilmez.',
      run: () => {
        demoControls.bumpConsent();
        return 'Sözleşme güncellendi: uygulama yeniden onay istiyor.';
      },
    },
    {
      key: 'f8-who-sees-me',
      title: 'Arkadaşlarım beni görüyor mu?',
      hint: 'Sunucuda konumunun şu an teslim edildiği kişiler (görünmezken 0).',
      run: () => {
        const s = demoControls.snapshot().f8;
        if (s.myDeliveriesCount === 0) return s.myInvisible ? 'Görünmezsin: kimse konumunu görmüyor (0).' : 'Şu an kimse konumunu görmüyor (0).';
        return `Konumunu şu an ${s.myDeliveriesCount} kişi görüyor: ${s.seesMe.join(', ')}.`;
      },
    },
  ];

  const lines = f8
    ? [
        `Görünmez mod: ${f8.myInvisible ? 'açık' : 'kapalı'} · konumunu gören: ${f8.myDeliveriesCount}`,
        `Konum izni verdiklerin: ${list(f8.givenLocation)}`,
        `Sana konum izni verenler: ${list(f8.receivedLocation)}`,
        `Bekleyen izin isteği: sana ${f8.pendingIncoming} · senden ${f8.pendingOutgoing}`,
        f8.consent ? `Onay: ${f8.consent.version} sürümü${f8.consent.current ? ' (güncel)' : ' (eski: yeniden onay gerekli)'}` : 'Onay: yok (onay ekranı açılır)',
      ]
    : [];

  return (
    <View style={{ gap: 6 }} testID="faz8-section">
      <Text variant="caption" color="textSecondary" style={{ letterSpacing: 1 }}>
        FAZ 8 SENARYOLARI
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
