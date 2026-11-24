# Fazlar ve geçiş noktaları

Her faz bir öncekinin sözleşmelerini (packages/core) **genişletir**, değiştirmez. Yeni alanlar eklenir, mevcut alanların anlamı değişmez.

| Faz | Kapsam | Durum |
| --- | --- | --- |
| 1 | Çekirdek konum, süre ve uzatma, temel harita, kimlik ve arkadaşlık | Kod iskeleti hazır, cihazda deneme bekliyor |
| 2 | Native Google Maps (stil, yumuşak pin, rota + ETA kartı, adres), QR/token ile paylaşım, salt okunur web haritası, Universal/App Links, anında iptal, Maps maliyet koruması | Kod hazır, emülatörde uçtan uca kabul testi geçti (59/59); gerçek proje ve cihazda deneme bekliyor. Ayrıntı: [`PHASE2.md`](PHASE2.md) |
| 3 | Arka plan takibi (iOS Always / Android FGS, kademeli izin akışı), hareket sensörüne göre GPS ve gönderim matrisi, uyku çiti, çevrimdışı kuyruk + `live_trail`, son doğrulanmış konum, %15 düşük pil bildirimi, duraksama bekçisi | Kod hazır, emülatörde uçtan uca kabul testi geçti (57/57); yerel modül (Swift/Kotlin) derlenmedi, gerçek cihazda pil ölçümü bekliyor. Ayrıntı: [`PHASE3.md`](PHASE3.md) |
| 4 | Kilit ve ana ekran widget'ları, favoriye tek dokunuşla 1 saat, buluşma noktası, SOS | Planlandı (ETA Faz 2'ye alındı) |

## Faz 1 → Faz 2 geçiş noktası

Faz 2'ye geçmeden önce Faz 1'in cihazda doğrulanması gerekir. Bu adımlar senin hesaplarınla yapılır:

- [ ] Firebase geliştirme projesi aç (Blaze plan, bölge `europe-west1`), Phone Auth, Firestore, Realtime Database, Functions ve App Check'i etkinleştir.
- [ ] `google-services.json` ve `GoogleService-Info.plist` dosyalarını `apps/mobile/firebase/` altına koy.
- [ ] Google Maps SDK for iOS ve Android anahtarlarını `.env` dosyasına yaz.
- [ ] `backend/` altında kuralları ve fonksiyonları geliştirme projesine dağıt.
- [ ] iOS ve Android'de development build kur; iki hesapla 1 saatlik paylaşım başlat, ekran kapalı 30 dakika bekle, konumun aktığını ve "Durdur" sonrası kesildiğini gör.
- [ ] Süre dolumunu gönderen telefon uçak modundayken dene: alıcıda konum en geç 1 dakika içinde kaybolmalı (zamanlayıcı dakikalık çalışır).

## Faz 2 (uygulandı)

Tasarım, veri sözleşmeleri, yaşam döngüsü ve maliyet kuralları [`PHASE2.md`](PHASE2.md) dosyasındadır. Özet:

| Parça | Ne yapıldı |
| --- | --- |
| Token | Sunucuda 32 bayt rastgele (256 bit), base64url 43 karakter. QR: `https://<alan-adı>/s/<token>`. Sunucuda yalnızca SHA-256 özeti (`token_hash`); düz token yalnızca oluşturma yanıtında, cihazda SecureStore'da. |
| Firestore | `link_shares/{link_id}`: gönderen, oturum, `token_hash`, durum, süre, `version`. Yalnızca gönderen okur, istemci yazamaz. Maps: `route_cache`, `geocode_cache`, `maps_quota`, `maps_budget`, `config/maps` (istemciye kapalı). |
| RTDB | `link_acl/{token_hash}` (istemciye kapalı ayna, bitişte mezar taşı) ve `link_live/{token_hash}` (gönderen yazar, token'ı bilen ACL aktif ve süresi dolmamışken okur; yalnızca `LINK_LIVE_FIELDS`). |
| Anında iptal | `link_share_stop`: Firestore commit → ACL mezar taşı → `link_live` silinir, hepsi çağrı dönmeden. Açık web sekmesi ≈ 1,2 sn'de (emülatör) "Paylaşım sona erdi" gösterir, pin kalkar. |
| Web haritası | `apps/web`: Vite + React, salt okunur, kimliksiz `link_live/{hash}` dinler; Google Maps JS yalnızca anahtar varsa ve ilk canlı konumda yüklenir, yoksa vektör yedek görünüm. |
| Uygulama bağlantısı | iOS Associated Domains, Android App Links (`autoVerify`), `app/s/[token].tsx`. Kurulu değilse Hosting `/s/**` → web haritası. |
| QR süreleri | 15 dk, 1 saat, 8 saat, gün sonuna kadar, 1 hafta, süresiz (`LINK_DURATION_OPTIONS`); Faz 1 süre motoru ve +30 dk / +1 saat uzatması. |
| Harita | Native Google Maps SDK (iOS + Android), açık/koyu JSON stil, core `markerTransition` ile yumuşak pin, Routes API ile rota çizgisi + ETA/mesafe kartı, önbellekli ters geocode; Google çağrıları yalnızca sunucu vekilinden (`route_compute`, `geocode_reverse`). |

Faz 2 kabul testleri: yanlış token okuyamaz ✓; durdurunca açık web sekmesi 2 saniye içinde boşalır ✓; süre dolunca
okuma reddedilir ✓ (hepsi `apps/web/e2e/emulator.cjs`, gerçek emülatörler); QR'ı okutan cihazda uygulama kuruluysa
uygulama içinde açılır: gerçek alan adı ve cihaz gerektirir (aşağıdaki geçiş listesi).

## Faz 2 → Faz 3 geçiş noktası

Faz 3'e geçmeden önce Faz 2 gerçek projede ve cihazda doğrulanmalı. Bu adımlar senin hesaplarınla yapılır
(Faz 1 → Faz 2 listesi önkoşuldur):

**Alan adı ve uygulama kimlikleri**
- [ ] Bağlantı alan adını al (ör. `konum.<alan>`), Firebase Hosting'e bağla (özel alan + SSL).
- [ ] Aynı değeri üç yerde ver: mobil `.env` `LINK_DOMAIN`, Functions `functions/.env.<proje>` `LINK_DOMAIN`, web derlemesi
      (Hosting aynı alanda). Geçersiz/eksik değerde üretim derlemesi durur ya da uyarır.
- [ ] Gerçek paket kimliğini belirle (`com.example.konum` yer tutucu): `app.config.ts` `BUNDLE_ID`, AASA, assetlinks.
- [ ] Apple Developer Team ID: `backend/hosting/public/.well-known/apple-app-site-association` → `appIDs: ["<TEAM_ID>.<BUNDLE_ID>"]`;
      App ID'de Associated Domains yeteneğini aç.
- [ ] Android imza SHA-256 parmak izleri (debug, upload ve Play App Signing anahtarı):
      `assetlinks.json` → `sha256_cert_fingerprints`. Maps SDK Android anahtarı için aynı anahtarların SHA-1'leri.

**Anahtarlar ve kotalar** (bkz. `PHASE2.md` §4.6)
- [ ] Google Maps anahtarları: iOS (Maps SDK for iOS + paket kimliği), Android (Maps SDK for Android + paket adı/SHA-1),
      web (Maps JavaScript API + `https://<alan>/*` referrer) → `VITE_GOOGLE_MAPS_WEB_KEY`, sunucu (Routes + Geocoding)
      → `firebase functions:secrets:set GOOGLE_MAPS_SERVER_KEY`.
- [ ] Routes API ve Geocoding API'yi etkinleştir; Places/Directions/Static/Street View kapalı kalsın.
- [ ] Cloud Console API kota tavanları ve faturalandırma bütçe uyarıları (%50 / %90 / %100); `MAPS_DAILY_BUDGET`
      ya da Firestore `config/maps` ile proje bütçesi.
- [ ] RTDB App Check zorlaması açılacaksa web görüntüleyicisine reCAPTCHA Enterprise App Check ekle.

**Dağıtım**
- [ ] `firestore.rules`, `firestore.indexes.json` (bileşik dizinler + TTL), `database.rules.json`, Functions (yeni callable'lar,
      `link_acl_reconciler`, `shareexpirytask` kuyruğu) dağıt.
- [ ] Web: `apps/web/.env.production` (`VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_DATABASE_URL`, isteğe bağlı
      `VITE_GOOGLE_MAPS_WEB_KEY`, mağaza adresleri) → `npm run build` → `firebase deploy --only hosting`
      (predeploy `hosting/assemble.mjs`). Hosting istek günlüklerini dışa aktarıyorsan `/s/` yolunu dışla.
- [ ] `https://<alan>/.well-known/apple-app-site-association` ve `/.well-known/assetlinks.json` `200` + `application/json`
      dönüyor mu; Google "Statement List Tester" ve Apple AASA doğrulaması.

**Cihaz testleri** (iOS + Android development build; yeni yerel bağımlılıklar: expo-secure-store, expo-clipboard,
react-native-qrcode-svg)
- [ ] Uygulama kurulu telefonda QR'ı kamera ile okut: uygulama içi canlı harita açılmalı (iOS Universal Link, Android
      App Link doğrulanmış; Android'de `adb shell pm get-app-links <paket>` "verified").
- [ ] Uygulama kurulu olmayan telefonda aynı QR: tarayıcıda salt okunur harita; "Uygulamada aç" ve mağaza rozetleri.
- [ ] "Paylaşımı durdur": açık web sekmesi ve uygulama içi izleyici 2 sn içinde "Paylaşım sona erdi"; pin kalkar.
- [ ] 15 dk bağlantı: bitişe 3 dk kala bildirim, bildirimden "+30 dakika" (uygulama kapalıyken) → bitiş 30 dk ileri.
- [ ] Gönderen uçak modundayken süre dolumu: web sekmesi bitişte kapanır, sunucu belgeyi kapatır.
- [ ] Haritada arkadaşa dokun: rota çizgisi, "dk · km", adres; Yürüyüş/Bisiklet; Google iOS'ta pin kayması akıcı mı.
- [ ] Açık/koyu tema geçişinde harita stili; Cloud Console'da harita yükleme, Routes ve Geocoding sayılarının beklenen
      düzeyde kaldığını gör (önbellek isabeti, görünürlük kuralı).

## Faz 3 (uygulandı)

Mimari, matris, kuyruk, düşük pil akışı ve test senaryoları [`PHASE3.md`](PHASE3.md) dosyasındadır. Özet:

| Parça | Ne yapıldı |
| --- | --- |
| Arka plan | iOS `UIBackgroundModes` location + remote-notification, "Uygulamayı Kullanırken" → bağlamda "Her Zaman" yükseltmesi, mavi gösterge, `pausesUpdatesAutomatically: false`; Android COARSE/FINE/BACKGROUND, `foregroundServiceType="location"` kalıcı bildirim ("Konumun paylaşılıyor · Süresiz"), Android 10/11+/13/14 kuralları. |
| İzin akışı | core `nextPermissionStep`: yalnızca gerektiğinde, oturumda bir kez, 7 gün "Şimdi değil", sistem penceresinden önce açıklama; pil optimizasyonu ipucu yalnızca Android + haftalık/süresiz; paylaşım ön plan izniyle başlar. |
| Hareket | core `motionReducer` (OS etkinliği + hız + yer değiştirme, histerezis) → `selectTrackingPlan` (`TRACKING_MATRIX` hareket × ön/arka × pil). Hareketsizken GPS kapalı, 100–150 m uyku çiti, hb 15 dk. Araçta 5 sn / 50 m, gönderim ≥ 10 sn, hb 2 dk. |
| Çevrimdışı | SQLite kuyruk (≤ 2000 nokta, sıkıştırma, 24 sa), bağlantı gelince canlıya `q: 1` + `recorded_at`, tüm noktalar `live_trail/{receiver}/{share_id}/{point_id}` (≤ 200 yollu partiler); durdurma/bitişte kuyruk ve iz silinir. |
| Alıcı | core `lastVerifiedLocation` + `receiverStatusOf` (hb'ye göre): "Son doğrulanmış konum · 14:05 · %42", "Bağlantısı kopmuş olabilir", "Çevrimdışıyken kaydedilen 12 nokta eşitlendi", kesikli iz; web görüntüleyici aynı metinler. |
| Düşük pil | Oturum başına %15'te bir kez `battery_low_notify` → FCM "Ayşe'nin pili azaldı" / "Pil %14. Konum daha seyrek güncellenecek."; ≥ %20 ya da şarjda yeniden kurulur, 30 dk tak-çıkar koruması, sunucuda 6/24 sa tavanı. |
| Bekçi | `share_stall_watchdog` (15 dk): uzun paylaşım `max(4·hb, 45 dk)` sessizse önce sessiz `resume_tracking`, 30 dk sonra görünür bildirim; 24 sa'ten eski iz budanır. |

Faz 3 kabul testleri (`apps/web/e2e/faz3/run-faz3.sh`, gerçek emülatörler, 57 denetim): pakette hb ✓; 12 noktalık
çevrimdışı kuyruk 3 yazmayla boşalır, alıcı `q`/`recorded_at`/iz okur ✓; 2100 → 1100 sıkıştırma, 6 parti ✓; durdurma
canlı + izi siler, geç boşaltma reddedilir ✓; pil 16 → 14 → 13 → 21: bir bildirim, bir yeniden kurma ✓; duraksamış
süresiz paylaşım sessiz → görünür dürtülür ✓; web görüntüleyici gerçek `q: 1` paketini "Bağlantı geri geldi" ile gösterir ✓.

## Faz 3 → Faz 4 geçiş noktası

Faz 4'e geçmeden önce Faz 3 gerçek cihazda doğrulanmalı (Faz 2 → Faz 3 listesi önkoşuldur). Senaryo ayrıntıları ve
sayısal ölçütler: [`PHASE3.md`](PHASE3.md) §4.3.

**Derleme ve yerel kod**
- [ ] `modules/konum-activity` iOS (Swift, `CMMotionActivityManager`) ve Android (Kotlin, Activity Recognition
      Transition, `play-services-location`) development build'de derlensin; `KONUM_ACTIVITY_RECOGNITION=0` ile kapalı
      derleme de denensin.
- [ ] Yeni yerel bağımlılık: `expo-sqlite` (kuyruk). iOS'ta kuyruk dosyası yedekten hariç tutulsun (Faz 3.1).
- [ ] Android: expo-location FGS'nin arka planda yeniden yapılandırılamaması için yama ya da kendi FGS kararı
      (`PHASE3.md` §1.3 "Bilinen sınır").

**Dağıtım**
- [ ] `database.rules.json` (`live_trail`, `q` alt sınırları), `firestore.indexes.json` (yeni dizinler, `battery_alerts.purge_at`
      TTL), Functions (`battery_low_notify`, `share_stall_watchdog`) dağıtılsın.
- [ ] iOS: APNs anahtarı Firebase'e yüklü; `remote-notification` arka plan modu ve `content-available` push'u gerçek
      cihazda uyandırıyor mu; Android bildirim kanalı `share_status`.

**Gerçek cihazda pil ölçümü** (her biri iOS + en az iki Android üreticisi, ör. Pixel + Samsung/Xiaomi)
- [ ] S1 masada 2 sa: Android `dumpsys batterystats` GPS süresi ≤ %5, tüketim ≤ %2/sa [Varsayım]; iOS Energy Log "Low".
- [ ] S4 haftalık 7 gün gerçek kullanım: paylaşıma atfedilen tüketim ≤ %10/gün [Varsayım], gönderim ≤ 35/sa,
      "gecikiyor" süresi ≤ %1.
- [ ] Araçta 1 sa (S2 olmadan): tüketim ve doğruluk; matris eşiklerinin (`MOTION_THRESHOLDS`, `TRACKING_MATRIX`) ölçümle
      ayarlanması ve `[Varsayım]` işaretlerinin kaldırılması.
- [ ] Sonuçlar `docs/PHASE3.md` §4.2 simülasyon tablosunun yanına "ölçülen" sütunu olarak eklenir.

**Dayanıklılık senaryoları**
- [ ] S2 tünel/internet kesintisi, S3 %15 pil (`adb shell dumpsys battery set level 14`), S5 yeniden başlatma, S6 zorla
      kapatma, S7 Doze (`adb shell dumpsys deviceidle force-idle`), S8 uçak modu, S9 izin düşürme: hepsi geçmeli.
- [ ] Üretici pil yöneticileri (Xiaomi otomatik başlatma, Samsung "Uyuyan uygulamalar", Huawei) ile 24 sa süresiz paylaşım.

**Mağaza**
- [ ] Play Console "Arka planda konum erişimi" beyanı + video; belirgin açıklama metninin Play ifadesiyle
      ("uygulama kapalıyken veya kullanılmıyorken de") güncellenmesi; Data Safety formu.
- [ ] App Store inceleme notu (arka plan konum gerekçesi, demo hesap, ekran kaydı).
