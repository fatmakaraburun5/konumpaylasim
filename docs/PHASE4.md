# Faz 4: Hızlı Etkileşim, Kısa Notlar ve Tam Konumlu SOS

Faz 4, Faz 1–3 sözleşmelerini **genişletir**: canlı pakete yalnızca isteğe bağlı iki alan eklendi (`note`, `note_exp`),
mevcut alanların anlamı değişmedi. Yeni veriler kendi yollarında durur (`ping_inbox`, `place_notes`, `sos_alerts`,
`users/{uid}.emergency_contacts`). Çelişki olursa `packages/core` geçerlidir. **[Varsayım]** ile işaretlenen her şey
gerçek cihazda ya da ürün kararıyla doğrulanmalıdır.

**Durum:** Kod hazır. Birim, kural ve emülatör testleri geçiyor, tarayıcı demosunda üç akış uçtan uca çalışıyor (§6).
Gerçek cihazda denenmedi. iOS Critical Alerts yetkisi Apple onayı gerektirdiği için **kapalı** (§3.4).

| İstenen | Nerede |
| --- | --- |
| Ping, not ve SOS veri modelleri, sınırlar, Türkçe metinler, SOS tetikleme durum makinesi | `packages/core/src/{ping,notes,sos}.ts`, `packet.ts` (`note`, `note_exp`), `contracts.ts` (CALLABLES, PATHS, ERROR_CODES, PushData Faz 4) |
| Callable'lar (`ping_send`, `place_note_upsert/delete`, `emergency_contacts_set`, `sos_send/update/resolve/ack`) | `backend/functions/src/handlers/{ping,notes,sos}.ts`, `index.ts` |
| Push içeriği (Android kanal, APNs öncelik ve `interruption-level`) | `backend/functions/src/push.ts` (`buildPingPush`, `buildSosPush`, `buildSosResolvedPush`, `buildSosAckPush`) |
| Kurallar ve dizinler | `backend/database.rules.json` (`ping_inbox`, `ping_expiry`, pakette `note`/`note_exp`), `backend/firestore.rules` (`place_notes`, `sos_alerts`), `backend/firestore.indexes.json` |
| Süpürücü ve hesap silme temizliği | `backend/functions/src/handlers/{sweeper,user,friends}.ts`, `graph.ts` |
| Mobil durum depoları | `apps/mobile/src/state/{pingStore,notesStore,sosStore}.ts` |
| Dinleyiciler, push işleme, kanallar | `apps/mobile/src/services/{f4Services.ts,firebase/{pingInboxRepo,placeNotesRepo,sosRepo,f4Docs}.ts,notifications/{f4Push,push,expiryNotifications}.ts}` |
| Durum notunun pakete eklenmesi | `apps/mobile/src/services/location/pipeline.ts`, `src/state/persist.ts` |
| "Buradayım / Yoldayım" düğmeleri ve gelen ping kartı | `apps/mobile/src/features/ping/` (`PingButtons`, `PingToast`), `features/map/{EtaCard,FriendsScreen,FriendMarker}.tsx` |
| Durum ve yer notu sayfası, not pini, alt kart | `apps/mobile/src/features/notes/` (`NoteSheet`, `PlaceNoteCard`, `StatusNotePill`), `features/map/F4Markers*.tsx` |
| SOS düğmesi, geri sayım, gönderildi ekranı, alıcı tam ekran kartı, acil kişi seçimi | `apps/mobile/src/features/sos/` |
| iOS time-sensitive / critical-alerts yetkisi, Android DND izni | `apps/mobile/app.config.ts`, `src/lib/notificationConfig.ts`, `src/state/permissionsStore.ts` |
| Tarayıcı demosu ("FAZ 4 SENARYOLARI") | `apps/mobile/src/demo/server/server.ts`, `src/demo/shell/Faz4.web.tsx` |

---

## 1. Veri modelleri

Zamanların hepsi epoch ms (sunucu saati). Firestore belgelerinde yalnızca `purge_at` bir `Timestamp`'tir (TTL alanı);
callable yanıtlarında yer almaz.

### 1.1 Ping: `ping_inbox/{to}/{ping_id}` (RTDB)

```ts
interface Ping {
  ping_id: string;          // sha256(uid | op_id) ilk 24 hex: aynı op_id → aynı kayıt (idempotent)
  from: UserId;
  kind: 'here' | 'on_way';  // "📍 Buradayım" / "🚶 Yoldayım"
  sent_at: EpochMs;
  expires_at: EpochMs;      // sent_at + 15 dk (PING_LIMITS.ttlMs)
  location: { lat; lng; accuracy; timestamp } | null;  // 5 dk'dan eskiyse sunucu atar
  eta_s: number | null;     // yalnızca "Yoldayım"
}
```

- Yalnızca sunucu yazar. Alıcı okur ve **yalnızca silebilir** (`!newData.exists()`). Null alanlar yazılmaz,
  `parsePing` doldurur.
- Sunucu dizini `ping_expiry/{ping_id} = {to, from, expires_at}` (istemciye kapalı). Kutu iki seviye derin olduğu için
  süpürücü süresi geçenleri bu dizinden bulur.
- Sınırlar: aynı alıcıya 20 sn soğuma, kullanıcı başına saatte 30 ping. Aşılırsa `rate_limited` + `retry_after_ms`.
- Arkadaş değil, engelli ya da kendisi: hepsi aynı `not_friends` (bilgi sızmaz).

### 1.2 Durum notu: canlı pakette `note` + `note_exp`

```ts
interface StatusNote { emoji: string | null; text: string; expires_at: EpochMs }  // cihazda, persist.ts
// pakete: statusNoteExtras(myStatus, now) → { note: "☕ Kahve molasındayım", note_exp }
```

- Sunucuda belge **yoktur**. Not, gönderenin arkadaşlara giden `live_locations/{receiver}/{share_id}` paketlerine
  eklenir. Böylece notu tam olarak konumu görenler görür ve paket silinince not da gider.
- Kural: `note` 1–60 karakterlik metin, `note_exp` 0'dan büyük tamsayı. İkisi birlikte olmalı, biri tek başına gelirse
  bütün paket reddedilir. `link_live` (QR) paketine not **gitmez**.
- Süre: 30 dk, 1 sa, 4 sa ya da 1 gün (`noteDurationsFor('status')`). Not değişince cihaz hemen bir paket yayınlar.
  Alıcı `visibleStatusNote(location, now)` ile süresi geçmiş notu gizler.
- Cihazda `konum.bg.statusNote.v1` anahtarında kalıcıdır, çıkışta silinir.

### 1.3 Yer notu: `place_notes/{note_id}` (Firestore)

```ts
interface PlaceNote {
  note_id: string; owner_id: UserId;
  emoji: string | null; text: string;                  // sanitizeNoteText, ≤ 60
  position: { lat; lng; accuracy: number | null };
  visible_to: UserId[];                                // boş = yalnızca sahibi; en çok 20 kabul edilmiş arkadaş
  created_at; updated_at; expires_at: EpochMs;         // 30 dk … 1 hafta
}  // + purge_at: Timestamp (TTL)
```

- Yalnızca callable yazar. Sahibi `owner_id == ben`, okuyucu `visible_to array-contains ben` sorgusuyla okur.
- Kullanıcı başına en çok 20 aktif not, aşılırsa `note_limit_reached`. Başkasının notu ya da olmayan not için
  `note_not_found`. Düzenlemede `created_at` korunur, silme idempotenttir (`{deleted:false}`).
- `visible_to` içindeki kabul edilmemiş ya da engelli kişiler sessizce atılır. Arkadaşlık bitince karşı taraf
  listeden çıkarılır.

### 1.4 SOS: `sos_alerts/{sos_id}` ve `users/{uid}.emergency_contacts` (Firestore)

```ts
interface SosAlert {
  sos_id: string; sender_id: UserId; sender_name: string;
  recipient_ids: UserId[];                         // gönderim anındaki geçerli acil kişiler (≤ 5)
  status: 'active' | 'resolved'; resolve_reason: 'safe' | 'timeout' | 'account_deleted' | null;
  message: 'Şu anda olduğum konumda tehlikedeyim';
  location: { lat; lng; accuracy; timestamp };     // TAM konum ZORUNLU, doğruluk yarıçapı metre
  address: string | null;                          // ters geocode, en çok 2 sn
  maps_url: string;                                // sosMapsUrl: iOS/Android/web açar
  battery_pct: number | null; is_charging: boolean | null;
  route: { destination_label; eta_s; distance_m } | null;   // açık rota/ETA varsa
  created_at; updated_at; resolved_at: EpochMs | null;
  acks: Record<UserId, EpochMs>;                   // "Gördüm"
  update_count: number;
}  // + purge_at: Timestamp (TTL)
```

- Okuma: gönderen (`sender_id == ben`) ve alıcılar (`recipient_ids array-contains ben`). İstemci yazamaz.
- Acil kişiler en çok 5 kişidir, sıra korunur. Yalnızca kabul edilmiş ve engelsiz arkadaşlar tutulur. SOS anında liste
  yeniden süzülür: arkadaşlığı biten kişiye uyarı gitmez.
- Aktif SOS varken yeniden basılırsa yeni belge açılmaz. Aynı belge yeni konumla güncellenir, alıcılara tekrar push
  gider ve aynı `sos_id` döner.
- Saatte en çok 10 SOS gönderilebilir. Sınır, acil durumu engellemeyecek kadar yüksek tutuldu.
- Aktif SOS 24 saat sonra süpürücü tarafından `resolved/timeout` yapılır. Çözülmüş SOS alıcıda 1 saat "güvende"
  kartıyla görünür.

### 1.5 Callable'lar ve hata kodları

| Callable | İstek → yanıt | Özel hatalar |
| --- | --- | --- |
| `ping_send` | `{op_id, to, kind, location?, eta_s?}` → `{ping_id, expires_at, server_now}` | `not_friends`, `rate_limited` |
| `place_note_upsert` | `{op_id, note_id?, emoji, text, position, visible_to, duration_ms}` → `{note}` | `note_limit_reached` (resource-exhausted), `note_not_found` (not-found), `invalid_argument` |
| `place_note_delete` | `{op_id, note_id}` → `{deleted}` | `note_not_found` |
| `emergency_contacts_set` | `{op_id, contact_ids}` → `{contact_ids}` (süzülmüş) | — |
| `sos_send` | `{op_id, location, battery_pct, is_charging, route, address}` → `{sos, recipients}` | `no_emergency_contacts` (failed-precondition), `rate_limited` |
| `sos_update` | `{op_id, sos_id, location, …}` → `{sos}` (15 sn'den sık: mevcut belge, hata yok) | `sos_not_active` (failed-precondition) |
| `sos_resolve` | `{op_id, sos_id}` → `{sos}` (idempotent) | `sos_not_active` |
| `sos_ack` | `{op_id, sos_id}` → `{sos}` | `sos_not_active` |

Hepsi `europe-west1`'de çalışır, App Check ister ve `op_id` ile idempotenttir (`runOp`). Push başarısız olsa da
callable başarılı döner. Belgeyi göremeyen biri hangi durumda olursa olsun aynı `sos_not_active` yanıtını alır.

---

## 2. Gerçek zamanlı ve push iletim akışı

Kural: **uygulama açıksa dinleyici, kapalıysa push**. Push yükünde koordinat yoktur. Koordinat, uygulama açılınca
yetkili okuma ile `ping_inbox` ya da `sos_alerts`'tan gelir. SOS push gövdesi bilinçli bir istisna taşır: kilit
ekranında okunabilsin diye adres, doğruluk ve pil içerir, ama ham koordinat içermez.

### 2.1 Ping

```text
Gönderen (EtaCard / Arkadaşlar)        ping_send (Functions)                 RTDB / FCM              Alıcı
  │ "📍 Buradayım" dokun                    │                                    │                        │
  │ pingStore.send: soğuma yerelde          │                                    │                        │
  │ + taze konum (≤ 5 dk), eta_s           │                                    │                        │
  ├──────────── callable (op_id) ─────────►│ tx: arkadaşlık + engel + oranlar   │                        │
  │                                         │ op kaydı                           │                        │
  │                                         ├─ çok yollu yazma ─────────────────►│ ping_inbox/{to}/{id}  │
  │                                         │                                    │ ping_expiry/{id}      │
  │◄─────── {ping_id, expires_at} ──────────┤                                    │                        │
  │ "Gönderildi" + 20 sn soğuma             ├─ push {type:'ping', ping_id, from, kind} ─────────────────►│
  │                                         │   Android kanal `ping` (HIGH), iOS `active`, tag=ping_{from}│
  │                                         │                                    │── onValue (açıksa) ──►│ pingStore.upsertIncoming
  │                                         │                                    │                        │ → PingToast (12 sn) + pin nabzı (8 sn)
  │                                         │                                    │                        │ → canlı pini yoksa geçici "ping pini"
  │                                         │                                    │                        │ bildirime dokunma → highlightFrom(from)
  │                                    süpürücü (dk'da bir): ping_expiry süresi geçen → iki kaydı da sil
```

### 2.2 Durum notu

```text
NoteSheet "Notu ekle" → notesStore.setMyStatus → persist → onStatusChange → pipeline yayını hemen zorlar
  → buildPackets(extras: statusNoteExtras) → live_locations/{alıcı}/{share_id} (kural: note+note_exp birlikte)
  → alıcı liveRepo → IncomingFriendLocation.location.note → FriendMarker balonu + EtaCard satırı
Süre dolunca: gönderen pakete eklemeyi bırakır; alıcı visibleStatusNote ile zaten gizler.
```

### 2.3 Yer notu

```text
EtaCard (nokta hedefi) "📝 Buraya not bırak" → NoteSheet (place) → place_note_upsert
  → place_notes/{id} → okuyucuların onSnapshot (visible_to array-contains) → F4Markers not pini → PlaceNoteCard
Süre dolunca istemci gizler (selectPlaceNotes(now)); süpürücü siler; TTL purge_at son çare.
```

### 2.4 SOS

```text
Gönderen                    sosStore                      sos_send                     Firestore / FCM           Alıcı (acil kişi)
 │ basılı tut 1,5 sn        │                              │                             │                         │
 │ → geri sayım 5 sn ──────►│ prepare(): yüksek doğruluk   │                             │                         │
 │   (İptal / Hemen gönder) │ ölçümü ŞİMDİ başlar          │                             │                         │
 │ 0 ya da "Hemen gönder" ─►│ konum: ≤15 sn & ≤35 m ise    │                             │                         │
 │                          │ hemen; yoksa hazır ölçüm     │                             │                         │
 │                          │ (≤ 8 sn), yoksa son bilinen  │                             │                         │
 │                          │ ∥ pil ∥ adres (≤ 2 sn)       │                             │                         │
 │                          ├── callable (op_id) ─────────►│ kişileri yeniden süz        │                         │
 │                          │  unavailable → AYNI op_id    │ aktif SOS varsa güncelle    │                         │
 │                          │  ile 3 sn arayla 5 kez       │ adres yoksa ≤ 2 sn geocode  ├─ sos_alerts/{id} ──────►│ onSnapshot (açıksa)
 │                          │                              ├─ push {type:'sos'} her alıcıya ─────────────────────►│ (kapalı/arka plan)
 │◄── "Uyarı gönderildi" ───┤◄─ {sos, recipients} ─────────┤  Android `sos` MAX, iOS time-sensitive|critical     │
 │  1 sa canlı paylaşım     │                              │                             │                         │ focusedSosId → tam ekran
 │  (zaten yoksa) [Varsayım]│                              │                             │                         │ "ACİL DURUM" kartı
 │                          │ ön planda 15 sn'de bir       │                             │                         │
 │                          ├── sos_update (push yok) ────►│ konum/pil/rota, update_count├────────────────────────►│ kart canlı güncellenir
 │                          │                              │                             │◄── sos_ack "Gördüm" ────┤
 │◄── push {type:'sos_ack'} "Ayşe uyarını gördü" (ping kanalı, iOS active: tehlikedeki telefon bağırmaz) ──────────┤
 │ "Güvendeyim" → onay ────►├── sos_resolve ──────────────►│ resolved/safe               ├─ push {type:'sos_resolved'} (aynı tag/collapse-id:
 │                          │                              │                             │   alarm bildiriminin YERİNE geçer) ►│ yeşil "güvende"
 süpürücü: 24 sa'i aşan aktif SOS → resolved/timeout. Hesap silme: aktif SOS → account_deleted (push yok).
```

### 2.5 Push özeti

| Push | Kime | Android | iOS (APNs) | Dokununca |
| --- | --- | --- | --- | --- |
| `ping` | alıcı | kanal `ping` (HIGH), `tag: ping_{from}` (yenisi eskisinin yerine), TTL = kalan süre | `apns-priority: 10`, `interruption-level: active`, `apns-collapse-id`, `apns-expiration` | haritada göndereni vurgula |
| `sos` | her acil kişi | `priority: high` (Doze'da da iletilir), kanal `sos` (MAX, `bypassDnd`, kilit ekranında herkese açık, alarm sesi + titreşim), `sticky`, `tag: sos_{id}` | `apns-priority: 10`, `time-sensitive` (varsayılan) ya da `critical` + kritik ses (`SOS_CRITICAL_ALERTS=1`), kategori `sos` | `sosStore.focus(sos_id)` → tam ekran kart |
| `sos_resolved` | her acil kişi | kanal `ping`, aynı `tag` | `time-sensitive`, aynı `apns-collapse-id` | `sosStore.focus(sos_id)` (yeşil kart) |
| `sos_ack` | gönderen | kanal `ping` | `active` | — |

Bildirim soğuk açılışta da işlenir: `getInitialNotification` olayı, koordinatör kurulana kadar bekletilir
(`f4Push.routeF4Open`).

---

## 3. SOS acil durum ekranı ve bildirim davranışı

### 3.1 Alıcı ekranı (`SosIncomingScreen`)

Tam ekran ve kırmızıdır. Temadan bağımsızdır: koyu temada da aynı kontrast. Ekranda şunlar var:

- **Başlık:** "ACİL DURUM", gönderenin adı, "Şu anda olduğum konumda tehlikedeyim", "x dk önce gönderildi ·
  güncellendi …".
- **Konum:** adres, koordinat (`formatCoords`, Kopyala), doğruluk ("Doğruluk ±6 m"), pil, rota/ETA
  ("Deniz Kaya yönüne: 9 dk · 1,8 km").
- **Eski konum:** ölçüm 2 dk'dan eskiyse "eski konum" uyarısı (`isSosLocationStale`).
- **Düğmeler:** "Haritada göster", "Yol tarifi" (`sosDirectionsUrl`), "112'yi ara" (`tel:112`), "Gördüm" (ack).
- **Çözülünce:** kart yeşil "güvende" durumuna geçer.
- **Kapatınca:** haritada kırmızı SOS şeridi ve kırmızı, nabızlı pin kalır. Gönderenin canlı pini yoksa SOS konumunda
  geçici pin çizilir, native'de doğruluk dairesiyle.
- **Birden çok SOS:** en yenisi üstte, diğerleri listede.

Gönderen ekranı (`SosActiveScreen`) şunları gösterir: "Uyarı gönderildi", kimlerin gördüğü (İletildi / ✓ Gördü),
gönderilen konum + doğruluk + adres + pil, "112'yi ara", "Güvendeyim" (onaylı) ve "Haritaya dön". Harita üzerinde
"SOS aktif" düğmesi ekranı yeniden açar.

### 3.2 Bildirim kanalları ve ön plan

| Durum | iOS | Android |
| --- | --- | --- |
| Uygulama ön planda | `setNotificationHandler`: Faz 4 türleri afiş olarak gösterilir. `sos` ve `sos_resolved` sesli. Tam ekran kart da dinleyiciyle açılır. | FCM ön planda bildirim göstermez. `push.ts` aynı içerikle yerel bildirim kurar (kanal `sos` / `ping`). `ping` ön planda yalnızca uygulama içi kartla gösterilir. |
| Arka plan / kilit ekranı | Sistem bildirimi. `time-sensitive` Odak ve Bildirim Özeti'ni aşar. Kategori `sos` `showTitle: true` olduğundan önizleme kapalı olsa da başlık ("ACİL: Ayşe tehlikede") görünür, gövde yerine "Acil durum uyarısı — görmek için aç" çıkar. | `priority: high` FCM, `sos` kanalı IMPORTANCE_MAX: heads-up, kilit ekranında tam içerik (`PUBLIC`), `sticky`. |
| Uygulama kapalı (zorla kapatılmamış) | APNs bildirimi gelir, dokununca soğuk açılış → kart. | FCM bildirimi gelir, dokununca soğuk açılış → kart. Zorla kapatılmış uygulamaya FCM ulaşmaz (Android sınırı). |
| Rahatsız Etme / Odak | `time-sensitive` Odak'ı aşar (kullanıcı uygulama için "Zamana Duyarlı"yı kapatmadıysa). `critical` her durumda aşar. | Kanal `bypassDnd: true`. Sistem bunu yalnızca kullanıcı uygulamaya "Rahatsız Etme erişimi" verdiyse (ya da kanal ayarında "Rahatsız Etme'yi geçersiz kıl" açıksa) uygular. `ACCESS_NOTIFICATION_POLICY` bildirildi. |
| Sessiz mod | `time-sensitive` **sessiz anahtarı aşmaz** (titreşir, ses çalmaz). Yalnızca `critical` ses çalar. | Ses alarm akışında (`AndroidAudioUsage.ALARM`) [Varsayım]: zil sessizken de alarm sesi düzeyinde çalar. DND "yalnızca alarmlar" modunda da duyulur. |
| Tekrar ve kapanış | Aynı SOS'un tekrar gönderimi ve "güvende" bildirimi aynı `apns-collapse-id` ile önceki bildirimin yerine geçer. | Aynı `tag` ile yerine geçer. |

### 3.3 Erişilebilirlik ve görünürlük

- Kart metinleri büyük ve kalındır. Ana düğmeler 64 pt yüksekliktedir. Kırmızı zeminde (`#B91C1C`) beyaz metin
  kullanılır, kontrast ≈ 6,5:1 (WCAG AA).
- Alıcı kartının başlık bloğu `accessibilityLiveRegion="assertive"` olduğu için kart açılınca ekran okuyucu ad ve
  mesajı hemen okur. Geri sayım `accessibilityLiveRegion` ile her saniye duyurulur.

### 3.4 Apple Critical Alerts yetkisi (başvuru gerekli)

`critical` düzeyi sessiz modu ve Odak'ı aşar, kendi ses düzeyiyle çalar. Bu düzey yalnızca Apple'ın
`com.apple.developer.usernotifications.critical-alerts` yetkisiyle kullanılabilir. Yetki **başvuruyla** verilir
(developer.apple.com → Contact → "Critical Alerts Entitlement"). Başvuruda kullanım gerekçesi anlatılır: kişisel
güvenlik ve acil durum uyarısı, yalnızca kullanıcının seçtiği acil kişilere gider, kötüye kullanım sınırları vardır.
Onay gelince:

1. App ID'de yetkiyi aç, provisioning profilini yenile.
2. Mobil derlemeyi `IOS_CRITICAL_ALERTS=1` ile al. `app.config.ts` yetkiyi ekler, izin isteğinde
   `allowCriticalAlerts: true` sorulur.
3. Functions ortamında `SOS_CRITICAL_ALERTS=1` ayarla. `buildSosPush` `interruption-level: critical` ve
   `sound: {critical: 1, volume: 1}` gönderir.

İki bayrak birlikte açılmalıdır. Yetkisiz derleme imzalanamaz. Yetki olmadan `critical` gönderilirse iOS bildirimi
normal düzeyde gösterir. Onaya kadar SOS `time-sensitive` kalır, bu düzey Odak'ı aşar ama sessiz modu aşmaz.
Android'de eşdeğer yetki yoktur. Kullanıcıdan "Rahatsız Etme erişimi" istemek gerekir (§7).

---

## 4. Yanlış tetiklemeyi önleyen ama hız kaybettirmeyen UX

```text
[SOS] basılı tut ──(1,5 sn, halka dolar)──► geri sayım 5…1 ──(0)──► gönder ──► "Uyarı gönderildi"
   │ erken bırak                              │ "İptal"                          │ "Güvendeyim" → onay → kapat
   ▼                                          ▼                                  │
 "Göndermek için basılı tut" ipucu (2,5 sn)   başa dön                           └ "112'yi ara" her an
 erişilebilirlik eylemi "activate" ─────────► doğrudan geri sayım (güvenlik geri sayımda)
 "Hemen gönder" ─────────────────────────────► geri sayımı atla
 acil kişi listesi yüklendi ve boş ──────────► kişi seçimi (≤ 5) → "Kaydet ve devam et" → doğrudan geri sayım
```

Durum makinesi core'dadır (`sosFlowReduce`, `sosHoldProgress`, `sosCountdownLeft`) ve testlidir.

**Yanlış basmayı önleyen katmanlar:**

1. Tek dokunuş hiçbir şey göndermez, 1,5 sn basılı tutmak gerekir. Cepte ya da kazara dokunma halkayı doldurmaz.
2. Basılı tutmadan sonra 5 sn'lik tam ekran geri sayım gelir. "İptal" büyük ve başparmak hizasındadır. Kime gideceği
   ve hangi bilgilerin gideceği görünür.
3. "Güvendeyim" onaylıdır. Kazara kapatma, alıcıları yanlışlıkla rahatlatmaz.
4. Sunucu tarafında saatte 10 SOS sınırı var. Aktif SOS'a tekrar basmak yeni alarm açmaz, aynı uyarıyı tazeler.

**Neden hız kaybettirmez:**

- En kısa yol 1,5 sn basılı tutmak ve "Hemen gönder"e dokunmaktır, yaklaşık 2 sn. Hiçbir şeye dokunamayan kişi için
  basılı tutma ve 5 sn sonra kendiliğinden gönderim yeterlidir.
- Konum ölçümü geri sayım **başlarken** başlar (`prepare()`). Geri sayım ile GPS ısınması üst üste biner. 15 sn'den
  taze ve ±35 m'den iyi konum varsa hiç beklenmez. Taze ölçüm en çok 8 sn sürer, sonra son bilinen konum gider ve
  alıcıda "eski konum" uyarısı çıkar. Konum hiç yoksa izin istenir.
- Pil ve adres paralel alınır. Adres en çok 2 sn beklenir, bulunamazsa sunucu da dener. Adres gönderimi bekletmez.
- Ağ hatasında aynı `op_id` ile 3 sn arayla 5 kez yeniden denenir. Sunucu işlemi bir kez uygular, çift alarm olmaz.
- Acil kişi seçilmemişse seçim sayfası akışın içindedir: kaydedince doğrudan geri sayıma geçer. Liste henüz
  yüklenmediyse (açılışın ilk saniyeleri) sayfa açılmaz, karar sunucudadır.
- Ekran okuyucu kullanıcısı basılı tutmak zorunda değildir. "activate" eylemi geri sayımı doğrudan açar. Güvenlik geri
  sayımda olduğu için koruma kaybolmaz.

**Ping ve notlarda hız:** ping tek dokunuştur, onay yoktur. 20 sn soğuma çift dokunmayı yutar ve düğme o sürede pasif
görünür. Not sayfası hazır çiplerle açılır ("☕ Kahve molasındayım", "🅿️ Park yeri burası", "🔑 Anahtar burada").
Tek dokunuşla seçilir. Varsayılan süre durum notunda 1 saat, yer notunda 1 gündür.

---

## 5. Gizlilik kararları

- **Ping konumu** yalnızca alıcının kendi kutusuna gider ve 15 dk sonra silinir. Konum 5 dk'dan eskiyse ping konumsuz
  gider. Konum hem "Buradayım" hem "Yoldayım"da (taze konum varsa) eklenir [Varsayım]. Push'ta koordinat yoktur.
- **Durum notu** sunucuda ayrı belge olarak tutulmaz. Yalnızca konumu zaten gören arkadaşlara giden pakette taşınır.
  QR izleyicilerine not gitmez [Varsayım].
- **Yer notu** varsayılan olarak "Yalnızca ben"dir. Okuyan arkadaş `visible_to` listesini görebilir, çünkü Firestore
  alan gizlemez [Varsayım]. Liste yalnızca sahibin seçtiği arkadaşlardan oluşur. Arkadaşlık bitince ya da engellenince
  karşı taraf listeden çıkarılır [Varsayım].
- **SOS push gövdesi** adres, doğruluk ve pil içerir, ham koordinat içermez. Bu, "push koordinat taşımaz" kuralının
  bilinçli tek istisnasıdır [Varsayım]: kilit ekranında harekete geçirecek kadar bilgi gerekir.
- **SOS'tan sonraki paylaşım:** acil kişilerle zaten canlı paylaşım yoksa 1 saatlik paylaşım otomatik başlar
  [Varsayım]. Kullanıcı bunu her zamanki gibi durdurabilir.
- **Bilgi sızıntısı:** görmeye yetkisi olmayana `sos_not_active`, arkadaş olmayana `not_friends` döner. Hedefin var
  olup olmadığı ya da engel durumu sızmaz.
- **Hesap silme:** kullanıcının yer notları, ping kutusu ve `ping_expiry` kayıtları silinir. Aktif SOS'u
  `account_deleted` ile kapanır (alıcıya push gitmez [Varsayım]). Kullanıcı başkalarının acil kişi ve not
  listelerinden çıkarılır.
- **Yeniden deneme:** `ping_send` aynı `op_id` ile tekrarlanırsa, alıcının silmiş olduğu ping en çok 15 dk için geri
  gelebilir [Varsayım].

---

## 6. Testler

| Paket | Komut | Sonuç |
| --- | --- | --- |
| core | `cd packages/core && npx vitest run && npx tsc --noEmit` | 197/197 (15 dosya), tsc temiz |
| mobil | `cd apps/mobile && npx tsc --noEmit && npx jest` | 166/166 (21 suite), Faz 4 için `faz4Stores` (8) + `faz4Ui` (6) |
| backend | `cd backend && npm run typecheck && npm test` | 195/195 (18 dosya), Faz 4 için `test/functions/faz4.test.ts` (6) + kural testleri + `DELIVERED_FIELDS` ↔ kural ve `CALLABLES` ↔ `index.ts` sözleşme testleri. Tam koşuda Faz 3'ten bilinen `cutoff.test.ts` zamanlama titremesi bir kez görüldü, dosya tek başına 8/8 geçti |
| web | `cd apps/web && npm run typecheck && npm test` | 53/53 |
| Android paketi | `EXPO_OFFLINE=1 CI=1 npx expo export --platform android` | Derlendi. Hermes paketinde demo metni yok ("FAZ 4 SENARYOLARI", "Demo kontrolleri", "Ayşe SOS göndersin", "Deniz Kaya": 0; UTF-8 ve UTF-16 arandı) |
| web demo | `npm run web:export` + Playwright | `dist-web/index.html` tek dosya, 18/18 denetim, konsol hatası yok |

Odaklı yeni testler şunları doğrular:

- **SOS gönderimi:** kişi listesi yüklendi ve boşsa ağa çıkılmaz. Liste yüklenmediyse karar sunucuya bırakılır.
  `unavailable` hatasında aynı `op_id` ile yeniden denenir. Pakette tam konum, pil ve adres vardır.
- **Ping ve durum notu:** ping soğuması ve gelen pingin vurgusu çalışıyor. Durum notu kaydında anında yayın
  tetikleniyor.
- **Demo sunucusu:** SOS akışı ve `note`/`note_exp` kuralı backend ile aynı.
- **Backend:** ping'de koordinatsız push gidiyor, eski konum atılıyor. Not oluştur → düzenle → yetkisiz kullanıcı
  düzenleyemiyor → sil işliyor. SOS gönder → tekrar gönder (aynı `sos_id`) → gördüm → güncelle → güvendeyim zinciri
  ve arkadaşlık bitince kişinin listeden düşmesi doğrulanıyor.

Tarayıcı demosu (`apps/mobile/dist-web/index.html`, giriş 532 123 45 67 / 123456 / "Deniz Kaya", panelde
"FAZ 4 SENARYOLARI"). Ekran görüntüleri 1280×860, 2x:

| Görüntü | Akış |
| --- | --- |
| `01-ping-buradayim.png` | Panel "Ayşe 'Buradayım' göndersin" → üstte ping kartı, Ayşe'nin pininde nabız halkası, ping pini |
| `02-durum-notu-sayfasi.png` | "Not ekle" → hazır çipler, emoji + metin (18/60), süre seçimi |
| `03-durum-notu-balonu.png` | Panel "Ayşe durum notu" → pin altında "☕ Kahve molasındayım" balonu; kendi notum sol altta |
| `04-yer-notu-karti.png` | Panel "Ayşe park yeri notu" → not pini ve alt kart ("Ayşe Yılmaz bıraktı · 3 sa 59 dk kaldı") |
| `05-sos-acil-kisi-secimi.png` | SOS basılı tut, acil kişi yok → kişi seçimi (2/5) |
| `06-sos-geri-sayim.png` | "Kaydet ve devam et" → 5 sn geri sayım, kime, giden bilgiler, "Hemen gönder" / "İptal" |
| `07-sos-gonderildi.png` | "Uyarı gönderildi", iki kişi "✓ Gördü", adres + koordinat + ±10 m + pil |
| `08-sos-alici-acil-karti.png` | Panel "Ayşe SOS göndersin" → alıcı tam ekran "ACİL DURUM": adres, koordinat, ±6 m, pil %23, rota |

### 6.1 Cihazda yapılacak kabul senaryoları

1. **Kilitli telefonda SOS:** alıcı telefon kilitli, Odak "Uyku" açık. SOS gönderilince kilit ekranında başlık ve
   adres okunmalı. Dokununca tam ekran kart açılmalı. Bunu iOS (time-sensitive) ve Android (kanal `sos`, DND erişimi
   verilmiş ve verilmemiş) için ayrı ayrı dene.
2. **Sessiz mod:** iOS'ta sessiz anahtar açıkken `time-sensitive` titreşmeli. Critical yetkisi gelince sesli çalmalı.
   Android'de zil sessizken alarm sesi duyulmalı.
3. **Uygulama kapalı:** alıcıda uygulama kaydırılarak kapatılmış olsun. Bildirime dokununca soğuk açılışta kart
   açılmalı.
4. **Konumsuz başlangıç:** göndericide GPS kapalı. SOS uyarısı en geç ~8 sn içinde son bilinen konumla gitmeli,
   alıcıda "eski konum" uyarısı çıkmalı.
5. **Ağ kesintisi:** SOS uçak modunda tetiklenir ve 10 sn içinde ağ açılır. Uyarı tek kez gitmeli.
6. **Ping:** iki telefon arasında "Yoldayım" gönder, ETA bildirimde görünmeli. 20 sn içinde ikinci ping düğmesi pasif
   olmalı.

---

## 7. Açık konular

- **Apple Critical Alerts** başvurusu yapılmadı (§3.4). Onaya kadar sessiz modda iOS SOS'u sesli çalmaz.
- **Android "Rahatsız Etme erişimi":** kullanıcıyı `ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS` ekranına götüren bir
  ayar girişi ya da izin adımı henüz yok. Bu yapılmadıkça `bypassDnd` uygulanmayabilir. Acil kişi seçiminden sonra
  bir kez sorulması önerilir.
- **Android tam ekran bildirimi** (`USE_FULL_SCREEN_INTENT`, kilitli ekranda doğrudan kart açma) eklenmedi. Android
  14'te bu izin yalnızca arama ve alarm uygulamalarına otomatik verilir, Play politikası incelenmeli.
- **Native performans:** pin nabzı (`FriendMarker`), nabız sürdükçe native pin görüntüsünü yeniden çiziyor. Çok pinli
  haritada cihazda ölçülmeli.
- **Arayüz eksikleri:**
  - Ping kartını kapatmak yalnızca kartı gizler, ping kutudan silinmez (`pingStore.dismiss` çağrılmıyor). Ping pini
    15 dk sonra kendiliğinden kalkar [Varsayım].
  - IncomingStrip kartlarında ping düğmesi yok. Ping, EtaCard ve Arkadaşlar ekranından gönderiliyor.
  - Acil kişileri düzenleme girişi yalnızca Arkadaşlar ekranında.
- **SOS rotası:** yalnızca SOS anında açık olan EtaCard rotası alınır. Açık rota yoksa paket rotasız gider [Varsayım].
- **Push içeriği** emülatörde sahte göndericiyle doğrulandı. Gerçek FCM/APNs teslimi, DND aşımı ve kilit ekranı
  görünümü cihazda doğrulanmalı (§6.1).
- **Dağıtım:** yeni bileşik dizinler ve `place_notes.purge_at` / `sos_alerts.purge_at` TTL alanları
  `firebase deploy` sonrası etkinleşir.
