# Konum

Arkadaşlarla süreli canlı konum paylaşan iOS ve Android uygulaması. Bu depo Faz 1–4'ün çalıştırılabilir kodudur: ortak çekirdek paket, Expo (React Native) mobil uygulama, Firebase backend ve QR bağlantıları için salt okunur web haritası. Faz 3 haftalık ve süresiz paylaşımlar için arka plan takibini, harekete göre pil optimizasyonunu, çevrimdışı kuyruğu ve %15 düşük pil bildirimini ekler. Faz 4 harita üzerinden tek dokunuşla "Buradayım / Yoldayım" sinyalini, konum yanına kısa durum ve yer notlarını ve tam konumlu SOS'u (basılı tut + geri sayım, acil kişiler, yüksek öncelikli bildirim, alıcıda tam ekran acil kartı) ekler.

## Yapı

```text
konum/
  packages/core/   @konum/core: veri modelleri, süre motoru, konum paketi, paylaşım state'i,
                   callable sözleşmeleri, Türkçe biçimlendirme. Mobil ve backend aynı kodu kullanır.
  apps/mobile/     Expo SDK 58 + expo-router. Native Google Maps (açık/koyu stil, yumuşak pin), rota + ETA kartı,
                   paylaşım başlatma, süre seçimi, uzatma, QR bağlantısı ve izleyicisi (app/s/[token]),
                   arka plan konum görevi, bildirimler, arkadaşlar, ping, durum/yer notu, SOS.
  apps/web/        Vite + React salt okunur web haritası: https://<alan>/s/<token> (uygulaması olmayanlar için).
  backend/         Firestore + RTDB kuralları, Cloud Functions (europe-west1), Maps vekili, Hosting
                   (Universal/App Links dosyaları), emülatör testleri.
  docs/
    PHASES.md        Faz tablosu, Faz 1 → 2, Faz 2 → 3, Faz 3 → 4 ve Faz 4 → 5 geçiş noktaları
    PHASE2.md        Faz 2: harita ve ETA kartı, süre yaşam döngüsü, QR token ve iptal, Maps maliyet/kota kuralları
    PHASE3.md        Faz 3: iOS/Android arka plan ve izin mimarisi, hareket × pil takip matrisi, çevrimdışı kuyruk,
                     son doğrulanmış konum, %15 düşük pil akışı, saha ve simülasyon test senaryoları
    PHASE4.md        Faz 4: ping, durum ve yer notu, SOS veri modelleri; gerçek zamanlı/push akışı; SOS acil
                     ekranı ve bildirim davranışı (iOS critical/time-sensitive, Android sos kanalı, DND);
                     yanlış tetiklemeyi önleyen UX; gizlilik kararları
    ARCHITECTURE.md  Bileşenler, konum ve bağlantı akışı, gizlilik modeli, yollar
    BACKEND_SPEC.md  İlk Firebase önerisi (core ve kod ile çeliştiğinde core geçerlidir)
```

Her alt klasörün kendi README'si kurulum ayrıntılarını içerir.

## Tarayıcıda önizleme (demo)

Uygulamanın gerçek arayüzü Firebase, Google Maps anahtarı ya da ağ bağlantısı olmadan tarayıcıda açılır:

```bash
cd apps/mobile && npm ci && npm run web     # → http://localhost:8081
```

Giriş için herhangi bir cep numarası ve **demo kodu 123456** yeterli. Firebase (giriş, veritabanı, fonksiyonlar),
arkadaşlar ve konumları, harita çizimi, arka plan konum takibi ve gerçek bildirimler simüle edilir; yanındaki
"Demo kontrolleri" paneliyle süre bitişi, arkadaşlık isteği gibi durumlar tetiklenir. Faz 2 de önizlemede çalışır:
arkadaşa dokununca rota + ETA kartı ve adres, Paylaş → "Bağlantı (QR)" ile QR, +30 dk / +1 saat, "Bağlantıyı önizle" ile
salt okunur izleyici ve panelden iptal ("Google yanıt vermesin" anahtarı servis kesintisini dener). Faz 4 için
paneldeki "FAZ 4 SENARYOLARI": Ayşe "Buradayım", Mehmet "Yoldayım", Ayşe durum notu, park yeri notu, "Ayşe SOS
göndersin" (tam ekran acil kartı) ve "Ayşe güvende"; kendi SOS'un için haritadaki kırmızı düğmeyi basılı tut. `npm run web:export`
tek dosyalık statik sürümü `apps/mobile/dist-web/` altına üretir. Ayrıntı: `apps/mobile/README.md`.

## Testleri çalıştırma

Gerekenler: Node 22. Backend emülatörleri için Java 11 veya üstü.

```bash
# Çekirdek (197 test; Faz 3 simülasyon tablosu: npx vitest run test/simulate.test.ts)
cd packages/core && npm ci && npm test && npm run typecheck

# Mobil (166 test, 21 dosya) + yerel JS paketleri
cd apps/mobile && npm ci && npm run typecheck && npm test
EXPO_OFFLINE=1 CI=1 npx expo export --platform android --output-dir /tmp/konum-android

# Backend (195 test, 18 dosya; Auth, Firestore, RTDB ve Functions emülatörlerini açar)
cd backend && npm ci && npm --prefix functions ci && npm test

# Web haritası (53 test) + derleme + Playwright duman testi (sahte veri, 80 denetim)
cd apps/web && npm ci && npm run typecheck && npm test && npm run build && npm run e2e

# Faz 2 uçtan uca kabul testi: gerçek emülatörler + web derlemesi + mobil yayıncı kodu (59 denetim)
cd backend && npm run build && npx firebase emulators:exec --project demo-konum \
  --only auth,firestore,database,functions "bash ../apps/web/e2e/run-emulator.sh"

# Faz 3 uçtan uca kabul testi: hb'li paketler, çevrimdışı kuyruk + live_trail, durdurma, %15 pil, bekçi (57 denetim)
cd backend && npm run build && npx firebase emulators:exec --project demo-konum \
  --only auth,firestore,database,functions "bash ../apps/web/e2e/faz3/run-faz3.sh"
```

Playwright betikleri `require('playwright')` kullanır (pakete eklenmedi; yerelde `npm i --no-save playwright && npx playwright install chromium`).

Mobil uygulamayı cihazda çalıştırmak için `apps/mobile/README.md`'deki development build adımlarına bak. Expo Go yeterli değildir, çünkü arka plan konumu ve native Google Maps için development build gerekir.

## Neden Firebase (WebSocket sunucusu yerine)

- **Arka planda bağlantı:** iOS ve Android uygulama kapalıyken kalıcı bir WebSocket'i ayakta tutmaz. Konum görevi uyandığında RTDB'ye tek bir yazma yapmak, soket yeniden kurmaktan hem daha güvenilir hem daha az pil harcar.
- **Kesme sunucuda:** Paylaşım durunca ya da süresi dolunca sunucu ACL'yi kapatır ve alıcının kopyasını siler. Gönderen telefon uçak modunda olsa bile alıcı konumu en geç bir dakika içinde kaybeder.
- **Gizlilik kural seviyesinde:** Alıcı yalnızca kendi kutusunu okur. Gönderen yalnızca ACL'de aktif olan paylaşıma, izinli alanlarla yazabilir. Bunların hepsi emülatör testleriyle doğrulanıyor.
- **İşletme yükü:** Kendi soket sunucusu, ölçekleme ve oturum yönetimi gerekmez. Telefonla giriş, push ve App Check aynı platformda gelir.

Bedeli: Google'a bağımlılık ve yoğun kullanımda RTDB maliyeti. Konum yazma yolu `packages/core` içindeki paket sözleşmesine bağlı olduğu için ileride bir WebSocket katmanına geçmek, istemcide yalnızca yayıncı modülünü değiştirmeyi gerektirir.

## Durum

Faz 1–4'ün kodu hazır; birim, kural, emülatör ve uçtan uca testler geçiyor. Henüz gerçek bir Firebase projesine dağıtılmadı, gerçek Google Maps anahtarlarıyla ve gerçek cihazda denenmedi; alan adı, Apple Team ID ve imza parmak izleri yer tutucu. Faz 3'ün hareket etkinliği yerel modülü (Swift/Kotlin) bu ortamda derlenmedi ve pil tüketimi gerçek cihazda ölçülmedi. Faz 4'ün SOS bildirim davranışı (Rahatsız Etme, sessiz mod, kilit ekranı) gerçek cihazda denenmedi; iOS Critical Alerts yetkisi Apple onayı beklediği için kapalı. Sıradaki adımlar `docs/PHASES.md` içindeki geçiş listelerindedir ("Faz 3 → Faz 4" gerçek cihazda pil ölçümünü, "Faz 4 → Faz 5" SOS'un cihaz testlerini içerir).
