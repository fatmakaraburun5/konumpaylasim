# Faz 9: Anlık Kamera İspatı, 200 m Yaklaşma Bildirimi, Güvenli Dönüş ve Çevrimdışı SOS SMS Yedeği

Faz 9, Faz 1–8, Konum İste ve Faz 7 sözleşmelerini **genişletir**; mevcut alanların anlamı değişmez. Çelişki olursa
`packages/core/src/{proof,approach,safeReturn,smsFallback}.ts` geçerlidir. **[Varsayım]** ile işaretlenenler ürün ya da
hukuk kararıyla doğrulanmalıdır.

| Konu | Bölüm |
| --- | --- |
| Tek kullanımlık kamera ispatı (yalnızca kamera, 1 saat TTL, erişim, silme zinciri) | §1 |
| 200 m yaklaşma ("Neredeyse vardım (1 dk)"), hedef modeli, tek seferlik tetik | §2 |
| Güvenli Dönüş zamanlayıcısı (15 / 30 / 45 / 60 dk), son uyarı, sunucu yedeği, otomatik alarm | §3 |
| Rehber ve SMS izinleri, ilk açılış, KVKK ek maddeleri, çevrimdışı SOS SMS | §4 |
| Bildirimler, kanallar, paket alanları, kurallar | §5 |
| Mobil yerleşim, tarayıcı demosu, testler, cihazda doğrulanacaklar | §6–§8 |

## 1. Tek kullanımlık anlık fotoğraf ispatı

### 1.1 Akış

1. Paylaşan kişi (aktif paylaşım sırasında ya da haritada kendi durum notunu sabitlerken) Durum notu sayfasında
   **"📷 Anlık fotoğraf ekle"** düğmesine basar.
2. Uygulama içi kamera açılır (`expo-camera` `CameraView`). **Galeri düğmesi, galeri izni, dosya seçici yoktur**;
   `launchImageLibraryAsync` bu akışta hiç çağrılmaz. Kamera izni yoksa yalnızca "Ayarları aç" gösterilir.
3. Deklanşör → önizleme ("Yeniden çek" / "Fotoğrafı ekle"). Görüntü cihazda yeniden kodlanır (uzun kenar 1280 px,
   JPEG 0,7, ≤ 600 KB; EXIF / GPS düşer) ve **çekim anı** (`captured_at`, sunucu saatine çevrilmiş) ile gönderilir.
4. `proof_create` sunucuda: kaynak `camera` (şema `z.literal`), tazelik (`captured_at` en çok 2 dk önce, en çok 1 dk
   ileride), JPEG imzası + SOF başlığındaki boyut = beyan edilen boyut, ≤ 1600 px, ≤ 600 KB, APPn/COM bölümleri
   atılır (`stripJpegMetadata`). Kullanıcı başına **1 etkin fotoğraf** (yenisi eskisinin yerine geçer, eskisi hemen
   silinir), günde 30.
5. Cihaz `photo_id` + `photo_exp` alanlarını canlı paketlere ekler (durum notu gibi; QR bağlantısına gitmez). Alıcı
   pinde 📷 rozeti ve kişi alt kartında küçük resim + "52 dk kaldı" görür; dokununca tam ekran görüntüleyici (kalan
   süre halkası). Süre dolunca görüntüleyici "Fotoğrafın süresi doldu" der, görsel kaldırılır.

### 1.2 Veri

| Yer | İçerik | Erişim |
| --- | --- | --- |
| Storage `proofs/{uid}/{proof_id}.jpg` | temizlenmiş JPEG | **istemciye tamamen kapalı** (kural `allow read, write: if false`); yalnızca Admin SDK |
| Firestore `photo_proofs/{proof_id}` | `PhotoProofDoc`: sahip, açıklama, boyut, çekim yeri (6 ondalık), `captured_at`, `created_at`, `expires_at`, `state`, `end_reason`, `object_deleted`, `purge_at` | istemciye kapalı |
| RTDB canlı paket | `photo_id`, `photo_exp` (ikisi birlikte, `photo_exp ≤ now + 61 dk`) | paylaşım alıcıları |
| Cihaz | gönderen: kendi kopyası + `konum.bg.proof.v1` (kimlik, bitiş); alıcı: indirilen kopya | önbellek dizini, süre dolunca silinir |

**Neden indirme token'ı yok:** Faz 6 avatarları token'lı adresle okunur; token kural dışıdır ve nesne silinene kadar
geçerlidir. Anlık fotoğrafta erişim her istekte yeniden denetlenmeli: bayt yalnızca `proof_get` callable'ı ile gelir.

### 1.3 Erişim (`canViewProof`)

Sahip her zaman (süre dolana kadar). Diğerleri: sahibinden **şu an etkin canlı paylaşım alıyor** (Faz 8
`location_view` ile başlamış) ve sahip görünmez değil. Erişimi olmayan `proof_not_found` alır (varlık sızmaz); süresi
dolmuşsa `proof_expired`. Paylaşım biterse, izin geri alınırsa, sahip görünmez olursa erişim anında kalkar.

### 1.4 Silme zinciri (1 saat)

| Katman | Mekanizma |
| --- | --- |
| Tam zamanında | Cloud Tasks (`shareexpirytask` kuyruğu, `{proof_id}` yükü) `expires_at` anında: Storage nesnesi silinir, belge `ended/expired` |
| Yedek | `share_expiry_sweeper` (dakikalık) `photo_proofs where state=='active' && expires_at<=now` + `object_deleted==false` yeniden deneme |
| Firestore TTL | `purge_at = expires_at + 1 gün` (koordinatsız özet) |
| Storage yaşam döngüsü | `backend/storage.lifecycle.json`: `proofs/` öneki, `age ≥ 1 gün` → sil (en son güvence; GCS gün çözünürlüklü) |
| Erken silme | `proof_delete` (sahip), yeni fotoğraf (`replaced`), görünmez ol (`invisible`), açık rızayı geri çek (`consent_withdrawn`), hesap silme (`account_deleted`, `proofs/{uid}/` öneki) |
| Gönderen cihazı | süre dolunca / kaldırınca yerel dosya silinir, paket alanları düşer |
| Alıcı cihazı | `photo_exp` anında zamanlayıcı + açılış / öne gelme süpürmesi: dosya ve bellek kopyası silinir; `expo-image` `cachePolicy="none"` |

### 1.5 Callable'lar

| Callable | İstek | Yanıt |
| --- | --- | --- |
| `proof_create` | `{op_id, source:'camera', jpeg_b64, width, height, captured_at, caption?, position?}` | `{proof, replaced_proof_id, server_now}` |
| `proof_get` | `{owner_id, proof_id}` (okuma; op_id yok) | `{proof, jpeg_b64, server_now}` |
| `proof_delete` | `{op_id, proof_id}` (onaydan muaf) | `{proof_id, deleted, server_now}` |

Hatalar: `proof_not_found`, `proof_expired`, `proof_invalid`, `proof_stale_capture`, `proof_limit_reached`,
`rate_limited`, `consent_required`.

## 2. 200 m yaklaşma: "Neredeyse vardım (1 dk)"

### 2.1 Hedef

Kullanıcının aynı anda **tek** etkin hedefi vardır (`ShareDestination`, cihazda `konum.bg.destination.v1`), tüm
arkadaş paylaşım oturumlarına uygulanır. Kaynaklar: kayıtlı bölge (Faz 5; yarıçap bölgeninki), haritada uzun basılan
nokta ("Hedefim yap"; varış yarıçapı 75 m [Varsayım]), etkinlik mekanı, buluşma noktası. Hedefin **koordinatı
cihazdan çıkmaz**; alıcılara yalnızca adı ve durumu gider, sunucu yalnızca koordinatsız `dest_key` (SHA-256'nın ilk 16
hanesi) görür. Tüm paylaşımlar bitince hedef silinir.

### 2.2 Algılama (`approachReduce`, her GPS örneğinde)

- Doğruluk kapısı: `accuracy > 100 m` örnek yok sayılır.
- **Kurulma**: en az bir güvenilir örnek `d − acc×0,5 ≥ 260 m` (uzaktan geliyor). Paylaşım hedefin dibinde başlarsa
  bildirim gitmez.
- **Doğrulama**: `d + acc×0,5 ≤ 200 m` olan iki ardışık örnek, aralarında ≥ 5 sn; ya da açıkça içeride tek örnek
  (`d + acc ≤ 120 m`, hızlı araç) ya da doğrudan varış yarıçapına giriş. Halkadan çıkan örnek sayacı sıfırlar.
- **Tek sefer**: `fired` kalıcıdır; aynı hedef için oturum boyunca bir daha tetiklenmez. Cihaz önce kalıcı yazar, sonra
  `approach_report` çağırır (4 sn yarış; ağ yoksa bağlantı gelince 2 dk içinde bir kez dener, sonra düşer).
- **Varış süresi**: `mesafe / hız` (hız yoksa harekete göre varsayılan), 1–10 dk; metin `Neredeyse vardım (1 dk)`.

### 2.3 Sunucu (`approach_report`)

`{op_id, session_ids[1..10], dest_key, dest_name, dest_kind, distance_m ≤ 400, eta_min 1..10, at}`. Onay ve görünmez
denetimi; 2 dk'dan eski rapor `stale`; saatte 12 rapor. Her oturum için `approach_marks/{uid}_{session}_{dest_key}`
transaction'da `create` (TTL 48 sa): yalnızca yeni yazılan oturumların **etkin paylaşım alıcılarına** ve
`movement_alerts` tercihini kapatmamış olanlara push. Hepsi zaten varsa `already_sent` (push yok). Yanıt
`{status: sent|already_sent|no_recipients|stale|invisible, notified_count}`.

### 2.4 Harita durumu

Paket alanları `dest_name` (≤ 30), `dest_state` (`en_route` | `near` | `arrived`), `dest_eta` (yalnızca `near`).
Alıcı pin altında "Neredeyse vardı · Ev · ~1 dk", kişi kartında aynı satır; gönderen kitapçıkta "Hedef: Ev".

## 3. Güvenli Dönüş (gece takip modu)

### 3.1 Akış

```
 Başlat (süre 15/30/45/60 dk + hedef + acil kişi(ler); başlangıç konumu ZORUNLU)
   │  kişilere "Ayşe Güvenli Dönüş başlattı" (koordinat yok)
   ▼
 running ──(due−5 dk yerel hatırlatma)──▶ ending_soon ──(due_at)──▶ final_warning (2 dk geri sayım, "Güvende misin?")
   │ varış (bölge / nokta yarıçapı) ya da "Güvendeyim"          │ "Güvendeyim" / "+15 dk"
   ▼                                                            ▼ grace_until doldu
 arrived / checked_in → kişilere "güvenle vardı"         alarm (SUNUCU): sos_alerts{origin:'safe_return'} +
 cancelled → kişilere "iptal etti"                        son doğrulanmış konum + doğruluk + pil + harita bağlantısı
```

- **Son uyarı** (`graceMs` 2 dk [Varsayım]): `due_at` anında cihaz tam ekran "Güvende misin?" + geri sayım; aynı anda
  sunucu sahibin cihazlarına `safe_return_due` push'u (yerel zamanlayıcı ölmüşse). Bildirim eylemleri "Güvendeyim"
  (kilit açmayı ister) ve "+15 dk".
- **Uzatma**: "+15 dk", toplam ≤ 3 sa.
- **Konum**: başlarken `fix` zorunlu; sürerken en sık 60 sn'de bir `safe_return_update` (son doğrulanmış konum + pil).
  "Yolculuk boyunca canlı konumumu da paylaş" (varsayılan açık) seçilirse seçilen kişilerle `grace_until + 1 sa`
  (alarm penceresi, Faz 4 SOS paylaşımı gibi) sonuna kadar canlı paylaşım başlar; bu, arka plan konum hattını
  (Android FGS, iOS arka plan) da canlı tutar. "+15 dk" sonrası paylaşım uzatılır; alarmda kesilmez. Güvenli Dönüş'ün
  açtığı oturum cihazda kaydedilir ve varış / "Güvendeyim" / iptal / alarm SOS'unun "Güvendeyim" ile kapatılmasında
  durdurulur.
- **Varış algılama**: hedef kayıtlı bölgeyse Faz 5 bölge izleyicisi (`onDecision arrive`), nokta ise `approachReduce`
  varış yarıçapı → otomatik `safe_return_check_in {reason:'arrived'}`.

### 3.2 Sunucu yedeği ve alarm

Zamanlayıcı **sunucudadır**: Cloud Tasks `due_at` ve `grace_until` + dakikalık süpürücü (`safe_returns where
status=='active' && grace_until<=now`, ayrıca `due_at<=now && due_notified_at==null`). Her belge kendi
transaction'ında yeniden okunur (`reduceSafeReturn` tick). Alarm: Faz 4 `sos_send` gövdesi paylaşılan
`openOrRefreshSos` ile çalışır (`origin:'safe_return'`, `safe_return:{destination_name, duration_min, due_at}`,
`message = safeReturnAlarmMessage`), alıcılar = seçilen kişiler ∩ `sos_alert` izni ∩ arkadaş. Telefon kapalı /
çevrimdışı olsa da alarm son bildirilen konumla gider. Cihaz açıksa SOS'un 15 sn'lik tazelemesi devam eder ve
"Güvendeyim" SOS'u kapatır. Son uyarıdan hemen sonra (alarm açılmışken) Güvenli Dönüş ekranından ya da bildirim
eyleminden gelen "Güvendeyim" `safe_return_not_active` alırsa istemci kaydı sunucudan okur ve alarmdaysa aynı dokunuşla
`sos_resolve` çağırır; kapatamazsa / durumu okuyamazsa kullanıcıya bildirimle söyler (sessizce geçilmez).

| Yol | Erişim |
| --- | --- |
| Firestore `safe_returns/{id}` (`SafeReturnDoc`, `purge_at` = bitiş + 7 gün) | yalnızca sahibi okur (`owner_id == auth.uid`), callable / sunucu yazar |
| Cihaz `konum.bg.safeReturn.v1` | hedef koordinatı ve yarıçapı (varış algılama için), kimlik, bitişler |

### 3.3 Callable'lar

| Callable | Not |
| --- | --- |
| `safe_return_start` | `{op_id, duration_min ∈ {15,30,45,60}, destination{kind,name,zone_id}, contact_ids[1..5], fix, time_zone}`; aynı anda tek etkin (`safe_return_active`); günde 12; kişilerde `sos_alert` izni yoksa düşer, hiç kalmazsa `no_emergency_contacts` |
| `safe_return_update` | son konum + pil (60 sn) |
| `safe_return_check_in` | `reason: safe | arrived` (onaydan muaf) |
| `safe_return_extend` | +15 dk (≤ 3 sa) |
| `safe_return_cancel` | onaydan muaf |

Görünmez mod Güvenli Dönüş'ü durdurmaz (kayıt yalnızca sahibine açık); alarm SOS kuralıyla görünmezliği kapatır.
Açık rızayı geri çekmek etkin zamanlayıcıyı `cancelled` yapar. Hesap silme kayıtları siler.

## 4. Rehber, SMS ve çevrimdışı SOS SMS yedeği

### 4.1 İlk açılış (`ONBOARDING_VERSION = 2`)

`welcome → location → location_always → notifications → contacts → sms → battery_share → camera_photos → done`.
v1'i bitirmiş kullanıcıya yalnızca `contacts` ve `sms` bir kez gösterilir (`onboardingDoneForUpgrade`).

- **Rehber**: sistem istemi (`expo-contacts`; iOS 18 "seçili kişiler" = `limited` da yeterli). Rehber sunucuya
  yüklenmez ve taranmaz; yalnızca seçilen numara cihazda saklanır.
- **SMS**: uygulama içi **açık onay** kutusu ("SMS yedeğine açık onay veriyorum…") + isteğe bağlı "Rehberden numara
  ekle". iOS'ta izin yoktur (`MFMessageComposeViewController`), Android'de `ACTION_SENDTO` (`smsto:`) izin istemez.
  `SEND_SMS`, `READ_SMS`, `RECEIVE_SMS`, `WRITE_CONTACTS` engellenir (`blockedPermissions`); uygulama SMS göndermez /
  okumaz, kullanıcı gönderir. Doğrudan arka plan gönderimi Play SMS politikası nedeniyle bu sürümde yok.

### 4.2 İzin & Gizlilik Merkezi

Yeni satırlar: **Rehber** (Açık / Seçili kişiler / Kapalı / Sorulmadı) ve **SMS ile acil durum yedeği** (Kapalı / Açık ·
N numara / Bu cihazda yok; eylem uygulama içi sayfa: onay anahtarı, numaralar, rehberden seç, elle yaz). Kamera satırı:
"Anlık fotoğraf yalnızca kamerayla çekilir, galeriden seçilemez."

### 4.3 KVKK metni (sürüm `2026-11-26`)

Eklenen / değişen maddeler: güvenlik sözleşmesine SMS yedeği, Güvenli Dönüş ve anlık fotoğraf kuralları; işlenen
verilere anlık fotoğraf, hedef, Güvenli Dönüş, rehber ve SMS (yalnızca cihazda); amaçlara Güvenli Dönüş alarmı, SMS
yardımı, "Neredeyse vardım", fotoğrafın 1 saat gösterimi; hukuki sebebe m.5/2-b (hayati tehlike); izinlere kamera
(anlık fotoğraf yalnızca kamera), fotoğraflar, rehber, SMS; aktarıma fotoğraf / hedef alıcıları, Güvenli Dönüş kişileri
ve SMS'in operatör üzerinden gittiği; saklamaya fotoğraf 1 saat, Güvenli Dönüş 7 gün, tekrar önleme 2 gün; açık rıza
beyanına fotoğraf, Güvenli Dönüş konumu ve rehber / SMS için ayrı onay. Tüm kullanıcılar "Neler değişti?" ile yeniden
onaylar. **Yer tutucular (`[Şirket unvanı]`, `[Adres]`, `[KEP / e-posta]`) hâlâ duruyor; hukuk incelemesi gerekir.**

### 4.4 Çevrimdışı SOS

- Cihaz her güvenilir konumu (`accuracy ≤ 100 m`) `konum.bg.lastFix.v1`'e yazar (paylaşım olmasa da; ön plan ve arka
  plan), pil ayrıca okunur.
- SOS gönderilirken bağlantı yoksa (RTDB `.info/connected` 3 sn'de gelmezse) ya da `sos_send` ağ hatasıyla düşerse ya
  da 10 sn'de yanıt gelmezse `offlineSosDecision`: SMS yedeği açık ve numara varsa geri sayım / hata ekranında büyük
  **"SMS ile gönder (N kişi)"** düğmesi; değilse nasıl açılacağı. SOS arka planda yeniden denemeye devam eder.
- Mesaj (`sosSmsBody`): "ACİL: Ayşe tehlikede, internet yok." / "Son doğrulanmış konum: 41.008240,28.978359 (±12 m) ·
  26.11.2026 14:05 · Pil %23" / `https://maps.google.com/?q=41.008240,28.978359` / "Hayati tehlikede 112'yi ara."
- `expo-sms` `sendSMSAsync(numaralar, gövde)`: iOS Mesajlar, Android SMS uygulaması hazır dolu açılır; tek dokunuş.
- Güvenli Dönüş son uyarısında çevrimdışıysan aynı düğme ("Güvenli Dönüş: Ev hedefine varamadım" satırıyla).

## 5. Bildirimler, paket ve kurallar

| Tür | Kime | Android kanal | iOS |
| --- | --- | --- | --- |
| `approach` | oturumun alıcıları | `movement` (heads-up) | `time-sensitive`, `thread-id movement_{uid}` |
| `safe_return_started` / `safe_return_ended` | acil kişiler | `safe_return` | `active` |
| `safe_return_due` | sahibin cihazları | `safe_return` (HIGH, varsayılan ses [Varsayım]) | `time-sensitive`, kategori `SAFE_RETURN` |
| alarm (`sos`, `origin: safe_return`) | acil kişiler | `sos_alarm` | `critical` / `time-sensitive` + `sos_alarm.wav` |

Push'larda koordinat yoktur (alarm gövdesinde SOS gibi adres vardır). RTDB `live_locations` kuralı yeni alanları
doğrular: `photo_id` (20 karakter base64url) ile `photo_exp` birlikte; `dest_name` (1–30) ile `dest_state` birlikte;
`dest_eta` (0–120) yalnızca `dest_state == 'near'`. `link_live` bu alanları almaz.

## 6. Mobil yerleşim

| Parça | Dosyalar |
| --- | --- |
| Veri / durum | `services/firebase/callables.ts` (`proofApi`, `approachApi`, `safeReturnApi`), `services/firebase/safeReturnRepo(.web).ts`, `services/proof/*` (kodlama, önbellek), `services/sms/smsComposer(.web).ts`, `services/permissions/contactsPermissions(.web).ts`, `services/location/lastFix.ts`, `state/{proofStore,destinationStore,safeReturnStore,smsFallbackStore}.ts`, `services/f9Services.ts`, `services/notifications/{f9Push,safeReturnNotifications}.ts` |
| Konum hattı | `pipeline.ts`: son konum kaydı, fotoğraf ve hedef paket alanları, `maybeReportApproach`, Güvenli Dönüş konum tazeleme ve varış; `zoneMonitorWiring` varışı |
| Arayüz | `features/proof/*` (kamera, küçük resim, görüntüleyici), `features/approach/*` (hedef seçici, rozet), `features/safeReturn/*` (sayfa, bant, son uyarı), `features/sms/*` (SMS yedeği sayfası, çevrimdışı SOS düğmesi), `NoteSheet`, `FriendMarker(.web)`, `EtaCard`, `ShareDeck`, `SosCountdown`, `SosIncomingScreen`, `OnboardingFlow`, `PrivacyCenterScreen`, `app/(main)/sms-fallback.tsx` |

## 7. Tarayıcı demosu

"FAZ 9 SENARYOLARI" paneli (`src/demo/shell/Faz9.web.tsx`; uygulandığı haliyle):

- **Ayşe anlık fotoğraf paylaşsın:** kameradan kare + "Mekana geçtim, masamız burası" → pinde 📷 notu, kişi kartında
  küçük resim + "60 dk kaldı", dokununca tam ekran. **Fotoğrafların süresini 1 saat ileri sar:** sunucu, sahte Storage
  ve iki tarafın önbelleği silinir; açık görüntüleyici görseli kaldırıp "Fotoğrafın süresi doldu" der.
- **Ayşe hedefine 200 m yaklaşsın / varsın:** bana "Ayşe Yılmaz: Neredeyse vardım (1 dk)" bildirimi + pin altında
  "🏁 Neredeyse vardı · Kitap Kafe · ~1 dk"; ikinci basışta "vardı", bildirim tekrar gitmez.
- **Ayşe Güvenli Dönüş başlatsın ve yanıt vermesin** (acil kişisi benim; demo kısaltması 20 sn + 20 sn son uyarı) →
  "Ayşe Güvenli Dönüş başlattı", ardından tam ekran "GÜVENLİ DÖNÜŞ ALARMI" (son konum, doğruluk, pil).
- **Güvenli Dönüş: süreyi bitir (son uyarı) / alarmı tetikle:** uygulamada (🛡 → Güvenli Dönüş) başlattığım
  zamanlayıcı için. Hedef için önce Faz 5 panelinden "Ev bölgemi buraya kaydet (demo)".
- **İnterneti kes + SOS (SMS yedeği)** ve **İnterneti geri getir:** SOS'a basılı tut → "SMS ile gönder (n kişi)" →
  telefon çerçevesinde hazır dolu simüle iOS Mesajlar ekranı; internet dönünce SOS aynı `op_id` ile uygulama
  üzerinden de gider. **SMS yedeğini demo numarasıyla aç:** onay + rehberden "Annem".
- **Rehber / SMS izinlerini sıfırla:** ilk açılış yalnızca yeni Rehber ve SMS adımlarını gösterir.

Kamera: tarayıcı kamerası İSTENMEZ; canvas vizörü ("Kafe masası" / "Trafik" sahneleri) 960×1280 JPEG üretir, dosya /
galeri / sürükle-bırak girişi yoktur. Rehber: simüle iOS izin istemi + demo kişi seçici (Annem, Babam (iki numara),
Ablam, Komşu Selin). Demo kendi telefonumu hedefe yürütmez; yaklaşma yalnızca Ayşe üzerinden simüle edilir.

Duman testi: `cd apps/mobile && EXPO_OFFLINE=1 CI=1 npm run web:export && node e2e/faz9-smoke.cjs`
(`SHOTS=<klasör>` verilirse ekran görüntüleri).

## 8. Testler ve cihazda doğrulanacaklar

| Katman | Kapsam |
| --- | --- |
| Çekirdek (`packages/core/test/faz9.test.ts`) | JPEG çözümleme / meta veri silme, tazelik, erişim, yaklaşma durum makinesi (kurulma, iki örnek, tek sefer, varış, doğruluk kapısı), Güvenli Dönüş geçişleri, SMS gövdesi ve kararı, ilk açılış v2, merkez satırları, paket alanları |
| Backend (`backend/test/functions/faz9.test.ts`, kural testleri) | fotoğraf oluştur / gör / erişim kaybı / süre dolumu / silme zinciri, yaklaşma tek sefer, Güvenli Dönüş başlat / uzat / bitir / sunucu alarmı, Storage ve RTDB kuralları |
| Mobil (`__tests__/faz9*.test.ts`, `demoFaz9.test.ts`) | depolar, hat kancaları, bildirim içerikleri, demo sunucusu |
| Tarayıcı | Playwright duman testi (`apps/mobile/e2e/faz9-smoke.cjs`, 40 denetim) |

Cihazda doğrulanacaklar:
- [ ] `expo-camera` uygulama içi kamera (iOS / Android), galeri yolunun olmadığı; kamera izni reddi.
- [ ] Fotoğrafın 1 saat sonra Storage'dan silindiği (Cloud Tasks), `storage.lifecycle.json`'un kovaya uygulandığı
      (`gsutil lifecycle set backend/storage.lifecycle.json gs://<kova>`).
- [ ] Yaklaşma: araçta ve yürürken 200 m eşiği, tek bildirim; arka planda (ekran kapalı) tetiklenme.
- [ ] Güvenli Dönüş: uygulama öldürülmüşken süre dolumu → sunucu alarmı; "Güvendeyim" bildirim eylemi (kilit açma).
- [ ] SMS: iOS Mesajlar ve Android SMS uygulamasında hazır dolu mesaj; SIM'siz cihazda "Bu cihazda yok".
- [ ] Rehber: iOS 18 sınırlı erişim, Android izin reddi.
- [ ] Yayın: `firestore.rules`, `firestore.indexes.json` (TTL `photo_proofs.purge_at`, `approach_marks.purge_at`,
      `safe_returns.purge_at`), `database.rules.json`, `storage.rules`, 9 yeni callable; KVKK sürümü değiştiği için
      istemci ve backend birlikte yayımlanmalı.
