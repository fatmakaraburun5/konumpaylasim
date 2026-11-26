# Konum

Arkadaşlarla süreli canlı konum paylaşan iOS ve Android uygulaması. Bu depo Faz 1–8'in çalıştırılabilir kodudur: ortak çekirdek paket, Expo (React Native) mobil uygulama, Firebase backend ve QR bağlantıları için salt okunur web haritası. Faz 3 haftalık ve süresiz paylaşımlar için arka plan takibini, harekete göre pil optimizasyonunu, çevrimdışı kuyruğu ve %15 düşük pil bildirimini ekler. Faz 4 harita üzerinden tek dokunuşla "Buradayım / Yoldayım" sinyalini, konum yanına kısa durum ve yer notlarını ve tam konumlu SOS'u (basılı tut + geri sayım, acil kişiler, yüksek öncelikli bildirim, alıcıda tam ekran acil kartı) ekler. Faz 5 kayıtlı bölgeler (Ev, İş, özel nokta) için varış / ayrılış tetikleyicilerini ("Eve vardığımda bildir", "İşten çıkınca paylaşımı başlat"; GPS sapması filtresiyle) ve harita üzerinde iki ya da daha çok kişi için adil erişim süreli "Buluşma noktası" önerisini ekler. Faz 6 ana ekran ve kilit ekranı widget'larını (iOS WidgetKit, Android AppWidget + Hızlı Ayar kutucuğu; favorilerin son durumu, pili, fotoğrafı ve aktif paylaşım), favoriye tek dokunuşla 1 saatlik paylaşımı (geri sayım ve bildirimle), kamera / galeriden profil fotoğrafını ve kayıtta zorunlu cinsiyete göre pembe / mavi fotoğraf çerçevesini (liste, widget, harita pini; fotoğraf yoksa baş harfler) ekler. Faz 7 arkadaşlarla tek seferde etkinlik oylamasını (davetli katılımı, mekanı ve saati tek yanıtta işaretler, sonuçların tamamı düzenleyene düşer, düzenleyen onaylar; "Katılamayacağım" notu; 1 gün önce ve sabah 08:00 hatırlatma), özel sesli SOS alarmını, "eve girdi / yola çıktı" üst bildirimlerini, ilk açılış izin akışını ve İzin & Gizlilik Merkezi'ni, varsayılan kapalı pil paylaşımını ve haritada Açık / Koyu / Sistem görünümünü ekler. Faz 8 yönlü kişi izinlerini, görünmez modu ve Güvenlik Sözleşmesi / KVKK onayını ekler.

## Yapı

```text
konum/
  packages/core/   @konum/core: veri modelleri, süre motoru, konum paketi, paylaşım state'i,
                   callable sözleşmeleri, Türkçe biçimlendirme. Mobil ve backend aynı kodu kullanır.
  apps/mobile/     Expo SDK 58 + expo-router. Native Google Maps (açık/koyu stil, yumuşak pin), rota + ETA kartı,
                   paylaşım başlatma, süre seçimi, uzatma, QR bağlantısı ve izleyicisi (app/s/[token]),
                   arka plan konum görevi, bildirimler, arkadaşlar, ping, durum/yer notu, SOS, bölgeler ve
                   varış/ayrılış tetikleyicileri, buluşma noktası önerisi, profil fotoğrafı ve cinsiyet çerçevesi,
                   favoriler ve tek dokunuşla 1 saat. targets/widgets (iOS WidgetKit, Swift) ve
                   modules/konum-widgets (Android AppWidget + Hızlı Ayar, Kotlin; iOS App Group köprüsü).
  apps/web/        Vite + React salt okunur web haritası: https://<alan>/s/<token> (uygulaması olmayanlar için).
  backend/         Firestore + RTDB + Storage kuralları, Cloud Functions (europe-west1), Maps vekili, Hosting
                   (Universal/App Links dosyaları), emülatör testleri.
  docs/
    PHASES.md        Faz tablosu, Faz 1 → 2 … Faz 5 → 6 geçiş noktaları ve Faz 6 → yayın
    PHASE2.md        Faz 2: harita ve ETA kartı, süre yaşam döngüsü, QR token ve iptal, Maps maliyet/kota kuralları
    PHASE3.md        Faz 3: iOS/Android arka plan ve izin mimarisi, hareket × pil takip matrisi, çevrimdışı kuyruk,
                     son doğrulanmış konum, %15 düşük pil akışı, saha ve simülasyon test senaryoları
    PHASE4.md        Faz 4: ping, durum ve yer notu, SOS veri modelleri; gerçek zamanlı/push akışı; SOS acil
                     ekranı ve bildirim davranışı (iOS critical/time-sensitive, Android sos kanalı, DND);
                     yanlış tetiklemeyi önleyen UX; gizlilik kararları
    PHASE5.md        Faz 5: geofence kural modeli, bölge yönetimi, varış/ayrılış akışı (iOS CLCircularRegion,
                     Android GeofencingClient), GPS sapması filtresi, buluşma noktası hesabı (Places + Route Matrix,
                     adalet puanı, önbellek/kota), harita pin/liste ve paylaşım akışı, gizlilik
    PHASE6.md        Faz 6: widget mimarisi (iOS WidgetKit, Android AppWidget), boyut/veri sınırları ve yenileme
                     bütçesi, tek dokunuşla 1 saat akışı ve hata/izin düşüşleri, widget token güvenliği, cinsiyet
                     alanı, kamera/galeri → kırpma → sıkıştırma → önbellek, cinsiyet renkli çerçeve ve harita pini
    PHASE7.md        Faz 7: etkinlik veri modeli ve durum makinesi, hatırlatmalar, iOS/Android bildirim kanalları ve
                     SOS alarmı, ilk açılış izin akışı ve İzin & Gizlilik Merkezi, pil paylaşımı onayı, harita teması
    PHASE8.md        Faz 8: yönlü kişi izinleri, görünmez mod, Güvenlik Sözleşmesi / KVKK onay kapısı
    RELEASE_CHECKLIST.md  Altı faz için mağaza yayını kontrol listesi (imzalama, izin metinleri, arka plan konumu
                     gerekçesi, bildirimler, widget'lar, App Check, gizlilik etiketleri, hesap silme, cihaz kabulü)
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
göndersin" (tam ekran acil kartı) ve "Ayşe güvende"; kendi SOS'un için haritadaki kırmızı düğmeyi basılı tut. Faz 5 için
"FAZ 5 SENARYOLARI": "Ev bölgemi buraya kaydet", "Evden çık" (paylaşım başlar), "Eve var", "GPS sapması" (tetik yok,
gerekçe panelde), "Ayşe eve vardı" ve "Ayşe buluşma noktası önersin"; kendi önerin için Ayşe'ye dokun → "Buluşma noktası öner". Faz 6 için kayıtta cinsiyet seçilir, profilden
"Galeri" ile fotoğraf yüklenir, arkadaşlarda yıldızla favori eklenir (en çok 4); paneldeki "FAZ 6 · WIDGET'LAR" iOS ana
ekran, kilit ekranı ve Android widget'larını gösterir, "1 sa paylaş" geri sayımı ve bildirimi başlatır; "Widget oturumu
sunucuda dolsun", "'Her Zaman' konum izni kapansın", "Bağlantı kesilsin" ve "Hız sınırı dolsun" düşüşleri dener. `npm run web:export`
tek dosyalık statik sürümü `apps/mobile/dist-web/` altına üretir. Faz 7 için sağ üstteki takvimden etkinlik oluştur
(Ayşe, Mehmet ve Zeynep birkaç saniyede yanıt verip mekan önerir ve oy verir; Can "Katılamayacağım" notu bırakır), panelde
"Ayşe etkinliğe davet etsin", "Hatırlatmayı şimdi gönder" ve "Mehmet yola çıksın"; harita görünümünü haritadaki
güneş / ay düğmesinden ya da hesap menüsü > İzin ve Gizlilik'ten değiştir. Ayrıntı: `apps/mobile/README.md`.

## Testleri çalıştırma

Gerekenler: Node 22. Backend emülatörleri için Java 11 veya üstü.

```bash
# Çekirdek (221 test; Faz 3 simülasyon tablosu: npx vitest run test/simulate.test.ts)
cd packages/core && npm ci && npm test && npm run typecheck

# Mobil (211 test, 26 dosya) + yerel JS paketleri
cd apps/mobile && npm ci && npm run typecheck && npm test
EXPO_OFFLINE=1 CI=1 npx expo export --platform android --output-dir /tmp/konum-android

# Backend (221 test, 21 dosya; Auth, Firestore, RTDB, Functions ve Storage emülatörlerini açar.
# Vekil arkasındaysan emülatör trafiği vekile gitmesin: env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npm test)
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

Faz 1–6'nın kodu hazır; birim, kural, emülatör ve uçtan uca testler geçiyor. Henüz gerçek bir Firebase projesine dağıtılmadı, gerçek Google Maps anahtarlarıyla ve gerçek cihazda denenmedi; alan adı, Apple Team ID ve imza parmak izleri yer tutucu. Faz 3'ün hareket etkinliği yerel modülü (Swift/Kotlin) bu ortamda derlenmedi ve pil tüketimi gerçek cihazda ölçülmedi. Faz 4'ün SOS bildirim davranışı (Rahatsız Etme, sessiz mod, kilit ekranı) gerçek cihazda denenmedi; iOS Critical Alerts yetkisi Apple onayı beklediği için kapalı. Faz 5'in bölge algılaması (iOS `CLCircularRegion`, Android `GeofencingClient`) ve başsız paylaşım başlatma gerçek cihazda, buluşma önerisi gerçek Places / Routes anahtarıyla denenmedi. Faz 6'nın Swift widget hedefi ve Kotlin widget modülü derlenmedi (yalnızca `expo prebuild` yapılandırması doğrulandı); widget, kilit ekranı ve uygulama kapalıyken hızlı paylaşım gerçek cihazda denenmedi. Mağaza yayını öncesi her şey `docs/RELEASE_CHECKLIST.md` içinde; gerçek Firebase projesine geçiş `firebase-kurulum` dalında bekliyor. Sıradaki adımlar `docs/PHASES.md` içindeki geçiş listelerindedir ("Faz 3 → Faz 4" gerçek cihazda pil ölçümünü, "Faz 4 → Faz 5" SOS'un, "Faz 5 → Faz 6" bölge tetikleyicilerinin, "Faz 6 → yayın" widget'ların cihaz testlerini içerir).
