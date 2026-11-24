# Mimari (Faz 1–3)

Bu dosya kodun nasıl bir araya geldiğini kısaca anlatır. Ayrıntılar kodda ve alt README'lerdedir. Çelişki olursa `packages/core` geçerlidir. Faz 2 (harita, ETA, QR bağlantısı, web haritası, Maps maliyeti) ayrıntısı: [`PHASE2.md`](PHASE2.md). Faz 3 (arka plan takibi, pil, çevrimdışı kuyruk) ayrıntısı: [`PHASE3.md`](PHASE3.md).

## Bileşenler

| Katman | Yer | Görev |
| --- | --- | --- |
| Çekirdek sözleşme | `packages/core` | Modeller, süre motoru (`resolveDuration`, `extendExpiry`), konum paketi (`buildPackets`), takip profilleri (`selectTrackingProfile`, `shouldPublish`), paylaşım reducer'ı (`sharingReducer`), callable şemaları, Türkçe metinler |
| Ekranlar | `apps/mobile/app`, `src/features` | `MapHome` (TopBar, MapCanvas, FriendMarker, IncomingStrip, ActiveShareCard, ExpiryBanner, ShareButton), `ShareSheet` (RecipientPicker, DurationPicker, CustomDurationPicker), `PermissionFlow`, `FriendsScreen`, giriş akışı |
| State | `apps/mobile/src/state` | zustand store'ları. `sharingStore` core reducer'ını sarar. `stopIntents` kullanıcının durdurma kararını yayından önce kalıcı yazar |
| Servisler | `apps/mobile/src/services` | `location/pipeline` (örnek → yayın kararı → yazma), `location/backgroundTask` (TaskManager), `firebase/publisher` (RTDB fan-out), `notifications` (+30 dk / +1 saat eylemleri), `sharingCoordinator` (dinleyicileri oturuma bağlar) |
| Backend | `backend/functions` | Callable'lar (paylaşım başlat, uzat, durdur, kapat; arkadaşlık; istek), dakikalık süpürücü, Cloud Tasks ile süre dolumu, FCM |
| Kurallar | `backend/firestore.rules`, `backend/database.rules.json` | Okuma kimliğe, yazma ACL'ye, süreye ve alan listesine bağlı |
| Faz 2: çekirdek | `packages/core/src/{link,markerMotion,mapsPolicy}.ts` | Token/özet/URL (`parseLinkToken`, `linkTokenHash`), `link_live` paketi ve ekran durumu (`linkViewState`), pin geçiş kuralı (`markerTransition`), rota/adres yeniden hesap ve önbellek kuralları, polyline, Türkçe ETA metinleri |
| Faz 2: harita ve QR (mobil) | `apps/mobile/src/features/{map,link,share}`, `state/linkStore.ts`, `services/maps` | `EtaCard` + `useEta`, `useMarkerMotion`, `LinkQrSheet`, `ActiveLinkCard`, `app/s/[token].tsx` izleyicisi, `linkPublisher` (`link_live` yazar), `routesRepo` / `geocodeRepo` (callable üzerinden, önbellekli) |
| Faz 2: backend | `backend/functions/src/handlers/{links,maps}.ts`, `linkAcl.ts` | `link_share_create/extend/stop`, `link_acl` aynası ve mezar taşı, `link_acl_reconciler`, Maps vekili `route_compute` / `geocode_reverse` (önbellek, kullanıcı kotası, proje bütçesi) |
| Faz 2: web haritası | `apps/web` | Vite + React salt okunur görüntüleyici: `/s/<token>` → token adresten silinir → kimliksiz `link_live/{hash}` dinlenir; Google Maps JS isteğe bağlı |
| Faz 2: barındırma | `backend/hosting`, `backend/firebase.json` | AASA + assetlinks (Universal/App Links), `/s/**` → web haritası, güvenlik başlıkları |
| Faz 3: çekirdek | `packages/core/src/{motion,trackingMatrix,outbox,battery,receiverStatus,permissionFlow,simulate}.ts` | Hareket durumu makinesi, `TRACKING_MATRIX` + `selectTrackingPlan`, kuyruk planı (`enqueueOutbox`, `planFlush`, `live_trail`), `lowBatteryTrigger` + push metni, `lastVerifiedLocation` / `receiverStatusOf`, `nextPermissionStep`, `simulateTrace` |
| Faz 3: mobil | `apps/mobile/src/services/{location/adaptive,outbox}`, `modules/konum-activity`, `features/permissions` | Uyarlamalı takip (plan → OS isteği, uyku çiti, 60 sn zamanlayıcı), SQLite kuyruk + boşaltma, hareket etkinliği yerel modülü, kademeli izin akışı, alıcıda son doğrulanmış konum ve kesikli iz |
| Faz 3: backend | `backend/functions/src/handlers/{battery,watchdog}.ts`, `database.rules.json` | `battery_low_notify` (oturum başına bir kez), `share_stall_watchdog` (sessiz → görünür dürtme, iz budama), `live_trail` kuralları, ACL `started_at` |
| Faz 3: e2e | `apps/web/e2e/faz3/` | Gerçek emülatörlerde mobil yayıncı + kuyruk + bekçi kabul testi (`run-faz3.sh`) |

## Paylaşım başlatma

1. Kullanıcı `ShareSheet`'te alıcıları ve süreyi seçer. `resolveDuration` bitiş zamanını hesaplar ve önizleme metnini üretir ("22:00'ye kadar paylaşılacak").
2. `share_start` callable çağrılır (op_id ile tekrar güvenli). Sunucu Firestore'da `location_shares/{sender_receiver}` kaydını transaction ile açar, `share_acl/{share_id}` aynasını yazar, süre dolumu görevini kurar.
3. İstemci sunucu onayını alana kadar yayın yapmaz (`selectPublishTargets`, `pending` oturumları dışarıda bırakır).
4. Onaydan sonra arka plan konum görevi başlar. Android'de `location` tipli ön plan servisi kullanılır.

## Konum akışı (her örnek)

```text
expo-location örneği
  → pipeline: kalıcı hedefleri yükle, süresi dolanı ve durdurulanı ele
  → normalizeSample → selectTrackingProfile (ön plan 5 sn/10 m, arka plan 30 sn/25 m, duran, düşük pil)
  → shouldPublish (ilk örnek, hareket, nabız, pil eşiği, alıcı değişimi; doğruluk dairesindeki titreme sayılmaz)
  → publisher: buildPackets → toFanoutUpdate → RTDB'ye tek çoklu yazma
       live_locations/{receiver_id}/{share_id} = DeliveredLocation (receiver_ids yok, server_ts var)
  → imleci kaydet; hedef kalmadıysa takibi kapat
```

Faz 3 ekleri (ayrıntı `PHASE3.md`):

```text
örnek / OS etkinliği / uyku çiti çıkışı / 60 sn tick / resume_tracking push
  → motionReducer → selectTrackingPlan (hareket × ön/arka × pil) → gerekirse OS isteğini yeniden kur
  → çevrimiçi: ÖNCE kuyruğu boşalt (canlıya q: 1 + recorded_at, live_trail partileri), SONRA taze yayın (hb ile)
  → çevrimdışı: outboxRepo.enqueue (SQLite, ≤ 2000 nokta, 24 sa)
  → pil ≤ %15 (oturum başına bir kez): battery_low_notify → FCM (koordinat yok)
```

Konum yolunda hiç Cloud Function çalışmaz. RTDB kuralları her yazmada `share_acl` aynasının aktif ve süresinin dolmamış olduğunu, yazanın göndereni olduğunu ve alanların izinli listede olduğunu doğrular.

## Uzatma ve bitiş

- Bitişe `extendPromptLeadMs` kadar kala (toplam sürenin %20'si, en az 3, en çok 15 dk) yerel bildirim ve harita bandı çıkar. `+30 dk` ve `+1 saat` bildirimden de çalışır.
- `share_extend`: yeni bitiş = max(şimdiki bitiş, şimdi) + adım, en fazla şimdi + 7 gün. "Gün sonuna kadar" uzatılınca süreli olur.
- Durdurma, alıcının kapatması, süre dolumu, arkadaşlığın kaldırılması, engelleme ve hesap silme aynı `lifecycle` yolunu izler: Firestore commit → ACL mezar taşı (sürüm artar) → alıcı kopyası silinir. Gönderenin telefonu çevrimdışı olsa da kesme sunucuda olur.

## Bağlantı (QR) paylaşımı (Faz 2)

1. `link_share_create` (op_id): sunucu 32 bayt token üretir, `link_shares/{link_id}` belgesine YALNIZCA `token_hash`
   yazar, `link_acl/{hash}` aynasını kurar, süre dolumu görevini planlar; token + URL yalnızca yanıtta döner.
2. Gönderen cihaz URL'yi SecureStore'da tutar ve QR'ı gösterir. Konum akışı Faz 1 ile aynıdır; yayıncı arkadaş fan-out'una
   ek olarak AYRI bir `update()` ile `link_live/{hash}` yazar (yalnızca `LINK_LIVE_FIELDS`).
3. QR'ı okutan: uygulama kuruluysa `app/s/[token].tsx`, değilse `apps/web`; ikisi de token'ı cihazda özetler ve
   `link_live/{hash}`'i kimliksiz dinler. Okuma kuralı `link_acl` aktif ve süresi dolmamışken izin verir.
4. Durdurma / süre dolumu / hesap silme: Firestore commit → `link_acl` mezar taşı → `link_live` silinir. Açık sekme
   "Paylaşım sona erdi" gösterir, yeni okuma reddedilir.

## Gizlilik modeli

- Alıcı yalnızca `live_locations/{kendi_uid}` altını okur. Gönderenin kime paylaştığını göremez.
- `share_acl` istemciye tamamen kapalıdır.
- Firestore koleksiyonlarına istemci yazamaz. Her durum geçişi callable içinden geçer.
- Bekleyen arkadaşlık isteğini yalnızca hedef okur. Gönderilen istekler `users/{uid}/outgoing_requests` altında, yalnızca sahibine açıktır.
- Push bildirimleri koordinat taşımaz.
- Faz 2: QR token'ı sunucuda saklanmaz (yalnızca SHA-256 özeti); token sahibi yalnızca `link_live/{hash}` görür, gönderen
  kimliği, telefon ve alıcı listesi pakette yoktur. Web sayfası token'ı adres çubuğundan siler, ağa yalnızca özet çıkar.
- Faz 2: Google'a ters geocode için kullanıcının tam konumu değil geohash-7 hücre merkezi sorulur; rota önbelleği
  kullanıcıya özeldir. Maps anahtarları istemciye inmez (sunucu anahtarı Secret Manager'da).
- Telefon numaraları sunucuda HMAC (gizli `PHONE_HMAC_PEPPER`) ile aranır, düz metin dizinlenmez.
- Faz 3: çevrimdışı iz (`live_trail`) yalnızca arkadaş alıcıya açıktır, en çok 24 sa tutulur ve paylaşım bitince canlı
  kopyayla aynı atomik silmede kalkar. QR bağlantısında iz, `recorded_at` ve `is_charging` yoktur. "Durdur" kuyruktaki
  noktaları hemen siler. Düşük pil ve duraksama bildirimleri koordinat taşımaz. Hareket etkinliği cihazdan çıkmaz
  (yalnızca pakette `activity_state` ve `hb`).

## Yollar

| Yol | Depo | Okur | Yazar |
| --- | --- | --- | --- |
| `users/{uid}` (+ `outgoing_requests`) | Firestore | sahibi | callable |
| `friendships/{a_b}` | Firestore | üyeler (kabul), hedef (bekleyen) | callable |
| `location_shares/{sender_receiver}` | Firestore | gönderen, alıcı | callable |
| `location_requests/{id}` | Firestore | iki taraf | callable |
| `blocks/{id}` | Firestore | engelleyen | callable |
| `devices/{uid}/tokens/{token}` | Firestore | sahibi | sahibi (biçim doğrulamalı) |
| `share_acl/{share_id}` | RTDB | yok | sunucu |
| `live_locations/{receiver}/{share_id}` | RTDB | alıcı | gönderen (ACL ile) |
| `link_shares/{link_id}` | Firestore | gönderen (`sender_id == auth.uid`) | callable |
| `link_acl_pending/{link_id}` | Firestore | yok | sunucu (ayna onarım işareti) |
| `route_cache/{başlangıç.hedef.mod.dilim.uid}` | Firestore | yok | sunucu (5 dk TTL) |
| `geocode_cache/{geohash7}` | Firestore | yok | sunucu (30 gün TTL) |
| `maps_quota/{uid}_{gün}`, `maps_budget/{gün}_{parça}` | Firestore | yok | sunucu (günlük sayaçlar, TTL) |
| `config/maps` | Firestore | yok | yönetici (bütçe, acil kapatma) |
| `link_acl/{token_hash}` | RTDB | yok | sunucu (aktif ayna ya da mezar taşı) |
| `link_live/{token_hash}` | RTDB | token'ı bilen (kimliksiz), ACL aktif ve süresi dolmamışken | gönderen (ACL ile, yalnızca `LINK_LIVE_FIELDS`) |
| `live_trail/{receiver}/{share_id}/{point_id}` | RTDB | alıcı | gönderen (ACL aktif, yalnızca `TRAIL_FIELDS`, `q: 1`, 24 sa, ≥ `started_at`); sunucu siler |
| `battery_alerts/{uid}_{session_id}` | Firestore | yok | sunucu (düşük pil tetikleyici durumu, TTL) |
| `location_shares/{id}.stall_nudges` | Firestore | (istemci şeması atar) | sunucu (bekçi kaydı, sürüm değişmez) |

## Bilinen açıklar

- Gerçek cihazda ve gerçek Firebase projesinde denenmedi. Faz 2 Google API'leri gerçek anahtarla denenmedi; alan adı,
  AASA ve assetlinks değerleri yer tutucu (bkz. `PHASES.md`, Faz 2 → Faz 3).
- Mobilde "Konum Paylaşımı İste" (`location_requests`) ekranı henüz yok. Backend ve sözleşme hazır.
- `eas.json` yok. iOS'ta AsyncStorage yedekten hariç tutulmuyor.
- Süre dolduktan sonra son paket, süpürücü çalışana kadar birkaç saniye ile 1 dakika arasında okunabilir kalabilir. Okuma kuralı süreye de baktığı için yeni yazma kabul edilmez.
- Faz 3: `modules/konum-activity` (Swift/Kotlin) derlenmedi; Android'de expo-location FGS'yi arka planda yeniden
  yapılandıramıyor (satır değişikliği ön plana dönüşte uygulanır). Zorla kapatılan uygulamaya push ulaşmaz.
  Pil tüketimi gerçek cihazda ölçülmedi (`PHASE3.md` §4.3).

## Çekirdek iş listesi

Mobil ve backend şu an bunları kendi içinde tanımlıyor. Faz 2'den önce `packages/core`'a taşınmalı:

- Callable yanıt şemaları (şimdi yalnızca istek şemaları core'da).
- `Friendship.target_id` alanı ve `OutgoingRequest` modeli.
- `ShareAcl` için `share_mode` ve `ended_at`.
- `receiver_inactive` bitiş nedeni.
- `_` içermeyen uid şeması (deterministik kimlikler `_` ile ayrılıyor).
- `PublishTarget` üzerinde `session_id` ve `version`.
- Kalıcı durdurma niyeti (`stopIntents`) sözleşmesi.
- `SERVER_SNAPSHOT` olayında sürüm karşılaştırması.
