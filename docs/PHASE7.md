# Faz 7: Etkinlik Alanı, Bildirim ve İzin Mimarisi, Harita Teması

Faz 7, Faz 1–6 ve Faz 8 sözleşmelerini **genişletir**; mevcut alanların anlamı değişmez. Çelişki olursa
`packages/core/src/{events,privacy,movement,permissionCenter,appearance}.ts` geçerlidir. **[Varsayım]** ile
işaretlenenler ürün kararıyla doğrulanmalıdır.

| Konu | Bölüm |
| --- | --- |
| Etkinlik veri modeli (Firestore), durum makinesi, hatırlatmalar | §1–§3 |
| Bildirim mimarisi (iOS / Android kanallar, SOS alarmı, heads-up) | §4 |
| İzin mimarisi, ilk açılış akışı, İzin & Gizlilik Merkezi | §5 |
| Harita stili (Açık / Koyu / Sistem) ve anında geçiş | §6 |
| Pil paylaşımı onayı, "yola çıktı" bildirimi | §7 |
| Web önizleme, testler, cihazda doğrulanacaklar | §8–§9 |

## 1. Etkinlik veri modeli

### 1.1 `events/{event_id}` (Firestore)

İstemci core `EventDoc` biçimini okur; sunucu ayrıca `open`, `next_action_at`, `purge_at` yazar.

```ts
interface EventDoc {
  event_id: string;
  owner_id: UserId;               // düzenleyen (her zaman katılır; sonuçları görür ve onaylar)
  title: string;                  // ≤ 60
  description: string | null;     // ≤ 300
  date: string;                   // 'YYYY-MM-DD', sahibin saat diliminde; bugün … +180 gün
  time_zone: string;              // IANA, ör. 'Europe/Istanbul'
  invitee_ids: UserId[];          // sahip hariç, ≤ 20
  member_ids: UserId[];           // [owner_id, ...invitee_ids]: kural ve array-contains sorgusu
  names: Record<UserId, string>;  // üyelerin ad anlık görüntüsü (üyeler birbirini tanımayabilir)
  stage: 'voting' | 'final' | 'completed' | 'cancelled' | 'expired';
  respond_by: EpochMs | null;          // yanıt süresi sonu (dolunca sonuçlar düzenleyene gider)
  vote_window_ms: number;              // 2 / 6 / 24 / 48 sa (varsayılan 24 sa)
  answers: Record<UserId, EventAnswer>;     // davetlinin TEK yanıtı: katılım + mekan + saat
  venue_options: EventVenueOption[];        // 1–3 mekan (tekse sabit)
  time_options: EventTimeOption[];          // 1–4 saat (tekse sabit); her biri tarihte ve ≥ 30 dk ileride
  results_at: EpochMs | null;               // sonuçların düzenleyene gittiği an
  results_reason: 'all_answered' | 'deadline' | null;
  venue_option_id: string | null;           // onaylanan mekan
  time_option_id: string | null;            // onaylanan saat
  starts_at: EpochMs | null;                // kesinleşen başlangıç
  finalized_at: EpochMs | null;
  expires_at: EpochMs;                      // tarih gününün yerel sonu
  end_reason: 'completed' | 'cancelled' | 'expired' | null;
  ended_at: EpochMs | null;
  seq: number;                              // v1, t2 … kimlik sayacı
  created_at: EpochMs; updated_at: EpochMs; version: number;
}
interface EventAnswer {
  status: 'going' | 'not_going';
  note: string | null;              // yalnızca not_going, ≤ 300 kod noktası
  venue_option_id: string | null;   // "Katılacağım" ise zorunlu (tek seçenekte kendiliğinden)
  time_option_id: string | null;    // "Katılacağım" ise zorunlu (tek seçenekte kendiliğinden)
  at: EpochMs;
}
```

- **Kurallar** (`backend/firestore.rules`): okuma yalnızca `request.auth.uid in resource.data.member_ids`; yazma
  yalnızca `event_*` callable'ları. Üye olmayan için belge yok sayılır (`event_not_found`, var olduğu sızmaz).
- **İndeksler** (`firestore.indexes.json`): `member_ids array-contains + updated_at desc` (liste),
  `open + next_action_at` (süpürücü), `owner_id + open` (sahip başına 10 etkin etkinlik), TTL `purge_at`
  (biten etkinlik 30 gün sonra silinir).
- **Not görünürlüğü** [Varsayım]: "Katılamayacağım" notu kartta tüm üyelere görünür (etkinlik grup içindir).

### 1.2 Yardımcı koleksiyonlar

| Yol | İçerik | Erişim |
| --- | --- | --- |
| `event_reminders/{event_id}_{kind}` | `kind` (`day_before` / `morning`), `due_at`, planlandığı andaki `starts_at`, `sent`, `outcome` (`sent` / `stale`), TTL | istemciye kapalı |
| `users/{uid}/notices/{id}` | uygulama içi bildirim kutusu: `type` (`event_invite`, `event_stage`, `event_rsvp`, `event_reminder`, `event_cancelled`), `event_id`, `title`, `body`, `created_at`; koordinat yok; 30 gün TTL | yalnızca sahibi okur, sunucu yazar |
| `users/{uid}.privacy` | `{ battery_share, movement_alerts, updated_at }` (§7) | sahibi okur, yalnızca `privacy_settings_set` yazar |
| RTDB `privacy/{uid}` | `{ battery_share, updated_at }` aynası (RTDB kuralı girdisi) | sahibi okur, yazma yok |
| `movement_cooldowns/{uid}` | son "yola çıktı" bildirimi anı (30 dk soğuma), TTL | istemciye kapalı |

### 1.3 Callable'lar (hepsi `op_id` ile tekilleştirilir; Faz 8 onay kapısı geçerli)

| Callable | Kim | Ne yapar |
| --- | --- | --- |
| `event_create` | herkes | Başlık, açıklama, tarih, saat dilimi, davetliler, **zorunlu** 1–3 mekan ve 1–4 saat, yanıt süresi. Davetliler yalnızca bana `meetup_invite` vermiş arkadaşlar (Faz 8 `canInvite`); diğerleri **sessizce düşer**, yalnızca sayısı döner (`skipped_count`). Hiç kalmazsa `not_permitted` / `not_friends`. Günde 20 oluşturma, aynı anda 10 etkin etkinlik. |
| `event_respond` | davetli | TEK yanıt: `status: going | not_going`, `venue_option_id`, `time_option_id` ("Katılacağım" ise ikisi de zorunlu; tek seçenekte kendiliğinden), `note` (yalnızca not_going, ≤ 300). Onaylanana kadar değiştirilebilir; `final`'de yalnızca katılım değişir. "Katılamayacağım" onaysız da gönderilebilir (koruyucu işlem). |
| `event_finalize` | sahip | Sonucu onaylar → `final`. En çok oyu alan mekan ve saat; eşitlikte `event_vote_tie` (+ `venue_leaders` / `time_leaders`) döner, sahip liderlerden birini `venue_option_id` / `time_option_id` ile seçer. Herkes yanıtlamadan da onaylanabilir; en az bir "Katılacağım" gerekir. |
| `event_options_set` | sahip, `voting` | Mekan ve saat seçeneklerini değiştirir. Aynı kalan seçenek (aynı ad / yer, aynı dakika) kimliğini ve oyunu korur; seçimi kaldırılan davetliye "seçenekler değişti" gider, yanıtı eksik kalır. |
| `event_update` | sahip | Başlık / açıklama (başlamadan önce); tarih yalnızca `voting`'de. Tarih değişirse yanıtlar sıfırlanır, saatler yeni güne taşınır, davetlilere "Tarih değişti". |
| `event_invite_add` | sahip | Sonradan davet (aynı izin süzgeci). |
| `event_cancel` | sahip | `cancelled`; davetlilere bildirim, hatırlatıcılar silinir. |

Hata kodları (core `ERROR_CODES`): `event_not_found`, `event_not_owner`, `event_stage_mismatch`,
`event_options_invalid` (+ `details.reason`), `event_vote_tie` (+ `details.venue_leaders` / `time_leaders`), `event_no_attendees`, `event_date_invalid`,
`event_note_too_long`, `event_invitee_limit`, `event_started`, `event_limit_reached`. Saatte 120 etkinlik işlemi.

## 2. Durum makinesi

Tek saf geçiş fonksiyonu: core `reduceEvent(doc, actor, action, ctx) → { doc, effects, changed }`. Backend
(`handlers/events.ts`) ve web demo sunucusu aynı fonksiyonu çağırır; üyelik ve sahiplik burada, arkadaşlık / izin /
onay / hız sınırı çağıranda denetlenir.

```
                       herkes yanıtladı ya da respond_by doldu
   ┌──────────┐  ───────────────────────────────────────▶  sonuçlar düzenleyene (results_at, TEK bildirim)
   │  voting  │       davetli: event_respond (katılım + mekan + saat, tek seferde; onaya kadar değişebilir)
   └──────────┘       sahip: event_options_set (seçenekleri değiştir), event_update (tarih → yanıtlar sıfırlanır)
     │      │ event_finalize (sahip; eşitlikte liderlerden seçer)
     │      ▼
     │   ┌────────┐  katılım değişebilir (oylar donmuş), sahibe bildirim; hatırlatıcılar planlanır
     │   │ final  │──────────── starts_at + 3 sa ────────────▶ completed
     │   └────────┘
     ├── gün bitti (expires_at) ya da hiçbir saat seçeneği kalmadı ──▶ expired
     └── cancel (sahip) ──▶ cancelled
```

- **Tek seferde oylama**: davetli daveti açınca katılımını, mekanı ve saati TEK kartta işaretler ve gönderir.
  "Katılacağım" mekan ve saat seçimi olmadan gönderilemez; tek mekan / tek saat sabittir (seçim kendiliğinden).
  Yanıtlar sonuçlardan önce tek tek bildirilmez.
- **Sonuçlar**: herkes yanıtlayınca (`all_answered`) ya da yanıt süresi dolunca (`deadline`) sonuçların tamamı TEK
  bildirimle düzenleyene düşer: "3 katılacak · 1 katılamayacak · 1 yanıt vermedi · Mekan: Moda Kahve (3 oy) · Saat:
  10:00 (2 oy)". Sonrasında gelen yanıt / değişiklik düzenleyene tek tek bildirilir. Oy sayımı yalnızca "Katılacağım"
  diyenlerin seçimidir; düzenleyen oy sayılarını ve kimin neyi seçtiğini görür, davetliler görmez.
- **Yanıt süresi** (`respond_by`): pencere (2 / 6 / 24 / 48 sa), tarih gününün sonu ve ilk saat seçeneğinden 1 sa önce;
  hangisi erken.
- **Onay** (`event_finalize`): yalnızca sahip; eşitlikte kazananı liderler arasından seçer. Herkes yanıtlamadan da
  onaylanabilir (uygulama önce sorar).
- **Sistem eylemleri**: `tick` (dakikalık süpürücü: yanıt süresi, gün sonu, tamamlanma) ve `remove_member`
  (arkadaşlık bitti / engel / hesap silindi; sahip çıkarılırsa etkinlik iptal; kalan herkes yanıtlamışsa sonuçlar gider).
- **Etkiler** (`EventEffect`): `invite`, `stage` (`results` sahibe, `final` davetlilere, `date_changed`,
  `options_changed` seçimi kaldırılanlara), `rsvp` (sahibe, sonuçlardan sonra; seçimlerle), `cancelled`, `reminders`.
  Sunucu bunları aynı transaction'da bildirim kutusuna ve hatırlatıcılara, commit sonrası push'a çevirir.

## 3. Hatırlatmalar ve davet bildirimi

- **Davet**: oluşturma / sonradan davet anında hemen (`event_invite`, push + bildirim kutusu).
- **Hatırlatma planı** (core `eventReminderPlan`, yalnızca `final`):
  - `day_before`: başlangıçtan tam 24 saat önce (o an geçtiyse planlanmaz).
  - `morning`: buluşma günü yerel 08:00 (geçtiyse ya da buluşma 08:00'de / daha önce başlıyorsa planlanmaz).
- **Gönderim** (`event_sweeper`, dakikada bir): etkinlik hâlâ `final` ve başlangıç değişmemişse; 2 saatten geç
  kalan ya da başlangıcı geçen hatırlatma `stale` (gönderilmez). Alıcılar: sahip + "Katılamayacağım"
  DEMEYEN davetliler. Uygulama içi (bildirim kutusu) ve push olarak.

## 4. Bildirim mimarisi

### 4.1 Android kanalları (immutable: değişen kanal yeni kimlikle açılır)

| Kanal | Önem | Kullanım |
| --- | --- | --- |
| `sos_alarm` (yeni; Faz 4 `sos` **silinir**) | MAX, `bypassDnd`, kilit ekranında PUBLIC, özel ses `res/raw/sos_alarm`, uzun titreşim | SOS (gelen acil durum) |
| `movement` | HIGH (heads-up banner), kilit ekranında PRIVATE | "Ayşe eve girdi" (bölge), "Mehmet yola çıktı" |
| `events` | HIGH | davet, sonuçlar, kesinleşme, yanıt, iptal |
| `event_reminders` | HIGH | 1 gün önce / sabah 08:00 |

Bölge (Faz 5 `zone_event`) push'u da `movement` kanalına taşındı. `ACCESS_NOTIFICATION_POLICY` izni `bypassDnd`'nin
çalışması için (kullanıcı Rahatsız Etme erişimi verdiyse).

### 4.2 iOS

| Tür | `interruption-level` | Ses |
| --- | --- | --- |
| SOS | `critical` (Apple Critical Alerts yetkisi varsa, `IOS_CRITICAL_ALERTS=1`) yoksa `time-sensitive` | `sos_alarm.wav` (≤ 30 sn) |
| Hareket / bölge, hatırlatma | `time-sensitive` (Odak açıkken de görünür) | varsayılan |
| Davet, aşama, iptal | `active` | varsayılan |
| Yanıt (sahibe) | `active` | sessiz (ön planda) |

Kategoriler (`setNotificationCategoryAsync`) kanal kimlikleriyle aynı; `apns-collapse-id` ile aynı etkinliğin aynı
türden yeni bildirimi eskisinin yerine geçer. `com.apple.developer.usernotifications.time-sensitive` yetkisi açık.

### 4.3 Alarm sesi

`apps/mobile/assets/sounds/sos_alarm.wav` (8 sn, iki tonlu siren); `app.config.ts` → expo-notifications
`sounds`. Uygulama öndeyken gelen SOS da aynı sesi ve kanalı kullanır (`f4Push.localSound`).

### 4.4 Yönlendirme

`f7Push.ts`: `parseF7Data` (veriyi core listelerine göre doğrular), `f7ForegroundContent` (ön planda yerel bildirim),
`routeF7Open` (dokununca: etkinlik → `/events/{id}`, hareket → haritada kişi vurgusu). Uygulama kapalıyken gelen
dokunuş bekletilir, servisler başlayınca açılır.

## 5. İzin mimarisi ve UX

### 5.1 İlk açılış akışı (`OnboardingFlow`)

Sözleşme onayından sonra bir kez; adım sırası core `nextOnboardingStep`:

1. **Hoş geldin** (bilgi)
2. **Konum "Kullanırken"** (sistem istemi)
3. **"Her zaman"a yükseltme** (iOS ikinci istem / Android 11+ ayarlar)
4. **Bildirimler** (SOS alarmı, bölge ve hareket uyarıları, etkinlikler)
5. **Pil paylaşımı onayı** (uygulama içi anahtar, **varsayılan KAPALI**)
6. **Kamera ve fotoğraflar**

Verilmiş izin atlanır; reddedilmiş izin için "Ayarlarda aç". Her adımda "Şimdi değil"; akış paylaşımı engellemez,
atlanan izinler ihtiyaç anında yeniden sorulur (Faz 3 kademeli izin akışı). Tamamlanma cihazda saklanır
(`konum.onboarding.v1`); Gizlilik Merkezi'nden yeniden gösterilebilir.

### 5.2 İzin & Gizlilik Merkezi (`/privacy`; hesap menüsü ve Profil)

- **Özet**: "Tüm izinler tamam" ya da "N ayar dikkat istiyor".
- **İzinler** (core `permissionCenterRows`): Konum (Kullanırken / Her zaman), Tam konum, Bildirimler, SOS alarmı
  (iOS zaman duyarlı / kritik), Kamera, Fotoğraflar, Hareket, Pil optimizasyonu (Android). Her satır: durum rengi,
  neden gerektiği, tek düğme ("İzin ver" → sistem istemi ya da "Ayarları aç"). Uygulama öne gelince yenilenir.
- **Paylaşım tercihleri** (hesaba bağlı, sunucuda zorlanır): Pil durumumu paylaş, "Yola çıktı" bildirimleri.
- **Görünüm**: Sistem / Açık / Koyu (harita dahil, anında).
- **Diğer**: Görünmez ol, kişi izinleri, Güvenlik Sözleşmesi / KVKK, kurulum rehberini yeniden göster.

## 6. Harita stili ve geçiş mantığı

- Tercih (`system | light | dark`) **cihazda** saklanır (`konum.theme_pref.v1`; hesaba bağlı değil).
- Etkin şema `resolveColorScheme(pref, cihaz)`; `useTheme()` hem uygulama renklerini hem harita stilini verir.
- Google Haritalar `customMapStyle` JSON'u iki **önceden hesaplanmış, dondurulmuş** diziden seçilir
  (`MAP_STYLES.light` / `MAP_STYLES.dark`, `ui/theme.ts`). Geçişte yalnızca dizi başvurusu değişir: native SDK
  stili haritayı yeniden yüklemeden uygular, kamera ve pinler yerinde kalır. Yer imleri ve toplu taşıma simgeleri
  gizli (kişiler öne çıksın).
- Değiştirme yerleri: haritadaki tek düğme (Sistem → Açık → Koyu → Sistem; erişilebilirlik etiketi bir sonrakini
  söyler) ve Gizlilik Merkezi'ndeki üçlü seçici. "Sistem"de cihaz ayarı değişince anında uygulanır.

## 7. Pil paylaşımı ve "yola çıktı"

### 7.1 Pil paylaşımı (varsayılan KAPALI)

Üç katmanda zorlanır:

1. **RTDB kuralı**: `live_locations`, `live_trail`, `link_live` içinde `battery_pct` / `is_charging` yalnızca
   `privacy/{auth.uid}/battery_share === true` iken yazılabilir.
2. **Sunucu**: `battery_low_notify` paylaşım kapalıyken `suppressed` döner (alıcıya "pili azaldı" gitmez).
3. **İstemci**: konum hattı pil alanlarını göndermez; çevrimdışı kuyruktan boşaltılan yazmalardan da ayıklar
   (`stripBatteryFields`).

Sıra: **açarken** önce RTDB aynası sonra Firestore (kural hazır olmadan pil gelmez), istemci sunucu onayından sonra
yayına başlar; **kapatırken** istemci hemen bırakır, sonra Firestore ve ayna.

### 7.2 "Yola çıktı" (`movement_report`)

İstemci hareket makinesinde "≥ 10 dk sabit → yürüme / araç" geçişini yakalar (core `shouldReportDeparture`).
Alıcılar: o an etkin paylaşımlarımın alıcıları (canlı konumu zaten görüyorlar) ve "yola çıktı" tercihi açık olanlar.
Görünmezken, 5 dk'dan eski raporda, 30 dk soğumada ya da alıcı yoksa gitmez. Push'ta koordinat yok.

## 8. Web önizleme (demo)

Demo sunucusu (`apps/mobile/src/demo/server/server.ts`) aynı core fonksiyonlarıyla Faz 7'yi taklit eder:

- Ayşe / Mehmet / Zeynep sana buluşma daveti izni vermiş (Can vermemiş: seçicide "Bu kişi sana bu izni vermedi").
- Botlar birkaç saniye içinde TEK yanıt verir (Can "Katılamayacağım" + not; diğerleri katılır ve bir mekan + saat seçer);
  herkes yanıtlayınca sonuçlar sana düşer. Ayşe'nin davetinde sen işaretleyip gönderince Ayşe birkaç saniyede onaylar.
- Eski (aşamalı oylama) biçimindeki demo etkinlikleri açılışta silinir.
- **FAZ 7 SENARYOLARI** paneli: "Ayşe etkinliğe davet etsin" (önce Ayşe'ye buluşma daveti izni ver),
  "Hatırlatmayı şimdi gönder", "Mehmet yola çıksın"; altta etkinlik sayısı, gizlilik tercihlerin ve son "yola çıktı"
  raporun.
- Sağ üstteki takvim simgesi Etkinlikler'i, rozet okunmamış bildirim sayısını gösterir.

## 9. Testler ve açıklar

| Katman | Kapsam |
| --- | --- |
| Çekirdek (`packages/core/test/faz7.test.ts`) | durum makinesi (tek yanıt, sonuçlar, onay ve eşitlik, süre dolumu, seçenek / tarih değişimi, üye çıkarma), hatırlatma planı (yaz saati), metinler, ilk açılış adımları, izin merkezi satırları, tema |
| Backend (`backend/test/functions/faz7.test.ts`, kural testleri) | callable'lar uçtan uca emülatörde, izin süzgeci, hatırlatma gönderimi / bayatlama, pil RTDB kuralı, düşük pil bastırma, "yola çıktı" |
| Mobil (`__tests__/faz7Mobile.test.ts`, `demoFaz7.test.ts`) | bildirim kanalları ve kesinti düzeyleri, SOS alarm kanalı, pil alanı süzgeci, gizlilik deposu sırası, tema, etkinlik deposu; demo sunucusunda tek seferde oylama bot üyelerle |
| Tarayıcı | giriş → onay → ilk açılış akışı → harita teması → etkinlik oluştur → botlar tek yanıt verir → sonuçlar → onay → hatırlatma bildirimi; Ayşe'nin davetine tek kartla yanıt → Gizlilik Merkezi (Playwright) |

### 9.1 Cihazda doğrulanacaklar

- [ ] Android: `sos_alarm` kanalı Rahatsız Etme açıkken sesli çalıyor mu, eski `sos` kanalı silindi mi (kanal ayarları).
- [ ] iOS: Critical Alerts onayı gelene kadar SOS `time-sensitive` + `sos_alarm.wav`; sessiz modda davranış.
- [ ] Heads-up: uygulama arka plandayken "Mehmet yola çıktı" ve "Ayşe eve girdi" üstten banner olarak geliyor mu.
- [ ] Hatırlatmalar: gerçek saat diliminde 1 gün önce ve 08:00 (yaz saati geçişi olan bir tarihte).
- [ ] Harita teması: native Google Maps'te geçiş kamerayı / pinleri sıfırlamadan anında mı.
- [ ] İlk açılış: iOS "Her zaman" ikinci istemi ve Android 11+ ayarlar yolu; kamera / fotoğraf istemleri.
- [ ] Yayın: `firestore.rules`, `firestore.indexes.json` (TTL dahil), `database.rules.json` (pil kuralı) ve 12 yeni
      callable + `event_sweeper` birlikte dağıtılsın. Eski istemci pil alanı yazarsa kural reddeder: istemci
      güncellemesi önce yayımlanmalı ya da kural geçiş süresince gevşek bırakılmalı [Varsayım].
