# Fazlar ve geçiş noktaları

Her faz bir öncekinin sözleşmelerini (packages/core) **genişletir**, değiştirmez. Yeni alanlar eklenir, mevcut alanların anlamı değişmez. **İstisna: Faz 8** etkileşim koşullarını bilinçli olarak **daraltır** (arkadaşlık artık hiçbir etkileşim için yeterli değil; yönlü izin, görünmez mod ve onay kapısı gerekir).

| Faz | Kapsam | Durum |
| --- | --- | --- |
| 1 | Çekirdek konum, süre ve uzatma, temel harita, kimlik ve arkadaşlık | Kod iskeleti hazır, cihazda deneme bekliyor |
| 2 | Native Google Maps (stil, yumuşak pin, rota + ETA kartı, adres), QR/token ile paylaşım, salt okunur web haritası, Universal/App Links, anında iptal, Maps maliyet koruması | Kod hazır, emülatörde uçtan uca kabul testi geçti (59/59); gerçek proje ve cihazda deneme bekliyor. Ayrıntı: [`PHASE2.md`](PHASE2.md) |
| 3 | Arka plan takibi (iOS Always / Android FGS, kademeli izin akışı), hareket sensörüne göre GPS ve gönderim matrisi, uyku çiti, çevrimdışı kuyruk + `live_trail`, son doğrulanmış konum, %15 düşük pil bildirimi, duraksama bekçisi | Kod hazır, emülatörde uçtan uca kabul testi geçti (57/57); yerel modül (Swift/Kotlin) derlenmedi, gerçek cihazda pil ölçümü bekliyor. Ayrıntı: [`PHASE3.md`](PHASE3.md) |
| 4 | Tek dokunuşla "Buradayım / Yoldayım" ping'i, konum yanına kısa durum notu ve yer notu, tam konumlu SOS (basılı tut + geri sayım, acil kişiler, yüksek öncelikli push, alıcıda tam ekran acil kartı) | Kod hazır; birim, kural ve emülatör testleri geçti, tarayıcı demosunda uçtan uca çalışıyor; gerçek cihazda bildirim davranışı ve Apple Critical Alerts onayı bekliyor. Ayrıntı: [`PHASE4.md`](PHASE4.md) |
| 5 | Varış / ayrılış tetikleyicileri (Ev, İş, özel bölgeler; iOS `CLCircularRegion` / Android `GeofencingClient`; "vardığımda bildir", "çıkınca paylaşımı başlat"; GPS sapması filtresi), harita üzerinde "Buluşma noktası" önerisi (orta nokta / adil erişim süresi, Places + Route Matrix, numaralı pinler, paylaşım ve alıcı kartı) | Kod hazır; birim, kural ve emülatör testleri geçti, tarayıcı demosunda uçtan uca çalışıyor; gerçek cihazda bölge algılama ve gerçek Places / Routes anahtarı bekliyor. Ayrıntı: [`PHASE5.md`](PHASE5.md) |
| 6 | Ana ekran ve kilit ekranı widget'ları (iOS WidgetKit, Android AppWidget + Hızlı Ayar kutucuğu), favoriye tek dokunuşla 1 saatlik paylaşım (widget token'ı, arka plan tetiği, geri sayım + bildirim), kamera / galeriden profil fotoğrafı (kırpma, sıkıştırma, önbellek), kayıtta zorunlu cinsiyet ve cinsiyet renkli çerçeve (liste, widget, harita pini, baş harf yedeği) | Kod hazır; birim, kural (Firestore + Storage) ve emülatör testleri geçti, tarayıcı demosunda uçtan uca çalışıyor; Swift / Kotlin widget kodu derlenmedi, gerçek cihazda widget ve kilit ekranı davranışı bekliyor. Ayrıntı: [`PHASE6.md`](PHASE6.md), yayın listesi: [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) |
| 7 | Etkinlik Alanı (tek seferde oylama: davetli katılımı, mekanı (1–3) ve saati (1–4) tek yanıtta işaretler, sonuçların tamamı düzenleyene düşer, düzenleyen onaylar; 300 karakterlik "Katılamayacağım" notu; davet anında, hatırlatma 1 gün önce ve sabah 08:00), bildirim mimarisi (özel sesli SOS alarm kanalı, "eve girdi / yola çıktı" heads-up), ilk açılış izin akışı ve İzin & Gizlilik Merkezi, varsayılan kapalı pil paylaşımı, harita Açık / Koyu / Sistem | Kod hazır; birim, kural ve emülatör testleri geçti, tarayıcı demosunda uçtan uca çalışıyor; gerçek cihazda bildirim kanalları, alarm sesi ve hatırlatma saatleri bekliyor. Ayrıntı: [`PHASE7.md`](PHASE7.md) |
| 8 | Yönlü kişi izinleri (`permission_grants`: konumu görme, ping, varış bildirimi, buluşma daveti, SOS; arkadaşlık izin değil, varsayılan kapalı), izin isteği / onayı / geri alma zincirleri, sunucuda zorlanan görünmez mod (seçmeli geri yükleme), Güvenlik Sözleşmesi ve KVKK aydınlatma / açık rıza onay kapısı (kaydırma şartı, sürüm + SHA-256 kaydı, geri çekme) | Kod hazır; birim, kural ve emülatör testleri geçti, tarayıcı demosunda uçtan uca çalışıyor; KVKK metni hukuk incelemesi, gerçek cihazda deneme ve eski arkadaşlıklar için izin göçü bekliyor. Ayrıntı: [`PHASE8.md`](PHASE8.md) |
| 9 | Tek kullanımlık anlık kamera fotoğrafı (yalnızca uygulama içi kamera, galeri kapalı; pine ve kişi kartına eklenir, kalan süre görünür, 1 saat sonra sunucudan ve önbelleklerden silinir), hedefe 200 m yaklaşınca tek seferlik "Neredeyse vardım (1 dk)" bildirimi ve harita durumu, Güvenli Dönüş / gece takip modu (15/30/45/60 dk + hedef; son uyarı geri sayımı, uygulama kapalıyken sunucu zamanlayıcısıyla acil kişilere SOS: son doğrulanmış konum + pil), Rehber ve SMS izinleri (ilk açılış v2, KVKK metni `2026-11-26`, Gizlilik Merkezi) ve internetsiz SOS için hazır dolu SMS yedeği (expo-sms / Android SMS intent, `SEND_SMS` yok) | Kod hazır; birim, kural ve emülatör testleri geçti, tarayıcı demosunda uçtan uca çalışıyor (Playwright 40 denetim); gerçek cihazda kamera, arka planda yaklaşma, uygulama kapalıyken alarm, SMS uygulaması ve `storage.lifecycle.json`'un kovaya uygulanması bekliyor. Ayrıntı: [`PHASE9.md`](PHASE9.md) |

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

**Faz 4 için erken başlatılacaklar** (onay süreleri uzun)
- [ ] Apple'a Critical Alerts yetkisi başvurusu (`PHASE4.md` §3.4). Onay gelmeden SOS iOS'ta `time-sensitive` kalır,
      sessiz modda ses çalmaz.
- [ ] APNs anahtarının Firebase'de yüklü olduğu ve iOS'ta "Time Sensitive Notifications" yeteneğinin App ID'de açık
      olduğu doğrulansın.

## Faz 4 (uygulandı)

Veri modelleri, iletim akışı, SOS bildirim davranışı ve UX gerekçesi [`PHASE4.md`](PHASE4.md) dosyasındadır. Özet:

| Parça | Ne yapıldı |
| --- | --- |
| Ping | `ping_send` → RTDB `ping_inbox/{to}/{ping_id}` (yalnızca alıcı okur/siler, 15 dk) + koordinatsız push (kanal `ping`). Alıcıda üstte kayan kart, pinde 8 sn nabız, canlı pini yoksa geçici ping pini. 20 sn çift soğuma, saatte 30. |
| Durum notu | Sunucuda belge yok: canlı pakete `note` + `note_exp` (kural: ikisi birlikte, ≤ 60 karakter). Yalnızca arkadaş paketleri, QR'a gitmez. Pin altında balon, EtaCard'da satır. |
| Yer notu | Firestore `place_notes` (callable yazar; sahibi ve `visible_to` okur, ≤ 20 kişi, ≤ 20 aktif not, 30 dk – 1 hafta, TTL). Not pini + alt kart, sahibine Düzenle/Sil. |
| SOS | `sos_send/update/resolve/ack`, Firestore `sos_alerts` (tam koordinat + doğruluk, adres, harita bağlantısı, pil, rota/ETA, acks). Acil kişiler `users/{uid}.emergency_contacts` (≤ 5 arkadaş). Aktifken 15 sn'de bir konum tazeleme, 24 sa'te zaman aşımı. |
| Bildirim | Android `sos` kanalı (MAX, DND aşımı, kilit ekranında açık, alarm sesi), iOS `time-sensitive` (yetki gelince `critical`), aynı `tag`/`collapse-id` ile "güvende" bildirimi alarmın yerine geçer; soğuk açılışta karta yönlendirme. |
| UX | Basılı tut 1,5 sn → 5 sn geri sayım ("İptal" / "Hemen gönder") → gönder; erken bırakmada ipucu; ekran okuyucu eylemi doğrudan geri sayım; geri sayım sırasında GPS ölçümü önceden başlar. |

Faz 4 kabul ölçütleri (bu depoda): ping konumu yalnızca alıcı kutusuna gider, push'ta koordinat yok ✓; pakette not
`note_exp`'siz reddedilir ✓; başkasının yer notu düzenlenemez/silinemez ✓; acil kişi yokken SOS reddedilir ✓; aktif
SOS'a tekrar basmak aynı uyarıyı tazeler ✓; arkadaşlık bitince kişi acil listeden düşer ✓ (emülatör testleri);
tarayıcı demosunda ping → not → SOS gönder/gör/güvende akışları ✓ (Playwright, 18 denetim).

## Faz 4 → Faz 5 geçiş noktası

Faz 5'e geçmeden önce Faz 4 gerçek cihazda doğrulanmalı (Faz 3 → Faz 4 listesi önkoşuldur). Senaryolar:
[`PHASE4.md`](PHASE4.md) §6.1.

**Dağıtım**
- [ ] `database.rules.json` (`ping_inbox`, `ping_expiry`, pakette `note`/`note_exp`), `firestore.rules` (`place_notes`,
      `sos_alerts`), `firestore.indexes.json` (yeni bileşik dizinler, `place_notes.purge_at` ve `sos_alerts.purge_at`
      TTL) ve 8 yeni callable dağıtılsın. `sos_send` / `sos_update` Maps sunucu anahtarı sırrını kullanır.
- [ ] iOS: App ID'de Time Sensitive Notifications; Critical Alerts onayı geldiyse mobil `IOS_CRITICAL_ALERTS=1` ve
      Functions `SOS_CRITICAL_ALERTS=1` **birlikte** açılsın.

**Cihaz testleri** (iOS + en az iki Android üreticisi)
- [ ] Kilitli telefonda, Odak/Rahatsız Etme açıkken SOS: kilit ekranında başlık + adres, dokununca tam ekran kart.
- [ ] Sessiz modda SOS: iOS titreşim (critical ile ses), Android alarm sesi. Android'de "Rahatsız Etme erişimi" verilmiş
      ve verilmemiş iki durum.
- [ ] Uygulama kapalıyken (kaydırılarak) SOS ve ping bildirimine dokunma → soğuk açılışta doğru ekran.
- [ ] GPS kapalı / uçak modunda SOS: en geç ~8 sn'de son bilinen konumla gider, ağ gelince tek uyarı; alıcıda
      "eski konum" uyarısı.
- [ ] Ping ve not pinlerinde native harita performansı (nabız halkası çok pinle).

**Ürün kararları** (`[Varsayım]`'ların kaldırılması)
- [ ] SOS ile otomatik 1 saatlik canlı paylaşım, SOS push gövdesinde adres, hesap silmede alıcıya bildirim gitmemesi.
- [ ] Android "Rahatsız Etme erişimi" adımı ve gerekirse tam ekran bildirimi (`USE_FULL_SCREEN_INTENT`, Play politikası).
- [ ] App Store inceleme notuna SOS'un ne yaptığı ve acil servis yerine geçmediği ("112'yi ara" düğmesi) yazılsın.

**Faz 5 için ek notlar** (Faz 5 kodu bu listeyi beklemeden yazıldı; cihaz testleri Faz 4 dağıtımının üstüne kurulur)
- [ ] Faz 5 bölge bildirimleri Faz 4'ün `ping` kanalını (Android) ve `active` kesinti düzeyini (iOS) kullanır: Faz 4
      kanal kurulumu cihazda doğrulanmadan Faz 5 bildirim testi anlamlı değildir.
- [ ] Faz 3 "Her zaman" / `ACCESS_BACKGROUND_LOCATION` izin akışı cihazda geçmiş olmalı (bölge izleme aynı izni ister).
- [ ] Google Cloud projesinde **Places API (New)** açılsın ve Maps sunucu anahtarına `places.googleapis.com` +
      `routes.googleapis.com` (Route Matrix) kısıtı eklensin; Faz 2 bütçe uyarılarına Places SKU'su eklensin.

## Faz 5 (uygulandı)

Kural modeli, tetikleme akışı, GPS sapması filtresi, buluşma hesabı ve gizlilik kararları [`PHASE5.md`](PHASE5.md)
dosyasındadır. Özet:

| Parça | Ne yapıldı |
| --- | --- |
| Bölgeler | Firestore `users/{uid}/zones` (YALNIZCA sahibi okur, `zone_upsert` / `zone_delete` yazar): tür, ad, merkez, 100 m – 2 km yarıçap, ≤ 6 kural; en çok 15 bölge (iOS 20 sınırı − uyku çiti). Bölgelerim ekranı, haritada artı işaretli düzenleyici ve yarıçap dairesi, kural sayfası (şablon, ≤ 10 alıcı, süre, gün, saat aralığı). |
| Tetikleme | Cihazda OS bölge olayı (görev `konum-zone-geofence`) → taze konum → `zoneFilterReduce` → `zone_event_report` (koordinatsız, kalıcı kuyruk, aynı `op_id`) → sunucu: bayat / kapalı / kural saati / 5 dk soğuma / 60 olay/gün → notify push (`zone_event`, yalnızca bölge adı) ve yanıtta `start_share` → cihaz `share_start`. |
| GPS sapması | Doğruluk kapısı, histerezis (gri bant), 2 güvenli örnek ≥ 20 sn ya da bekleme, ışınlanma reddi (> 70 m/sn), ters geçiş için 3 dk, aynı yön 10 dk, ilk durum tetiksiz, uzaklaşınca (R + 1 km) hızlı onay. |
| Buluşma noktası | `meetup_suggest`: merkez (orta nokta / geometrik medyan), arama yarıçapı yayılım/4 (300 m – 3 km), Places Nearby (dar alan maskesi), mod başına Route Matrix (K = 5), adalet puanı `max + 0,5 × (max − min)`, yedek orta nokta + kuş uçuşu ETA, 10 dk kullanıcıya özel önbellek, günde 30 sorgu. `meetup_share/respond/cancel` + `meetups` (öneren ve alıcılar okur, 12 sa). |
| Harita | Numaralı öneri pinleri, orta nokta, seçili öneriye kesikli çizgiler, benim rotam; alıcı kartında herkesin ETA'sı, canlı ETA, "Yol tarifi", "Geliyorum / Uyamam"; öneren kartında yanıtlar ve iptal. |

Faz 5 kabul ölçütleri (bu depoda): bölge koordinatı kural alıcısına bile okunmaz ✓; push ve olay kaydı koordinat
taşımaz ✓; arkadaş olmayan alıcı sessizce düşer ✓; tekrar `op_id` yeni push üretmez ✓; soğuma ve bayat olay bastırılır ✓;
buluşma yedekleri (too_close / too_far / places_unavailable / quota_exceeded / no_results) ✓ (emülatör testleri);
GPS sapmasında tetik yok, gerçek çıkışta paylaşım başlar, arkadaşın varış bildirimi, buluşma önerisi → alıcı kartı ✓
(tarayıcı demosu, Playwright 23 denetim).

## Faz 5 → Faz 6 geçiş noktası

Faz 6'ya geçmeden önce Faz 5 gerçek cihazda doğrulanmalı (Faz 4 → Faz 5 listesi önkoşuldur). Senaryolar:
[`PHASE5.md`](PHASE5.md) §7.1.

**Dağıtım**
- [ ] `firestore.rules` (`users/{uid}/zones`, `users/{uid}/zone_events`, `meetups`), `firestore.indexes.json` (4 TTL:
      `zone_events.purge_at`, `zone_cooldowns.purge_at`, `meetups.purge_at`, `meetup_cache.expire_at`) ve 7 yeni callable
      dağıtılsın. `meetup_suggest` Maps sunucu anahtarı sırrını kullanır.
- [ ] Places API (New) + Routes API gerçek anahtarla bir kez denensin: `MEETUP_CATEGORY_TYPES` türleri geçerli mi,
      faturada Nearby Search **Pro** ve Route Matrix öğe sayısı beklenenle aynı mı (`PHASE5.md` §4.1).

**Cihaz testleri** (iOS + en az iki Android üreticisi)
- [ ] Uygulama kapalıyken (sistemce ve kullanıcı tarafından) evden çıkış / eve varış: alıcıda bildirim, "Çıkınca
      paylaş" kuralında paylaşımın başlaması (Android 12+ ön plan servisi istisnası).
- [ ] Kapalı alanda 2 saat sabit telefon: sıfır yanlış tetik. Sınırdaki otoparkta bir gün: en çok bir çıkış + bir varış.
- [ ] iOS: 15 bölge + aktif paylaşımın uyku çiti birlikte (20 bölge sınırı); uyku çitinin bölge görevine alınması.
- [ ] Arka plan süresi: OS olayından sonra ikinci taze ölçüm (≤ 25 sn) iOS'ta kesiliyor mu?
- [ ] Native harita: düzenleyicide harita kaydırma ile merkez seçimi, daire / numaralı pin / kesikli çizgi çizimi.

**Ürün kararları** (`[Varsayım]`'ların kaldırılması)
- [ ] Bölge koordinatının yalnızca sahibinde kalması ve push'ta yalnızca bölge adı; buluşma hesabı için arkadaş
      konumunun sunucuya ve Google'a gitmesi (gizlilik metni / Data Safety formu).
- [ ] Soğuma (5 dk), günlük sınır (60), buluşma kotası (30/gün), varsayılan mod (≤ 2 km Yürüyüş), alıcıların birbirini
      görmesi, iptalde alıcıya push gitmemesi.
- [ ] Arkadaşlık bitince aktif buluşma önerisinin iptal edilmesi; proje geneli buluşma bütçe sayacı.

**Faz 6 için ek notlar** (Faz 6 kodu bu listeyi beklemeden yazıldı; cihaz testleri Faz 5 dağıtımının üstüne kurulur)
- [ ] Widget'tan başlatılan paylaşımın uygulama kapalıyken takibe dönmesi Faz 3 `resume_tracking` sessiz push'una
      dayanır: Faz 3 arka plan kabulü cihazda geçmeden Faz 6 "uygulama kapalıyken widget" senaryosu anlamlı değildir.
- [ ] Apple Developer hesabında App Group (`group.${BUNDLE_ID}`) ve widget uzantısı kimliği (`${BUNDLE_ID}.widgets`)
      açılsın; aynı imza ekibiyle uygulama + uzantı profilleri üretilsin (anahtarlık erişim grubu ortak).

## Faz 6 (uygulandı)

Widget mimarisi, sınırlar, yenileme bütçesi, hızlı paylaşım akışı ve düşüşleri, fotoğraf hattı ve çerçeve kararları
[`PHASE6.md`](PHASE6.md) dosyasındadır. Özet:

| Parça | Ne yapıldı |
| --- | --- |
| Widget verisi | Uygulama tek bir anlık görüntü JSON'u yazar (`konum.widget.snapshot.v1`, ≤ 16 KB, en çok 4 favori, `favorites_set`; iOS App Group `UserDefaults`, Android `SharedPreferences "konum_widgets"`), widget yalnızca okur. `widgetSyncDecision`: yazma ≥ 60 sn, zaman çizelgesi yenileme ≥ 5 dk (büyük değişiklikte hemen). Kilit ekranı ayrıntısı (yer adı / pil) kullanıcı ayarıyla, varsayılan kapalı. |
| iOS | `targets/widgets` (`@bacons/apple-targets`, iOS 17.0): systemSmall / systemMedium + accessoryCircular / Rectangular / Inline; favori seçici (`AppIntentConfiguration`), `StartQuickShareIntent` (`.requiresAuthentication`), geri sayım `Text(timerInterval:)`. App Group ve anahtarlık erişim grubu `group.${BUNDLE_ID}`'den türetilir. |
| Android | `AppWidgetProvider` + RemoteViews (2x2, 4x2), `Chronometer` geri sayımı, `QuickShareReceiver` (`goAsync`, `exported=false`), Hızlı Ayar kutucuğu (`unlockAndRun`), WorkManager 30 dk yenileme, token AndroidKeyStore AES-GCM ile şifreli. |
| Tek dokunuşla 1 saat | Widget token'ı (32 bayt, sunucuda yalnızca `widget_tokens/{sha256}`, 30 gün, saatte 6 çağrı) → `widget_quick_share` (oturumsuz callable, App Check'siz; token `widget_token_issue` / `widget_token_revoke` ile yönetilir) → `quickShareExpiry` (started / extended / already_active) → `quick_share_started` push (görünür, iOS "Durdur" eylemi) + `resume_tracking`. Düşüş sırası `quickShareRoute`: oturum yok > favori yok > iOS < 17 > token yok > token dolmak üzere > arka plan konumu yok > arka planda başlat; her düşüş uygulamayı derin bağlantıyla açar. |
| Profil fotoğrafı | Kamera / galeri (izin reddinde "Ayarları aç"), kare kırpma, 512 px JPEG q0,8 + 160 px JPEG q0,7 (yeniden kodlama EXIF / GPS siler), Storage `avatars/{uid}/{13 hane}.jpg` + `_160.jpg` (`storage.rules`, `checkAvatarPair`), adres `user_bootstrap` ile profile yazılır (`avatar_url`, `avatar_thumb_url`, `avatar_version`), expo-image bellek + disk önbelleği, `avatar_version` ile önbellek kırma. |
| Cinsiyet ve çerçeve | Kayıtta zorunlu `gender` (`female` / `male`, `users/{uid}`), `GENDER_RING` pembe `#EC4899` / mavi `#3B82F6` / bilinmiyor gri; 3 px halka arkadaş listesinde, widget'ta ve harita pininde; fotoğraf yoksa baş harfli avatar. Tazelik halkadan durum noktasına taşındı. Android pininde `tracksViewChanges` görüntü yüklenince + 600 ms (en çok 5 sn) kapanır. |

Faz 6 kabul ölçütleri (bu depoda): widget push'u ve anlık görüntü ham koordinat taşımaz ✓; token sunucuda yalnızca özetiyle
durur, iptal / süre dolumu / hız sınırı / arkadaş olmayan alıcı reddedilir ✓; aynı `op_id` ikinci paylaşım açmaz ✓;
cinsiyetsiz kayıt ve sahte avatar yolu reddedilir ✓ (emülatör + Storage kural testleri); kayıt → fotoğraf → çerçeveli
liste / pin → favori sınırı → widget'tan 1 saat → geri sayım ve bildirim → token dolunca derin bağlantı ✓ (tarayıcı
demosu, Playwright 48 denetim).

## Faz 6 → yayın

Altı faz kod olarak tamamlandı; mağaza yayını öncesi alan alan kontrol listesi
[`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) dosyasındadır (kimlikler ve imzalama, native derleme, izin metinleri,
arka plan konumu gerekçesi, bildirimler / SOS, widget'lar, App Check ve kurallar, gizlilik etiketleri, hesap silme,
test hesapları, çökme raporlama, faz bazında cihaz kabulü). Faz 6 cihaz senaryoları: [`PHASE6.md`](PHASE6.md) §9.1.

Gerçek Firebase projesine geçiş (dağıtım, sırlar, CI) henüz yapılmadı: `firebase-kurulum` dalına bakın.

## Faz 7 (uygulandı)

Faz 8'den sonra uygulandı; Faz 8'in izin modelini kullanır (davet için `meetup_invite`). Ayrıntı:
[`PHASE7.md`](PHASE7.md). Özet:

| Parça | Ne yapıldı |
| --- | --- |
| Etkinlik Alanı | `events/{id}` (yalnızca üyeler okur), 7 callable, saf durum makinesi `reduceEvent` (voting → final → completed; cancelled / expired). Davetli katılım + mekan + saati tek yanıtta işaretler; herkes yanıtlayınca ya da süre dolunca sonuçlar düzenleyene düşer, düzenleyen onaylar. Davet yalnızca izin vermiş arkadaşlara, diğerleri sessizce düşer. Eşit oyda sahip kazananı seçer. |
| Bildirimler | Davet anında; hatırlatma 1 gün önce ve buluşma günü 08:00 (`event_sweeper`, dakikalık). Uygulama içi bildirim kutusu `users/{uid}/notices` (30 gün) + push. Android kanalları `sos_alarm` (özel ses, Rahatsız Etme'yi aşar), `movement` (heads-up), `events`, `event_reminders`; eski `sos` silinir. iOS `critical` / `time-sensitive` / `active`. |
| İzinler | İlk açılış akışı (Kullanırken → Her zaman → bildirimler → pil onayı → kamera/fotoğraf; her adım atlanabilir), İzin & Gizlilik Merkezi (durum, neden, tek düğme). |
| Gizlilik | Pil paylaşımı varsayılan KAPALI: RTDB kuralı, sunucu ve istemci üç katmanda zorlar. "Yola çıktı" bildirimi (≥ 10 dk sabit → hareket; 30 dk soğuma; alıcı tercihi). |
| Harita teması | Sistem / Açık / Koyu; haritadaki düğme ve Gizlilik Merkezi; önceden hesaplanmış iki stil dizisi → anında geçiş. |

Faz 7 kabul ölçütleri (bu depoda): izinsiz davetli düşer ve sayısı döner ✓; üye olmayan etkinliği göremez ✓; eşit oyda
`leaders` döner, sahip seçer ✓; herkes oy verince kendiliğinden kesinleşir ✓; hatırlatma yalnızca `final`'de ve
başlangıç değişmediyse, geç kalan `stale` ✓; pil paylaşımı kapalıyken pil alanı RTDB'de reddedilir, düşük pil
bastırılır ✓ (emülatör + kural testleri); oluştur → botlar yanıtlar → mekan oyu (eşitlik) → saat oyu → kesinleşme →
hatırlatma bildirimi → Gizlilik Merkezi → harita Koyu ✓ (tarayıcı demosu, Playwright).

**Faz 7 → yayın** (`RELEASE_CHECKLIST.md`'ye ek): `PHASE7.md` §9.1.

## Faz 8 (uygulandı)

Tasarım sözleşmesi, uygulama kararları, testler ve açıklar [`PHASE8.md`](PHASE8.md) dosyasındadır. Özet:

| Parça | Ne yapıldı |
| --- | --- |
| Yönlü izinler | `permission_grants/{granter}_{grantee}` (iki taraf okur, yalnızca callable yazar). Kapsamlar `location_view`, `ping`, `zone_notify`, `meetup_invite`, `sos_alert` (`sos_alert` dışındakiler istenebilir; o yalnızca acil kişi seçimiyle doğar). Arkadaş kabulü hiçbir izin yazmaz. Her etkileşim core `access.ts` matrisinden geçer (backend ve demo aynı fonksiyonları çağırır). |
| İstek ve onay | `permission_request_send` (10 dk çift soğuması, 24 sa ret soğuması, günde 30, istek 48 sa), `permission_request_respond` (seçilen kapsamlar + isteğe bağlı aynı işlemde paylaşım), `permission_set` (kişi izinleri anahtarı; kapatmak zincirleme temizler). Ret anları sunucuya özel `permission_declines`'ta; retde ve geri almada push yok. `share_start` izinsiz alıcıyı `needs_grant_receiver_ids`'te döner, `grant_location_view` ile izin aynı işlemde yazılır. |
| Görünmez mod | `invisible_set`: tüm giden paylaşımlar `stopped_by_sender` ile, QR bağlantıları biter; görünmezken paylaşım / uzatma / widget / bölge olayı açılamaz, cihaz yayın yapmaz. Görünür olunca yalnızca seçilen kişiler eski bitişle döner (varsayılan hiçbiri). SOS görünmezken gider ve modu kapatır. |
| Onay (KVKK) | `CONSENT_VERSION` + `CONSENT_TEXT_SHA256`; kapı cinsiyet kapısından sonra, oturum servisleri onaydan sonra başlar. Düğme metin sonuna kadar kaydırılınca açılır. Kayıt `users/{uid}/consents/{version}` (platform, uygulama sürümü, kaydırma). Onaysız kullanıcıya konum / sosyal callable'lar `consent_required`; koruyucu işlemler (durdur, geri al, engelle, sil, görünmez ol, onayı geri çek) her zaman çalışır. |

Faz 8 kabul ölçütleri (bu depoda): arkadaş kabulü izin yazmaz ✓; tek taraflı onay ters yönde yetki doğurmaz ✓; geri
alma paylaşımı bitirir ve RTDB yazmasını reddettirir ✓; görünmezken yeni paylaşım `invisible_mode`, teslim 0 ✓; onaysız
konum çağrısı `consent_required`, yanlış özet / kaydırmasız onay reddedilir ✓ (emülatör + kural testleri); onay kapısı →
izin isteği → Kişi izinleri → görünmez ol → seçmeli geri yükleme → yeniden onay ✓ (tarayıcı demosu, Playwright 60
denetim).

**Faz 8 → yayın** (`RELEASE_CHECKLIST.md`'ye ek)
- [ ] KVKK metni hukuk incelemesi; `[Şirket unvanı]`, `[Adres]`, `[KEP / e-posta]` doldurulsun; 18 yaş kuralı ve
      yurt dışı aktarım dili onaylansın. Metin değişirse `CONSENT_VERSION` artırılsın.
- [ ] Eski arkadaşlıklar için izin göçü kararı (`via:'migration'` doldurması yazılmadı; şu an herkes izinleri yeniden verir).
- [ ] `firestore.rules`, `firestore.indexes.json` (TTL `permission_declines.purge_at`) ve 6 yeni callable; istemci ve
      backend birlikte yayımlansın (eski istemci `consent_required` alır).
- [ ] Cihazda: onay kapısı (ekran okuyucu, büyük yazı), görünmezken arka plan yayınının durması, geri almada alıcının
      ekranı, `permission_request` push'unun Arkadaşlar > İzin istekleri'ni açması (`PHASE8.md` §9.1).

## Faz 9 (uygulandı)

Tasarım sözleşmesi, uygulama kararları, testler ve cihazda doğrulanacaklar [`PHASE9.md`](PHASE9.md) dosyasındadır. Özet:

| Parça | Ne yapıldı |
| --- | --- |
| Anlık fotoğraf | `proof_create` / `proof_get` / `proof_delete`. Yalnızca `expo-camera` ile o an çekilmiş kare (galeri, dosya ve sürükle-bırak yolu yok; çekim ≤ 2 dk taze). Core `validateProofJpeg` EXIF / GPS / yorum siler. Kişi başına 1 etkin fotoğraf (yenisi eskisini siler), günde 30. Bayt Storage `proofs/{uid}/{id}.jpg` (istemciye kapalı), kayıt `photo_proofs` (istemciye kapalı). Görme yalnızca sahibine ve ŞU AN etkin paylaşım alana (`canViewProof`). Pakette `photo_id` + `photo_exp`; pinde 📷, kişi kartında küçük resim + "52 dk kaldı", tam ekran görüntüleyici süre dolunca görseli kaldırır ("Fotoğrafın süresi doldu"). |
| Silme zinciri (1 saat) | Cloud Task `{proof_id}` → dakikalık tarama yedeği → Firestore TTL (`purge_at`) → `storage.lifecycle.json` (`proofs/` ≥ 1 gün). İstemci önbellekleri (`cachePolicy="none"`, dosya deposu) süre dolunca siler. Görünmez mod ve onayı geri çekme fotoğrafı bitirir; hesap silme klasörü siler. |
| 200 m yaklaşma | Hedef: kayıtlı bölge, etkinlik mekanı, buluşma noktası ya da haritadan "🏁 Hedefim yap". Core `approachReduce` (doğruluk kapısı, iki örnek, tek sefer) → `approach_report` (oturum + hedef başına tek push, `approach_marks` 48 sa TTL; alıcılar ∩ `movement_alerts`). Pakette `dest_name` / `dest_state` / `dest_eta`; pin altında "🏁 Neredeyse vardı · Kitap Kafe · ~1 dk". Çevrimdışıysa rapor diskte bekler, 2 dk içinde yeniden denenir. |
| Güvenli Dönüş | `safe_return_start` / `update` / `check_in` / `extend` / `cancel` (core `reduceSafeReturn`). 15/30/45/60 dk + hedef (bölge / paylaşım hedefi / etkinlik) + acil kişiler (`sos_alert` izni) + isteğe bağlı canlı paylaşım. `due_at`'te "Güvende misin?" tam ekran son uyarı (2 dk; "Güvendeyim" / "Vardım" / "+15 dk"), `grace_until`'de sunucu aynı işlemde SOS açar (`origin:'safe_return'`, son doğrulanmış konum, doğruluk, pil, adres). Zamanlayıcı sunucuda (Cloud Tasks + dakikalık tarama) olduğu için uygulama kapalıyken de çalışır. Hedefe girince otomatik "vardı". |
| Rehber + SMS | İlk açılış v2 (`ONBOARDING_VERSION = 2`; v1'i bitiren yalnızca yeni Rehber ve SMS adımlarını görür), KVKK metni `2026-11-26` (Rehber ve SMS maddeleri, açık rıza). Rehber yalnızca sistem kişi seçicisiyle numara seçmek için; rehber sunucuya gitmez, seçilen numaralar cihazda kalır. Gizlilik Merkezi'nde "Rehber" ve "SMS ile acil durum yedeği" satırları (`/sms-fallback`). |
| Çevrimdışı SOS | SOS 3 sn içinde RTDB bağlantısı kuramaz ya da 10 sn yanıt alamazsa (`offlineSosDecision`) "SMS ile gönder (n kişi)": hazır dolu mesaj (son doğrulanmış koordinat, ± doğruluk, saat, pil %, `maps.google.com` bağlantısı); iOS `MFMessageComposeViewController` / Android SMS intent (expo-sms), Gönder'e kullanıcı dokunur, `SEND_SMS` / `READ_SMS` izni yok. Arka planda aynı `op_id` ile 15 dk yeniden deneme: internet gelince SOS uygulama üzerinden de gider. |

Faz 9 kabul ölçütleri (bu depoda): yalnızca taze kamera karesi kabul edilir, EXIF atılır, etkin paylaşım almayana
`proof_get` `proof_not_found`, 1 saat sonra görev (kaçarsa dakikalık tarama) nesneyi ve kaydı siler ✓; yaklaşma bildirimi oturum başına bir kez ✓; süre + son uyarı
dolunca acil kişilere `origin:'safe_return'` SOS (görev kaçarsa tarama açar), "Güvendeyim" alarmı önler, uzatma ≤ 3 sa ✓ (emülatör +
kural testleri); ilk açılışta Rehber + SMS adımları → Ayşe'nin fotoğrafı ("60 dk kaldı") → 1 saat ileri sar ("Fotoğrafın
süresi doldu") → "Neredeyse vardım" → Güvenli Dönüş son uyarı + "Güvendeyim" → internetsiz SOS → hazır dolu SMS
(koordinat + `maps.google.com`) → Gizlilik Merkezi Rehber / SMS satırları → Ayşe'nin yanıtsız Güvenli Dönüş alarmı ✓
(tarayıcı demosu, `apps/mobile/e2e/faz9-smoke.cjs`, Playwright 40 denetim).

**Faz 9 → yayın** (`RELEASE_CHECKLIST.md`'ye ek)
- [ ] `backend/storage.lifecycle.json` kovaya uygulansın:
      `gsutil lifecycle set backend/storage.lifecycle.json gs://<kova>` (ya da
      `gcloud storage buckets update gs://<kova> --lifecycle-file=backend/storage.lifecycle.json`).
- [ ] `firestore.rules`, `firestore.indexes.json` (5 bileşik dizin; TTL `photo_proofs.purge_at`,
      `approach_marks.purge_at`, `safe_returns.purge_at`), `database.rules.json`, `storage.rules` ve 9 yeni callable.
      KVKK sürümü değiştiği için istemci ve backend birlikte yayımlansın (eski istemci `consent_required` alır).
- [ ] Yeni yerel eklentiler (`expo-camera` mikrofonsuz / barkodsuz, `expo-contacts`, `expo-sms`, iOS
      `LSApplicationQueriesSchemes: sms`) için `expo prebuild` + yeni derleme; mağaza izin metinleri (kamera, rehber).
- [ ] KVKK metninin Rehber / SMS / anlık fotoğraf maddeleri hukuk incelemesinden geçsin.
- [ ] Cihazda doğrulanacaklar: [`PHASE9.md`](PHASE9.md) §8 (kamera, arka planda yaklaşma, uygulama öldürülmüşken
      Güvenli Dönüş alarmı ve bildirim eylemleri, iOS Mesajlar / Android SMS, rehber izni reddi / sınırlı erişim).

## Faz 10 (uygulandı)

Ayrıntılar [`PHASE10.md`](PHASE10.md) dosyasındadır. Özet:

| Parça | Ne yapıldı |
| --- | --- |
| Ortak Takvim | Kesin etkinlik kartında "Takvime Ekle": başlık, başlangıç–bitiş, mekan + adres, Google Haritalar bağlantısı, katılımcı özeti. Resmi onay adımı + iOS yalnızca yazma / Android takvim izni (`expo-calendar`); izin yoksa sistem formu ya da Google Takvim. İzin Merkezi ve ilk açılışta Takvim satırı. |
| Kim Ne Kadar Uzakta? | Başlangıçtan 45 dk önce açılır, buluşmadan sonra kapanır. Yalnızca "Katılacağım" + konumunu açık paylaşanlar; vardı → en yakın → en uzak (`Ayşe · 6 dk`). Etkinlik kartında ve haritada şerit. |
| İki aşamalı kurtarma, çoklu cihaz | SMS + e-posta kodu (mock sağlayıcılar), cihaz oturumları (`dsid`'li özel token), yeni telefonda veriler taşınır, Güvenlik → Aktif Cihazlar, "Eski Cihazdaki Oturumu ve Konum Yayınını Kapat" (kurallarla anında yazım reddi + sessiz push). |

## Faz 11 (uygulandı)

Ayrıntılar [`PHASE11.md`](PHASE11.md) dosyasındadır. Özet:

| Parça | Ne yapıldı |
| --- | --- |
| Tema paketi | Nude (krem / sütlü kahve / tarçın-espresso / koyu kahve), Pudra Pembesi (kırık beyaz / toz pembe / mürdüm-vişne / koyu gri), Siyah / Gri (#121417 / #1C1F24, kademeli gri katmanlar, kırık beyaz metin). Tüm belirteçler + WCAG kontrast değerleri. |
| Google Maps stilleri | Beş tema için önceden üretilmiş `customMapStyle` dizileri; JSON kopyaları `docs/map-styles/`. Sokak < cadde < otoyol kademesi. |
| Anlık geçiş + saat kuralı | Tema ve harita stili aynı karede, yeniden başlatmasız. "Saate göre": gündüz / gece teması + iki saat; tek zamanlayıcı + ön plana dönüşte yeniden okuma. |
| Tema seçici | "Tema ve Harita" ekranı: mini harita + pembe/mavi pin + mini kitapçık içeren canlı önizleme kartları. Haritadaki palet düğmesi (uzun bas: Faz 7 hızlı döngü). |
| Kontrast halkası | Pudra Pembesi'nde beyaz boşluk + beyaz dış halka + mürdüm gölge; Nude ve Siyah / Gri'de kendi halkası. Pin ölçüleri değişmez. |

Geçiş listesi:
- [ ] Cihazda: halka gölgesinin Android pin bit eşleminde kırpılmadığı, tema geçişinde haritanın yeniden yüklenmediği, saat kuralının uygulama arka plandayken kaçırdığı geçişi ön plana dönünce uyguladığı.

## Faz 12 (uygulandı)

Ayrıntılar [`PHASE12.md`](PHASE12.md) dosyasındadır. Özet:

| Parça | Ne yapıldı |
| --- | --- |
| Kilit ekranı canlı sayaç | Tek model (core `liveActivity.ts`): iOS Live Activity + Dynamic Island (ActivityKit), Android süren canlı bildirim (Chronometer + ilerleme, Android 16 promoted ongoing). Kalan süre, ETA, pembe/mavi çerçeveli avatar, mola durumu; Mola / Devam et / Durdur eylemleri. |
| Yaşam döngüsü | İçerik değişince güncelleme (sayaç yerelde akar); süre / durdurma → 4 dk "sona erdi" kartı; Görünmez Ol ve çıkış → hemen kalkar. |
| Mola | 15 / 30 dk: "☕ Moladayım" notu gider, sonra yeni konum yayınlanmaz ve kuyruğa girmez; süre işler; kendiliğinden biter. |
| Sık paylaştıkların | Cihazdaki geçmişten (14 gün yarı ömür, favori +0,75) en çok 4 kişi; haritada ve kitapçık altında "＋ Paylaş" ile aynı satırda; tek dokunuşla 15 dk / 1 saat. |
| Ön kontroller | Görünmez → "Görünür ol"; sözleşme; `location_view` yoksa "İzin ver ve paylaş"; zaten açıksa kısaltma yok; mola biter; OS izin akışı. |

Geçiş listesi:
- [ ] Cihazda: iOS 16.2+ Live Activity + Dynamic Island, Android 13+ canlı bildirim (izinli / izinsiz), mola sonrası kendiliğinden yayın, Görünmez Ol'da kartın anında kalkması.
