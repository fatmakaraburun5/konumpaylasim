# Backend tasarımı (Firebase)

> Bu belge Faz 1 backend tasarımının referansıdır. Kod (backend/) bununla çelişirse kod ve testleri doğrudur; fark bu belgeye işlenir. Mesafe/sıklık/limit değerleri [Varsayım] etiketlidir.

#### Karar özeti

İlişki ve paylaşım durumu Firestore'da, canlı konum ise Realtime Database'de (RTDB) tutulur. Durumu değiştiren her işlem bir Cloud Functions callable'ı içinde, Firestore transaction'ı ile yapılır. Konum yolunda hiç Function çalışmaz. Gönderen istemci her alıcı için ayrı bir kopya yazar ve RTDB kuralları her yazmayı doğrular. Gizlilik, dinleyicilerin kurallarla yeniden değerlendirilmesine dayanmaz. Okuma yetkisi yalnızca kimliğe bağlıdır. İptal, verinin sunucu tarafından silinmesiyle gerçekleşir.

#### 1. Bileşenler ve çağrı yönleri

| Bileşen | Görev | Çağrı yönü |
|---|---|---|
| Mobil istemci | Giriş, harita, konum toplama | Auth, callable'lar, Firestore (salt okuma), RTDB (konum yazma/okuma), FCM |
| Firebase Auth (Phone) + Identity Platform | SMS doğrulama, ID token | İstemci çağırır |
| Cloud Functions 2nd gen (`europe-west1`) | Durum geçişleri, push, temizlik | Callable, Firestore tetikleyicisi, zamanlayıcı, task queue |
| Cloud Firestore | `users`, `users_private`, `phone_index`, `invite_codes`, `friendships`, `location_shares`, `location_requests` | İstemci okur; yalnızca Admin SDK yazar |
| RTDB (K instance) | `share_acl`, `live_locations` | Functions ACL yazar; istemci konum yazar/dinler |
| FCM (APNs üzerinden) | `location_requests` bildirimi | Functions çağırır |
| App Check | Play Integrity / App Attest | Firestore, RTDB ve callable'larda zorunlu |

Callable'lar şunlardır: `user_bootstrap`, `friend_request_send`, `friend_request_respond`, `friend_request_cancel`, `friendship_remove`, `user_block`, `share_start`, `share_stop`, `location_request_send`, `location_request_respond`, `account_delete`. Her çağrı bir `client_op_id` (UUIDv4) taşır. Tekrar eden çağrılar `ops/{uid}_{client_op_id}` belgesiyle tekilleştirilir **[Varsayım]**.

| Veri | Depo | Gerekçe |
|---|---|---|
| İlişki ve paylaşım durumu | Firestore | Transaction, `array-contains` sorgusu, TTL politikası, düşük yazma sıklığı |
| `live_locations`, `share_acl` | RTDB | Sık ve küçük yazmalar. Ücret işlem başına değil, bant genişliği ve depolama üzerinden **[Varsayım: doğrulanmalı]**. Kurallarda `now` ile yazma anında süre kontrolü |

Kaynak doğru (source of truth) Firestore'dur. `share_acl` ondan türetilmiş, sürüm numaralı bir aynadır. ACL düğümü yoksa erişim de yoktur (fail-closed).

#### 2. Telefon doğrulama ve SMS kötüye kullanımı

1. İstemci numarayı libphonenumber ile E.164'e çevirir. Sunucu `^\+[1-9]\d{7,14}$` ile doğrular. Faz 1'de yalnızca `^\+905\d{9}$` kabul edilir **[Varsayım]**.
2. Akış `verifyPhoneNumber`, SMS kodu ve `signInWithCredential` adımlarından oluşur. Android'de Play Integrity, iOS'ta sessiz APNs veya reCAPTCHA yedeği devreye girer **[Varsayım: doğrulanmalı]**.
3. İlk girişte `user_bootstrap` çalışır. `users`, `users_private.phone_e164`, `phone_index/{phone_e164}` ve `invite_codes/{code}` belgelerini idempotent biçimde tek transaction'da yazar. 2nd gen'de Auth `onCreate` tetikleyicisi yoktur **[Varsayım: doğrulanmalı]**.

SMS pompalama (toll fraud) savunması, SMS gönderilmeden önce çalışmalıdır:
- Identity Platform SMS bölge politikası yalnızca TR'ye izin verir **[Varsayım: doğrulanmalı]**.
- reCAPTCHA SMS toll fraud koruması ve Auth için App Check zorlaması açılır **[Varsayım: doğrulanmalı]**.
- Günlük SMS kotası ve Cloud Billing bütçe alarmı kurulur **[Varsayım: doğrulanmalı]**.
- Test numaraları yalnızca geliştirme projesinde tanımlanır.

Telefonla arama istek gönderdiğinde yanıt, numara kayıtlı olsa da olmasa da aynıdır. Bu, numara taramayı engeller **[Varsayım]**.

#### 3. invite_code tekilliği

Örnekteki `LOC-8492` biçimi yalnızca 10.000 değer sunar. Bu alan tahminle taranabilir ve kullanıcı sayısı arttıkça çakışmalar çoğalır. Öneri, `LOC-` önekine 31 karakterlik alfabeden 6 karakter eklemektir. Alfabede 0/O/1/I/L yoktur. Toplam değer sayısı 31^6 ≈ 887 milyondur **[Varsayım]**. Bu biçim değişikliği kullanıcı onayı gerektirir.

```js
const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
for (let i = 0; i < 5; i++) {
  const code = 'LOC-' + Array.from({ length: 6 }, () => A[crypto.randomInt(31)]).join('');
  try {
    await db.runTransaction(async tx => {
      tx.create(db.doc(`invite_codes/${code}`), { user_id: uid });
      tx.update(db.doc(`users/${uid}`), { invite_code: code });
    });
    return code;
  } catch (e) { if (e.code !== 6) throw e; } // 6 = ALREADY_EXISTS
}
```

Tekilliği `create()` garanti eder: belge zaten varsa commit başarısız olur. Girdi normalize edilir: büyük harfe çevrilir, boşluk temizlenir, `LOC-` öneki isteğe bağlıdır. Kod araması kullanıcı başına saatte 20 ile sınırlanır **[Varsayım]**. 1 milyon kullanıcıda rastgele bir tahminin isabet olasılığı yaklaşık %0,11'dir.

#### 4. Atomik ve yarışsız geçişler

- İstemci Firestore'a hiç yazmaz (`allow write: if false`).
- Belge kimlikleri deterministiktir. Böylece her yarış tek bir belge üzerinde çözülür:
  - `friendships/{min_uid}_{max_uid}`
  - `location_shares/{sender_id}_{receiver_id}` (yönlüdür; çift başına tek kayıt)
  - `location_requests/{requester_id}_{target_id}`
- **Karşılıklı eşzamanlı istek:** İki çağrı aynı belgeye düşer. İkinci transaction `pending` durumunu ve `requested_by == karşı taraf` koşulunu görür, durumu `accepted` yapar.
- **Kabul ile iptal yarışı:** İki işlem de `status == 'pending'` önkoşulunu transaction içinde okur. Kaybeden taraf `failed-precondition` hatası ve güncel durumu alır.
- `share_start`, aynı transaction'da `friendships` belgesinin `accepted` olduğunu doğrular. `friendship_remove` ve `user_block`, ilgili tüm paylaşımları ve istekleri aynı transaction'da kapatır.
- **Sürümlü ACL:** Her paylaşım belgesinde monoton artan bir `version` alanı vardır. Commit sonrası Function, `share_acl/{share_id}` düğümüne bir RTDB transaction'ıyla yazar. Yazma yalnızca gelen `version` daha büyükse uygulanır.
- Paylaşım bittiğinde düğüm silinmez. Yerine `{status:"ended", version}` mezar taşı (tombstone) yazılır. Böylece geç ulaşan eski bir "aç" yazısı, yeni bir "kapat" kararını ezemez.
- ACL yazımı başarısız olursa `onDocumentWritten(location_shares/{id})` tetikleyicisi ve 5 dakikalık bir uzlaştırıcı yeniden dener **[Varsayım]**.

#### 5. Konum yalnızca aktif alıcılara

```text
/share_acl/{share_id}                     { sender_id, receiver_id, status, expires_at|null, version }  istemciye kapalı
/live_locations/{receiver_id}/{share_id}  alıcı başına son paket, geçmiş yok
```

Gönderen, tüm aktif paylaşımları için tek bir çok yollu güncelleme (multi-path update) yazar. Paketteki `receiver_ids[]` alanı bu güncellemenin anahtarlarına dönüşür. Teslim edilen kopyada bu alan bulunmaz.

Aşağıdaki kurallarda alan tipi kontrolleri kısaltılmıştır.

```json
{
  "rules": {
    "share_acl": { ".read": false, ".write": false },
    "live_locations": {
      "$receiver_id": {
        ".read": "auth != null && auth.uid === $receiver_id",
        "$share_id": {
          ".write": "auth != null && newData.exists() && root.child('share_acl/'+$share_id+'/status').val() === 'active' && root.child('share_acl/'+$share_id+'/sender_id').val() === auth.uid && root.child('share_acl/'+$share_id+'/receiver_id').val() === $receiver_id && (!root.child('share_acl/'+$share_id+'/expires_at').exists() || root.child('share_acl/'+$share_id+'/expires_at').val() > now)",
          ".validate": "newData.hasChildren(['sender_id','lat','lng','accuracy','timestamp','server_ts','share_mode']) && newData.child('sender_id').val() === auth.uid && newData.child('server_ts').val() === now && newData.child('timestamp').val() > now - 120000",
          "lat": { ".validate": "newData.isNumber() && newData.val() >= -90 && newData.val() <= 90" },
          "lng": { ".validate": "newData.isNumber() && newData.val() >= -180 && newData.val() <= 180" },
          "$other": { ".validate": "$other.matches(/^(accuracy|speed_mps|heading|battery_pct|is_charging|activity_state|timestamp|server_ts|expires_at|share_mode|sender_id)$/)" }
        }
      }
    }
  }
}
```

- **Okuma:** Kural yalnızca `auth.uid === $receiver_id` koşulundan oluşur. Veriye bağlı olmadığı için yeniden değerlendirmeye ihtiyaç duymaz.
- **Yazma:** Veriye bağlı kontroller yalnızca yazma kurallarındadır. Bu kurallar her yazmada değerlendirilir.
- **Kesme sırası:** Firestore transaction'ı çalışır, ardından `share_acl` mezar taşı yazılır. Bu andan sonra gönderenin yazmaları reddedilir. Son olarak `live_locations/{receiver_id}/{share_id}` silinir ve alıcıda `child_removed` tetiklenir. Gönderen istemcinin iş birliği gerekmez.
- **Süre dolumu:** Kural `expires_at > now` koşulunu denetler. Bu yüzden yazmalar tam süresinde reddedilir.
  - Son paketi, `share_start` sırasında kuyruğa alınan bir task queue Function'ı siler.
  - Dakikalık zamanlanmış tarama yedek olarak çalışır **[Varsayım]**.
  - İstemci, süresi dolmuş paketi `.info/serverTimeOffset` ile hesapladığı sunucu saatine göre hemen gizler.
- **Alıcı izolasyonu:** Her alıcı yalnızca kendi kopyasını görür. Firestore kuralı da yalnızca ilgili çiftin üyelerine okuma verir:

```js
match /location_shares/{share_id} {
  allow read: if request.auth != null
    && request.auth.uid in [resource.data.sender_id, resource.data.receiver_id];
  allow write: if false;
}
```

Bu kural yalnızca belgenin değişmeyen alanlarına bakar. Sorgularda `where('receiver_id', '==', uid)` kısıtı zorunludur, çünkü kurallar filtre işlevi görmez. Arkadaşların görünen adları `friendships.member_profiles` alanına kopyalanır. `users/{uid}` belgesini yalnızca sahibi okuyabilir.

**Kesin bilinmeyen davranışlar (tasarım bunlara dayanmaz):**
- Firestore'da kural dağıtımının aktif dinleyicilere yansıması 10 dakikayı bulabilir **[Varsayım: doğrulanmalı]**.
- `get()` ile okunan bağımlı belge değiştiğinde, açık dinleyicinin hemen kesileceği garanti değildir **[Varsayım: doğrulanmalı]**.
- RTDB'nin, kural sonucu değişen dinleyiciyi iptal etmesine güvenilmez **[Varsayım: doğrulanmalı]**.

**Önceden teslim edilmiş veri:** Alıcıya ulaşmış konum geri alınamaz.
- Sunucu son paketi siler ve geçmiş tutmaz.
- İstemcide RTDB disk kalıcılığı kapalı kalır. `child_removed` olayında bellekteki konum silinir.
- Ekran görüntüsü engellenemez. Bu durum aydınlatma metninde belirtilir.

**Kısmi ret:** Çok yollu güncellemede tek bir yol reddedilirse güncellemenin tamamı reddedilir. İstemci `PERMISSION_DENIED` aldığında paylaşım listesini Firestore'dan tazeler ve bir kez yeniden dener.

#### 6. location_requests bildirimi

```json
{
  "notification": { "title": "Konum isteği", "body": "Ayşe konumunu paylaşmanı istiyor" },
  "data": { "type": "location_request", "request_id": "uA_uB" },
  "android": { "notification": { "channel_id": "location_requests" } },
  "apns": { "payload": { "aps": { "category": "LOCATION_REQUEST" } } }
}
```

- Bildirimde koordinat, telefon numarası veya başka bir alıcı bilgisi yoktur. Kilit ekranında adı gizleme seçeneği sunulur **[Varsayım]**.
- Sınırlar: çift başına 10 dakikada 1 istek, kullanıcı başına günde 30 istek. Yanıtlanmayan istek 15 dakikada `expired` olur **[Varsayım]**.
- Kabul, `share_start({in_response_to})` çağrısıyla yapılır. İstek ve paylaşım tek transaction'da güncellenir.
- `registration-token-not-registered` hatası alınan token'lar silinir.

#### 7. Arka plan konumu

| Konu | iOS | Android |
|---|---|---|
| İzin | "Always" izni ve `location` arka plan modu | Android 10+ için ayrı `ACCESS_BACKGROUND_LOCATION`; Play Console beyanı gerekir |
| Sürekli çalışma | `allowsBackgroundLocationUpdates`, mavi gösterge; iOS 17+ için `CLBackgroundActivitySession` | `foregroundServiceType="location"` ve kalıcı bildirim; Android 14+ için `FOREGROUND_SERVICE_LOCATION` |
| Kapatılınca | Kullanıcı kaydırıp kapatırsa güncelleme durur; yalnızca önemli konum değişikliği (~500 m) uyandırır | Android 12+ ön plan servisi arka plandan başlatamaz; OEM pil yöneticileri servisi öldürebilir |

Tablodaki tüm platform davranışları **[Varsayım: doğrulanmalı]** etiketlidir.

İstemci politikası **[Varsayım]**:
- **Ön plan:** 5 saniyede bir, 10 m mesafe filtresiyle gönderim.
- **Arka plan:** 30 saniyede bir, 25 m filtresiyle gönderim. Kullanıcı `still` durumundayken 5 dakikada bir nabız paketi gönderilir.
- **Başlatma:** Paylaşım yalnızca ön planda başlatılır. Ön plan servisi o anda açılır.
- **Bayatlık:** Alıcı arayüzü paketin yaşını gösterir. 2 dakikadan eski paket "bayat" olarak işaretlenir.

#### 8. Maliyet modeli

Değişkenler **[Varsayım]**:
- N = 10.000 eşzamanlı paylaşan
- p_fg = 0,3 (ön plan oranı)
- R = 1,5 (paylaşan başına ortalama alıcı)
- o = 0,6 (dinlemede olan alıcı oranı)
- S = 500 B (protokol yükü dahil paket boyutu)

```text
U (güncelleme/s)     = N × (p_fg/5 + (1−p_fg)/30) = 10.000 × (0,06 + 0,0233) ≈ 833
RTDB yazma/s         ≈ U   (çok yollu güncelleme tek işlem sayılır [Varsayım: doğrulanmalı])
İnen veri/ay         = U × R × o × S × 2.592.000 ≈ 970 GB
RTDB maliyeti/ay     ≈ 970 × p_download_GB + depolama (N × R × S ≈ 7,5 MB, ihmal edilebilir)
Konum yolu Function  = 0
Firestore alternatifi: yazma/ay = U × R × 2.592.000 ≈ 3,24 milyar; okuma/ay ≈ 1,94 milyar
Function fan-out alternatifi: U × 2.592.000 ≈ 2,16 milyar çağrı/ay
SMS/ay               = yeni doğrulama sayısı × p_sms_TR
```

- Formül üst sınırdır, çünkü mesafe filtresi gerçek U değerini düşürür.
- Bu desende Firestore'un işlem başına ücreti belirgin biçimde daha pahalı olur **[Varsayım: doğrulanmalı]**.
- RTDB'de instance başına yaklaşık 1.000 yazma/s ve 200.000 eşzamanlı bağlantı sınırı vardır **[Varsayım: doğrulanmalı]**. U ≈ 833 bu sınıra yakındır.
- Bu yüzden `users.rtdb_instance` alanı ilk günden bulunur. Değer kayıtta atanır ve değişmez. Faz 1, K = 2 instance ile açılır **[Varsayım]**.
- Alıcı, gelen paylaşımların `rtdb_instance` değerlerine göre en fazla K dinleyici açar.

#### 9. Test edilebilirlik

- **Emülatör:** Local Emulator Suite; Auth, Firestore, RTDB, Functions ve Pub/Sub'ı kapsar. Auth emülatörü SMS göndermez; kodlar emülatörün REST arayüzünden okunur. CI'da `firebase emulators:exec "npm test"` çalışır.
- **Kural testleri:** `@firebase/rules-unit-testing` kullanılır. Şunların reddi doğrulanır:
  - `ended` durumundaki ACL'ye yazma
  - süresi geçmiş `expires_at`
  - başka bir alıcının yolunu okuma
  - sahte `sender_id`
  - `receiver_ids` içeren paket
- **Yarış testleri:** Karşılıklı istek ve kabul/iptal yarışı `Promise.all` ile denenir. Sürümlü ACL, yazmalar ters sırada uygulanarak test edilir.
- **Kapsam dışı kalanlar:** Gerçek SMS, App Check (geliştirmede debug provider kullanılır), FCM/APNs teslimi ve kotalar. Bunlar staging projesinde test numaralarıyla doğrulanır.
- **Yük testi:** Staging RTDB'ye saniyede yaklaşık 833 sentetik yazma gönderilir ve p95 gecikme ölçülür.

#### 10. KVKK ve veri yerleşimi

- **Bölgeler:** Firestore `eur3`, RTDB ve Functions `europe-west1` **[Varsayım: doğrulanmalı]**. Türkiye'de Firebase bölgesi yoktur **[Varsayım: doğrulanmalı]**.
- **Seçilemeyen bölgeler:** Auth (telefon numarası) ve FCM için bölge seçilemez; veriler ABD'de işlenebilir **[Varsayım: doğrulanmalı]**.
- **Hukuki sonuç:** Bu durum KVKK m.9 kapsamında yurt dışına aktarımdır. Standart sözleşme ve Kurul'a bildirim gerekebilir **[Varsayım: doğrulanmalı]**.
- **Rıza:** Konum paylaşımı için ayrı açık rıza ve aydınlatma metni alınır. Paylaşım tek dokunuşla geri alınabilir.
- **Minimizasyon:** Konum geçmişi tutulmaz. `account_delete` tüm belgeleri ve `phone_index` kaydını siler. Mezar taşları ve biten istekler 7 gün sonra TTL ile silinir **[Varsayım]**.

#### 11. Sonraki fazlara uygunluk

- **Geofence:** İşletim sisteminin bölge izleme özelliği istemcide çalışır. Geçiş olayları bir callable ile kaydedilir.
- **Buluşma noktası:** `meeting_points` koleksiyonu kurulur ve `share_acl` deseni yeniden kullanılır.
- **Widget:** Widget süreci soket bağlantısı tutamaz. RTDB REST okuması veya push ile güncellenen bir anlık görüntü gerekir **[Varsayım: doğrulanmalı]**.
- **QR:** QR kodu yalnızca `invite_code` taşır ve `friend_request_send` callable'ını kullanır.

#### 12. En önemli 5 risk

| # | Risk | Azaltma |
|---|---|---|
| 1 | SMS pompalama faturası | TR bölge politikası, App Check, reCAPTCHA, günlük kota, bütçe alarmı |
| 2 | Arka planda güncellemelerin kesilmesi | Ön plan servisi, önemli konum değişikliği yedeği, bayatlık göstergesi, OEM ayar rehberi |
| 3 | Geri dönüştürülmüş numarayla eski hesaba giriş | 180 gün pasif kalmış hesapta sosyal grafiği sıfırlama **[Varsayım]**; eski cihazlara giriş bildirimi |
| 4 | Firestore ile `share_acl` arasında tutarsızlık | Sürümlü ACL, fail-closed yapı, uzlaştırıcı, değişmez (invariant) testleri |
| 5 | KVKK yurt dışı aktarımı | Avrupa bölgesi, standart sözleşme, açık rıza, çıkış öncesi hukuki inceleme |

#### 13. Efor **[Varsayım]**

| İş paketi | Kişi-hafta |
|---|---|
| Veri modeli, kurallar, kural testleri | 2 |
| Callable'lar, ACL aynası, temizlik işleri | 3 |
| Telefon doğrulama ve SMS savunması | 1 |
| İstemci: giriş, arkadaşlar, istekler, harita | 4 |
| İstemci: iOS ve Android arka plan konumu | 3–4 |
| Staging, yük testi, gerçek cihaz testleri | 2 |
| **Toplam** | 15–16 kişi-hafta; 2 kişiyle yaklaşık 8–10 hafta |

#### Dürüst değerlendirme

**Güçlü yanlar:**
- Yönetilecek sunucu yoktur. Yeniden bağlanmayı SDK üstlenir.
- Konum yolunda Function yoktur. Maliyet bant genişliğiyle doğrusal artar.
- Gizlilik, yazma kurallarına ve sunucu tarafı silmeye dayanır. İkisi de emülatörde otomatik test edilir.

**Zayıf yanlar:**
- Gönderen her alıcı için ayrı bir kopya yükler. R büyüdükçe pil ve veri tüketimi artar.
- Paketleri sunucu değil kurallar doğrular. Sahte GPS engellenemez.
- İki ayrı depo ve sürümlü ACL, küçük bir ekip için ek karmaşıklık getirir.
- Auth ve FCM'nin veri yerleşimi kontrol edilemez. Satıcı bağımlılığı yüksektir.
- Callable'lardaki soğuk başlangıç ilk istekleri yavaşlatır. `minInstances` ise ek maliyet getirir **[Varsayım: doğrulanmalı]**.
