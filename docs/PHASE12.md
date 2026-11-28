# Faz 12: Kilit ekranı canlı sayaç ve sık paylaşılan kişi kısayolları

Durum (2026-11-28): kod hazır, tüm testler ve web duman testi geçiyor. Yerel iOS / Android kodu bu ortamda
derlenmedi (Xcode / Android SDK yok); cihazda doğrulanmalı.

## 1. Kilit ekranı canlı sayaç

Tek veri modeli: `packages/core/src/liveActivity.ts`. Uygulama durumu → `LiveShareContent`; iOS ve Android yalnızca çizer.

| Alan (`ContentState`) | Anlam |
| --- | --- |
| `phase` | `sharing` · `expiring` (son 5 dk, turuncu) · `paused` (mola) · `ended` (sona erdi kartı) |
| `ends_at`, `started_at` | öndeki paylaşımın bitişi / başlangıcı (sayaç + ilerleme çubuğu); süresiz = `null` |
| `break_until` | mola bitişi |
| `lead` | öndeki kişi: ad, baş harfler, `ring` (female pembe / male mavi / none gri), `avatar_key` |
| `receivers` | konumu gören toplam kişi ("Ayşe +1") |
| `eta` | seçili arkadaş / nokta: etiket + MUTLAK varış saati (dakika yerelde akar) |
| `title`, `subtitle` | hazır Türkçe metin (Android başlığı, erişilebilirlik) |

`ActivityAttributes` sabit: `v`, `activity_id`, `started_at`. İçerikte koordinat yok.

Öndeki kişi kitapçıkla aynı kural: en kısa süresi kalan paylaşım.

### Yaşam döngüsü (`planLiveActivity`, `services/f12Services.ts`)

| Olay | Yerel çağrı |
| --- | --- |
| ilk arkadaş paylaşımı onaylandı | `start` |
| alıcı / öndeki kişi / mola / ETA değişti, son 5 dk | `update` (içerik imzası değişmediyse hiç çağrı yok) |
| süre doldu ya da durduruldu | `end` + "Paylaşım süresi doldu / durduruldu" kartı 4 dk kalır |
| Görünmez Ol | HEMEN `end` (kilit ekranında iz kalmaz) |
| çıkış | HEMEN `end` |

Sayaç her dakika güncellenmez: iOS `Text(timerInterval:)` + `ProgressView(timerInterval:)`, Android
`setUsesChronometer + setChronometerCountDown`. Bu, ActivityKit güncelleme bütçesini ve pili korur.

### iOS (ActivityKit, iOS 16.2+)

- Arayüz: `targets/widgets/LiveShareActivity.swift` (WidgetKit uzantısı). Kilit ekranı: avatar (pembe/mavi halka),
  "Ayşe +1 konumunu görüyor", büyük geri sayım, ilerleme çubuğu, ETA satırı ("Ayşe · 3 dk içinde"),
  "Mola 15 dk" / "Devam et" ve "Durdur" bağlantıları.
- Dynamic Island: kompakt (avatar | kalan dk, molada ☕), minimal (avatar), genişletilmiş (başlık + sayaç + çubuk).
- Uygulama tarafı: `modules/konum-widgets/ios/LiveShareBridge.swift` (`liveStart / liveUpdate / liveEnd / liveEnabled`).
  `KonumShareAttributes` iki dosyada da AYNI ad ve alanlarla tanımlı (ActivityKit böyle eşler); biri değişirse diğeri de.
- `app.config.ts`: `NSSupportsLiveActivities: true`. Avatar: Faz 6 App Group klasöründe `live_<uid>.jpg`.

### Android

- `modules/konum-widgets/android/.../LiveShareNotification.kt`: kanal `konum_live_share` (sessiz, kilit ekranında
  görünür), Chronometer geri sayımı, ilerleme çubuğu, çerçeveli avatar (Faz 6 `AvatarRenderer`), "MOLA 15 DK" /
  "DEVAM ET" ve "DURDUR" eylemleri. Android 16'da `requestPromotedOngoing` ile durum çubuğu çipi.
- Konum hizmetinin kendi ön plan bildirimi (Faz 3) ayrı kalır; canlı kart onun üstünde zengin özet.

### Eylemler

`konum://live?action=break15|resume|stop|open` → `app/live.tsx` → `handleLiveAction`. "Durdur" yalnızca öndeki oturumu
durdurur (hepsini durdurmak kitapçıktaki iki adımlı "Tümünü durdur"da kalır). Eylem uygulamayı açar (kilit açılır).

## 2. Mola

`core/breakMode.ts`, `state/breakStore.ts`, `state/breakHold.ts`.

- Kitapçık üstündeki satırda "☕ Mola" → 15 / 30 dk. Molada "☕ Moladasın · 12 dk" + "Devam et".
- Mola başlarken durum notu "☕ Moladayım" tek paketle gider; 5 sn sonra konum hattı yeni konum yayınlamaz ve
  kuyruğa da yazmaz (mola izi oluşmaz). Takip ve hedefler sürer; mola bitince ilk örnek yayınlanır.
- Paylaşım süresi işlemeye devam eder (mola süreyi uzatmaz). [Varsayım]
- Kendiliğinden biter: süre dolunca, Görünmez Ol, tüm paylaşımlar bitince, yeni paylaşım başlayınca.
- Kayıt cihazda (`konum.bg.break.v1`), başsız arka plan görevi de okur. Sunucu değişikliği yok.

## 3. Sık paylaştıkların (kısayollar)

- Geçmiş YALNIZCA cihazda (`konum.f12.shareHistory.v1`): her onaylı giden paylaşım (alıcı başına, `share_id` tekil);
  hangi yoldan başladığı fark etmez (paylaş sayfası, kısayol, widget, Konum İste onayı). Çıkışta silinir.
- Puan (`rankFrequentContacts`): her paylaşım ≈ 1 puan, 14 günde yarıya iner, 60 günden eskisi sayılmaz; favori +0,75
  (hiç paylaşılmamış favori de görünür ama sık paylaşılan öne geçer). Arkadaş olmayan elenir. En çok 4 kişi.
- Yer: haritanın alt alanı. Paylaşım yokken "Konumumu paylaş"ın üstünde tek satır; paylaşım sürerken kitapçığın
  altında "＋ Paylaş" ile AYNI satırda (harita alanından yükseklik yemez).
- Kişiye dokun → aynı satırda [15 dk] [1 saat] (kişinin her zamanki süresi dolgun). Dokunuş = paylaşım başlar.
  Uzun bas → "Öneriden kaldır".

### Başlatmadan önce kontrol (`planShortcutStart`)

| Durum | Ne olur |
| --- | --- |
| Görünmez | "Görünmez moddasın…" + "Görünür ol" (Faz 8 geri dönüş akışı); paylaşım başlamaz |
| Güncel sözleşme onayı yok | "Sözleşmeyi aç" |
| Ben → o `location_view` izni yok | açıklama + "İzin ver ve 15 dk paylaş" (ikinci dokunuş açık onaydır, Faz 8 `grant_location_view`) |
| Bu kişiye zaten daha uzun / süresiz paylaşım var | "Konumunu zaten görüyor · 40 dk kaldı" (kısaltma yapılmaz) |
| Mola | "Molan biter ve yayın yeniden açılır." |
| OS konum izni gerekiyor | mevcut PermissionFlow |

Açılan satırın üstünde karşılıklı izin bilgisi: "Ayşe da konumunu seninle paylaşabiliyor" ya da
"Ayşe sana konum izni vermedi; yalnızca sen paylaşırsın".

## 4. Dosyalar

- core: `liveActivity.ts`, `frequentContacts.ts`, `breakMode.ts`, test `test/faz12.test.ts`
- mobil: `services/f12Services.ts`, `services/live/liveActivityBridge.ts`, `state/{breakStore,breakHold,shareHistoryStore,liveEtaStore}.ts`,
  `features/shortcuts/{ShortcutStrip.tsx,useFrequentContacts.ts}`, `features/map/ShareExtrasBar.tsx` (Mola),
  `features/map/MapHome.tsx` (şerit + ETA), `app/live.tsx`, `services/location/pipeline.ts` (mola bekletmesi)
- yerel: `targets/widgets/LiveShareActivity.swift`, `modules/konum-widgets/ios/LiveShareBridge.swift`,
  `modules/konum-widgets/android/.../LiveShareNotification.kt`
- demo: `src/demo/shell/Faz12.web.tsx` ("FAZ 12 SENARYOLARI"), `src/demo/web/liveSim.ts`; duman testi `e2e/faz12-smoke.cjs` (24 denetim)

## 5. Cihazda denenecekler

1. iOS 16.2+ cihazda paylaşım başlat → kilitle: kart + Dynamic Island; Ayarlar > Konum > Canlı Etkinlikler kapalıyken hiç çıkmamalı.
2. Android 13+: bildirim izni verilmişken kilit ekranında canlı kart; Android 16'da durum çubuğu çipi.
3. Mola 15 dk → alıcı telefonda "☕ Moladayım" notu, 15 dk boyunca yeni konum yok, sonra kendiliğinden devam.
4. Görünmez Ol → kilit ekranındaki kart anında kalkar.
