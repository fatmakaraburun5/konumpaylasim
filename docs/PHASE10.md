# Faz 10: Ortak Takvim, "Kim Ne Kadar Uzakta?" ve İki Aşamalı Hesap Kurtarma / Çoklu Cihaz Oturumları

Faz 10, Faz 1–9 sözleşmelerini **genişletir**; mevcut alanların anlamı değişmez. Çelişki olursa
`packages/core/src/{calendar,etaBoard,accountSecurity}.ts` geçerlidir. **[Varsayım]** ile işaretlenenler ürün ya da
hukuk kararıyla doğrulanmalıdır.

## 1. Ortak Takvim ("Takvime Ekle")

- Yalnızca **kesinleşmiş** (Faz 7 `stage: 'final'`) etkinlik kartında görünür. Core `calendarEntryOf(doc, …)` girişi
  üretir: başlık, başlangıç–bitiş (bitiş yoksa +2 sa), saat dilimi, mekan adı + adres (`location`), Google Haritalar
  bağlantısı (`url`), katılımcı özeti + uygulama bağlantısı (`notes`), uyarılar 60 ve 15 dk önce.
- **Resmi onay adımı**: ilk eklemede "Telefon takvimine ekle" sayfası (ne yazılır, ne okunmaz, KVKK maddesi) →
  sistem izni. iOS 17+ **yalnızca yazma** (`NSCalendarsWriteOnlyAccessUsageDescription`; eski iOS için
  `NSCalendarsFullAccessUsageDescription`), Android `READ_CALENDAR` + `WRITE_CALENDAR` (CalendarContract; birincil,
  yazılabilir takvim, ör. Google Takvim).
- İzin reddedildiyse izinsiz yol: sistemin "Yeni Etkinlik" formu (`createEventInCalendarAsync`) ya da Google Takvim
  web bağlantısı. Eşleme (`etkinlik → takvim kimliği`) cihazda kalır; saat/mekan değişirse kart "Takvimi güncelle"
  der (iOS yalnızca yazma izninde güncelleme yerine yeniden ekleme önerilir).
- İzin Merkezi ve ilk açılış rehberinde "Takvim" satırı/adımı.

## 2. "Kim Ne Kadar Uzakta?"

- Pencere: kesin başlangıçtan **45 dk önce** açılır, başlangıçtan 30 dk sonra (ya da herkes vardığında) kapanır
  (`etaWindowOf`). Faz 7 hatırlatma planına `eta_window` eklendi.
- Yalnızca **"Katılacağım"** diyen ve şu an konumunu bana açık paylaşan kişiler (`location_view` alınan izni);
  diğerleri "+n kişi konum paylaşmıyor". Hesap tamamen istemcide, gelen paketlerden (sunucu yeni veri tutmaz).
- Sıralama: varanlar ("Ayşe · Vardı", Faz 9 `dest_state`) → en yakın ETA → en uzak. Cinsiyet çerçeveli avatar.
- Etkinlik kartında ve haritanın üstünde yatay şerit; haritada dokununca etkinlik, kişiye dokununca kişi odaklanır.

## 3. İki aşamalı kurtarma ve çoklu cihaz oturumları

- Sağlayıcılar `AuthVerificationProvider` (SMS) ve e-posta göndericisi arayüzleri ardında; bu depoda **mock /
  yerel** adaptörler (`backend/functions/src/verification/`). Gerçek SMS / e-posta sağlayıcısı en son bağlanacak.
- Her kurulum bir **cihaz oturumu** (`device_sessions/{dsid}`); istemci `device_register` ile kaydolur ve `dsid`
  içeren özel token'la yeniden oturum açar. İlk kayıt etkin olur, `legacy` (dsid'siz) token kara listeye girer.
- SMS ile giriş numarayı doğrular (`sms_verified_at`). Kurtarma e-postası doğrulanmışsa yeni kurulum
  **"doğrulama bekliyor"** kalır; e-postaya giden 6 haneli kodla (`device_second_factor_verify`) etkinleşir.
  Arkadaşlıklar, `permission_grants`, favoriler, bölgeler ve KVKK onayları hesaba bağlı olduğu için olduğu gibi
  taşınır (`account_migration_manifest` sayıları gösterir).
- Profil → Güvenlik → **Aktif Cihazlar ve Oturumlar**: model, son görülme, konum yayını durumu, doğrulama yolu.
  **"Eski Cihazdaki Oturumu ve Konum Yayınını Kapat"** → `device_revoke`: oturum `revoked`, Firestore
  `revoked_devices/{uid}_{dsid}` + RTDB aynası (kurallar o dsid'in yazımını anında reddeder), o cihazın canlı
  paylaşımları durur, sessiz `session_revoked` push'u arka plan yayınını kapatıp çıkış yaptırır.
- Yeni cihaz girişinde diğer cihazlara "yeni cihaz girişi" bildirimi.
- **[Varsayım]** Özel token ile alınan ID token'da `phone_number` taşınmaya devam eder; gerçek kurulumda doğrulanmalı.

## 4. Test ve demo

- Core birim, backend emülatör (`backend/test/functions/faz10.test.ts`), mobil jest (305 test).
- Tarayıcı demosu "FAZ 10 SENARYOLARI": Ayşe 40 dk sonrası için buluşma → şerit; Takvime Ekle → resmi onay →
  simüle iOS izni → simüle Takvim; "Yeni telefona geç" → SMS 123456 → e-posta kodu → Aktif Cihazlar → eski cihazı
  kapat. Duman testi `apps/mobile/e2e/faz10-smoke.cjs` (23 denetim).

## 5. Yayın ve cihazda doğrulanacaklar

- [ ] Gerçek SMS ve e-posta sağlayıcısı (gizli anahtarlar Secret Manager'da), gönderen alan adı SPF/DKIM.
- [ ] `firestore.rules`, `database.rules.json`, `firestore.indexes.json` ve 10 yeni callable birlikte yayımlansın;
      eski istemci `device_registration_required` alır.
- [ ] `expo-calendar` için `expo prebuild` + yeni derleme; iOS 17 yalnızca yazma izni, Android Google Takvim.
- [ ] Cihazda: eski telefon arka planda yayın yaparken iptal → yazım reddi + sessiz push ile durma; uygulama
      öldürülmüşken push; iki cihazda aynı anda giriş.
