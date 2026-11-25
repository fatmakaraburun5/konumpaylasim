# Konum backend (Faz 1 – Faz 6)

Firebase üzerinde Konum backend'i: Firestore ve Realtime Database (RTDB) güvenlik kuralları, Cloud Functions (2nd gen, Node 22) ve emülatörde çalışan testler.

- **Durum** (arkadaşlık, paylaşım, istek) Firestore'dadır. İstemci bu koleksiyonlara **yazmaz**. Her geçiş bir callable içinde, Firestore transaction'ı ile yapılır.
- **Canlı konum** RTDB'dedir: `live_locations/{receiver_id}/{share_id}`. Konum yolunda hiç Function çalışmaz. Gönderen, alıcı başına kopyayı kendisi yazar ve RTDB kuralları her yazmayı `share_acl/{share_id}` aynasına göre doğrular.
- Ortak sözleşme `packages/core`'dadır (modeller, süre motoru, paket, callable şemaları). `@konum/core` esbuild ile `functions/lib/index.js` içine gömülür, bu yüzden dağıtım yerel pakete ihtiyaç duymaz. **core ile `docs/BACKEND_SPEC.md` çeliştiğinde core geçerlidir.**

```text
backend/
  firebase.json            functions (source: functions), kurallar, dizinler, emülatör portları
  .firebaserc              varsayılan proje demo-konum + RTDB hedefi (live → demo-konum)
  firestore.rules          Firestore kuralları (varsayılan: kapalı)
  firestore.indexes.json   bileşik dizinler, token collection-group dizini, TTL alanları
  database.rules.json      share_acl kapalı (sunucu dizinleri: status, ended_at); live_locations yazma/okuma kuralları
  storage.rules            Faz 6: avatars/{uid}/{sürüm}.jpg + _160.jpg (yalnızca sahibi yazar / siler; JPEG, boyut sınırı)
  functions/
    build.mjs              esbuild paketleyici (core + zod gömülür)
    src/index.ts           tüm fonksiyonların dışa aktarımı (adlar = core CALLABLES)
    src/handlers/*.ts      saf iş mantığı (shares, friends, requests, user, sweeper)
    src/acl.ts             sürümlü ACL aynası, mezar taşı, acl_pending işaretleri, uzlaştırıcı
    src/lifecycle.ts       paylaşım bitirme (transaction + işaret)
    src/tasks.ts           süre dolumu görevleri (Cloud Tasks)
    src/push.ts            FCM: token sahipliği, koordinatsız bildirimler
    src/ops.ts             op_id ile tekilleştirme (istek özeti), hız sınırı
    src/linkAcl.ts         Faz 2: link_acl aynası, mezar taşı, link_live kesme, uzlaştırıcı
    src/handlers/links.ts  Faz 2: link_share_create / extend / stop, toplu bitirme, süre dolumu görevi
    src/handlers/maps.ts   Faz 2: route_compute / geocode_reverse (Google vekili, önbellek, kota)
    src/handlers/battery.ts  Faz 3: battery_low_notify (düşüş başına bir kez, yeniden kurma, günlük tavan)
    src/handlers/watchdog.ts Faz 3: uzun paylaşım duraksama bekçisi + live_trail budaması
    src/handlers/ping.ts, notes.ts, sos.ts  Faz 4: ping, yer notları, acil durum
    src/handlers/zones.ts    Faz 5: zone_upsert / zone_delete / zone_event_report (bölge tetikleri, soğuma, günlük tavan)
    src/handlers/meetup.ts   Faz 5: meetup_suggest (Places + Route Matrix vekili, önbellek, kota, yedekler) /
                             meetup_share / meetup_respond / meetup_cancel
    src/handlers/favorites.ts Faz 6: favorites_set (sıralı ≤ 4 favori, yalnızca arkadaşlar)
    src/handlers/widget.ts    Faz 6: widget_token_issue / revoke, widget_quick_share (oturumsuz, token'lı 1 sa
                             paylaşım), widget_refresh kararı
  hosting/
    public/.well-known/    apple-app-site-association + assetlinks.json (Universal Links / App Links)
    assemble.mjs           yayın klasörü: ../apps/web/dist + public → hosting/dist (predeploy)
    placeholder/           web derlemesi yokken yerel deneme sayfası (--placeholder)
  test/
    unit/                  sözleşme testleri (emülatör gerekmez)
    rules/                 @firebase/rules-unit-testing ile RTDB + Firestore kural testleri
    functions/             emülatörde uçtan uca callable ve bakım testleri
    review/                inceleme bulgularının regresyon testleri (kâhinler, kesme, silme yarışı)
```

## Kurulum

Gerekenler: Node 22, Java 11+ (Firestore/RTDB emülatörleri için; Java 21 ile denendi). `firebase-tools` devDependency olarak gelir, global kurulum gerekmez.

```bash
cd backend
npm ci
npm --prefix functions ci
```

`packages/core` için ayrıca `npm ci` gerekmez: core'un bağımlılıkları (zod) `functions/node_modules` içinden çözülür.

## Emülatörler ve testler

`demo-` önekli proje kimliği sayesinde emülatörler gerçek bir Firebase projesi ya da giriş olmadan çalışır.

```bash
# Functions'ı derle (emülatör functions/lib/index.js'i yükler)
npm run build

# Tüm testler (birim + kurallar + uçtan uca callable'lar)
npx firebase emulators:exec --project demo-konum --only auth,firestore,database,functions,storage "npx vitest run"
# kısayol: npm test   (önce build eder)
# HTTP(S) vekili arkasındaysan emülatör trafiği vekile gitmesin:
#   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npm test

# Yalnızca kural ve birim testleri (Functions/Auth gerekmez, daha hızlı)
npx firebase emulators:exec --project demo-konum --only firestore,database,storage "npx vitest run test/rules test/unit"
# kısayol: npm run test:rules

# Elle denemek için emülatörleri açık bırak (UI kapalı)
npm run emulators

# Tip kontrolü (functions + testler)
npm run typecheck
```

Portlar: Auth 9099, Firestore 8080, RTDB 9000, Functions 5001, Storage 9199 (hepsi `127.0.0.1`). Storage emülatörü
kural motoru için ilk çalıştırmada bir JAR indirir (`npx firebase setup:emulators:storage`). Callable adresi: `http://127.0.0.1:5001/demo-konum/europe-west1/<ad>`.

Notlar:

- **RTDB ad alanı:** demo projelerinde Functions emülatörü Admin SDK'yı `https://demo-konum.firebaseio.com` adresine (ad alanı `demo-konum`) bağlar. `firebase.json` içindeki `live` hedefi kuralları bu ad alanına yükler. Bir test, emülatördeki kuralların dosyayla aynı olduğunu doğrular. Uygulamayı emülatöre bağlarken de `?ns=demo-konum` kullanılmalıdır.
- **Zamanlanmış işler** emülatörde kendiliğinden çalışmaz (Pub/Sub emülatörü yok). Testler `sweepExpired({ now })` ve `sweepInactive({ now })` fonksiyonlarını enjekte edilen saatle doğrudan çağırır.
- **Cloud Tasks:** Functions emülatörü görev kuyruğu emülatörünü kendiliğinden açar. Emülatör `scheduleTime` değerini yok sayıp görevi hemen iletir; işleyici bu yüzden `early` döner ve hiçbir şey yapmaz. Testler `handleExpiryTask(data, now)` fonksiyonunu doğrudan çağırır.
- **FCM** emülatörde gönderilmez. Mesaj yalnızca loglanır.
- **HTTPS_PROXY kullanan ortamlar:** `firebase-tools`, `NO_PROXY` değişkenini okumaz ve `127.0.0.1` dahil her isteği proxy'ye yollar. Kurumsal proxy arkasında emülatör kuralları yüklenemezse (`Unable to parse JSON: "request bl..."`), CLI'ı localhost isteklerini doğrudan ileten bir yerel proxy ile çalıştırın.
- **Telefon HMAC anahtarı:** Emülatörde ve test sürecinde sabit bir geliştirme anahtarı kullanılır. Üretimde `PHONE_HMAC_PEPPER` secret'ı zorunludur (aşağıya bakın).

## Dağıtım

1. Projeyi ekleyin: `firebase use --add <proje-id>`.
2. RTDB örneğini **europe-west1**'de oluşturun ve hedefe bağlayın: `firebase target:apply database live <örnek-adı>`. Örnek adı genellikle `<proje-id>-default-rtdb` olur. [Varsayım: doğrulanmalı] Faz 1 tek örnekle açılır. Parçalama (`users.rtdb_instance`) için ek örnekler aynı hedefe eklenir.
3. Firestore'u `eur3` konumunda oluşturun. [Varsayım: doğrulanmalı] Firestore tetikleyicisi (`share_acl_reconciler`) ile `europe-west1` fonksiyon bölgesinin uyumu ilk dağıtımda doğrulanmalıdır.
4. Auth: telefonla girişi açın. SMS bölge politikasını yalnızca TR olarak ayarlayın, SMS toll fraud korumasını ve günlük SMS kotasını açın, bütçe alarmı kurun. Test numaralarını yalnızca geliştirme projesinde tanımlayın.
5. Secret: `firebase functions:secrets:set PHONE_HMAC_PEPPER` (en az 16 karakter, rastgele). Telefon engelleri (`phone_blocks`) bu anahtarla HMAC'lenir. Anahtar değişirse eski telefon engelleri eşleşmez, bu yüzden döndürmeden önce taşıma gerekir. [Varsayım: doğrulanmalı]
6. Cloud Tasks: Cloud Tasks API'yi açın. Süre dolumu kuyruğu `shareexpirytask` dağıtımda oluşturulur. Kuyruk kimliği fonksiyon kimliğidir ve alt çizgi içeremez. Fonksiyonların çalıştığı servis hesabı görev oluşturabilmeli (`roles/cloudtasks.enqueuer`) ve görevi kendi kimliğiyle imzalayabilmelidir (`roles/iam.serviceAccountUser`). [Varsayım: doğrulanmalı] Kuyruğa alma başarısız olursa dakikalık tarama yedek olarak devralır.
7. App Check: iOS için App Attest, Android için Play Integrity sağlayıcılarını kaydedin. Callable'larda `enforceAppCheck` üretimde açıktır. Emülatörde kendiliğinden kapanır. Staging'de hata ayıklamak için `APP_CHECK_ENFORCE=false` ortam değişkeni kullanılabilir. Firestore ve RTDB için App Check zorlamasını konsoldan açın.
8. Dağıtın:

   ```bash
   firebase deploy --only firestore:rules,firestore:indexes,database,functions
   ```

   `predeploy` adımı `typecheck` ve `build` çalıştırır. Yüklenen paket yalnızca `lib/index.js` ve `package.json` dosyalarından oluşur. Bulutta yalnızca `firebase-functions` ve `firebase-admin` kurulur.
9. TTL: `firestore.indexes.json` içindeki `purge_at` alanları (`ops`, `rate_limits`, `location_shares`, `location_requests`, `outgoing_requests`, `outgoing_request_links`, `deleted_users`) TTL politikası olarak dağıtılır. TTL alanı Firestore Timestamp türündedir. Bu, "tüm zamanlar epoch ms" kuralının tek istisnasıdır ve istemci bu alanı okumaz.

## Gizlilik modeli

1. **Okuma yalnızca kimliğe bağlıdır:** `live_locations/{uid}` dalını yalnızca `auth.uid == uid` okur. Mobil tüm gelen kutusunu tek dinleyiciyle dinler. RTDB'de üst düğümde verilen okuma alt düğümde geri alınamaz, bu yüzden okumanın süre dolumunda kesilmesi kurala değil sunucunun son paketi silmesine dayanır (bkz. 3).
2. **Yazma her pakette ACL'ye karşı doğrulanır:** ACL `active` olmalı, `sender_id == auth.uid` ve `receiver_id == $receiver_id` tutmalı, `expires_at > now` sağlanmalıdır. Kural BİRLEŞİK pakete bakar: paketteki `share_mode` ve `expires_at` ACL ile aynı olmalıdır (süresizde `expires_at` olmamalı). Böylece alt alan güncellemesi uzatmadan önceki bitişi taşıyamaz. Paket core `DELIVERED_FIELDS` dışında alan taşıyamaz (`receiver_ids` dahil). `server_ts` değeri `now` olmalı, `timestamp` [now−2 dk, now+60 sn] aralığında kalmalıdır. Yazma, kural gereği tam zamanında kesilir. Uzatmada sunucu saklanan paketin `expires_at` ve `share_mode` alanlarını da ACL'ye eşitler.
3. **Kesme gönderenin iş birliği olmadan olur:** Firestore commit, ardından ACL mezar taşı (`{status:'ended', version, ended_at}`), ardından canlı kopyanın silinmesi (alıcıda `child_removed`). ACL sürümlüdür: geç gelen eski bir "aç" yazısı yeni bir "kapat" kararını ezemez. Süre dolumunda her süreli sürüm için `expires_at` anına kuyruğa alınmış Cloud Tasks görevi (`shareexpirytask`) paylaşımı bitirir ve son paketi siler. Dakikalık tarama yedektir. **Kalan pencere:** görev çalışana kadar (tipik olarak birkaç saniye, görev başarısızsa en çok yaklaşık 1 dk) eski alıcı bitişten önceki SON paketi okuyabilir. Yeni paket yazılamaz.
4. **Ayna kaybı kapalı kalır (fail-closed):** Her durum değişikliği aynı transaction'da `acl_pending/{share_id}` işareti yazar. İşaret ayna uygulanınca silinir. Callable aynası başarısız olursa istemci aynı `op_id` ile tekrar dener. `share_acl_reconciler` tetikleyicisi `retry: true` ile çalışır. Dakikalık bakım 60 sn'den eski işaretleri belgeden yeniden uygular. Her 5 dakikada bir RTDB'deki TÜM aktif ACL'ler Firestore ile karşılaştırılır. Belge yoksa, aktif değilse ya da sürümü farklıysa ACL uzlaştırılır.
5. **Alıcı diğer alıcıları öğrenemez:** Her alıcının ayrı paylaşım belgesi ve ayrı canlı kopyası vardır, kopyada `receiver_ids` yoktur. Arkadaş olmayan ya da engelli alıcı nedeni söylenmeden atlanır.
6. **Sosyal grafik ve numara kâhini yok:**
   - Bekleyen arkadaşlık isteğini YALNIZCA hedef okur (`target_id`). İsteyen kendi bekleyen belgesini göremez.
   - İsteyenin görünümü `users/{uid}/outgoing_requests` koleksiyonudur. Hedef kayıtlı olsun olmasın, engelli ya da zaten arkadaş olsun, aynı maskeli kayıt yazılır ve kayıt hedefin uid'ini içermez. İptal `outgoing_id` ile yapılır.
   - `friend_request_cancel`, `friendship_remove` ve `friend_request_respond`, var olmayan ve üyesi olunmayan arkadaşlık için aynı yanıtı döner.
   - Engellenen engeli öğrenmez: paylaşılan belgelere `blocked` nedeni yazılmaz, paylaşımlar `friendship_removed` ile biter.
   - Telefon engeli: engellenen hesabın numarası HMAC ile `phone_blocks` koleksiyonuna da yazılır. Hesap silinip aynı numarayla yeniden açılsa bile engel geçerli kalır.
   - `avatar_url` yalnızca projenin Storage kovasındaki `avatars/{uid}/...` nesnesi olabilir. Bekleyen istekte avatar hiç kopyalanmaz.
   - Telefon numarası yalnızca `users_private` ve `phone_index` içinde durur ve istemciye kapalıdır.
7. **Asgari veri:** Konum geçmişi tutulmaz, alıcı başına yalnızca son paket saklanır. Bildirimler koordinat taşımaz. Biten paylaşım ve istekler 7 gün sonra TTL ile silinir. ACL mezar taşları 7 gün sonra bakımda silinir. `account_delete` hesabın tüm `share_acl` düğümlerini hemen siler. **Sınır:** Alıcıya ulaşmış veri geri alınamaz (ekran görüntüsü engellenemez). iOS'ta uygulama kaydırılarak kapatılırsa güncelleme durur. Alıcı paketin yaşını görür, sunucu ise süre dolunca son paketi yine siler.
8. **Geri dönüştürülmüş numara:** `user_bootstrap` en çok saatte bir `last_active_at` yazar. Günlük iş 30 gün pasif hesaba gelen paylaşımları bitirir. 180 gün pasif hesabın sosyal grafiğini sıfırlar, ancak cihaz son 30 günde konum yayınladıysa sıfırlamaz. Pasif hesaba yeni SMS girişinde aynı kontroller `user_bootstrap` içinde de çalışır. [Varsayım: ürün onayı gerekli]
9. **Kimlikler:** Callable'lar `[A-Za-z0-9-]{1,128}` dışındaki uid'leri reddeder, çünkü `_` belge kimliklerinde ayırıcıdır. Aynı `op_id` başka bir istekle (farklı komut ya da girdi özeti) kullanılırsa `invalid_argument` döner. Silinen hesap, hâlâ geçerli ID token'ı ile profil oluşturamaz (`deleted_users`). Yenileme token'ları silmede iptal edilir.

## Callable'lar

Bölge `europe-west1`. Her komut bir `op_id` (UUID v4) taşır. İlk yanıt `ops/{uid}_{op_id}` belgesine durum değişikliğiyle aynı transaction'da yazılır ve tekrar eden çağrıya aynen döner. İstisnalar: `user_bootstrap` için `op_id` isteğe bağlıdır, `account_delete` ise doğası gereği idempotenttir. Hatalar `HttpsError` olarak döner ve `details.code` alanı core `ERROR_CODES` değerlerinden birini taşır (`retryable` ile birlikte).

| Ad | Girdi | Etki |
|---|---|---|
| `user_bootstrap` | `{op_id?, display_name?, avatar_url?}` | İdempotenttir. `users/{uid}`, `users_private/{uid}.phone_e164` (kimlik belirtecinden), `phone_index/{e164}` ve `invite_codes/{code}` belgelerini yazar. Davet kodu `create()` ile oluşturulur, çakışmada yeniden denenir. `avatar_url` yalnızca Storage `avatars/{uid}/...` adresi olabilir. Kalp atışı (`last_active_at`) yazar. Silinmiş hesapta `unauthenticated` döner. |
| `invite_code_regenerate` | `{op_id}` | Yeni `LOC-XXXXXX` kodunu oluşturur ve eski kodu siler. Sınır: günde 5 [Varsayım]. |
| `friend_request_send` | `{op_id, via:'invite_code', invite_code}` ya da `{op_id, via:'phone', phone_e164}` | Her durumda `users/{ben}/outgoing_requests/{outgoing_id}` maskeli kaydını yazar (30 gün TTL). Hedef kayıtlıysa ve engel yoksa `friendships/{min}_{max}` belgesini `pending` olarak açar (`target_id`, isteyenin yalnızca adı). Karşı taraftan bekleyen istek varsa otomatik kabul eder. Yanıt her durumda `{status:'sent'}` olur. Sınır: saatte 20 [Varsayım]. |
| `friend_request_respond` | `{op_id, friendship_id, accept}` | Yalnızca hedef yanıt verir. Kabulde `accepted` yapar ve iki güncel profili kopyalar. Retçe belgeyi siler. İsteyenin giden kaydı kendi süresince "gönderildi" olarak kalır. Yok, üyesi değilim ya da kendi isteğim: `not-found`. |
| `friend_request_cancel` | `{op_id, outgoing_id}` ya da `{op_id, friendship_id}` | `outgoing_id`: giden kaydı ve (varsa) bağlı bekleyen belgeyi siler, yanıt her durumda aynıdır. `friendship_id` (geriye uyum): yok ya da üyesi değilim durumunda aynı başarı yanıtı döner. Kabul yarışı kazandıysa `failed-precondition` ve güncel durum döner. |
| `friendship_remove` | `{op_id, friendship_id}` | Arkadaşlığı siler. İki yöndeki paylaşımlar `friendship_removed` ile biter, bekleyen konum istekleri iptal olur. Yok ya da üyesi değilim durumunda aynı yanıt döner. |
| `user_block` | `{op_id, user_id}` | `blocks/{ben}_{o}` ve telefon engeli (`phone_blocks`, HMAC) yazar, arkadaşlığı siler. Paylaşımlar `friendship_removed` ile biter (engellenen engeli öğrenmez), istekler iptal olur. Yanıt hedef olsun olmasın aynıdır. |
| `user_unblock` | `{op_id, user_id}` | Engeli ve telefon engelini kaldırır. Arkadaşlık geri gelmez. |
| `share_start` | core `ShareStartRequestSchema` | Süreyi sunucu çözer (`resolveDuration` ve `time_zone`). Tek transaction'da `location_shares/{ben}_{alıcı}` belgesine upsert yapar: yeni `session_id`, `active`, `version+1`. Ardından ACL aynasını yazar. Arkadaş olmayan ya da engelli alıcı `skipped_receiver_ids` içinde döner. `in_response_to` verilirse isteği de kapatır. |
| `share_extend` | core `ShareExtendRequestSchema` (`minutes: 30 \| 60`) | Oturumdaki aktif ve süresi dolmamış paylaşımlara `extendExpiry` uygular: `version+1`, `extended_count+1`, ardından ACL. |
| `share_stop` | core `ShareStopRequestSchema` | Oturumu ya da alıcı alt kümesini `stopped_by_sender` ile bitirir. Sıra: commit, mezar taşı, canlı kopyanın silinmesi. |
| `share_revoke` | core `ShareRevokeRequestSchema` (`sender_id`) | Alıcı, gönderen → ben paylaşımını `revoked_by_receiver` ile bitirir. Sıra aynıdır. |
| `location_request_send` | core `LocationRequestSendSchema` | `location_requests/{ben}_{hedef}` belgesini `pending` olarak açar, 15 dk sonra `expired` olur. Çift başına tek bekleyen istek, 10 dk bekleme süresi, günde 30 istek [Varsayım]. Hedefin cihazlarına koordinatsız FCM gider: `{type:'location_request', request_id}`. |
| `location_request_respond` | core `LocationRequestRespondSchema` | Kabulde hedef → isteyen paylaşımı açılır (varsayılan 1 saat ya da verilen süre). Aktif paylaşım zaten en az o kadar sürüyorsa (ya da süresizse) değişmez. Daha kısaysa aynı oturumda uzatılır. Paylaşım ve istek aynı transaction'da güncellenir. Retçe `declined` olur. |
| `account_delete` | `{op_id, confirm: true}` | Sıra: (1) çit (`deleted_users` + `users.deleting`, yenileme token'ları iptal), (2) arkadaşlıklar ve giden istekler, (3) iki geçişte paylaşımlar `account_deleted` ile biter, canlı kopyalar ve gelen kutusu silinir, (4) istekler, kendi engelleri, op kayıtları, cihazlar, (5) hesabın tüm `share_acl` düğümleri, (6) profil ve indeksler, (7) Auth kullanıcısı. Başkalarının bu hesap hakkındaki engelleri kalır [Varsayım: hukuki onay]. |

Arka plan fonksiyonları:

| Ad | Tetik | Etki |
|---|---|---|
| `shareexpirytask` | Cloud Tasks, her süreli sürüm için `expires_at` anında | Sürüm hâlâ geçerliyse paylaşımı `expired` ile bitirir, mezar taşı yazar, son paketi siler. Erken gelirse en çok 30 sn bekler. Eski sürümün görevi hiçbir şey yapmaz. Mantık: `handleExpiryTask(data, now)`. |
| `share_expiry_sweeper` | Her 1 dakika [Varsayım] | Yedek: `status == active && expires_at <= now` olan paylaşımları partiler hâlinde `expired` ile bitirir. Her parti transaction içinde yeniden okunur, böylece arada uzatılan paylaşım bitirilmez. Süresi dolmuş istekleri `expired` yapar. 60 sn'den eski `acl_pending` işaretlerini uygular. Her 5. dakikada tüm aktif ACL'leri denetler ve 7 günden eski mezar taşlarını siler. Mantık: `sweepExpired({now, audit})`. |
| `share_acl_reconciler` | `onDocumentWritten(location_shares/{id})`, `retry: true` | ACL aynasını belgenin **güncel** hâlinden idempotent olarak yeniden uygular. Commit ile ayna arasında yaşanan bir çökmeyi kapatır. Belge silinmişse aynayı kapatır. |
| `inactive_account_sweeper` | Her 24 saat [Varsayım] | Pasif hesap süreci (30 gün: gelen paylaşımlar, 180 gün: sosyal grafik). Mantık: `sweepInactive({now})`. |

## Mobil uygulamadan beklenenler

Bu sürümün kuralları mobilin bugünkü bazı sorgularını reddeder:

- Arkadaş listesi iki sorgudan oluşmalıdır: `member_ids array-contains ben` + `status == 'accepted'` ve gelen istekler için `target_id == ben` + `status == 'pending'`. Kısıtsız `member_ids array-contains` sorgusu artık reddedilir.
- Giden istekler `users/{ben}/outgoing_requests` koleksiyonundan okunmalı, iptal `friend_request_cancel({op_id, outgoing_id})` ile yapılmalıdır.
- Çıkışta cihaz kendi `devices/{uid}/tokens/{token}` belgesini silmelidir. Sunucu da gönderimden önce token'ın son sahibini bulur.
- `user_bootstrap` her açılışta çağrılmaya devam etmelidir, çünkü pasif hesap süreci bu kalp atışına dayanır.

## Faz 2: QR / bağlantı paylaşımı, Maps vekili, Universal Links

### Bağlantı (QR) paylaşımı

| Ad | Girdi (core şeması) | Etki |
|---|---|---|
| `link_share_create` | `LinkShareCreateRequestSchema` `{op_id, duration, time_zone?}` | Sunucu `crypto.randomBytes(32)` → base64url token üretir. `link_shares/{link_id}` (yalnızca `token_hash` = sha256Hex(token)), `link_acl/{hash}` aynası, süre dolumu görevi. Yanıt `LinkShareCreateResponse`: `token` + `url` (`https://<LINK_DOMAIN>/s/<token>`) YALNIZCA bu yanıtta. Sınırlar: aynı anda 5 aktif (`link_limit_reached`), saatte 20 oluşturma (`rate_limited`) [Varsayım]. |
| `link_share_extend` | `LinkShareExtendRequestSchema` `{op_id, link_id, minutes: 30\|60}` | Faz 1 `extendExpiry`: max(bitiş, şimdi) + adım, en çok şimdi + 7 gün. `version+1`, ACL ve saklanan `link_live` paketinin `expires_at` alanı aynı çağrıda eşitlenir. Süresiz: `invalid_duration`, bitmiş: `share_not_active`, süresi dolmuş: `already_expired`. |
| `link_share_stop` | `LinkShareStopRequestSchema` `{op_id, link_id}` | Firestore commit → `link_acl` mezar taşı `{status:'ended', version, ended_at, end_reason}` → `link_live/{hash}` silinir; hepsi callable dönmeden. Açık web sekmesinin dinleyicisi `null` alır, yeni okuma kuralla reddedilir. İdempotent. |

- **Yok ve başkasının bağlantısı aynı yanıtı alır** (`link_not_found`): link_id taraması bilgi vermez.
- **op_id tekrarı ve düz token:** `ops` kaydı düz token ve URL TUTMAZ. Yanıtı kaybolan `link_share_create` aynı `op_id` ile tekrarlanırsa ve bağlantı hâlâ aktifse token YENİLENİR (yeni token, yeni `token_hash`, `version+1`); eski özetin ACL'si kapanır, eski `link_live` silinir. Eski token'ı kimse görmemiştir. Bağlantı bitmişse `share_not_active` (istemci yeni `op_id` ile oluşturur). [Varsayım] Bu yüzden `token_hash` yalnızca bu durumda değişebilir; mobil yayıncı `link_shares` belgesindeki güncel özeti kullanmalıdır.
- **Okuma kuralı süreyi kendisi keser:** `link_live/{hash}` okuması `link_acl/{hash}` aktif VE `expires_at > now` iken açıktır (kimlik gerekmez: token = yetki). Faz 1'deki "son paket penceresi" bağlantıda yoktur. Görev / tarama ayrıca belgeyi `expired` ile kapatır ve paketi siler.
- **Yazma:** yalnızca `auth.uid == link_acl/{hash}/sender_id`, ACL aktif ve süresi dolmamışken; alanlar core `LINK_LIVE_FIELDS` (sender_id, link_id, telefon, avatar, şarj, aktivite YOK); birleşik paketin `share_mode` ve `expires_at` alanları ACL ile aynı olmalı; `server_ts == now`, `timestamp` [now−2 dk, now+60 sn]. `link_live` ve `link_acl` üst düğümleri listelenemez.
- **Bitti sondur:** biten bağlantı yeniden açılmaz. Belge bitmişken aynı özetin ACL'si (sürüm ne olursa olsun) aktif görünürse kapatılır (fail-closed). Ayna kaybına karşı Faz 1 ile aynı üç katman: `link_acl_pending/{link_id}` işareti (eski token özeti dahil), `link_acl_reconciler` tetikleyicisi (`retry: true`), dakikalık bakım (eski işaretler, her 5 dk tüm aktif `link_acl` denetimi, 7 günden eski mezar taşlarının silinmesi).
- **Süre dolumu görevi** aynı kuyruğu kullanır (`shareexpirytask`, veri `{link_id, version}`, görev kimliği `link-{link_id}-v{version}-{expires_at}`): yeni kuyruk / IAM gerekmez.
- **Hesap silme:** aktif bağlantılar `account_deleted` ile biter, ardından `link_acl` düğümleri, işaretler ve `link_shares` belgeleri silinir (karşı taraf yok). `maps_quota` ve kullanıcıya özel `route_cache` kayıtları da silinir.
- **Firestore:** `link_shares` yalnızca gönderen okur (sorgu `sender_id == ben` [+ `status`]), kimse yazamaz. Bileşik dizinler: `(status, expires_at)`, `(sender_id, status)`. Biten belge 7 gün sonra TTL (`purge_at`).
- **Süre dolmak üzere bildirimi** Faz 1'deki gibi mobilde yereldir (`extendPromptAt(linkView)`, "+30 dk" / "+1 saat" aksiyonları `link_share_extend` çağırır). Sunucu push'u (`link_ending_soon`) bu sürümde gönderilmez [Varsayım].

### Google Maps sunucu vekili (Routes API, Geocoding API)

| Ad | Girdi | Etki |
|---|---|---|
| `route_compute` | `RouteComputeRequestSchema` `{op_id, origin, destination, travel_mode}` | `POST https://routes.googleapis.com/directions/v2:computeRoutes`, başlıklar `X-Goog-Api-Key` ve `X-Goog-FieldMask: routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline`. DRIVE'da `routingPreference: TRAFFIC_UNAWARE` (Essentials SKU) [Varsayım]; `ROUTES_DRIVE_PREFERENCE=TRAFFIC_AWARE` canlı trafik verir ama Pro SKU'dur. Yanıt `RouteComputeResponse`. Rota yok → `route_not_found`. |
| `geocode_reverse` | `GeocodeReverseRequestSchema` `{lat, lng}` | Geocoding API'ye kullanıcının tam konumu değil geohash-7 HÜCRE MERKEZİ sorulur (`language=tr`, `result_type` süzgeci). Yanıt `{label, cell, cached}`; ZERO_RESULTS → `label: null`. |

Maliyet ve kota koruması (sırayla): istemci yalnızca kart görünürken ve core `shouldRecomputeRoute` / `shouldReverseGeocode` true iken sorar → App Check → Firestore önbelleği (`route_cache` 5 dk ve kullanıcıya özel; `geocode_cache` 30 gün ve kullanıcılar arası paylaşılır [Varsayım: Google önbellek koşulları]; isabet kota yemez, anahtar gerektirmez) → kullanıcı başına günlük sınır (core `MAPS_DAILY_LIMITS`: route 200, geocode 100) → proje geneli günlük bütçe (varsayılan route 5000, geocode 5000 [Varsayım]; 10 parçalı sayaç, toplam bütçeyi aşmaz) → Google. Sayaç Google'dan ÖNCE transaction ile ayrılır; aşımda `quota_exceeded` (`details.scope: 'user' | 'global'`, `retry_after_ms`). Anahtar yok / Google hatası / 5 sn zaman aşımı → `maps_unavailable` (yeniden denenebilir). Loglarda koordinat, hücre, polyline, adres ya da URL yoktur.

Bütçe ve kapatma (kill switch): ortam değişkeni `MAPS_DAILY_BUDGET` (`5000` ya da `route=5000,geocode=3000`; 0 = kapalı) ve yeniden dağıtım gerektirmeyen Firestore `config/maps` belgesi `{disabled: true, route_daily_budget, geocode_daily_budget}` (örnek başına 60 sn önbellek). Ayrıca GCP konsolunda API başına günlük kota tavanı ve bütçe uyarısı kurulmalıdır.

### Universal Links / App Links ve web haritası (Firebase Hosting)

- `hosting/public/.well-known/apple-app-site-association`: `applinks`, `appIDs: ["TEAMID.com.example.konum"]` [Varsayım: gerçek Team ID], yol `/s/*`. `application/json`, yönlendirmesiz.
- `hosting/public/.well-known/assetlinks.json`: `com.example.konum`, `sha256_cert_fingerprints` yer tutucu [Varsayım: Play App Signing anahtarının SHA-256'sı].
- `firebase.json` → `hosting`: yayın klasörü `hosting/dist` (predeploy `hosting/assemble.mjs` oluşturur: `../apps/web/dist` + `hosting/public`). `/s/**` → `/index.html` (SPA). `/s/**` başlıkları: `Referrer-Policy: strict-origin` (yalnızca kök gönderilir, yol ve token ASLA; HTTP referrer kısıtlı Maps JS anahtarı kökü ister, anahtarsız sayfa `<meta name="referrer" content="no-referrer">` ile sıkılaştırır), `Content-Security-Policy: frame-ancestors 'none'` + `X-Frame-Options: DENY` (başka siteye çerçevelenmez), `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`. Genel `**` başlığı da `Referrer-Policy: strict-origin`.
- Web görüntüleyici sözleşmesi (`apps/web`): Vite `base: '/'`, giriş `dist/index.html`; token tarayıcıda `parseLinkToken` + `linkTokenHash` ile özetlenir, `link_live/{hash}` dinlenir (kimlik gerekmez). Routes / Geocoding ÇAĞIRMAZ.
- Mobil: iOS `associatedDomains: ["applinks:<LINK_DOMAIN>"]`, Android `intentFilters` (`autoVerify: true`, `https`, `<LINK_DOMAIN>`, `pathPrefix: /s/`) ve `app/s/[token].tsx` rotası (mobil ekibin işi).
- Yerel deneme: `node hosting/assemble.mjs --placeholder && npx firebase emulators:start --only hosting` (port 5050).

### Faz 2 dağıtım adımları

1. Alan adı: `functions/.env.<proje-id>` dosyasına `LINK_DOMAIN=<alan>` (varsayılan core `LINK_DOMAIN_DEFAULT = konum.example.com` [Varsayım]). Aynı alan Firebase Hosting'e bağlanır (özel alan adı, SSL).
2. Secret: `firebase functions:secrets:set GOOGLE_MAPS_SERVER_KEY`. Anahtar GCP'de YALNIZCA Routes API + Geocoding API'ye kısıtlanır (uygulama kısıtı: yok / sunucu IP'si). Harita servisini kapalı dağıtmak için değer `disabled` yapılabilir (callable'lar `maps_unavailable` döner). Mobil SDK anahtarları ayrıdır (paket adı / SHA-1 kısıtlı).
3. AASA `appIDs` ve assetlinks `sha256_cert_fingerprints` gerçek değerlerle değiştirilir.
4. Web: `npm --prefix ../apps/web ci && npm --prefix ../apps/web run build`.
5. `firebase deploy --only firestore:rules,firestore:indexes,database,functions,hosting`. TTL politikaları: `link_shares.purge_at`, `route_cache.expire_at`, `geocode_cache.expire_at`, `maps_quota.purge_at`, `maps_budget.purge_at`.
6. RTDB için App Check zorlaması açılırsa web görüntüleyicinin de App Check (reCAPTCHA Enterprise) kullanması gerekir; aksi hâlde kimliksiz okuma reddedilir [Varsayım: ürün kararı].

## Faz 3: arka plan takibi, çevrimdışı iz, düşük pil, duraksama bekçisi

**RTDB kuralları** (`database.rules.json`, yalnızca ekleme; Faz 1/2 alanlarının anlamı aynı):
- `live_locations` / `link_live`: core'un `hb`, `q`, (`recorded_at` yalnızca canlıda) alanları. `q === 1` noktası 24 sa'e kadar eski
  olabilir ama düğümdeki noktadan yeni ve **ACL `started_at`'ten eski olamaz** (önceki oturumun konumu sızmaz). Bu koşullar
  2 dk'lık taze pencere içindeki kuyruk noktası için de geçerlidir (taze pencere yalnızca `q` taşımayan pakete açık). `recorded_at` (cihaz
  saati) ≤ sunucu + 1 sa [Varsayım saat sapması payı]. `share_acl` / `link_acl` aktif değeri artık `started_at` taşır (Faz 3 öncesi
  aynalarda yok: kural `exists()` ile korunur).
- `live_trail/{receiver}/{share_id}/{point_id}`: çevrimdışı dönemin noktaları. Yazma: ACL aktif + gönderen + alıcı eşleşir + süresi
  dolmamış; `point_id` `^\d{13}-\d{3}$`; alanlar core `TRAIL_FIELDS`, `q === 1`, `server_ts === now`, `timestamp` ∈ [now − 24 sa,
  now + 60 sn] ve ≥ ACL `started_at`. Okuma: yalnızca alıcı. Üst düğüme toplu `set` reddedilir (core `trailBatchUpdate` çok yollu yazar).
- **Bağlantılara iz yok** (core `LINK_TRAIL_ENABLED = false`): `link_trail` düğümü tanımlı değil (kök kuralı reddeder).
- Paylaşım bitince (durdurma, geri alma, süre dolumu, arkadaşlık bitişi, engel, hesap silme) `removeLiveCopy` canlı kopyayı ve izi
  tek atomik çok yollu silmeyle kaldırır. Hesap silmede `live_trail/{uid}` tamamen silinir. Uzun paylaşımlarda bekçi 24 sa'ten eski
  iz noktalarını budar.

| Ad | Tür | Davranış |
| --- | --- | --- |
| `battery_low_notify` | callable `{op_id, session_id, battery_pct, is_charging?}` | Gönderen, core `lowBatteryTrigger` durumu değiştiğinde (bildirim / yeniden kurma) çağırır. Sunucu aynı saf fonksiyonu `battery_alerts/{uid}_{session_id}` durumuyla uygular: ≤ %15 → oturumun aktif alıcılarına bir kez FCM ("Ayşe'nin pili azaldı" / "Pil %14. Konum daha seyrek güncellenecek."; koordinat yok), ≥ %20 ya da şarj → yeniden kurulur, iki bildirim arası ≥ 30 dk, oturum başına 24 sa'te ≤ 6, saatte 30 çağrı. Yedek yeniden kurma: son bildirimden sonra yayınlanmış canlı paket `battery_pct ≥ 20` / `is_charging` gösteriyorsa. Yanıt `{status: notified\|rearmed\|suppressed\|noop, armed, receivers, server_now}`. Oturumun göndereni değilsen ya da aktif paylaşım yoksa `share_not_active`. Bağlantı izleyicilerine push yok (rozet `link_live.battery_pct`). |
| `share_stall_watchdog` | her 15 dk [Varsayım] | Aktif uzun paylaşımlar (haftalık, süresiz, > 8 sa): son paket `server_ts` (yoksa `started_at`) `max(4·hb, 45 dk)`'dan eskiyse (hb yoksa 10 dk) göndericiye yalnızca veri `resume_tracking` (sessiz uyandırma); ≥ 30 dk sonra hâlâ duraksamışsa ek olarak görünür "Konum paylaşımın duraksadı. Devam etmek için dokun." (`tracking_stalled`); sonra en erken 6 sa'te bir, dönem başına ≤ 4. Kayıt `location_shares/{id}.stall_nudges` (sürüm değişmez); yeni paket dönemi kapatır (`recovered_at`). Gönderen başına tek push. Mantık: `sweepStalls({now, send})`. |

**Uyandırma sınırları** [Varsayım: cihazda doğrulanmadı] — ayrıntı `functions/src/push.ts` `buildResumeTrackingPush`:
Android'de yüksek öncelikli veri mesajı Doze'da iletilir ve FGS'yi arka plandan yeniden başlatma istisnası verir (konum için arka plan
izni şart); görünür bildirime dönüşmeyen yüksek öncelikli mesajlar zamanla düşürülebilir, "Zorla durdur" ya da üretici pil yöneticisi
kısıtı varsa hiç iletilmez. iOS'ta `content-available` sessiz push saatte birkaçla sınırlıdır, Düşük Güç Modu'nda gecikir ve uygulama
kaydırılarak kapatıldıysa iletilmez; bu durumda görünür bildirim tek yoldur. Bildirim kanalı `share_status` (Android) mobilde
tanımlanmalıdır.

**Dağıtım:** yeni bileşik dizinler `location_shares (status, share_mode, started_at)` ve `(status, started_at)`; TTL
`battery_alerts.purge_at`; yeni fonksiyonlar `battery_low_notify`, `share_stall_watchdog`.

## Faz 4: ping, kısa notlar, tam konumlu SOS

Kod: `handlers/ping.ts`, `handlers/notes.ts`, `handlers/sos.ts`; push yükleri `push.ts` (`buildPingPush`, `buildSosPush`,
`buildSosResolvedPush`, `buildSosAckPush`). Hepsi europe-west1, App Check, `op_id` tekilleştirmesi, şemalar core'dan.

| Ad | Etki |
|---|---|
| `ping_send` | Kabul edilmiş + engelsiz arkadaşa "Buradayım / Yoldayım". Arkadaş değil / engelli / kendisi → `not_friends`. Aynı çifte 20 sn, saatte 30 → `rate_limited`. 5 dk'dan eski konum atılır. RTDB `ping_inbox/{to}/{ping_id}` (alıcı okur ve siler) + sunucu dizini `ping_expiry/{ping_id}`; alıcıya `ping` push (kanal `ping`, koordinat yok). `ping_id` = sha256(uid, op_id): tekrar aynı kaydı yazar, push yalnızca ilk sefer. |
| `place_note_upsert` / `place_note_delete` | Firestore `place_notes/{id}`. Metin/emoji `sanitizeNoteText`; `visible_to` tekilleştirilir, kendisi ve arkadaş olmayanlar sessizce atılır. Aktif not ≥ 20 → `note_limit_reached`; başkasının / süresi geçmiş not → `note_not_found`; olmayan notu silme `{deleted:false}`. |
| `emergency_contacts_set` | `users/{uid}.emergency_contacts` (≤ 5, sıra korunur, yalnızca arkadaşlar). Arkadaşlık kaldırma / engelleme karşı tarafı iki listeden ve yer notu kitlesinden çıkarır. |
| `sos_send` | Geçerli acil kişi yoksa `no_emergency_contacts`; saatte 10. Aktif SOS varsa aynı belge tazelenir ve yeniden push edilir (aynı `sos_id`). Adres yoksa ≤ 2 sn önbellek/Google (kota dışı, hata → null). Push: Android `priority: high`, kanal `sos`, `visibility: public`; iOS `apns-priority: 10`, `interruption-level: time-sensitive` ya da `SOS_CRITICAL_ALERTS=1` ise `critical` + kritik ses. Gövdede adres + doğruluk + pil, ham koordinat yok. |
| `sos_update` | Yalnızca gönderen, aktifken (`sos_not_active`); 15 sn'den sık çağrı mevcut belgeyi döndürür; push yok. |
| `sos_resolve` | Gönderen "Güvendeyim": `resolved / safe`, alıcılara `sos_resolved` (aynı tag / collapse-id ile alarmın yerine geçer). İdempotent. |
| `sos_ack` | Yalnızca alıcı: `acks.{uid}`; her alıcının ilk onayında gönderene `sos_ack`. |

Bakım (dakikalık tarama): süresi geçen pingler (`ping_expiry` → `ping_inbox`), süresi geçen yer notları silinir; 24 saati
aşan aktif SOS `resolved / timeout` olur. Hesap silme: kendi yer notları, ping kutusu ve gönderdiği pingler, aktif SOS
(`account_deleted`), başkalarının acil kişi listelerindeki ve not kitlelerindeki kaydı temizlenir. Canlı pakete isteğe bağlı
`note` (1–60) + `note_exp` (ikisi birlikte) eklendi; `link_live`'a not gitmez.

**Dağıtım:** yeni dizinler `sos_alerts (sender_id, status)`, `(status, created_at)`, `place_notes (owner_id, visible_to
CONTAINS)`; TTL `place_notes.purge_at`, `sos_alerts.purge_at`; `sos_send` / `sos_update` Maps secret'ını ister. iOS Critical
Alerts Apple onayından sonra `SOS_CRITICAL_ALERTS=1` ile açılır [Varsayım].

## Faz 6: favoriler, widget'tan tek tuşla 1 saat, profil fotoğrafı, cinsiyet

Kod: `handlers/favorites.ts`, `handlers/widget.ts`, `handlers/user.ts` (cinsiyet + avatar), `handlers/shares.ts`
(`writeShareStarts`: `share_start` ile hızlı paylaşımın ORTAK başlatma adımı), push yükleri `push.ts`
(`buildQuickShareStartedPush`, `buildWidgetRefreshPush`). Şemalar ve kararlar core'da (`profile.ts`, `favorites.ts`,
`quickShare.ts`).

| Ad | Etki |
|---|---|
| `user_bootstrap` | Profil oluşturulurken `gender` (`female` / `male`) zorunlu → yoksa `gender_required`; sonra isteğe bağlı, `null` reddedilir. `avatar_url` + `avatar_thumb_url`: projenin kovasında `avatars/{uid}/{13 hane}.jpg` ve aynı sürümün `_160.jpg` kardeşi (`checkAvatarPair`); `avatar_url: null` üçünü (`avatar_thumb_url`, `avatar_version`) temizler. Ad / fotoğraf / cinsiyet değişince kabul edilmiş arkadaşlıkların `member_profiles` kopyasına yayılır (bekleyen istekte yalnızca ad). Fotoğraf değişince önceki sürümün iki nesnesi silinir (en iyi çaba). |
| `favorites_set` | `users/{uid}.favorite_ids` (sıralı, ≤ 4, tekrarsız). Arkadaş olmayan / engelli / kendisi sessizce düşer. Arkadaşlık kaldırma, engel, pasif hesap sıfırlaması ve hesap silme karşı tarafın listesini de temizler. |
| `widget_token_issue` | Oturum + App Check. Cihaza özel 43 karakterlik token (30 gün); yalnızca `widget_tokens/{sha256}` saklanır, `ops` kaydı TUTULMAZ (düz token yanıtta bir kez). Aynı cihazın eski token'ı iptal; kullanıcı başına ≤ 5 aktif, günde ≤ 20 üretim [Varsayım]. |
| `widget_token_revoke` | `device_id` ya da `null` (tümü, çıkışta). `{revoked: n}`. |
| `widget_quick_share` | **Oturumsuz, App Check'siz** (`tokenCallable`). Token → sahibi; hedef favori değilse `not_favorite`, arkadaş değilse `not_friend`, token yok / iptal `token_invalid`, süresi dolmuş `token_expired`, token başına saatte 6 başarılı çağrı `rate_limited`. Aktif paylaşım varsa bitiş = max(mevcut, şimdi + 60 dk) (`extended` / `already_active`), yoksa yeni 60 dk (`started`). Sonra gönderene sessiz `resume_tracking` + görünür `quick_share_started` (iOS kategori `QUICK_SHARE`, "Durdur" eylemi `QUICK_SHARE_STOP`; ikisi de core `QUICK_SHARE_NOTIFICATION`, uygulama aynı sabitle kaydeder). |

`widget_refresh` (yalnızca veri, content-available): `share_acl_reconciler` tetikleyicisi paylaşımın aktifliği değişince
(başladı / bitti, her yol) alıcı paylaşanı favorilerinde tutuyorsa gönderir. Storage: `storage.rules` yalnızca sahibine
JPEG yazma (ana ≤ 400 KB, küçük ≤ 60 KB), meta veri okuma (`getDownloadURL` için) ve silme izni verir; arkadaşlar
indirme token'lı URL'yi kullanır. Firestore: `widget_tokens` kapalı.

**Dağıtım:** `firebase deploy --only storage` (yeni `storage.rules`), TTL `widget_tokens.purge_at`; Functions servis
hesabının Storage nesnelerini silme yetkisi olmalı (varsayılan hesapta var).

## Varsayımlar ve açık noktalar

- Bölgeler (Firestore `eur3`, RTDB ve Functions `europe-west1`) ve KVKK yurt dışı aktarımı [Varsayım: doğrulanmalı].
- Sınırlar `functions/src/config.ts` içindedir ve hepsi [Varsayım] etiketlidir: istek ve kod sınırları, TTL süreleri, tarama ve denetim aralığı, pasif hesap eşikleri, kullanıcı başına token sınırı.
- Süre dolumunda okuma, kural yerine görevle kesilir. Kalan pencere birkaç saniyedir (görev başarısızsa en çok yaklaşık 1 dk). Kuralla kesmek, ACL'li alt düğüm dinleyicilerine geçmeyi gerektirir (mobil + core).
- Pasif hesaba gelen paylaşımlar `expired` nedeniyle biter, çünkü core'da `receiver_inactive` yoktur. Geri dönen gerçek sahibe yeniden doğrulama ekranı ve gönderenlere bildirim henüz yoktur.
- Faz 2 yapıları (`link_shares`, `link_acl`, `link_live`, Maps önbellek / kota koleksiyonları) Faz 1 yapısını değiştirmeden eklendi. Faz 1 alanlarının anlamı değişmedi.
- Faz 2 sınırları ve fiyat varsayımları `functions/src/config.ts` (`LIMITS.linkCreatePerHour`, `MAPS`) ve core `LINK_LIMITS` / `mapsPolicy.ts` içindedir; hepsi [Varsayım].
- Kota birimi Google çağrısından önce ayrılır ve başarısız çağrıda geri verilmez (kötüye kullanımda da sayaç işler). Proje geneli bütçe 10 parçaya bölünür: toplam asla aşılmaz, en çok 9 çağrı eksik kalabilir.
- `route_cache` polyline (konum izi) içerir: TTL 5 dk ama Firestore TTL silmesi 24 saate kadar gecikebilir; hesap silmede hemen silinir.
