# Faz 5: Varış / Ayrılış Tetikleyicileri (Geofence) ve "Buluşma Noktası" Önerisi

Faz 5, Faz 1–4 sözleşmelerini **genişletir**: canlı paket, paylaşım ve push alanlarının anlamı değişmedi. Yeni veriler
kendi yollarında durur (`users/{uid}/zones`, `users/{uid}/zone_events`, `zone_cooldowns`, `meetups`, `meetup_cache`).
Bölge tetikleyicisi paylaşımı **mevcut** `share_start` ile başlatır; buluşma önerisi rotayı **mevcut** `route_compute`
ile çizer. Çelişki olursa `packages/core` (`zones.ts`, `meetup.ts`, `contracts.ts`) geçerlidir. **[Varsayım]** ile
işaretlenen her şey gerçek cihazda ya da ürün kararıyla doğrulanmalıdır.

**Durum:** Kod hazır. Birim, kural ve emülatör testleri geçiyor; tarayıcı demosunda bölge kaydı → GPS sapması →
evden çıkış (paylaşım başlar) → arkadaşın varış bildirimi → buluşma önerisi → alıcı kartı akışı uçtan uca çalışıyor
(§7). Gerçek cihazda (iOS `CLCircularRegion`, Android `GeofencingClient`) ve gerçek Places / Routes anahtarıyla
**denenmedi**.

| İstenen | Nerede |
| --- | --- |
| Geofence kural modeli, şemalar, kural eşleme, push metinleri | `packages/core/src/zones.ts` (`Zone`, `ZoneRule`, `ZONE_LIMITS`, `ZONE_RULE_TEMPLATES`, `matchZoneRules`, `localClock`, `zoneEventPushText`, `describeZoneRule`) |
| GPS sapması filtresi (saf, cihaz + test ortak) | `packages/core/src/zones.ts` (`ZONE_FILTER`, `zoneFilterReduce`, `classifyZoneSample`, `osRegionRadius`), örnekler `packages/core/test/faz5.test.ts` |
| Buluşma noktası hesabı (merkez, arama yarıçapı, Places / Route Matrix gövdeleri ve ayrıştırıcıları, adalet puanı, yedek ETA, önbellek anahtarı) | `packages/core/src/meetup.ts` |
| Callable adları, yollar, hata kodları, push türleri | `packages/core/src/contracts.ts` (CALLABLES, PATHS, ERROR_CODES, PushData Faz 5, `PUSH_TYPES_F5`) |
| Callable'lar (`zone_upsert`, `zone_delete`, `zone_event_report`, `meetup_suggest`, `meetup_share`, `meetup_respond`, `meetup_cancel`) | `backend/functions/src/handlers/{zones,meetup}.ts`, `index.ts` |
| Push içeriği (Android kanal `ping`, iOS `active`, etiketler) | `backend/functions/src/push.ts` (`buildZoneEventPush`, `buildMeetupPush`, `buildMeetupResponsePush`) |
| Kurallar, TTL, süpürücü, hesap / arkadaşlık temizliği | `backend/firestore.rules`, `backend/firestore.indexes.json`, `handlers/{sweeper,user,friends}.ts` |
| Bölge yönetimi (durum) ve buluşma durumu | `apps/mobile/src/state/{zonesStore,meetupStore}.ts` |
| Arka plan bölge algılama ve tetikleme | `apps/mobile/src/services/location/{zoneMonitorCore,zoneMonitorWiring,zoneMonitor,geofenceRegistry,zoneSampleTap}.ts`, `backgroundTask.ts`, `pipeline.ts`, `state/persist.ts` |
| Dinleyiciler, push yönlendirmesi | `apps/mobile/src/services/{f5Services.ts,firebase/{zonesRepo,meetupsRepo,f5Docs}.ts,notifications/{f5Push,push,expiryNotifications}.ts}` |
| Bölgelerim, bölge ve kural düzenleyici, haritada bölgeler | `apps/mobile/app/(main)/{zones,zone-edit}.tsx`, `src/features/zones/` |
| Buluşma sayfası, harita pinleri / çizgiler, alıcı kartı | `apps/mobile/src/features/meetup/`, `features/map/{MapHome,MapCanvas}.tsx` |
| Tarayıcı demosu ("FAZ 5 SENARYOLARI") | `apps/mobile/src/demo/server/{server,fakePlaces}.ts`, `src/demo/web/zoneSim.ts`, `src/demo/shell/Faz5.web.tsx` |

---

## 1. Veri modelleri

Zamanların hepsi epoch ms (sunucu saati). Firestore belgelerinde yalnızca `purge_at` / `expire_at` bir `Timestamp`'tir
(TTL alanı); callable yanıtlarında yer almaz, istemci ayrıştırıcıları (`parseZone`, `parseMeetup`) bilinmeyen alanları
atar.

### 1.1 Bölge ve kurallar: `users/{uid}/zones/{zone_id}` (Firestore)

```ts
interface Zone {
  zone_id: string; owner_id: UserId;
  kind: 'home' | 'work' | 'school' | 'custom';   // Ev / İş / Okul / Özel nokta
  name: string;                                  // sanitizeNoteText, ≤ 30
  emoji: string | null;                          // boşsa türün emojisi (🏠 💼 🎓 📍)
  center: { lat; lng };                          // HASSAS: yalnızca sahibi okur
  radius_m: number;                              // 100 … 2000 (varsayılan 150)
  rules: ZoneRule[];                             // ≤ 6
  enabled: boolean;
  time_zone: string;                             // IANA, kural pencereleri bu dilimde
  created_at; updated_at: EpochMs;
}
interface ZoneRule {
  rule_id: string;                               // istemci üretir (uuid); aynı bölgede tekrar → invalid_argument
  trigger: 'arrive' | 'leave';
  action: 'notify' | 'start_share';
  recipient_ids: UserId[];                       // 1 … 10, kabul edilmiş + engelsiz arkadaş
  share_duration: DurationChoice | null;         // start_share: 15 dk / 1 sa / 8 sa / gün sonu; notify: null
  days_mask: number;                             // bit 0 = Pazartesi … bit 6 = Pazar, 127 = her gün
  window: { from_min; to_min } | null;           // yerel dakika; from > to gece yarısını aşar (22:00–06:00)
  enabled: boolean;
}
```

- **Kural şablonları** (`ZONE_RULE_TEMPLATES`): "Vardığımda bildir", "Çıktığımda bildir", "Çıkınca paylaşımı başlat",
  "Varınca paylaşımı başlat". Liste satırı `describeZoneRule` ile "Ev konumuna vardığımda Ayşe'ye bildir" olur.
- **Sınırlar** (`ZONE_LIMITS`): en çok 15 bölge (iOS 20 bölge sınırı − Faz 3 uyku çiti − pay **[Varsayım]**), bölge
  başına 6 kural, kural başına 10 alıcı.
- **Alıcı süzme:** sunucu arkadaş olmayan / engelli / kendisi olan alıcıları **sessizce** düşürür ve
  `dropped_recipient_ids` ile döner (arayüz "… artık arkadaşın olmadığı için kuraldan çıkarıldı" uyarısı gösterir).
  Alıcısı kalmayan kural silinir. Arkadaşlık bitince / engellenince iki tarafın kurallarından karşı taraf çıkarılır.
- Yazma yalnızca `zone_upsert` / `zone_delete` ile. `zone_id: null` yeni bölgedir (kimliği sunucu üretir); var olmayan
  kimlik `zone_not_found`, 16. bölge `zone_limit_reached`. Düzenlemede `created_at` ve bölgenin `time_zone`'u korunur.

### 1.2 Olay kaydı ve soğuma

- `users/{uid}/zone_events/{op_id}` = `ZoneEventLog` (`zone_id`, `transition`, `occurred_at`, `notified`,
  `suppressed`) + `reported_at` + `purge_at` (30 gün TTL). **Koordinat yoktur.** Yalnızca sahibi okur; Bölgelerim
  ekranındaki "Son olaylar" buradan gelir ("Ev · vardın · 18:42 · Ayşe Yılmaz'a bildirildi" / bastırıldıysa nedeni).
- `zone_cooldowns/{uid}_{zone_id}_{transition}`: son bildirim anı (yalnızca sunucu, 1 gün TTL). Günlük sayaç
  `rate_limits/{uid}_zone_event` (mevcut sabit pencere).

### 1.3 Buluşma önerisi: `meetups/{meetup_id}` ve `meetup_cache/{id}` (Firestore)

```ts
interface Meetup {
  meetup_id: string; from: UserId; from_name: string;
  to: UserId[];                                  // 1 … 4 kabul edilmiş arkadaş
  place: { place_id: string | null; name; address: string | null; location: { lat; lng };
           primary_type: string | null; category: 'cafe' | 'transit' | 'meeting_point' | 'midpoint' };
  etas: { key: UserId; duration_s; distance_m; estimated: boolean }[];   // paylaşım anı; 'me' → gönderenin uid'i
  meet_at: EpochMs | null; note: string | null;  // ≤ 120
  responses: Record<UserId, 'accepted' | 'declined'>;
  status: 'active' | 'cancelled';
  created_at; expires_at: EpochMs;               // + 12 sa
}  // + updated_at, purge_at (TTL)
```

- Okuma: `from == ben` ya da `ben ∈ to` (sorgular `where('from','==',ben)` ve `where('to','array-contains',ben)`;
  kural iki sorguyu da kanıtlayabiliyor, rules testinde doğrulandı). Yazma yalnızca `meetup_*` callable'ları.
- Süresi dolan ve iptal edilen belgeler süpürücüye kadar durur; istemci `isMeetupActive` ile gizler.
- `meetup_cache/{sha256(core anahtarı | uid | anahtar@geohash6:mod …)}`: yalnızca sunucu, 10 dk; **kullanıcıya ve
  katılımcı anahtarlarına özeldir** (yanıttaki ETA anahtarları çağırana göredir).
- `maps_quota/{uid}_{gün}.meetup`: günlük öneri sayacı (Faz 2 kota belgesi).

### 1.4 Callable'lar ve hata kodları

| Callable | İstek | Yanıt | Hatalar |
| --- | --- | --- | --- |
| `zone_upsert` | `op_id, zone_id \| null, kind, name, emoji, center, radius_m, rules, enabled, time_zone` | `{zone, dropped_recipient_ids, server_now}` | `invalid_argument` (ad / dilim / tekrarlanan `rule_id`), `zone_not_found`, `zone_limit_reached` |
| `zone_delete` | `op_id, zone_id` | `{zone_id, deleted, server_now}` (yoksa `deleted: false`) | — |
| `zone_event_report` | `op_id, zone_id, transition, occurred_at, accuracy_m` (**koordinat yok**) | `{notified, start_share[], suppressed, server_now}` | `zone_not_found` |
| `meetup_suggest` | `op_id, participants[{key: 'me' \| uid, position, mode}] (2–5, 'me' zorunlu), category` | `MeetupSuggestResponse` | `invalid_argument` |
| `meetup_share` | `op_id, to (1–4), place, etas, meet_at, note` | `{meetup, server_now}` | `not_friends`, `rate_limited` (saatte 20) |
| `meetup_respond` | `op_id, meetup_id, response` | `{meetup, server_now}` | `meetup_not_found`, `rate_limited` (saatte 60) |
| `meetup_cancel` | `op_id, meetup_id` | `{meetup, server_now}` (tekrar güvenli) | `meetup_not_found` |

Hata eşlemesi (Functions kodu): `zone_not_found` / `meetup_not_found` → `not-found`, `zone_limit_reached` →
`resource-exhausted`. Hepsi `europe-west1`, App Check, `runOp` (`meetup_suggest` durum yazmadığı için `runOp`
kullanmaz; tekrar gelen istek önbellekten karşılanır).

---

## 2. Geofence: kural modeli, bölge yönetimi ve tetikleme akışı

### 2.1 Bölge yönetimi (arayüz)

- **Bölgelerim** (TopBar menüsü ve Arkadaşlar ekranındaki kart): emoji + ad + yarıçap (`formatZoneRadius`),
  "Şu an buradasın" rozeti (filtre durumu `inside`), kural özetleri, aç/kapa anahtarı, son 20 olay ve izleme bandı
  ("Bölge bildirimleri için konum iznini 'Her zaman' yap" + düğme / "Bölge izleme açık…").
- **Bölge düzenleyici** (`/zone-edit?id=…`): merkez = haritanın ortasındaki artı işareti (haritayı kaydır;
  "Şu anki konumum"), haritada yarıçap dairesi, tür çipleri (Ev / İş / Okul / Özel nokta), ad, yarıçap çipleri
  100 m – 2 km ve ±50 m, kurallar, "Bölge açık", "Bölgeyi sil".
- **Kural sayfası:** şablon, alıcılar (≤ 10 arkadaş), start_share için süre (`ZONE_SHARE_DURATIONS`), gün çipleri
  (`WEEKDAY_SHORT_TR`), isteğe bağlı saat aralığı (30 dk adım, gece yarısını aşabilir). Kayıtta düşen alıcılar uyarısı.
- **Haritada:** kendi bölgelerim soluk daire + emoji (native `Circle`, web önizleme katmanı).

### 2.2 OS bölge kaydı (iOS `CLCircularRegion`, Android `GeofencingClient`)

expo-location `startGeofencingAsync(task, regions)` iOS'ta `CLLocationManager` + `CLCircularRegion`, Android'de
`GeofencingClient` kullanır. Faz 5 görevi `konum-zone-geofence` (Faz 3 `konum-sleep-geofence`'tan ayrı).

| Konu | iOS | Android |
| --- | --- | --- |
| Bölge sınırı | Uygulama başına **20** bölge, uygulama genelinde paylaşılır. Uyku çiti (1) + en çok 15 bölge. | Uygulama başına 100 geofence. |
| Görevler | Bölge varken uyku çiti de `konum-zone-geofence` görevine eklenir, uyku görevi durdurulur (expo-location bir görevi güncellerken TÜM `monitoredRegions`'ı bırakır; iki görev birbirini silerdi). Görev `konum-sleep` kimlikli olayı uyku çiti olarak işler. | Her görevin kendi `PendingIntent`'i var; görevler ayrı kalır. |
| Kaydedilen yarıçap | `osRegionRadius(R) = R + dışarı tamponu / 2` (R = 150 → 175 m): OS'un çıkış olayı filtre eşiğinden önce gelmesin. | Aynı. |
| İzin | "Her zaman" (`requestAlwaysAuthorization`). "Kullanırken"de bölge izleme çalışmaz. | `ACCESS_FINE_LOCATION` + Android 10+ `ACCESS_BACKGROUND_LOCATION` (Faz 3 kademeli akışı). |
| Uygulama kapalıyken | Bölge olayı uygulamayı arka planda başlatır; işlem süresi kısıtlı (≈ 10 sn + arka plan görevi) **[Varsayım: cihazda ölçülmeli]**. | Olay `PendingIntent` ile başsız JS görevini başlatır. Android 8+ arka planda olayları birkaç dakikada bir toplu teslim eder. |
| Gecikme | Sınır aşıldıktan sonra sistem kendi tamponunu ve ~20 sn bekleme uygular. | Arka planda dakikalar; ön planda saniyeler. |

- Bölge listesi değişince (dinleyici ya da callable yanıtı) kayıt yenilenir, etkin bölge yoksa görev durur.
  İzin yoksa `monitoring: 'needs_permission'`: OS kaydı yapılmaz ama ön plan örnekleriyle filtre yine çalışır.
- Başsız açılış için bölge merkezi / yarıçapı, filtre durumu ve rapor kuyruğu kalıcıdır (`persist.ts`:
  `konum.bg.zones.v1`, `konum.bg.zoneFilter.v1`, `konum.bg.zoneReports.v1`); çıkışta silinir.
- Ek GPS maliyeti yok: ön plan örnekleri ve Faz 3 arka plan görevinin örnekleri de tüm bölgelerin filtresine beslenir.

### 2.3 Varış / ayrılış tetikleme akışı

```text
OS (CLCircularRegion /           cihaz: zoneMonitor                     sunucu: zone_event_report            alıcı
    GeofencingClient)
  │ "exit" (R + tampon/2)            │                                        │                                   │
  ├─────────────────────────────────▶│ 1. zoneFilterReduce(os_event) → aday   │                                   │
  │                                  │    (durum diske yazılır)               │                                   │
  │                                  │ 2. taze konum (≤ 20 sn) → reduce       │                                   │
  │                                  │    → "pending" ise ≥ 20 sn sonra       │                                   │
  │                                  │    İKİNCİ taze konum (≤ 25 sn)          │                                   │
  │                                  │ 3. onaylandı → emit 'leave'            │                                   │
  │                                  │ 4. rapor kalıcı kuyruğa (op_id) ──────▶│ zone yok → zone_not_found          │
  │                                  │    {zone_id, transition,               │ occurred_at > now+60 sn → now      │
  │                                  │     occurred_at (sunucu saati),        │ now − occurred_at > 30 dk → stale  │
  │                                  │     accuracy_m}  KOORDİNAT YOK         │ kapalı → disabled                  │
  │                                  │                                        │ matchZoneRules boş → outside_window│
  │                                  │                                        │ 5 dk aynı yön → cooldown           │
  │                                  │                                        │ 60/gün → daily_limit               │
  │                                  │                                        │ notify ∪ (hâlâ arkadaş) ──push────▶│ "Deniz · Ev konumundan ayrıldı"
  │                                  │◀── {notified, start_share, suppressed} │ olay → zone_events (koordinatsız)  │
  │                                  │ 5. start_share: zaten paylaşım        │                                   │
  │                                  │    almayanlarla share_start + yerel    │                                   │
  │                                  │    "Bölge kuralı" bildirimi            │                                   │
```

- **Çevrimdışı:** rapor önce `konum.bg.zoneReports.v1` kuyruğuna yazılır, bağlantı gelince / ön plana dönünce
  **aynı op_id** ile yeniden gönderilir (sunucu bir kez uygular). Kalıcı hata (bölge silindi, şema) → atılır, son
  olaylarda "gönderilemedi". 30 dk'dan eski olay `stale` olarak kaydedilir, bildirim gitmez.
- **Kural saati** bölgenin `time_zone`'unda, olay anına göre hesaplanır (`localClock` + `offsetFnForTimeZone`).
- **start_share** yanıtındaki süre `DurationChoice`'tur; cihaz mevcut `sharingStore.startShare` yolunu kullanır
  (paket yayını, süre motoru, uzatma aynen). Android 12+ başsız başlatmada ön plan servisi istisnası **[Varsayım:
  cihazda doğrulanmalı]**.
- Bastırılan olaylarda (cooldown ve daily_limit dahil) push gitmez, `start_share` boş döner **[Varsayım]**. Soğuma
  ve günlük sayaç yalnızca gerçekten bildirim / paylaşım tetiklenen olayda işler.
- **Bildirime dokunma** (`zone_event`): haritada gönderenin pini vurgulanır (`pingStore.highlightFrom`); gönderen
  canlı paylaşmıyorsa yalnızca bildirim görünür (bölge koordinatı alıcıya hiç gelmez).

---

## 3. GPS sapması (hatalı giriş-çıkış) filtreleme kuralları

OS bölge olayı yalnızca **adaydır**; geçişi cihazdaki saf `zoneFilterReduce` onaylar (bölge başına kalıcı durum).
Sunucu ikinci savunma hattıdır (soğuma, günlük sınır, bayat olay).

| Değer (`ZONE_FILTER`) | Varsayılan | Kural | Gerekçe |
| --- | --- | --- | --- |
| `maxAccuracyM` | 100 m (büyük bölgede `R × 0,5`'e kadar gevşer) | Doğruluğu bundan kötü örnek karar vermez → `low_accuracy` | Kapalı alanda / Wi-Fi konumunda ±300–1000 m sıçramalar tek başına "çıktı" ürettirmesin. |
| `accuracyWeight` (k) | 1 | İÇERİ = `d + acc·k ≤ R`; DIŞARI = `d − acc·k ≥ R + tampon` | Doğruluk dairesinin tamamı bölgenin içinde / dışında olmalı. |
| `minExitBufferM`, `exitBufferRatio` | 50 m, `R × 0,25` | Dışarı eşiği `R + max(50, R·0,25)`; arası **gri bant** → `grey_band` (karar yok) | Sınırda (bahçe, otopark, apartman girişi) dolaşan kullanıcı sürekli var/çık üretmesin (histerezis). |
| `confirmSamples`, `minConfirmSpanMs` | 2 örnek, ≥ 20 sn arayla | Aynı yönde 2 güvenli örnek → `confirmed_samples` | Tek örnek sapma olabilir; 20 sn bağımsız ikinci ölçüm ister. |
| `enterDwellMs` / `exitDwellMs` | 60 sn / 3 dk | Aday bu süre boyunca tutarlıysa → `confirmed_dwell` | Seyrek örnekte (arka plan) de onay; çıkışta daha temkinli (yanlış "evden çıktı" daha rahatsız edici). |
| `maxSpeedMps` | 70 m/sn (252 km/sa) | Önceki örneğe göre bu hızın üstü → `teleport`, örnek atılır | Baz istasyonu / IP konumu sıçramaları. |
| `minStayMs` | 3 dk | Onaylı geçişten sonra ters geçiş 3 dk onaylanmaz → `min_stay` | Kapıya çıkıp dönmek ya da sınırda titreşim "çıktı → vardı → çıktı" zinciri üretmesin. |
| `farEscapeM` | 1 km | `d − acc ≥ R + 1 km` → `far_escape` (bekleme ve `min_stay` aşılır) | Hızla uzaklaşan (araçla çıkış) kullanıcıda gecikme olmasın. |
| `sameTransitionCooldownMs` | 10 dk | Aynı yön tekrarı → `same_cooldown` (durum güncellenir, emit yok) | Çıktı → gri bantta dolaştı → yeniden "çıktı" bildirimi gitmesin. |
| `osEventFixTimeoutMs` | 20 sn | OS olayından sonra taze konum için en çok bekleme | iOS arka plan süresi kısıtlı. |
| `candidateMaxAgeMs` | 15 dk | Onaylanmayan aday düşer | Eski aday sonradan yanlış onaylanmasın. |
| (ilk durum) | — | İlk güvenli örnek durumu **tetiksiz** kurar → `initial` | Uygulama evde açılınca "eve vardı" gitmez. |
| (OS ↔ taze konum çelişkisi) | — | OS "girdi" der, taze konum dışarıda → taze konum kazanır (`no_change`) | OS olayı da yanılabilir. |
| Sunucu | 5 dk soğuma, 60 olay/gün, 30 dk bayatlık | `cooldown`, `daily_limit`, `stale` | Cihaz durumu silinse / iki cihaz olsa bile bildirim yağmuru olmaz. |

Doğruluğu bilinmeyen ölçüm 5000 m sayılır, yani hiçbir zaman karar vermez.

**Örnek senaryolar** (R = 150 m → dışarı eşiği 200 m, doğruluk sınırı 100 m, OS yarıçapı 175 m):

1. **Evde, kapalı alanda ±400 m sıçrama** → `low_accuracy`. Aynı anda OS "çıktı" der → `os_candidate`. Taze konum
   1,5 km uzakta ama 1 sn içinde → `teleport`. Sonraki gerçek örnek içeride → aday düşer. **Tetik yok** (demo §7,
   `05-gps-sapmasi.png`).
2. **Gerçek çıkış (yürüyerek):** 240 m ±8 → `pending`; 20+ sn sonra 350 m ±8 → `confirmed_samples` → **ayrılış**.
   "Çıkınca Ayşe ile 1 saat paylaş" kuralı → paylaşım başlar (`04-evden-cikis.png`).
3. **Otoparkta sınırda dolaşma:** 170 m ±10 (`d + acc = 180 > 150`, `d − acc = 160 < 200`) → `grey_band`, karar yok.
4. **Çöpü atıp 1 dk'da geri dönme:** çıkış onaylandıysa geri dönüş `min_stay` ile 3 dk bekler; aynı gün içinde ikinci
   "çıktı" 10 dk içinde gelirse `same_cooldown`.
5. **Araçla hızlı çıkış:** 1,3 km ±20 tek örnek → `far_escape`, beklemeden ayrılış.
6. **Uygulama evde açıldı:** ilk örnek içeride → `initial`, bildirim yok.

---

## 4. Buluşma noktası

### 4.1 Hesaplama mantığı (`meetup_suggest`, saf parçalar core `meetup.ts`)

1. **Katılımcılar:** ben (`'me'`, kendi konumum ya da haritada seçilen nokta, `positionOverrides.me`) + konumu bana
   **görünen** arkadaşlar (canlı paylaşım). Konumu görünmeyenler isteğe katılmaz, `missingFriendIds` ile uyarılır.
   2–5 katılımcı, anahtarlar benzersiz, `'me'` zorunlu. Ulaşım modu katılımcı başına (Araç / Yürüyüş / Bisiklet);
   varsayılan: yayılım ≤ 2 km → Yürüyüş, değilse Araç **[Varsayım]**.
2. **Merkez** (`meetupCenter`): 2 kişide büyük daire orta noktası; 3–5 kişide geometrik medyan (Weiszfeld; uçtaki tek
   kişi merkezi kendine çekmez). **Yayılım** = merkeze en uzak katılımcı.
3. **Erken kararlar** (kota işlemez): `yayılım × 2 < 150 m` → `too_close` ("Zaten birbirinize çok yakınsınız",
   yalnızca orta nokta); `yayılım > 100 km` → `too_far` (öneri yok).
4. **Önbellek:** kullanıcı + katılımcı anahtarı + geohash6 hücresi + mod + kategori; 10 dk. İsabet kota yemez,
   `cached: true`.
5. **Kesme anahtarı / anahtar yok / proje bütçesi 0** (`config/maps.disabled`, Faz 2 bütçe sayacı) → `places_unavailable`
   + yalnızca orta nokta. **Kullanıcı kotası** günde 30 sorgu (Google'dan önce transaction) → `quota_exceeded` + orta nokta.
6. **Aday arama:** Places API (New) `places:searchNearby`, merkez çevresinde `searchRadiusM = clamp(yayılım/4, 300 m, 3 km)`,
   kategoriye göre `includedTypes` (Kafe: `cafe, coffee_shop, bakery`; Durak: `bus_station, subway_station,
   train_station, light_rail_station, transit_station, ferry_terminal`; Buluşma noktası: `park, shopping_mall, plaza,
   tourist_attraction` **[Varsayım: tür listesi Google belgesiyle doğrulanmalı]**), `maxResultCount: 10`,
   `rankPreference: DISTANCE`, `languageCode: tr`. Başlık
   `X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.types`
   (en dar maske → **Nearby Search Pro** SKU; `rating` / `userRatingCount` Enterprise SKU olduğu için istenmez
   **[Varsayım]**). 0 sonuç → `no_results` + orta nokta; hata → `places_unavailable`.
7. **Erişim süresi:** merkeze en yakın `K = 5` aday için Routes API `computeRouteMatrix`, **mod başına tek matris**
   (kaynaklar = o moddaki katılımcılar, hedefler = adaylar), `X-Goog-FieldMask:
   originIndex,destinationIndex,duration,distanceMeters,condition`, araçta `routingPreference: TRAFFIC_UNAWARE`
   (Essentials SKU **[Varsayım]**). Boş / hatalı hücre → o katılımcı için kuş uçuşu tahmini
   `fallbackEta = haversine × 1,35 / ortalama hız` (Araç 8,3, Yürüyüş 1,3, Bisiklet 4,2 m/sn), `estimated: true`
   (arayüzde "~").
8. **Adalet puanı** (`rankMeetupCandidates`, düşük = iyi):

   ```text
   puan = en_uzun_süre + 0,5 × (en_uzun_süre − en_kısa_süre)
   ```

   Herkesin makul sürede varması (en uzun yolculuk) ve iki tarafın birbirine yakın süre harcaması birlikte gözetilir.
   Eşitlikte merkeze yakın olan önde. ETA'sı eksik aday elenir. İlk 3 öneri döner.

**Maliyet (öneri başına, önbellek ıskası):** 1 Nearby Search Pro isteği + Σ(mod) katılımcı × 5 matris öğesi (2 kişi,
aynı mod: 10 öğe). Önbellek (10 dk), kullanıcı kotası (30/gün), Faz 2 proje bütçesi ve kesme anahtarı aynen geçerli.
Kategori değişince öneriler yeniden aranır; katılımcı / mod değişince "Önerileri güncelle" gerekir (kota için
**[Varsayım]**). Anahtar yalnızca sunucuda (Secret Manager); istemci Google'a hiç gitmez.

### 4.2 Harita pin / liste gösterimi

- Giriş: EtaCard'da (arkadaş hedefi) **"📍 Buluşma noktası öner"**; nokta hedefinde "Buradan buluşma öner".
- `MeetupSheet` (arkasını karartmayan alt sayfa, harita üstte görünür kalır): kategori çipleri (☕ Kafe / 🚏 Durak /
  📍 Buluşma noktası), sonuç listesi 1–3 (ad, adres, `formatMeetupEtas` "Sen 8 dk · Ayşe Yılmaz 7 dk", tahminiyse "~",
  `formatFromCenter` "Orta noktaya 140 m"), yedek metinleri ("Yalnızca orta nokta gösteriliyor" vb.), konumu
  görünmeyen arkadaş uyarısı, katılımcı çipleri ve her biri için mod, "Konumum / Seçilen nokta".
- Haritada: **numaralı öneri pinleri** (1–3, seçili olan dolu; pine dokunmak listeden seçer), **orta nokta işareti**,
  seçili öneriye her katılımcıdan **kesikli çizgi**, benim **rotam** (mevcut `route_compute` / `useRouteEta`).
  Harita katılımcılar + öneriler + orta noktaya sığdırılır; seçimde katılımcılar + seçili öneriye.
- Paylaşılan öneri: yer pini (kategori emojisi + ad) ve kart.

### 4.3 Paylaşım akışı

```text
öneren: seç → "Paylaş" → alıcılar (varsayılan katılımcılar, ≤ 4) + saat (isteğe bağlı) + not → meetup_share
  sunucu: alıcıları arkadaşlarla süz (yoksa not_friends) · etas 'me' → öneren uid · expires_at = +12 sa
          → meetups/{id} · her alıcıya push {type:'meetup', meetup_id, from} "Ayşe · Buluşma noktası önerdi: …"
alıcı:  dinleyici (to ∋ ben) yeni öneriyi getirir (≤ 2 dk yeniyse kart kendiliğinden açılır) ya da push'a dokunma
        → meetupStore.focus → MeetupCard: öneren, yer + adres, saat + not, herkesin paylaşım anı ETA'sı, benim
        canlı ETA'm, "Yol tarifi" (google.com/maps/dir/?api=1&destination=lat,lng), "Geliyorum" / "Uyamam"
        → meetup_respond → önerene push {type:'meetup_response', …} "Ayşe · … için 'Geliyorum' dedi"
öneren: kartında yanıtlar ("Ayşe Yılmaz: Geliyorum") ve "Öneriyi iptal et" → meetup_cancel (alıcıya push yok
        [Varsayım]; kart dinleyicideki status:'cancelled' ile kapanır)
```

Push ön plandayken: `meetup` uygulama içi kart açar (sistem bildirimi gösterilmez); `zone_event` ve `meetup_response`
yerel bildirimle gösterilir.

---

## 5. Push özeti

| Tür | Alıcı | Veri (koordinat YOK) | Metin | Kanal / öncelik | Etiket |
| --- | --- | --- | --- | --- | --- |
| `zone_event` | notify kuralının alıcıları (hâlâ arkadaş) | `from, zone_name, transition` | "Deniz · Ev konumuna vardı" / "… konumundan ayrıldı" | Android `ping`, iOS `active` | `zone_${from}` |
| `meetup` | öneri alıcıları | `meetup_id, from` | "Ayşe · Buluşma noktası önerdi: Moda Kahve" | Android `ping`, iOS `active` | `meetup_${meetup_id}` |
| `meetup_response` | öneren | `meetup_id, by, response` | "Ayşe · Moda Kahve için 'Geliyorum' dedi" | Android `ping`, iOS `active` | `meetup_${id}_${by}` |
| yerel `zone_share_started` | kendim | `zone_id` | "Bölge kuralı · Ev · çıktın: Ayşe Yılmaz ile konum paylaşımı başladı" | `ping` | — |

---

## 6. Gizlilik kararları

- **Bölge koordinatı yalnızca sahibinde** [Varsayım: ürün kararı]: `users/{uid}/zones` yalnızca sahibine açık
  (kural alıcısı bile okuyamaz; rules testi). Push ve olay kaydı yalnızca **bölge adını** taşır; `zone_event_report`
  koordinat göndermez (yalnızca kimlik, yön, an, doğruluk). Arayüz bunu söyler: "Bölgenin yeri yalnızca sende kalır;
  arkadaşların yalnızca adını görür."
- Bölge adı alıcıya gider: kullanıcı "Ayşe'nin evi" gibi ad yazarsa bu bilgi de gider (arayüz adı 30 karakterle
  sınırlar).
- Tetikleme yalnızca **hâlâ arkadaş** olan alıcılara gider; arkadaşlık bitince / engellenince sunucu kurallardan çıkarır,
  olay anında yeniden doğrular. Hesap silinince bölgeler, olay kaydı ve soğuma belgeleri silinir.
- **Buluşma için arkadaş konumu sunucuya hesap için gider** [Varsayım]: `meetup_suggest` isteğinde bana görünen
  arkadaşların canlı konumu (zaten bende olan bilgi) Places / Routes hesabı için Cloud Functions'a ve Google'a gider;
  sunucuda katılımcı konumları saklanmaz; yalnızca sonuç (orta nokta, yerler, ETA'lar) 10 dk'lık, kullanıcıya özel
  önbellekte kalır (belge kimliği hücrelerin özetidir). Konumu görünmeyen
  arkadaş isteğe hiç girmez.
- Paylaşılan öneri yalnızca yerin konumunu ve paylaşım anındaki ETA'ları taşır (katılımcıların konumu değil). Alıcılar
  birbirini ve herkesin ETA'sını görür (öneri grup içindir) [Varsayım].
- Filtre kararları, uzaklık ve doğruluk yalnızca cihazda kalır (demo panelindeki "Son filtre kararları" teşhis içindir).

---

## 7. Testler

| Paket | Komut | Sonuç |
| --- | --- | --- |
| core | `cd packages/core && npx vitest run && npx tsc --noEmit` | 209/209 (16 dosya), Faz 5 için `test/faz5.test.ts` (12: filtre davranışı, merkez, puan, ayrıştırıcılar), tsc temiz |
| mobil | `cd apps/mobile && npx tsc --noEmit && npx jest` | 185/185 (23 suite), Faz 5 için `faz5Zones` (9: filtre → rapor, sapma → rapor yok, çevrimdışı aynı op_id, start_share, meetupStore katılımcıları, demo sunucusu, önbellek anahtarı) + `faz5Ui` (10: saf arayüz mantığı) |
| backend | `cd backend && npm run typecheck && npm run build && npm test` | 204/204 (19 dosya), Faz 5 için `test/functions/faz5.test.ts` (6) + kural testleri (bölge yalnızca sahibine, meetup sorguları) + push sözleşmesi (koordinat yok, `PUSH_TYPES_F5`, `ping` kanalı) |
| web | `cd apps/web && npm run typecheck && npm test` | 53/53 (4 dosya) |
| Android paketi | `EXPO_OFFLINE=1 CI=1 npx expo export --platform android` | Derlendi. Hermes paketinde demo metni yok ("FAZ 5 SENARYOLARI", "Demo kontrolleri", "Deniz Kaya", "Ev bölgemi buraya kaydet": 0; UTF-8 ve UTF-16), Faz 5 arayüz metinleri var (pozitif kontrol) |
| web demo | `npm run web:export` + Playwright | `dist-web/index.html` tek dosya (3,8 MB), 23/23 denetim, konsol hatası yok |

Tarayıcı demosu (`apps/mobile/dist-web/index.html`, giriş 532 123 45 67 / 123456 / "Deniz Kaya", panelde
"FAZ 5 SENARYOLARI"). "Evden çık" / "Eve var" yürüyüşü zaman atlamalı oynatılır (~70 sn'lik geriye tarihli
örnekler); filtre kuralları değişmez. Ekran görüntüleri 1280×860, 2x:

| Görüntü | Akış |
| --- | --- |
| `01-bolgelerim.png` | Panel "Ev bölgemi buraya kaydet" → Bölgelerim: 🏠 Ev · 150 m · "Şu an buradasın", iki kural özeti, izleme bandı |
| `02-bolge-duzenleyici.png` | Satıra dokun → düzenleyici: haritada 150 m daire + artı işareti, tür çipleri, yarıçap çipleri |
| `03-kural-duzenleyici.png` | "Çıkınca … paylaşımı başlat" kuralı: şablonlar, süre (1 saat), alıcılar, günler |
| `04-evden-cikis.png` | "Evden çık" → panelde "ONAYLANDI: 2 güvenli örnek (AYRILIŞ)", "Bölge kuralı · Ev · çıktın: Ayşe Yılmaz ile konum paylaşımı başladı" bildirimi, "Konumun paylaşılıyor" kartı |
| `05-gps-sapmasi.png` | "GPS sapması" → `doğruluk düşük` → `OS olayı: aday` → `ışınlanma`; tetik yok, son olay yok |
| `06-ayse-eve-vardi.png` | "Ayşe eve vardı" → bildirim "Ayşe Yılmaz · Ev konumuna vardı" (koordinat yok) |
| `07-bulusma-onerileri.png` | Ayşe → "Buluşma noktası öner": 3 kafe, haritada 1–3 pinleri + orta nokta + kesikli çizgiler, "Sen 8 dk · Ayşe Yılmaz 7 dk" |
| `08-bulusma-karti.png` | "Ayşe buluşma noktası önersin" → alıcı kartı: yer, saat + not, "Ayşe Yılmaz 7 dk · Sen 8 dk", canlı ETA, Geliyorum / Uyamam, Yol tarifi |

### 7.1 Cihazda yapılacak kabul senaryoları

1. **iOS uygulama kapalı (sistemce sonlandırılmış):** evden 300+ m uzaklaş. Kilit ekranında "Bölge kuralı" bildirimi
   ve alıcıda "… Ev konumundan ayrıldı" en geç ~3–5 dk içinde gelmeli. Aynısını kullanıcı kaydırarak kapattığında dene
   (iOS davranışı farklı olabilir).
2. **Android 12+ Doze / pil tasarrufu:** aynı senaryo; başsız açılışta `share_start` + ön plan servisi başlıyor mu?
3. **Kapalı alanda sabit telefon 2 saat:** hiç tetik olmamalı (Wi-Fi / hücresel konum sıçramaları).
4. **Sınırda yaşayan kullanıcı** (bölge kenarında otopark): 1 gün boyunca en çok 1 çıkış + 1 varış.
5. **iOS 20 bölge sınırı:** 15 bölge + aktif paylaşım (uyku çiti) birlikteyken bölge olayları ve uyku çiti çalışmalı.
6. **"Kullanırken" izni:** bant görünmeli, ön planda yürürken olay yine onaylanmalı; "Her zaman" verilince OS kaydı
   kendiliğinden yapılmalı.
7. **Buluşma (gerçek anahtar):** iki kişi farklı modlarla; Places / Route Matrix fatura satırları (Nearby Search Pro,
   Route Matrix öğe sayısı) beklenenle aynı mı?

---

## 8. Açık konular

- **Cihazda denenmedi:** iOS'ta uyku çitinin bölge görevine alınması, arka plan süresi içinde ikinci taze ölçüm
  (≤ 25 sn; kesilirse olay sonraki ölçümle doğrulanır), Android 12+ başsız paylaşım başlatma ve ön plan servisi
  istisnası. Native harita akışları (düzenleyicide harita kaydırma, react-native-maps daire / pin / kesikli çizgi)
  yalnızca tarayıcı önizlemesinde görüldü.
- **Places türleri ve SKU'lar** Google fiyat tablosu / belgesiyle doğrulanmalı (`MEETUP_CATEGORY_TYPES`,
  `PLACES_FIELD_MASK`, Route Matrix `TRAFFIC_UNAWARE`). Emülatörde Maps anahtarı olmadığı için `meetup_suggest`
  (too_close / too_far dışında) `places_unavailable` döner; gerçek anahtarla denenmedi.
- **Proje geneli meetup bütçe sayacı yok:** yalnızca kesme anahtarı, Faz 2 bütçesinin 0 kontrolü ve kullanıcı başına
  günde 30 sorgu **[Varsayım]**.
- **Arkadaşlık bitince** iki taraf arasındaki aktif buluşma önerisi iptal edilmiyor (en çok 12 sa sonra süresi doluyor,
  bu arada yanıt verilemiyor).
- **Hesap silme:** silinen uid başkalarının bölge kurallarında kalır (olay anında arkadaşlık doğrulandığı için ona
  bildirim gitmez).
- **Arayüz:** bölge emojisi türden gelir (ayrı emoji girişi yok); buluşma sayfası açıkken SOS düğmesi gizlenir (sayfa
  o alanı kaplıyor); paylaşılan öneri kartındaki canlı ETA rota kartının modunu kullanır (varsayılan Araç); web
  önizlemesinde "Geliyorum / Uyamam" seçimi yalnızca renkle işaretlenir (`aria-selected` üretilmiyor; native'de
  `accessibilityState.selected` var).
- **Dağıtım:** `firestore.rules` (zones, zone_events, meetups), `firestore.indexes.json` (4 TTL alanı:
  `zone_events.purge_at`, `zone_cooldowns`, `meetups.purge_at`, `meetup_cache.expire_at`) ve 7 yeni callable
  `firebase deploy` sonrası etkinleşir. `meetup_suggest` Maps sunucu anahtarı sırrını kullanır; Places API (New) ve
  Routes API projede açılmalı.
