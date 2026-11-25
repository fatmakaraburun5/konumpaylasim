# Konum İste (istek ve süreli onay)

Bir arkadaşın şu an seninle paylaşmıyorsa ondan konum isteyebilirsin. O kişi bildirimden ya da uygulama içinden
**Onayla** (süre seçer) veya **Reddet** der. Onaylanınca paylaşım isteyenin haritasında hemen başlar ve
onaylayanın paylaşım kitapçığına (ShareDeck) girer.

Kod: `packages/core/src/locationRequest.ts` (kurallar, metinler), `backend/functions/src/handlers/requests.ts`,
`apps/mobile/src/state/locationRequestStore.ts`, `apps/mobile/src/features/locationRequest/*`,
`apps/mobile/src/services/locationRequestServices.ts`, `apps/mobile/src/services/notifications/locationRequestPush.ts`.

## Veri modeli

`location_requests/{requester}_{target}`: çift başına tek belge. İki taraf da okur, istemci yazmaz (yalnızca callable).

| Alan | Anlam |
|---|---|
| `request_id`, `requester_id`, `target_id` | kimlik ve taraflar |
| `status` | `pending` · `approved` · `rejected` · `expired` · `cancelled` |
| `created_at`, `expires_at` | gönderim anı, gönderim + 15 dk |
| `responded_at`, `share_id` | yanıt anı, onaylanınca başlayan (ya da uzayan) paylaşım |

Durum akışı: `pending → approved | rejected | cancelled | expired`. Eski kayıtlardaki `accepted/declined`
istemcide `approved/rejected` olarak okunur.

## Callable'lar

| Ad | Kim | Ne yapar |
|---|---|---|
| `location_request_send {target_id}` | isteyen | Arkadaş değilse `not_friends`. Hedef zaten paylaşıyorsa `already_sharing` (istek ve push yok). Bekleyen istek varsa aynısı döner (yeni push yok). Aynı çift için 10 dk bekleme, günde 30 istek (`rate_limited` + `retry_after_ms`). |
| `location_request_cancel {request_id}` | isteyen | "Geri çek". Idempotent, bekleme süresini sıfırlamaz. |
| `location_request_respond {request_id, accept, duration?, time_zone?}` | hedef | Ret: `rejected` + isteyene sade push. Onay: hedef → isteyen `location_view` izni + paylaşım + istek **tek transaction'da**; varsayılan 1 saat. Mevcut paylaşım daha uzunsa dokunulmaz, daha kısaysa aynı oturumda uzar (kabul asla kısaltmaz). |

Süre seçenekleri (`REQUEST_DURATION_OPTIONS`): 15 dk, 1 saat (varsayılan), 8 saat, Gün sonuna kadar, Haftalık,
Süresiz, Saat seç (bitiş saati / süre).

## Bildirimler

| Tür | Kime | Metin | Eylemler |
|---|---|---|---|
| `location_request` | hedef | "Konum isteği · Can konumunu paylaşmanı istiyor" | **Onayla** (uygulamayı açar → süre seçici) · **Reddet** (uygulamayı açar, hemen reddeder) · dokunma → harita kartı |
| `location_request_answered` | isteyen | onay: "Konum isteğin onaylandı · Can konumunu seninle paylaşıyor"; ret: "Can şu an konumunu paylaşamıyor" | dokunma → harita / Arkadaşlar |

- iOS: APNs alert + `category: LOCATION_REQUEST` (eylemleri sistem gösterir), `apns-collapse-id` = istek kimliği.
- Android: FCM **yalnızca veri** taşır (yüksek öncelik). Eylemler yerel bildirimde çalıştığı için bildirimi uygulama
  gösterir; uygulama kapalıyken `setBackgroundMessageHandler` gösterir. Kanal `location_requests` (yüksek önem).
- Uygulama öndeyken iki platformda da yerel bildirim + haritada istek kartı.
- Push'ta koordinat yoktur. Ret nedeni (görünmez, istemiyor) söylenmez.

## Arayüz

- **Konum iste** düğmesi: Arkadaşlar satırı ve kişi sayfası. Kişi bana paylaşıyorsa görünmez.
  Bekliyorsa "Konum isteği gönderildi · Yanıt bekleniyor (14 dk)" + **Geri çek**; ret / süre dolumu / geri çekme
  sonrası kısa durum ve "8 dk sonra tekrar isteyebilirsin".
- **Gelen istek kartı**: haritanın üst şeridinde (en çok 2) ve Arkadaşlar ekranının başında: "Can konumunu paylaşmanı
  istiyor" → Reddet / Onayla.
- **Onay sayfası** (her ekranın üstünde): süre çipleri, "Saat seç", izin notu. Görünmezken düğme
  **Görünür ol ve paylaş** olur (önceki paylaşımlar geri gelmez, yalnızca bu istek paylaşılır).

## Güvenlik ve izin matrisi (Faz 8 ile uyum)

| Durum | Sonuç |
|---|---|
| Arkadaş değil / engelli | `not_friends`; engellemede bekleyen istek `cancelled` |
| Onay (KVKK) yok | gönderme ve onay reddedilir; **ret ve geri çekme onaydan muaf** |
| Hedef görünmez | onay `invisible_mode`; ret çalışır; isteyen yalnızca "şu an paylaşamıyor" görür |
| Onay | yalnızca hedef → isteyen `location_view` yazılır (`via: location_request`); ters yön asla |
| İzin sonradan geri alınırsa | paylaşım Faz 8 zinciriyle biter |
| Kurallar | `location_requests` okuma: isteyen veya hedef; yazma: kimse (yalnızca sunucu) |

## Web demo

Demo sunucusu aynı kuralları uygular. Sen bir arkadaşından istersen Zeynep reddeder, diğerleri 6 sn sonra 1 saat
paylaşır. Demo panelinde **Mehmet konumunu istiyor**: Onayla / Reddet düğmeli bildirim + harita kartı.

## Varsayımlar

- 15 dk geçerlilik, 10 dk çift başına bekleme, günde 30 istek. [Varsayım]
- Bildirimdeki iki eylem de uygulamayı açar (Reddet arka planda sessiz çalışmaz: Firebase oturumu ve onay
  kapısı uygulama içinde doğrulanır). [Varsayım]
- Onay kapısı açıkken bildirimden gelen yanıt, onay verilip oturum başlayınca işlenir. [Varsayım]
