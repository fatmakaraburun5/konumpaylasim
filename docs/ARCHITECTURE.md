# Mimari (Faz 1–6)

Bu dosya kodun nasıl bir araya geldiğini kısaca anlatır. Ayrıntılar kodda ve alt README'lerdedir. Çelişki olursa `packages/core` geçerlidir. Faz 2 (harita, ETA, QR bağlantısı, web haritası, Maps maliyeti) ayrıntısı: [`PHASE2.md`](PHASE2.md). Faz 3 (arka plan takibi, pil, çevrimdışı kuyruk) ayrıntısı: [`PHASE3.md`](PHASE3.md). Faz 4 (ping, kısa notlar, tam konumlu SOS) ayrıntısı: [`PHASE4.md`](PHASE4.md). Faz 5 (varış / ayrılış tetikleyicileri, buluşma noktası) ayrıntısı: [`PHASE5.md`](PHASE5.md). Faz 6 (widget'lar, tek dokunuşla 1 saat, profil fotoğrafı, cinsiyet çerçevesi) ayrıntısı: [`PHASE6.md`](PHASE6.md). Mağaza yayını öncesi liste: [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md).

## Bileşenler

| Katman | Yer | Görev |
| --- | --- | --- |
| Çekirdek sözleşme | `packages/core` | Modeller, süre motoru (`resolveDuration`, `extendExpiry`), konum paketi (`buildPackets`), takip profilleri (`selectTrackingProfile`, `shouldPublish`), paylaşım reducer'ı (`sharingReducer`), callable şemaları, Türkçe metinler |
| Ekranlar | `apps/mobile/app`, `src/features` | `MapHome` (TopBar, MapCanvas, FriendMarker, IncomingStrip, ShareDeck (alt kitapçık, docs/SHARE_DECK.md), ExpiryBanner, ShareButton), `ShareSheet` (RecipientPicker, DurationPicker, CustomDurationPicker), `PermissionFlow`, `FriendsScreen`, giriş akışı |
| State | `apps/mobile/src/state` | zustand store'ları. `sharingStore` core reducer'ını sarar. `stopIntents` kullanıcının durdurma kararını yayından önce kalıcı yazar |
| Servisler | `apps/mobile/src/services` | `location/pipeline` (örnek → yayın kararı → yazma), `location/backgroundTask` (TaskManager), `firebase/publisher` (RTDB fan-out), `notifications` (+30 dk / +1 saat eylemleri), `sharingCoordinator` (dinleyicileri oturuma bağlar) |
| Backend | `backend/functions` | Callable'lar (paylaşım başlat, uzat, durdur, kapat; arkadaşlık; istek), dakikalık süpürücü, Cloud Tasks ile süre dolumu, FCM |
| Kurallar | `backend/firestore.rules`, `backend/database.rules.json` | Okuma kimliğe, yazma ACL'ye, süreye ve alan listesine bağlı |
| Faz 2: çekirdek | `packages/core/src/{link,markerMotion,mapsPolicy}.ts` | Token/özet/URL (`parseLinkToken`, `linkTokenHash`), `link_live` paketi ve ekran durumu (`linkViewState`), pin geçiş kuralı (`markerTransition`), rota/adres yeniden hesap ve önbellek kuralları, polyline, Türkçe ETA metinleri |
| Faz 2: harita ve QR (mobil) | `apps/mobile/src/features/{map,link,share}`, `state/linkStore.ts`, `services/maps` | `EtaCard` + `useEta`, `useMarkerMotion`, `LinkQrSheet`, `ShareDeck` içindeki QR kartı, `app/s/[token].tsx` izleyicisi, `linkPublisher` (`link_live` yazar), `routesRepo` / `geocodeRepo` (callable üzerinden, önbellekli) |
| Faz 2: backend | `backend/functions/src/handlers/{links,maps}.ts`, `linkAcl.ts` | `link_share_create/extend/stop`, `link_acl` aynası ve mezar taşı, `link_acl_reconciler`, Maps vekili `route_compute` / `geocode_reverse` (önbellek, kullanıcı kotası, proje bütçesi) |
| Faz 2: web haritası | `apps/web` | Vite + React salt okunur görüntüleyici: `/s/<token>` → token adresten silinir → kimliksiz `link_live/{hash}` dinlenir; Google Maps JS isteğe bağlı |
| Faz 2: barındırma | `backend/hosting`, `backend/firebase.json` | AASA + assetlinks (Universal/App Links), `/s/**` → web haritası, güvenlik başlıkları |
| Faz 3: çekirdek | `packages/core/src/{motion,trackingMatrix,outbox,battery,receiverStatus,permissionFlow,simulate}.ts` | Hareket durumu makinesi, `TRACKING_MATRIX` + `selectTrackingPlan`, kuyruk planı (`enqueueOutbox`, `planFlush`, `live_trail`), `lowBatteryTrigger` + push metni, `lastVerifiedLocation` / `receiverStatusOf`, `nextPermissionStep`, `simulateTrace` |
| Faz 3: mobil | `apps/mobile/src/services/{location/adaptive,outbox}`, `modules/konum-activity`, `features/permissions` | Uyarlamalı takip (plan → OS isteği, uyku çiti, 60 sn zamanlayıcı), SQLite kuyruk + boşaltma, hareket etkinliği yerel modülü, kademeli izin akışı, alıcıda son doğrulanmış konum ve kesikli iz |
| Faz 3: backend | `backend/functions/src/handlers/{battery,watchdog}.ts`, `database.rules.json` | `battery_low_notify` (oturum başına bir kez), `share_stall_watchdog` (sessiz → görünür dürtme, iz budama), `live_trail` kuralları, ACL `started_at` |
| Faz 3: e2e | `apps/web/e2e/faz3/` | Gerçek emülatörlerde mobil yayıncı + kuyruk + bekçi kabul testi (`run-faz3.sh`) |
| Faz 6: çekirdek | `packages/core/src/{widget,quickShare,favorites,profile}.ts` | Widget anlık görüntüsü (`buildWidgetSnapshot`, ≤ 16 KB, `widgetSnapshotChanged`, `widgetSyncDecision`), hızlı paylaşım yönlendirmesi (`quickShareRoute`) ve sunucu kararı (`quickShareExpiry`), token biçimi ve hız sınırı, `QUICK_SHARE_NOTIFICATION`, favori kuralları (≤ 4), `GENDER_RING`, `initialsOf`, avatar yolları ve `checkAvatarPair` |
| Faz 6: mobil | `apps/mobile/src/{services/widgets,services/profile,features/profile,features/quickShare}`, `state/{favoritesStore,profileStore,quickShareStore,widgetStore}.ts`, `services/f6Services.ts` | `widgetSync` (anlık görüntü yazma / yenileme kısıtı), `widgetBridge` (yerel modül köprüsü, web'de no-op), fotoğraf hattı (`avatarPipeline`: kırp, 512 + 160 px JPEG, `avatarUpload`), `GenderPicker` / `GenderGate`, `ProfileScreen`, `QuickShareSheet`, `app/quick-share.tsx` derin bağlantısı, "Durdur" bildirim eylemi |
| Faz 6: native | `apps/mobile/targets/widgets` (Swift, `@bacons/apple-targets`), `modules/konum-widgets` (Expo modülü: iOS App Group yazıcı, Android AppWidget / Hızlı Ayar / WorkManager, config plugin) | iOS 17 WidgetKit (ana ekran + kilit ekranı, `StartQuickShareIntent`), Android RemoteViews 2x2 / 4x2, `QuickShareReceiver`, `QuickShareTileService`; widget token'ı anahtarlık (App Group erişim grubu) / AndroidKeyStore'da |
| Faz 6: backend | `backend/functions/src/handlers/{widget,favorites,user}.ts`, `backend/storage.rules` | `widget_token_issue/revoke`, `widget_quick_share` (oturumsuz, token yetkili), `favorites_set`, `user_bootstrap` (+ `gender`, `avatar_thumb_url`), `widget_refresh` uyandırması, Storage avatar kuralları |

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

## Ping, notlar ve SOS (Faz 4)

Üç özellik de mevcut desene oturur: istemci yalnızca callable çağırır ya da kendi kutusunu dinler, sunucu doğrular ve
yazar, uygulama kapalıysa push gider. Push koordinat taşımaz, koordinat yetkili okumayla gelir.

- **Ping:** `ping_send` → RTDB `ping_inbox/{alıcı}/{ping_id}` (15 dk) + `ping` push. Alıcı `pingStore` ile kart ve pin
  vurgusu üretir, kaydı yalnızca silebilir. Süpürücü `ping_expiry` dizininden süresi geçenleri siler.
- **Durum notu:** ayrı belge yoktur. Yayıncı arkadaş paketlerine `note` + `note_exp` ekler (`statusNoteExtras`).
  Kural ikisini birlikte ister, `link_live`'a eklenmez.
- **Yer notu:** `place_note_upsert/delete` → Firestore `place_notes` (sahibi + `visible_to` okur). Süpürücü ve TTL siler.
- **SOS:** `sos_send` → Firestore `sos_alerts` (tam koordinat, doğruluk, adres, harita bağlantısı, pil, rota) + her acil
  kişiye yüksek öncelikli `sos` push (Android `sos` kanalı, iOS `time-sensitive` / onaylanırsa `critical`). Alıcı
  dinleyicisi `focusedSosId` ile tam ekran kartı açar. `sos_update` (15 sn), `sos_ack` (gönderene push),
  `sos_resolve` ("güvende" push'u alarm bildiriminin yerine geçer). 24 sa'te süpürücü kapatır.
- Mobilde üç depo (`state/{pingStore,notesStore,sosStore}.ts`) ve tek başlatıcı (`services/f4Services.ts`) vardır.
  Çıkışta depolar sıfırlanır.

## Bölge tetikleyicileri ve buluşma noktası (Faz 5)

İki özellik de aynı deseni izler (callable yazar, istemci dinler, push koordinatsız). Yeni olan, kararın bir kısmının
**cihazda** verilmesidir: geçişi OS bildirir ama sapma filtresi onaylar.

- **Bölgeler:** `zone_upsert/delete` → Firestore `users/{uid}/zones` (yalnızca sahibi okur). `zonesStore` dinler;
  `f5Services` listeyi `zoneMonitor`'a verir, o da `geofenceRegistry` üzerinden OS'a kaydeder (görev
  `konum-zone-geofence`, `startGeofencingAsync`; iOS'ta uyku çiti aynı göreve alınır, 20 bölge sınırı).
- **Tetikleme:** OS olayı → `zoneMonitorCore` (taze konum + core `zoneFilterReduce`, bölge başına kalıcı durum) →
  `zone_event_report` (kalıcı kuyruk, aynı `op_id`, koordinatsız) → sunucu kural eşler, soğuma / günlük sınır uygular,
  `zone_event` push'u gönderir ve `start_share` döner → cihaz mevcut `share_start` ile paylaşımı başlatır. Ön plan ve
  Faz 3 arka plan örnekleri de filtreye beslenir (`pipeline.ts`, `zoneSampleTap.ts`).
- **Buluşma:** `meetupStore.suggest` (ben + görünen arkadaş konumları) → `meetup_suggest` (merkez, Places Nearby,
  mod başına Route Matrix, adalet puanı, önbellek / kota / yedek orta nokta; Google yalnızca sunucudan) →
  `meetup_share` → Firestore `meetups` (öneren + alıcılar) + `meetup` push → alıcı kartı → `meetup_respond`.
- Mobilde iki depo (`state/{zonesStore,meetupStore}.ts`) ve tek başlatıcı (`services/f5Services.ts`); çıkışta OS
  bölge kaydı kalkar, kalıcı bölge durumu silinir.

## Widget ve tek dokunuşla 1 saat (Faz 6)

Widget süreci Firebase SDK'sını ve uygulamanın JS kodunu çalıştırmaz. Uygulama yazar, widget yalnızca okur; tek ağ çağrısı
hızlı paylaşımdır.

```text
uygulama (ön plan / push / WorkManager)
  → buildWidgetSnapshot (favoriler ≤ 4, son durum, pil, fotoğraf dosyası, aktif paylaşım; ham koordinat yok)
  → widgetSyncDecision (yazma ≥ 60 sn, yenileme ≥ 5 dk; büyük değişiklikte hemen)
  → widgetBridge: iOS App Group UserDefaults + WidgetCenter / Android SharedPreferences + AppWidgetManager

widget "1 sa paylaş" (iOS AppIntent .requiresAuthentication / Android receiver, kutucuk unlockAndRun)
  → token anahtarlıkta / KeyStore'da var mı, dolmak üzere mi, arka plan izni var mı (quickShareRoute)
     ├─ hayır → derin bağlantı konum://quick-share?... → uygulama açılır, aynı adımı orada tamamlar
     └─ evet  → POST widget_quick_share {token, to_uid, op_id}
                 → sunucu: özet eşle, süre / iptal / saatlik 6 çağrı / arkadaşlık / favori denetimi
                 → quickShareExpiry: started | extended | already_active (60 dk)
                 → resume_tracking (sessiz) + quick_share_started (görünür, iOS "Durdur" eylemi)
```

## Profil fotoğrafı ve cinsiyet çerçevesi (Faz 6)

- Kayıtta `user_bootstrap` profil oluşturulurken `gender` ister (`gender_required`). Faz 6 öncesi hesap `GenderGate` ile
  bir kez seçer. Cinsiyet ve küçük avatar `friendships.member_profiles` kopyasına yayılır.
- Kamera / galeri → kare kırpma → 512 px (q0,8) + 160 px (q0,7) JPEG (EXIF / GPS atılır) → Storage
  `avatars/{uid}/{sürüm}.jpg` ve `{sürüm}_160.jpg` → `user_bootstrap {avatar_url, avatar_thumb_url}` (sunucu
  `checkAvatarPair` ile aynı sürüm olduğunu doğrular, eski sürümü siler).
- Liste, widget ve harita pini aynı kuralı kullanır: 160 px fotoğraf (yoksa baş harfler) + cinsiyet renginde 3 px halka
  (`GENDER_RING`: kadın pembe, erkek mavi, bilinmiyor gri). Önbellek expo-image bellek + disk, anahtar `avatar_version`.

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
- Faz 4: ping konumu yalnızca alıcının kutusuna gider ve 15 dk yaşar. Durum notu yalnızca konumu zaten gören arkadaşlara
  pakette gider. Yer notu varsayılan olarak "yalnızca ben"dir. SOS yalnızca seçilen (≤ 5, hâlâ arkadaş olan) acil
  kişilere gider. SOS push gövdesi adres, doğruluk ve pil taşır, ham koordinat taşımaz (bilinçli istisna). Yetkisiz okuma
  `sos_not_active` / `not_friends` ile bilgi sızdırmadan reddedilir.
- Faz 5: bölge merkezi (ev / iş adresi) yalnızca sahibine açıktır; kural alıcısı bile okuyamaz. `zone_event_report`
  koordinat taşımaz, push ve olay kaydı yalnızca bölge adını taşır. Buluşma önerisi için bana görünen arkadaş konumları
  hesap amacıyla sunucuya ve Google'a gider, saklanmaz (sonuç 10 dk kullanıcıya özel önbellekte). Paylaşılan öneri
  yalnızca yeri ve paylaşım anındaki ETA'ları taşır.
- Faz 6: widget anlık görüntüsü ve `quick_share_started` / `widget_refresh` push'ları ham koordinat taşımaz; kilit
  ekranında yer adı ve pil varsayılan olarak gizlidir (kullanıcı ayarı). Widget token'ı sunucuda yalnızca SHA-256
  özetiyle durur, yalnızca sahibinin favorilerine 1 saatlik paylaşım açabilir (saatte 6, 30 gün). Fotoğraf yeniden
  kodlanır (EXIF / GPS gitmez); Storage nesnesini kurallarla yalnızca sahibi okur, arkadaşlar indirme token'lı URL ile
  görür. Favori listesi yalnızca sahibine açıktır. Cinsiyet yalnızca çerçeve rengi için arkadaş kopyasına gider.

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
| `ping_inbox/{to}/{ping_id}` | RTDB | alıcı | sunucu; alıcı yalnızca siler |
| `ping_expiry/{ping_id}` | RTDB | yok | sunucu (süpürücü dizini) |
| `place_notes/{note_id}` | Firestore | sahibi, `visible_to` | callable (TTL `purge_at`) |
| `sos_alerts/{sos_id}` | Firestore | gönderen, `recipient_ids` | callable (TTL `purge_at`) |
| `users/{uid}.emergency_contacts` | Firestore | sahibi | callable (`emergency_contacts_set`, arkadaşlık bitince sunucu) |
| `users/{uid}/zones/{zone_id}` | Firestore | yalnızca sahibi | callable (`zone_upsert/delete`; arkadaşlık bitince sunucu alıcıyı çıkarır) |
| `users/{uid}/zone_events/{op_id}` | Firestore | yalnızca sahibi | callable (`zone_event_report`, koordinatsız, 30 gün TTL) |
| `zone_cooldowns/{uid}_{zone_id}_{transition}` | Firestore | yok | sunucu (son bildirim anı, TTL) |
| `meetups/{meetup_id}` | Firestore | öneren (`from`), alıcılar (`to`) | callable (`meetup_*`, 12 sa + TTL `purge_at`) |
| `meetup_cache/{id}` | Firestore | yok | sunucu (10 dk, kullanıcıya özel, TTL `expire_at`) |
| `users/{uid}.gender`, `.avatar_thumb_url`, `.avatar_version` | Firestore | sahibi (arkadaşlar `member_profiles` kopyasından) | callable (`user_bootstrap`) |
| `users/{uid}.favorite_ids` | Firestore | yalnızca sahibi | callable (`favorites_set`; arkadaşlık bitince / hesap silmede sunucu çıkarır) |
| `widget_tokens/{sha256}` | Firestore | yok | sunucu (`widget_token_issue/revoke`, 30 gün TTL, saatlik çağrı sayacı) |
| `avatars/{uid}/{sürüm}.jpg`, `{sürüm}_160.jpg` | Storage | sahibi (`get`), arkadaşlar indirme URL'siyle | sahibi (yalnızca JPEG, ≤ 400 / 60 KB); sunucu eski sürümü ve hesap silmede klasörü siler |

## Bilinen açıklar

- Gerçek cihazda ve gerçek Firebase projesinde denenmedi. Faz 2 Google API'leri gerçek anahtarla denenmedi; alan adı,
  AASA ve assetlinks değerleri yer tutucu (bkz. `PHASES.md`, Faz 2 → Faz 3).
- Mobilde "Konum Paylaşımı İste" (`location_requests`) ekranı henüz yok. Backend ve sözleşme hazır.
- `eas.json` yok. iOS'ta AsyncStorage yedekten hariç tutulmuyor.
- Süre dolduktan sonra son paket, süpürücü çalışana kadar birkaç saniye ile 1 dakika arasında okunabilir kalabilir. Okuma kuralı süreye de baktığı için yeni yazma kabul edilmez.
- Faz 3: `modules/konum-activity` (Swift/Kotlin) derlenmedi; Android'de expo-location FGS'yi arka planda yeniden
  yapılandıramıyor (satır değişikliği ön plana dönüşte uygulanır). Zorla kapatılan uygulamaya push ulaşmaz.
  Pil tüketimi gerçek cihazda ölçülmedi (`PHASE3.md` §4.3).
- Faz 4: SOS bildiriminin DND, sessiz mod ve kilit ekranı davranışı gerçek cihazda denenmedi. iOS Critical Alerts Apple
  onayı bekliyor (kapalı). Android'de "Rahatsız Etme erişimi" adımı yok (`PHASE4.md` §7).
- Faz 5: OS bölge algılama (iOS `CLCircularRegion`, Android `GeofencingClient`), başsız paylaşım başlatma ve native
  harita katmanları gerçek cihazda denenmedi; Places / Routes gerçek anahtarla denenmedi (`PHASE5.md` §8).
- Faz 6: Swift widget hedefi ve Kotlin widget modülü derlenmedi (yalnızca `expo prebuild` yapılandırması doğrulandı).
  Android'de widget başına favori seçici yok (sıralı ilk favoriler). iOS 16 cihazda widget yok. Uygulama kapalıyken
  widget'tan başlayan paylaşımın takibe dönmesi sessiz push'a bağlı. Yetim avatar dosyaları süpürülmez. Uygulama içi
  hesap silme ekranı ve çökme raporlama yok (`PHASE6.md` §10, `RELEASE_CHECKLIST.md`).

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
