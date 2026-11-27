# Faz 11: Tema Paketi (Nude, Pudra Pembesi, Siyah / Gri), Google Maps Stil Senkronu ve Canlı Tema Seçici

Faz 11, Faz 7 görünüm altyapısını (Açık / Koyu / Sistem, `customMapStyle`) **genişletir**; Faz 7 tercihleri aynen
çalışır. Kaynaklar: `packages/core/src/appearance.ts` (tema kimlikleri, saat kuralı), `apps/mobile/src/ui/tokens.ts`
(belirteç setleri), `apps/mobile/src/ui/theme.ts` (harita stilleri), `apps/mobile/src/features/appearance/`.

## 1. Tema kimlikleri ve tercih

| Tercih | Etkin tema |
| --- | --- |
| `system` | Telefonun açık/koyu ayarı → `light` / `dark` (Faz 7) |
| `light`, `dark` | Faz 7 temaları |
| `nude`, `blush`, `charcoal` | Faz 11 paketleri (`charcoal` tabanı koyu: durum çubuğu açık yazı) |
| `schedule` | Kişisel ikili kural: `day_start`'tan itibaren gündüz teması, `night_start`'tan itibaren gece teması |

- Tercih + kural cihazda tek JSON kaydı: `konum.theme_settings.v2` (`{ pref, schedule }`). Faz 7'nin
  `konum.theme_pref.v1` kaydı ilk okumada taşınır. Hesaba bağlı değil (iki telefon farklı olabilir).
- Varsayılan kural: gündüz **Nude** 07:00, gece **Siyah / Gri** 19:00. Saatler 30 dk adımla; iki saat aynı olamaz.
  Gece yarısını aşan aralıklar desteklenir (`isDayTime`).

## 2. Belirteç setleri (`ColorTokens`)

Faz 11'de her temaya eklenen alanlar: `deckLayer1`, `deckLayer2` (kitapçık arka katmanları), `ringHalo`,
`ringShadow`, `ringGap` (avatar kontrast halkası), `mapHighway`, `mapRoadStroke`, `mapRoadMinor`, `mapLabel`,
`mapTransit`, `mapShore`. Açık / Koyu temada bu alanlar Faz 7 görünümünü birebir korur (halka yok).

| Belirteç | Nude | Pudra Pembesi | Siyah / Gri |
| --- | --- | --- | --- |
| bg (zemin) | `#F7F1E8` krem | `#FBF7F6` kırık beyaz | `#121417` grafit |
| surface (ön kart) | `#EFE5D8` sütlü kahve | `#F7EAEB` toz pembe | `#1C1F24` antrasit |
| surfaceAlt | `#E4D6C5` taş | `#F0DDE0` | `#262A31` |
| deckLayer1 / 2 | `#E3D4C1` / `#D6C4AE` | `#ECD5DA` / `#E1C5CC` | `#262A31` / `#30353D` |
| primary (aksiyon) | `#99582F` tarçın | `#7A2E4D` mürdüm | `#8CA0BD` arduvaz |
| primaryPressed | `#6B3B1E` espresso | `#561C34` koyu vişne | `#72869F` |
| onPrimary | `#FFF9F3` | `#FFFFFF` | `#0E1013` |
| text / textSecondary | `#2B211B` / `#64533F` | `#2A2326` / `#655760` | `#ECEDEF` / `#A9AFB8` |
| border | `#D8C7B2` | `#E8D2D7` | `#33383F` |
| ringHalo / ringGap | `#FFFDF9` / `#FFFDF9` | `#FFFFFF` / `#FFFFFF` | `rgba(10,11,13,.85)` / `#1C1F24` |

WCAG kontrastları (ön kart üzerinde): metin 12,6 / 13,1 / 14,1 : 1; ikincil metin 5,9 / 5,8 / 7,5 : 1; aksiyon
düğmesi yazısı 5,3 / 9,0 / 7,1 : 1. Durum renkleri (canlı, uyarı, tehlike) her temada ayrı ayarlandı.

## 3. Google Maps stilleri

- `buildMapStyle(theme)` aynı şablonu belirteçlerle doldurur; beş tema için diziler **modül yüklenirken bir kez**
  üretilir (`MAP_STYLES[themeId]`). JSON kopyaları: `docs/map-styles/{nude,blush,charcoal}.json` (Cloud Console'da
  Map ID stili olarak da kullanılabilir; `__tests__/faz11Theme.test.ts` dosyaların kodla aynı olduğunu denetler,
  `WRITE_MAP_STYLES=1` yeniden üretir).
- Kademe: `road.local` (sokak) → `road` (cadde) → `road.highway` (otoyol). Nude: krem sokak, açık bej cadde, kum
  otoyol, adaçayı park, toprak-gri su. Pudra: pudra/krem zemin, beyaz yollar + leylak-gri kenar, leylak otoyol,
  soğuk gri-mavi su. Siyah / Gri: `#23272D` sokak, `#2B2F36` cadde, `#3D434C` otoyol, `#1B2734` koyu mavi-gri su.
- POI ve toplu taşıma simgeleri kapalı (Faz 7 kararı: haritada kişiler öne çıksın).

## 4. Anlık geçiş (yeniden başlatma yok)

- `themePrefStore` (zustand) tercih + kural + `clock` tutar. `useThemeId()` seçicisi skaler tema kimliği döndürür:
  tema değişmedikçe yeniden çizim olmaz. `useTheme()` sabit `THEMES[id]` nesnesini verir.
- `MapCanvas` `customMapStyle={MAP_STYLES[id]}`; yalnızca dizi başvurusu değişir → react-native-maps Android'de
  `MapStyleOptions`, iOS'ta `GMSMapStyle` olarak aynı karede uygular, harita yeniden oluşturulmaz, kamera korunur.
- Saat kuralı: bir sonraki sınıra **tek** `setTimeout` (`nextThemeSwitchAt`); uygulama ön plana dönünce saat
  yeniden okunur (arka planda kaçan geçiş). Arka planda tema hesabı yapılmaz (pil).

## 5. Avatar kontrast halkası ve pinler

- `Avatar`: cinsiyet çerçevesi (3 px) ile fotoğraf arasındaki 2 px boşluk `ringGap`; temada `ringHalo` varsa
  çerçevenin dışına `boxShadow` yayılımıyla 1,5 px halka + `ringShadow` gölgesi. Yayılım düzeni değiştirmez:
  `avatarOuterSize` ve Android pin bit eşlem ölçüleri aynı.
- **Pudra Pembesi**: beyaz boşluk + beyaz dış halka + mürdüm tonlu gölge → kadın çerçevesi (#EC4899) pembe
  zemine, toz pembe kartlara ve pin konturuna karışmaz. Harita pininin dış konturu da `ringGap` (beyaz).
- **Nude**: pembe/mavi çerçeve bej zeminde ~2,8:1; kırık beyaz halka + kahve gölge çerçeveyi zeminden ayırır.
- **Siyah / Gri**: koyu halka + siyah gölge, çerçeveyi gri yollardan ayırır.

## 6. Kitapçık katman ayrışması (Siyah / Gri)

Ön kart `#1C1F24`; arkadaki katmanlar kademeli **açılır** (`#262A31` → `#30353D`) ve her katmanın `#33383F`
kenarı vardır. Saf siyah yok; böylece koyu haritanın üstünde üç katman ayrı okunur. Nude'da taş, Pudra'da gül
tonları aynı kurgu.

## 7. Tema ve Harita ekranı (`/appearance`)

- Girişler: haritadaki palet düğmesi (dokun → ekran; **uzun bas** → Faz 7 hızlı döngüsü Sistem → Açık → Koyu) ve
  İzin & Gizlilik Merkezi → Görünüm → "Tema ve Harita".
- İki sütun önizleme kartı (`ThemePreviewCard`): kartın içi önizlenen temanın belirteçleriyle çizilir: mini harita
  (zemin, park, su, otoyol / cadde / sokak), pembe ve mavi çerçeveli pin (halka dahil), mini kitapçık (iki arka
  katman + ön kart + aksiyon). Dokunuş anında uygular. Ayrıca "Sistem" kartı.
- "Saate göre otomatik" anahtarı: Gündüz / Gece sekmesi + iki saat (−/+ 30 dk). Kural açıkken kart dokunuşu seçili
  sekmenin temasını değiştirir; kartlarda "☀️ Gündüz" / "🌙 Gece" rozeti. Durum satırı bir sonraki geçişi söyler.

## 8. Web önizleme ve testler

- Demo paneli "FAZ 11 SENARYOLARI": ekranı aç, üç tema, saat kuralını gece / gündüz saatine kaydır, Sistem'e dön.
- `apps/mobile/e2e/faz11-smoke.cjs` (16 denetim, ekran görüntüleri `SHOTS=…`), `__tests__/faz11Theme.test.ts`,
  `packages/core/test/faz11.test.ts`.
- **[Varsayım]** Native boxShadow yayılımı (RN yeni mimari) Android pin bit eşleminde kırpılabilir; cihazda
  denenmeli. Gerekirse halka, pin kutusuna 2 px dolgu ile çizilir.
