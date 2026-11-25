# Faz 8: Görünmez Ol, Karşılıklı İzin (permission_grants) ve Güvenlik / KVKK Onayı

Faz 8, Faz 1–6 sözleşmelerini **daraltır**: "kabul edilmiş arkadaş ve engel yok" (`graph.ts canShare`) artık hiçbir
etkileşim için yeterli değildir. Her etkileşim, verinin sahibinin ya da etkileşimin alıcısının verdiği **yönlü izin
kaydına** dayanır. Çelişki olursa `packages/core/src/{access,invisible,consent}.ts` geçerlidir. **[Varsayım]** ile
işaretlenenler ürün ya da hukuk kararıyla doğrulanmalıdır.

> Bu dosyanın §1–§6'sı uygulamadan ÖNCE yazılan tasarım sözleşmesidir; ajanlar buna göre kodlar. §7 ve sonrası
> uygulama bittikten sonra doldurulur (durum, testler, ekran görüntüleri).

## 1. İlkeler

1. **Arkadaşlık izin değildir.** `friend_request_send/respond` (ve karşılıklı isteğin otomatik kabulü) hiçbir izin ve
   hiçbir paylaşım yazmaz. Arkadaşlığın tek varsayılan hakkı karşı taraftan **izin istemek**tir (hız sınırlı).
2. **İzin yönlüdür.** `permission_grants/{granter}_{grantee}` belgesi, `granter`ın `grantee`ye verdiği yetkileri tutar.
   A'nın B'ye verdiği izin, B'nin A'ya izin verdiği anlamına gelmez; tek taraflı onaydan ters yönde yetki doğmaz.
3. **Kapsamlar (`AccessScope`)** — "granter, grantee'nin şunu yapmasına izin verir":

   | Kapsam | Anlamı | Kim verir |
   | --- | --- | --- |
   | `location_view` | grantee, granter'ın **konumunu görebilir**: granter→grantee canlı paylaşım, bölge `start_share`, widget hızlı paylaşım, ping'e eklenen konum, buluşmadaki varış süresi (ETA), yer notu `visible_to` | konumun sahibi |
   | `ping` | grantee, granter'a "Buradayım / Yoldayım" gönderebilir | alıcı |
   | `zone_notify` | grantee, granter'a varış/ayrılış bildirimi gönderebilir | alıcı |
   | `meetup_invite` | grantee, granter'ı buluşmaya/etkinliğe davet edebilir | alıcı |
   | `sos_alert` | grantee, granter'ın SOS'unu (tam konumla) alır | konumun sahibi; yalnızca `emergency_contacts_set` yazar |

   `ACCESS_SCOPES = ['location_view','ping','zone_notify','meetup_invite','sos_alert']`.
   `REQUESTABLE_SCOPES` = ilk dördü (`sos_alert` istenemez, yalnızca sahibin acil kişi seçimiyle doğar).
4. **Görünmez mod sunucuda zorlanır.** İstemci işbirliği etmese de: paylaşımlar sona erer, ACL mezar taşına döner,
   RTDB yazıları kurallarca reddedilir; görünmezken yeni paylaşım, uzatma, hızlı paylaşım, bölge olayı açılamaz.
5. **Görünür olunca hiçbir şey kendiliğinden açılmaz.** Önceki paylaşımlar listelenir, kullanıcı tek tek seçer
   (varsayılan: hiçbiri seçili değil).
6. **Onay (KVKK) olmadan hizmet yok, ama koruyucu işlemler her zaman çalışır.** Güncel sürüm onaylanmadan veri işleyen
   callable'lar `consent_required` döner. Durdurma / geri alma / engelleme / silme işlemleri (`share_stop`,
   `share_revoke`, `link_share_stop`, `permission_set` ile **geri alma**, `invisible_set(true)`, `friendship_remove`,
   `user_block`, `account_delete`, `widget_token_revoke`, `consent_withdraw`) onay olmadan da çalışır.
7. **Bilgi sızmaz.** Arkadaşa "görünmez oldu" ya da "iznini geri aldı" denmez; paylaşım `stopped_by_sender` ile biter.
   İzni olmayan alıcı `share_start`te hata vermez, `needs_grant_receiver_ids` içinde döner (yalnızca çağırana).

## 2. Veri modeli

### 2.1 `permission_grants/{granter_id}_{grantee_id}` (Firestore)

```ts
interface PermissionGrantDoc {
  granter_id: UserId;
  grantee_id: UserId;
  /** Verilmiş kapsamlar. Anahtar yoksa izin yok. */
  scopes: Partial<Record<AccessScope, { granted_at: EpochMs; via: GrantVia }>>;
  /** grantee'nin bekleyen isteği (granter onaylayacak). Süresi geçmişse yok sayılır. */
  pending: { scopes: AccessScope[]; requested_at: EpochMs; expires_at: EpochMs } | null;
  /** Son ret zamanı (kapsam başına), tekrar isteme soğuması için. */
  declined_at: Partial<Record<AccessScope, EpochMs>>;
  updated_at: EpochMs;
  version: number;
}
type GrantVia = 'request' | 'manual' | 'share' | 'location_request' | 'emergency_contact' | 'migration';
```

- Kurallar: `read` yalnızca `granter_id` ya da `grantee_id`; `write: false` (yalnızca callable).
- Sorgular: `where granter_id == me` (bana gelen istekler + benim verdiklerim) ve `where grantee_id == me` (bana
  verilenler). Tek alan eşitliği; bileşik dizin gerekmez. Arkadaş sayısıyla sınırlı.
- Bekleyen istek süresi `PERMISSION_REQUEST_TTL_MS = 48 saat` **[Varsayım]**. Soğuma: aynı çift için yeni istek
  10 dakikada bir, ret sonrası aynı kapsam için 24 saat; günlük en çok 30 istek (`rate_limits`).
- Arkadaşlık bitince / engellenince her iki yöndeki izin belgesi silinir (`writePairCascade`), hesap silinince de.

### 2.2 Kullanıcı belgesi (`users/{uid}`, yalnızca sahibi okur, yalnızca callable yazar)

```ts
invisible: { on: boolean; since: EpochMs | null; snapshot: InvisibleSnapshotEntry[]; links_ended: number } | null;
consent: { version: string; accepted_at: EpochMs } | null;
interface InvisibleSnapshotEntry { receiver_id: UserId; share_mode: ShareMode; expires_at: EpochMs | null; started_at: EpochMs }
```

### 2.3 `users/{uid}/consents/{version}` (onay kaydı, yalnızca sahibi okur)

```ts
interface ConsentRecord {
  user_id: UserId; version: string; text_sha256: string; scrolled_to_bottom: true;
  accepted_at: EpochMs; platform: 'ios' | 'android' | 'web'; app_version: string;
  withdrawn_at: EpochMs | null;
}
```

Sürüm `CONSENT_VERSION` (core sabiti, ör. `'2026-11-25'`); metin `CONSENT_DOCUMENT` (core, Türkçe);
`CONSENT_TEXT_SHA256` metnin SHA-256'sı (core'da hesaplanır, testle sabitlenir). Sunucu, istemcinin gönderdiği sürüm
ve özetin güncel olanla aynı olmasını şart koşar: gösterilen metin = onaylanan metin.

## 3. Callable'lar (yeni ve değişen)

| Callable | İstek | Davranış |
| --- | --- | --- |
| `permission_request_send` | `{op_id, target_id, scopes: RequestableScope[1..4]}` | Arkadaş + engel yok + onay şart. Zaten verilmiş kapsamlar düşer; hiç kalmazsa `{status:'already_granted'}`. Bekleyen isteğe birleşir. Push `{type:'permission_request'}` (konum yok). Yanıt her zaman `{status:'sent'｜'already_granted'}`. |
| `permission_request_respond` | `{op_id, requester_id, grant_scopes: RequestableScope[], share: {duration, time_zone} ｜ null}` | Çağıran = granter. `grant_scopes ∩ pending.scopes` verilir, gerisi reddedilir (`declined_at`). Boş dizi = ret. `share` varsa ve `location_view` verildiyse ve görünmez değilse aynı işlemde granter→requester paylaşımı başlar (`writeShareStarts`). İzin verilirse push `{type:'permission_granted'}`; retde push yok. |
| `permission_set` | `{op_id, grantee_id, scope: RequestableScope, granted: boolean}` | Granter'ın doğrudan aç/kapat anahtarı. Açmak arkadaşlık + onay ister; kapatmak her zaman çalışır ve zincirleme temizler (§4). |
| `invisible_set` | `{op_id, invisible: boolean, restore_receiver_ids?: UserId[]}` | Açınca: etkin giden paylaşımların anlık görüntüsü alınır, hepsi `stopped_by_sender` ile biter, etkin QR bağlantıları biter (geri yüklenmez), `users.invisible` yazılır. Kapatınca: yalnızca `restore_receiver_ids` içindeki ve anlık görüntüde olan, süresi dolmamış, hâlâ arkadaş + `location_view` izni olan alıcılarla **eski bitiş saatine kadar** (`custom_until`, süresizse `indefinite`) yeniden başlar. Yanıt `{invisible, restored_receiver_ids, skipped_receiver_ids}`. |
| `consent_accept` | `{op_id, version, text_sha256, scrolled_to_bottom: true, platform, app_version}` | Sürüm/özet uyuşmazsa `consent_required` (`extra.current_version`). `users/{uid}/consents/{version}` + `users.consent` yazılır. |
| `consent_withdraw` | `{op_id}` | Tüm giden paylaşımlar ve bağlantılar biter, `consents/{version}.withdrawn_at` ve `users.consent = null`. Uygulama yeniden onay ekranına düşer. |
| `share_start` (değişti) | `+ grant_location_view: boolean = false` | Alıcıda `location_view` yoksa: bayrak açıksa izin aynı işlemde yazılır (`via:'share'`), değilse alıcı atlanır ve `needs_grant_receiver_ids`te döner. Görünmezken `invisible_mode`. |
| `location_request_respond` (değişti) | aynı | Kabul: target→requester `location_view` izni (`via:'location_request'`) + paylaşım; ters yön yazılmaz. |
| `emergency_contacts_set` (değişti) | aynı | Seçilen her kişiye `sos_alert` izni yazar (`via:'emergency_contact'`), listeden çıkanlardan siler. |

Hata kodları (core `ERROR_CODES`): `not_permitted` (failed-precondition, "Bu kişi sana bu izni vermedi."),
`invisible_mode` (failed-precondition, "Görünmez moddasın. Paylaşmak için önce görünür ol."), `consent_required`
(failed-precondition, "Devam etmek için güncel Güvenlik Sözleşmesi ve KVKK metnini onaylaman gerekiyor."),
`permission_cooldown` (resource-exhausted, "Bu kişiden kısa süre önce izin istedin. Biraz sonra tekrar dene.").

Push türleri: `permission_request`, `permission_granted` (`PUSH_TYPES_F8`). Koordinat taşımaz.

## 4. Etkileşim matrisi (X → Y)

`friend(X,Y)` = kabul edilmiş arkadaşlık ve iki yönde de engel yok. `g(A→B, s)` = A'nın B'ye verdiği `s` kapsamı.
`inv(X)` = X görünmez.

| Etkileşim | Koşul (sunucuda) | İstemci |
| --- | --- | --- |
| Canlı paylaşım X→Y (`share_start`, `share_extend`, widget, bölge `start_share`, `location_request_respond`, görünür olunca geri yükleme) | `friend ∧ g(X→Y, location_view) ∧ ¬inv(X) ∧ onay(X)` | Seçicide izin yoksa "izin yok" etiketi; başlatırken bir kez "Konumunu görme izni de verilecek" onayı |
| Ping X→Y | `friend ∧ g(Y→X, ping) ∧ onay(X)`; konum yalnızca `g(X→Y, location_view) ∧ ¬inv(X)` ise eklenir, yoksa sessizce çıkarılır | İzin yoksa düğme yerine "İzin iste" |
| Bölge bildirimi (X'in olayı Y'ye) | `friend ∧ g(Y→X, zone_notify)`; `inv(X)` ise olay `suppressed:'invisible'` | Kural alıcılarında izin yoksa seçilemez, ipucu |
| Buluşma daveti X→Y | `friend ∧ g(Y→X, meetup_invite)`; X'in ETA'sı yalnızca `g(X→Y, location_view) ∧ ¬inv(X)` | Seçicide izin yoksa seçilemez |
| Yer notu `visible_to` Y (sahibi X) | `g(X→Y, location_view)` | |
| SOS X→Y | `friend ∧ g(X→Y, sos_alert)`; görünmezken SOS **gider** ve görünmez mod geri yükleme yapmadan kapanır | |
| Pil uyarısı | yalnızca etkin paylaşımın alıcıları (değişmedi) | |
| İzin isteği X→Y | `friend ∧ onay(X)`, soğuma ve günlük sınır | |

Geri alma zincirleri (`permission_set(granted:false)` ve izin silinmesi):
- `location_view` X→Y kalkınca: X→Y paylaşımları `stopped_by_sender` ile biter; Y, X'in yer notlarının `visible_to`
  listesinden, X'in bölge `start_share` kurallarından ve X'in favorilerinden (`favorite_ids`) çıkar.
- `zone_notify` Y→X kalkınca: Y, X'in `notify` kurallarının alıcılarından çıkar.
- `ping`, `meetup_invite` kalkınca: yalnızca yeni etkileşim engellenir; geçmiş kayıtlar kalır.
- `sos_alert` yalnızca `emergency_contacts_set` ile değişir.

## 5. Mobil arayüz

1. **Onay kapısı** (`app/(main)/_layout.tsx`): `profile.consent?.version !== CONSENT_VERSION` ise `ConsentGate`
   (cinsiyet kapısından sonra). `startSessionServices` **onaydan sonra** başlar. Ekran: başlık "Güvenlik Sözleşmesi ve
   KVKK Aydınlatma / Açık Rıza Metni", sürüm ve tarih, kaydırılabilir metin, altta sabit "Okudum, Onaylıyorum" düğmesi.
   Düğme `scrolled_to_bottom` olana kadar pasif ve altında "Onaylamak için metni sonuna kadar kaydır" yazar. Kaydırma
   kararı saf modelde: `isScrolledToBottom({offsetY, viewportH, contentH}, tol=24)`; metin ekrana sığıyorsa doğrudan
   true. Güncellenmiş sürümde başlıkta "Metin güncellendi" ve değişiklik özeti.
2. **Profil** (sol üstteki avatar → "Profili düzenle"): en üstte "Görünmez ol" kartı ve anahtarı. Açarken onay:
   "n paylaşımın duracak, QR bağlantıların kapanacak, arka planda konum gönderilmeyecek. Arkadaşlarına görünmez olduğun
   söylenmez." Kapatırken geri yükleme sayfası: önceki paylaşımlar (kişi, bitiş saati, kalan süre), hiçbiri seçili
   değil, "Seçilenleri yeniden başlat (n)" ve "Kimseyle paylaşma". Profilde ayrıca "Sözleşme ve KVKK" kartı (sürüm, onay
   tarihi, metni görüntüle, "Açık rızamı geri çek").
3. **Harita**: görünmezken üst çubuğun altında "Görünmezsin · kimse konumunu görmüyor" şeridi ve "Görünür ol" düğmesi;
   sol üst avatarda göz-kapalı rozeti; paylaş düğmesi "Görünmez moddasın" uyarısı açar.
4. **Arkadaşlar**: en üstte "İzin istekleri" kartı ("Can senden konumunu görmek istiyor" → "İzin ver…" / "Reddet").
   "İzin ver…" sayfası: istenen kapsamlar (işaretli, tek tek kaldırılabilir), `location_view` varsa "Şimdi paylaş"
   süresi (1 saat varsayılan, "Yalnızca izin ver, şimdi paylaşma" seçeneği) ve "Sen de onun konumunu görmek istersen
   ayrıca izin iste" ipucu. Her arkadaş satırında yön durumu ("Karşılıklı kapalı", "O seni görebilir", "Sen onu
   görebilirsin", "Karşılıklı"). Satıra dokununca **Kişi izinleri** sayfası: "Senin verdiğin izinler" (anahtarlar) ve
   "Onun sana verdiği izinler" (salt okunur + "İzin iste"). Arkadaş kabulünden sonra: "Arkadaş olmanız konumunuzu
   açmaz."
5. **Seçiciler**: paylaşım (`RecipientPicker`), bölge, buluşma, favoriler, ping, acil kişiler izin durumunu gösterir.

## 6. Tarayıcı demosu

- Tohum: Ayşe, Mehmet, Zeynep **daha önce** bana `location_view` vermiş (`via:'migration'`) ve paylaşıyor; Can izin
  vermemiş. Benim hiçbir arkadaşa iznim yok. Kayıtlı eski demo durumu `withPhase8` ile göç eder (etkin bot
  paylaşımları için izin yazılır; onay boş, kapı görünür).
- Botlar: isteğime 6 sn sonra yanıt verir (Can izin verir ve 1 saat paylaşır; diğerleri izin verir). Paylaşım başlatma
  izin ister.
- "FAZ 8 SENARYOLARI": "Can konumunu görmek istiyor", "Ayşe iznini geri alsın", "Mehmet sana ping izni versin",
  "Sözleşme güncellendi (yeniden onay)", "Arkadaşlarım beni görüyor mu?" (görünmezken 0).

## 7. Durum

**Kod hazır.** Birim, kural ve emülatör testleri geçiyor; tarayıcı demosunda onay kapısı → harita → izin isteği ve
"İzin ver…" (1 saat paylaşım) → Kişi izinleri → paylaşırken "izin de verilecek" onayı → görünmez ol → görünür olurken
tek kişiyi geri yükleme → sözleşme güncellenince koyu temada yeniden onay uçtan uca çalışıyor (§9). **iOS ve Android
gerçek cihazda / simülatörde çalıştırılmadı.** KVKK metni hukuk incelemesinden geçmedi (§10).

| İstenen | Nerede |
| --- | --- |
| Kapsamlar, izin belgesi, saf belge geçişleri, §4 matrisi, geri alma zincirleri, metinler, callable şemaları | `packages/core/src/access.ts` (`ACCESS_SCOPES`, `REQUESTABLE_SCOPES`, `PermissionGrantDoc`, `withGranted` / `withRevoked` / `withPendingRequest` / `withResponse`, `planPermissionRequest`, `canShareLocation` … `canRequestPermission`, `REVOKE_EFFECTS`, `pairAccessSummary`, `ACCESS_TEXT`) |
| Görünmez mod: anlık görüntü, geri yükleme planı, metinler | `packages/core/src/invisible.ts` (`planInvisibleOn`, `planInvisibleRestore`, `restoreDuration`, `INVISIBLE_TEXT`) |
| Onay metni, sürüm, SHA-256, kaydırma kararı, muaf callable'lar | `packages/core/src/consent.ts` (`CONSENT_VERSION = '2026-11-25'`, `CONSENT_DOCUMENT`, `CONSENT_TEXT_SHA256` testle sabit, `isScrolledToBottom`, `consentExemptCall`) |
| Sözleşme eklemeleri | `contracts.ts` (6 callable, `PATHS.permissionGrant` / `consent`, 4 hata kodu, `grant_location_view`, `needs_grant_receiver_ids`, `PUSH_TYPES_F8`), `ids.ts` (`grantId`), `model.ts` (`UserProfile.invisible` / `.consent`), `zones.ts` (`suppressed:'invisible'`) |
| 6 yeni callable | `backend/functions/src/handlers/access.ts` (`permission_request_send/respond`, `permission_set` + aynı transaction'da zincir, `invisible_set`, `consent_accept/withdraw`) |
| Matrisin sunucuda uygulanması | `graph.ts` (`PairState.grantOut/grantIn`, `pairInput`, `readCaller` onay denetimi; `canShare` kaldırıldı), `callable.ts` (`consentGate`), `handlers/{shares,requests,friends,ping,notes,favorites,zones,meetup,sos,widget,watchdog,battery,links,user}.ts`, `push.ts` (`buildPermissionRequestPush` / `buildPermissionGrantedPush`, koordinatsız) |
| Kurallar ve dizinler | `backend/firestore.rules` (`permission_grants` iki tarafa okunur, `permission_declines` kapalı, `users/{uid}/consents` sahibine), `firestore.indexes.json` (TTL `permission_declines.purge_at`) |
| Mobil veri katmanı | `src/services/firebase/grantsRepo(.web).ts`, `callables.ts`, `lib/schemas.ts`, `state/{grantsStore,invisibleStore,consentStore,publishHold}.ts`, `services/f8Services.ts`, `services/notifications/f8Push.ts`, `location/{pipeline,resume,backgroundTask,zoneMonitorWiring}.ts` (görünmezken / onay kapısındayken yayın tutulur) |
| Onay kapısı ve okuma ekranı | `app/(main)/_layout.tsx` (cinsiyet kapısından sonra `ConsentGate`, oturum servisleri onaydan sonra), `app/(main)/consent.tsx`, `src/features/consent/*` |
| Görünmez ol | `src/features/invisible/*` (profil kartı, onay, geri yükleme sayfası), `src/features/map/InvisibleBanner.tsx`, `TopBar.tsx` (göz-kapalı rozeti) |
| İzin istekleri, İzin ver…, Kişi izinleri, seçiciler | `src/features/access/*`, `app/(main)/friend/[id].tsx`, `FriendsScreen`, `ShareSheet` / `RecipientPicker`, `ZoneRuleSheet`, `MeetupSheet`, `NoteSheet`, `PingButtons`, `QuickShareButton`, `EmergencyContactsSheet` |
| Tarayıcı demosu ("FAZ 8 SENARYOLARI") | `src/demo/server/server.ts` (aynı core geçişleri ve matrisi, `withPhase8` göçü, bot yanıtları), `server/index.ts` (`canRequestsMyLocation`, `ayseRevokes`, `mehmetGrantsPing`, `bumpConsent`, `resetConsent`, `snapshot().f8`), `shell/Faz8.web.tsx` |

## 8. Uygulama kararları (sözleşmeden ayrılan ya da onu netleştiren)

Hepsi daha gizli / daha güvenli seçenektir.

1. **Ret isteyene sızmaz.** İstemcinin okuduğu belgede `declined_at` her zaman boştur. Ret anları sunucuya özel
   `permission_declines/{granter}_{grantee}` belgesindedir; belgeyi yalnızca granter okur (kural:
   `granter_id == auth.uid`), kimse yazamaz, TTL `purge_at` = ret soğuması ile istek ömrünün büyüğü + 1 gün. Ret anı
   isteyenin gördüğü `pending`i DEĞİŞTİRMEZ: reddedilen kapsam, isteğin kendi `expires_at`ine kadar "bekliyor" görünür.
   Salt ret izin belgesine hiç dokunmaz (sürüm ve `updated_at` dahil); kısmi onayda verilen kapsam `pending`den düşer,
   reddedilen aynı istek anı ve bitişle kalır. Granter'ın kartı `liveRequestScopes` ile süzer
   (`declined_at[s] >= pending.requested_at` olan kapsam gizli). Mobil `grantsRepo` ret belgelerini kendi verdiğim
   belgelere birleştirir. Demo aynı ayrımı yapar.
2. **Yeniden istek ret oracle'ı vermez.** Zaten bekleyen kapsam için `noop`, yeni kapsam için yazma; ret soğumasındaki
   kapsam da istemci belgesine yazılır (isteyen "bekliyor" görür) ama ret anı yeni istek anına taşınır, granter'a gizli
   kalır ve push gitmez (`plan.hidden`, push yalnızca `plan.added` varsa `plan.live` ile). Çift soğuması (10 dk) ve
   günlük sınır reddedilmiş ve reddedilmemiş istekte aynıdır. `permission_cooldown` yalnızca aynı çifte 10 dk içinde
   yeni kapsam eklenirken döner.
3. `pending.scopes` tipi `RequestableScope[]` (`sos_alert` istenemez).
4. **Onay kapısı muafları** §1.6 listesine ek olarak `user_bootstrap` (cinsiyet kapısı onaydan önce gelir),
   `consent_accept` ve koruyucu / silme çağrıları `sos_resolve`, `place_note_delete`, `zone_delete`, `meetup_cancel`,
   `friend_request_cancel`. `invisible_set` yalnızca `invisible: true`, `permission_set` yalnızca `granted: false` iken
   muaftır. Görünür olmak (geri yükleme paylaşım açtığı için) onay ister.
5. **Geri yükleme**: 5 dakikadan az süresi kalan kayıt geri yüklenmez (`custom_until` en az 5 dk ister).
6. **Favoriler** tek dokunuşla paylaşım hedefi olduğu için yalnızca benim `location_view` verdiğim arkadaşlar kalır;
   izin geri alınınca kişi favorilerden çıkar. **Widget** denetim sırası: onay → görünmez değil → favori → arkadaş →
   `location_view`; hızlı paylaşım izin yazmaz.
7. **Bölge kuralı kaydı** (`zone_upsert`) görünmezliği denetlemez (kural ileride çalışır); olay anında
   `suppressed:'invisible'`. Olay görünmezken olduysa (ör. çevrimdışı ikinci cihaz görünür olunca bildiriyor) da
   bastırılır: `invisible_set(false)` ve SOS'un görünmezliği kapatması `users.visible_since` yazar, `occurred_at <
   visible_since` olan olay `suppressed:'invisible'`.
8. **Buluşma ETA'sı**: `meetup_share` yalnızca kurucunun KENDİ ETA'sını tutar (tüm alıcılara `location_view` iznim
   varsa ve görünür isem); başka katılımcıların ETA'sı koşulsuz düşer. Aksi hâlde düşen ETA, kurucuya o katılımcının
   görünmez olduğunu ya da izin vermediğini söylerdi. **Ping ETA'sı**: konum çıkarılan "Yoldayım" pingte `eta_s` de
   silinir (kayıt ve push metni); istemci de görünmezken / izin yokken ETA eklemez.
9. **Cihazda yayın tutma**: onay kapısı açıkken ve görünmezken cihaz hiç konum yayınlamaz (`publishHold`,
   `konum.bg.invisible.v1`), bölge olay raporları cihazda düşer. Yerel görünmez bayrağı yalnızca sunucunun "görünür"
   yanıtıyla (ya da `sos_send` yanıtıyla) kalkar; `invisible_set(false)` hatası bayrağı kaldırmaz. Sunucuya ulaştığı
   doğrulanmamış görünmez niyeti görünür olurken önce aynı op_id ile `invisible_set(true)` olarak gönderilir; çıkışta
   hesaba göre `konum.f8.pendingInvisible.v1`de saklanır ve aynı hesapla girişte geri gelir. Kayıt onaylı sözleşme
   sürümünü de tutar (`consent_version`): başsız bağlam (push ile takip yeniden başlatma, bölge / uyku çiti, widget)
   kayıttaki sürüm uygulamanınkinden eskiyse ya da kayıt hiç yokken diskteki hedef listesi Faz 8 öncesi bir sürümün
   yazdığı boş olmayan listeyse (`consent_aware` yok) yayın yapmaz (kapalı başarısızlık). `location_view` geri alınınca
   o kişiye yayın, sunucu paylaşımı bitirmeden önce cihazda kesilir; geri alma ağ hatasıyla biterse kesim kalır ve
   bağlantı gelince aynı op_id ile yeniden gönderilir, yalnızca kesin sunucu reddinde geri alınır.
10. **Arayüz**: izni olmayan favori / hızlı paylaşım soluk "izin yok" düğmesi olarak görünür ve Kişi izinleri'ne
    götürür; bölge kuralı kaydında izinsiz kişiler çıkarılıp kullanıcıya söylenir; geri yükleme başarısızsa neden
    yalnızca benim tarafımdan söylenir (arkadaş değil / izni kapattım / süresi doldu), karşı taraf hakkında bilgi
    verilmez. "Tümünü iste" yalnızca 2+ eksik izinde görünür. Paylaşım sayfası konum iznini yalnızca onay penceresinde
    adı geçen kişilere verir (onlar `grant_location_view: true`, diğerleri `false` ile ayrı başlatılır; sunucu izin
    isterse yalnızca o kişiler için yeniden sorulur).
11. **Onay kapısı çıkmaz sokak değil**: kapıda "Çıkış yap" ve "Paylaşımlarımı durdur ve görünmez ol" (`invisible_set`,
    muaf; tüm paylaşımları ve QR bağlantılarını bitirir) vardır. Kapı açıkken oturum servisleri başlamaz, yalnızca
    `startGateServices` çalışır: bekleyen paylaşım / bağlantı durdurmaları, görünmez olma isteği ve konum izni geri
    almaları açılışta, bağlantı gelince ve ön plana dönünce aynı op_id ile yeniden gönderilir. Takip izleyicisi
    (`share_stall_watchdog`) görünmez ve onayı olmayan göndericiye `resume_tracking` göndermez. Profil başka cihazda
    onaylanmış DAHA YENİ bir sürüm gösteriyorsa eski uygulama kapıyı göstermez (`clientConsentRequired`), Profil'de
    "uygulamayı güncelle" der; sunucu `consent_required` ile daha yeni `current_version` döndürürse kapıda da aynısı.
12. **Onayı geri çekme** aynı işlemde: giden paylaşımlar ve QR bağlantıları biter, süren SOS `resolve_reason:'safe'`
    ile kapanır (alıcılara `sos_resolved` push'u), yer notlarım silinir, önerdiğim etkin buluşmalar iptal edilir.
    **Onay kaydı ekleme amaçlıdır**: geri çekilip yeniden onaylanan sürümde önceki kayıt (özet, onay ve geri çekme anı,
    platform, uygulama sürümü) `history` dizisine eklenir (en çok 50), üzerine yazılmaz.
13. **SOS ve izinler**: `sos_send` / `sos_update` alıcıları her seferinde `emergency_contacts` ∩ arkadaş ∩ engelsiz ∩
    `sos_alert` ile yeniden hesaplar; süren SOS'un `recipient_ids`i bu kümeyle kesişir (yeni kişi sessizce eklenmez).
    `emergency_contacts_set`, arkadaşlıktan çıkarma, engelleme ve hareketsizlik sıfırlaması süren SOS'tan ilgili kişiyi
    hemen çıkarır. **Göç (tembel)**: listede olup `sos_alert`i olmayan arkadaş için ilk `sos_send` / `sos_update`
    aynı işlemde `via:'migration'` izni yazar (liste ile izin aynı kaynaktan, yalnızca sahibi tarafından yazıldığı için
    sahibin önceki seçimiyle aynıdır). Hareketsizlik sıfırlaması bu yüzden acil kişi listesini de boşaltır.
    **Görünmezken SOS**: `sos_send` görünmezliği kapatır; SOS sürerken görünmez olunursa SOS sürer (SOS görünmezliği
    geçersiz kılar, §4) ve şerit, kart ve onay metni bunu söyler. SOS'la başlayan 1 saatlik canlı paylaşım konum izni
    vermez: izni olmayan acil kişilerle başlamaz ve SOS ekranında söylenir.
14. **QR uzatma** görünmezken `invisible_mode` döner (backend ve demo aynı). Demo RTDB'deki ek görünmezlik denetimi
    savunma amaçlıdır; normal akışta gözlenebilir farkı yoktur (demo ACL'i eşzamanlı yansıtır).
15. **Demo göçü**: kayıtlı eski durum için `withPhase8` yalnızca etkin BOT paylaşımlarına (bot → ben) izin yazar;
    benim adıma izin yazmaz.
16. **Tek paylaşımda liste**: kitapçıkta tek kart varken de "1/1 ⌃" ve yukarı sürükleme listeyi (ve "+ Yeni paylaşım"ı)
    açar (`SHARE_DECK.md`).

## 9. Testler

| Paket | Komut | Sonuç |
| --- | --- | --- |
| core | `cd packages/core && npx vitest run && npx tsc --noEmit` | 236/236 (18 dosya); Faz 8: `test/faz8.test.ts` (15: varsayılan kapalı, yön, istek planı / soğuma, yanıt, ret isteyene sızmaz, matris, zincir, görünmez anlık görüntü ve geri yükleme, onay özeti sabit `2f36ecc7…de3839`, istemci onay kararı (daha yeni sürüm), kaydırma kararı, muaf çağrılar) |
| backend | `cd backend && npm run typecheck && npm run build && env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npm test` | 239/239 (22 dosya, emülatörler); Faz 8: `test/functions/faz8.test.ts` (12: kabul izin yazmaz + `needs_grant_receiver_ids`, istek yönü ve ret sızmaması, salt ret izin belgesine dokunmaz, konum isteği kabulü tek yön, geri almada paylaşım + ACL mezar taşı + RTDB reddi, ping izni ve konum / ETA çıkarma, görünmez mod, seçmeli geri yükleme ve QR uzatma reddi, SOS tembel göç, süren SOS alıcı budaması, onay kapısı ve koruyucu çağrılar, onayı geri çekme (SOS / not / buluşma) ve onay geçmişi), `test/rules/firestore.rules.test.ts` (+3; ret belgesini yalnızca granter okur), `test/unit/contract.test.ts` (callable / push sözleşmesi) |
| mobil | `cd apps/mobile && npx tsc --noEmit && npx jest` | 258/258 (30 suite); Faz 8: `faz8Stores` (20: + ağ hatasında geri alma kesimi, sunucuya ulaşmamış görünmez niyeti, çıkışta niyet saklama, başsız kapalı başarısızlık ×2, "uygulamayı güncelle"), `faz8Ui` (13), `demoFaz8` (9), `faz4Stores` (+1: SOS sonrası niyet otomatik paylaşımdan önce silinir) |
| web | `cd apps/web && npm run typecheck && npm test` | 53/53 (4 dosya) |
| web demo | `cd apps/mobile && EXPO_OFFLINE=1 CI=1 npm run web:export` + Playwright | `dist-web/index.html` tek dosya (4,2 MB), 60/60 denetim, konsol hatası yok |

Ekran görüntüleri (390×844, 2x; tarayıcı demosu, giriş 532 123 45 67 / 123456 / "Deniz Kaya", Erkek):

| Görüntü | Akış |
| --- | --- |
| `01-sozlesme-ust.png` | Onay kapısı: başlık, sürüm ve tarih; "Okudum, Onaylıyorum" pasif (`aria-disabled`), erken basış bir şey yapmaz; "Onaylamak için metni sonuna kadar kaydır"; altta onay vermeden "Paylaşımlarımı durdur ve görünmez ol" |
| `02-sozlesme-alt.png` | Metnin sonu: düğme etkin; basınca harita açılır, sunucuda güncel onay |
| `03-harita.png` | Ayşe / Mehmet / Zeynep (bana izin vermiş) haritada, Can yok; benim verdiğim izin yok, kimse beni görmüyor |
| `04-izin-istegi.png` | "Can konumunu görmek istiyor" → Arkadaşlar'da "İzin istekleri" kartı; "İzin ver…" 1 saat → Can konumumu alıyor (`f8.seesMe`), ters yön yazılmadı |
| `05-kisi-izinleri.png` | Can'ın Kişi izinleri: "Senin verdiğin izinler" (konum açık, diğerleri kapalı) + "Onun sana verdiği izinler" (salt okunur, "İzin iste") |
| `06-gorunmez-onay.png` | Profili düzenle → "Görünmez ol": "2 paylaşımın duracak, … görünmez olduğun söylenmez." |
| `07-gorunmez-harita.png` | "Görünmezsin · kimse konumunu görmüyor" şeridi, avatarda göz-kapalı rozeti; `f8.myDeliveriesCount === 0` |
| `08-gorunur-ol.png` | Geri yükleme sayfası: iki önceki paylaşım, hiçbiri seçili değil; yalnızca Can seçilince yalnızca Can eski bitişle (≈ 60 dk) döner |
| `09-paylasim-izin-onayi.png` | Paylaşım sayfasında izin vermediğim Ayşe "izin yok"; başlatınca "Ayşe Yılmaz'a konumunu görme izni de verilecek" |
| `10-sozlesme-koyu.png` | Koyu tema, "Sözleşme güncellendi" → "Metin güncellendi" rozeti ve "Neler değişti?", düğme yine pasif |

Ek görüntüler: `04b-izin-ver-sayfasi.png`, `07b-gorunmez-paylas-uyarisi.png`, `08b-gorunur-ol-secili.png`,
`11-ayse-izni-geri-aldi.png` (Ayşe izni kaldırınca haritadan düşer, bana neden söylenmez).

### 9.1 Cihazda yapılacak kabul senaryoları

1. **Onay kapısı**: ilk açılışta konum izni istenmeden ve arka plan görevi başlamadan önce kapı gelmeli; küçük ekranda
   ve büyük yazı boyutunda kaydırma kararı doğru çalışmalı (VoiceOver / TalkBack "sonuna kadar kaydır" ipucunu okumalı).
2. **Görünmez ol** uygulama arka plandayken: arka plan görevi yayın yapmamalı (RTDB'de yeni paket yok), bölge olayı
   bildirilmemeli; uygulama kapalıyken açılan bildirimden dönüşte bayrak korunmalı.
3. **Geri alma**: `location_view` kapatılınca alıcının ekranında pin "paylaşım bitti" gibi kalkmalı, push gelmemeli.
4. **İzin isteği push'u** (`permission_request`) dokununca Arkadaşlar > İzin istekleri açılmalı, ilgili satır vurgulanmalı.
5. **Onayı geri çekme**: tüm paylaşımlar ve QR bağlantıları durmalı, süren SOS kapanmalı, yer notları silinmeli,
   uygulama onay ekranına düşmeli. Kapıda "Paylaşımlarımı durdur ve görünmez ol" onay vermeden paylaşımları bitirmeli.
6. **Başsız kapalı başarısızlık**: Faz 8 öncesi sürümden güncellenen ve hiç açılmayan cihazda push ile takip yeniden
   başlatma yayın yapmamalı (onay sürümü bilinmiyor).

## 10. Bilinen açıklar ve [Varsayım] listesi

- **Cihazda çalıştırılmadı.** iOS ve Android gerçek cihazda / simülatörde denenmedi; Faz 8 için native kod yok, ama
  arka plan yayın tutma ve push yönlendirmesi yalnızca birim testleri ve tarayıcı demosuyla doğrulandı.
- **KVKK metni hukuk incelemesi bekliyor [Varsayım].** `CONSENT_DOCUMENT` ~1.560 kelime; yer tutucular `[Şirket unvanı]`,
  `[Adres]`, `[KEP / e-posta]` doldurulmalı. Ayrıca doğrulanmalı: 18 yaş kuralı (veli / vasi izni), yurt dışı aktarım
  dili (m.9, Auth / FCM ABD), saklama süreleri (silme kaydı 30 gün, backend yapılandırmasıyla aynı), açık rıza ile
  aydınlatmanın tek metinde ve tek onayla alınması. Metin değişirse `CONSENT_VERSION` artırılmalı ve core testindeki
  özet güncellenmeli (sunucu eski özetle onayı reddeder).
- **Metin düzeltmesi sürüm artırmadan.** İnceleme sonrası yanlış iddialar düzeltildi (§3 numara açık hâliyle Auth, özel
  profil ve numara dizininde, yalnızca engelleme kaydı özet; §6 arka plan konumu yalnızca paylaşımda, rota / buluşma /
  ping / SOS anlık konum gönderir; §7 arkadaş ve QR görünen alanların tam listesi, Cloud Storage bölgesi; §8 giden
  istek ve düşük pil durumu 30 gün, adres önbelleği, TTL gecikmesi; §10 geri çekmede SOS / not / buluşma; §11 yalnızca
  uygulamada olan eylemler). Faz 8 yayımlanmadığı için `CONSENT_VERSION` `2026-11-25` kaldı, yalnızca özet değişti
  (`2f36ecc7…de3839`); yayımlanmış bir sürümde düzeltme sürüm artırır. Metin artık Cloud Storage'ın Avrupa'da (eur3)
  olduğunu söyler: varsayılan bucket bu bölgede oluşturulmalı (`RELEASE_CHECKLIST.md`).
- **Onay kayıtlarının saklanması [Varsayım]**: hesap silmede `users/{uid}/consents/*` de silinir (geri çekme / yeniden
  onay geçmişi `history` dahil). Onayın ispatı için belli bir süre saklanması gerekiyorsa (ör. silme kaydı gibi 30 gün)
  hukuk kararıyla değiştirilmeli.
- **Konum izni göçü yok.** Faz 8 öncesi arkadaşlıklar için `location_view` / `ping` / bölge / buluşma izinleri
  yazılmadı: süren eski paylaşımlar bitişine kadar devam eder ama uzatılamaz (`not_permitted`); yeniden başlatma "izin
  de verilecek" onayıyla olur. Mevcut kullanıcılar ilk açılışta onay kapısını görür. Yalnızca `sos_alert` tembel göçle
  yazılır (§8.13), böylece eski acil kişi listesiyle SOS `no_emergency_contacts` vermez.
- **Emülatör testi eksikleri**: bölge `suppressed:'invisible'` ve buluşma ETA süzgeci için ayrı emülatör testi yok
  (core matris testleri ve demo testleriyle kapsanıyor).
- **Demo favorileri**: tohum favoriler (Ayşe, Mehmet, Zeynep) izinsiz kalır ve "izin yok" görünür; gerçek backend bu
  listeyi `favorites_set`'te izinlilere indirger.
- **Geri alma kesimi bellektedir**: ağ hatasında kalan `location_view` kesimi ve yeniden deneme (aynı op_id) uygulama
  yeniden başlayınca kaybolur; o zamana kadar sunucu isteği almadıysa kişi Kişi izinleri'nde yine açık görünür.
- **Onay kapısında "Güvendeyim" yok**: kapı açıkken SOS dinleyicisi çalışmaz; süren SOS'u kapatmanın yolu onayı geri
  çekmek (SOS kapanır) ya da onaylamaktır. `sos_resolve` sunucuda onaydan muaftır.
- **Karışık izinli paylaşım iki oturum açar**: onay penceresinde adı geçen ve geçmeyen kişiler birlikte seçilirse
  paylaşım iki ayrı oturumla başlar (kitapçıkta iki kart).
- **Tek etkin paylaşım varken** haritada "Konumumu paylaş" yerine alt kitapçık durur; ikinci kişiye paylaşım kartın
  "1/1 ⌃" düğmesi ya da yukarı sürükleme → "+ Yeni paylaşım" ile açılır (`SHARE_DECK.md`).
- **[Varsayım] süreler**: bekleyen istek 48 sa, çift soğuması 10 dk, ret soğuması 24 sa, günde 30 istek.
- **Dağıtım**: `firestore.rules` + `firestore.indexes.json` (TTL `permission_declines.purge_at`), 6 yeni callable; onay
  kapısı tüm konum callable'larını etkilediği için istemci ve backend birlikte yayımlanmalı (eski istemci
  `consent_required` alır).
