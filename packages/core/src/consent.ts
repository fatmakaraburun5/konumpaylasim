/**
 * Faz 8: Güvenlik Sözleşmesi ve KVKK Aydınlatma / Açık Rıza Metni (docs/PHASE8.md §1.6, §2.3, §3, §5.1).
 *
 *  - Metin `CONSENT_DOCUMENT` (bölümler) → `CONSENT_TEXT` (düz metin, deterministik) → `CONSENT_TEXT_SHA256`.
 *    Özet saf `sha256Hex` ile hesaplanır: Node, Hermes ve tarayıcıda aynıdır; testle sabitlenir. Metnin TEK harfi
 *    değişirse özet değişir ve test kırılır: o zaman `CONSENT_VERSION` artırılır, `CONSENT_CHANGES` güncellenir.
 *  - Sunucu `consent_accept`te sürüm ve özetin güncel olanla aynı olmasını şart koşar (`isCurrentConsent`):
 *    gösterilen metin = onaylanan metin.
 *  - Onay yokken veri işleyen callable'lar `consent_required` döner; koruyucu işlemler her zaman çalışır
 *    (`consentExemptCall`).
 */
import { z } from 'zod';
import { CALLABLES, type CallableName } from './contracts';
import { sha256Hex } from './link';
import type { UserId } from './model';
import type { EpochMs } from './time';

export const CONSENT_VERSION = '2026-11-25';
export const CONSENT_TITLE = 'Güvenlik Sözleşmesi ve KVKK Aydınlatma / Açık Rıza Metni';

/** Yayından önce veri sorumlusunun dolduracağı yer tutucular (sürüm kontrol listesi bunları arar). */
export const CONSENT_PLACEHOLDERS = ['[Şirket unvanı]', '[Adres]', '[KEP / e-posta]'] as const;

/** Bir bölüm: önce paragraflar, sonra maddeler, sonra (varsa) kapanış paragrafları gösterilir. */
export interface ConsentSection {
  id: string;
  heading: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  closing?: readonly string[];
}

export const CONSENT_DOCUMENT: readonly ConsentSection[] = [
  {
    id: 'veri_sorumlusu',
    heading: '1. Veri sorumlusu',
    paragraphs: [
      'Bu metin, Konum uygulamasının kullanım kurallarını ve kişisel verilerinin nasıl işlendiğini anlatır. 6698 sayılı Kişisel Verilerin Korunması Kanunu (KVKK) m.10 uyarınca aydınlatma metni, m.5 ve m.9 uyarınca açık rıza metni ve uygulamanın kullanım sözleşmesidir.',
    ],
    bullets: ['Veri sorumlusu: [Şirket unvanı]', 'Adres: [Adres]', 'Başvuru: [KEP / e-posta]'],
    closing: ['Köşeli parantez içindeki bilgiler, uygulama yayımlanmadan önce veri sorumlusu tarafından doldurulur.'],
  },
  {
    id: 'guvenlik_sozlesmesi',
    heading: '2. Taraflar, kapsam ve güvenlik sözleşmesi',
    paragraphs: [
      'Bu sözleşme sen (kullanıcı) ile veri sorumlusu arasında kurulur. Konum, seçtiğin arkadaşlarınla konumunu seçtiğin süre boyunca paylaşmana yarar. Uygulamayı kullanarak şu kuralları kabul edersin:',
    ],
    bullets: [
      'Arkadaşlık konum izni değildir. Arkadaş olmak ikinizin de konumunu açmaz; arkadaşın yalnızca senden izin isteyebilir.',
      'İzinler kişiye özeldir ve tek yönlüdür. Konumunu görme, ping, varış / ayrılış bildirimi ve buluşma daveti izinlerini her arkadaşına ayrı verirsin; senin verdiğin izin, onun sana izin verdiği anlamına gelmez. İzinlerini Arkadaşlar > Kişi izinleri sayfasından istediğin an geri alabilirsin; konum iznini geri alınca o kişiyle paylaşımın hemen durur.',
      'Konumun yalnızca sen paylaşım başlattığında, konumunu görme izni verdiğin kişilere ve seçtiğin süre boyunca gider. Paylaşımı istediğin an durdurabilirsin; karşı taraf da görmeyi bırakabilir.',
      'Görünmez mod: açtığında tüm paylaşımların ve QR bağlantıların durur, arka planda konum gönderilmez. Arkadaşlarına görünmez olduğun söylenmez. Süren bir SOS uyarısı görünmez moddan etkilenmez; kapatana kadar acil durum kişilerin SOS konumunu görmeye devam eder. Görünür olunca hiçbir paylaşım kendiliğinden başlamaz; hangilerinin yeniden başlayacağını sen seçersin.',
      'Engelleme: engellediğin kişiyle arkadaşlığın, iki yöndeki izinler ve paylaşımlar biter; o kişi sana yeniden istek gönderemez.',
      "SOS: seçtiğin en çok 5 acil durum kişisine tam konumunu, adresini ve pil durumunu gönderir; onlarla 1 saatlik paylaşım da başlatabilir. Görünmez moddayken de gider ve görünmez modu kapatır. SOS resmi acil çağrının yerini tutmaz; hayati tehlikede 112'yi ara.",
      'Yasak kullanımlar: birini bilgisi ve rızası olmadan izlemek ya da onun telefonunu kullanarak konumunu paylaştırmak; başkalarının konumunu, fotoğrafını veya bilgilerini izinsiz kaydetmek ya da yaymak; uygulamayı taciz, ısrarlı takip, tehdit veya baskı için kullanmak; sahte kimlik ya da başkasının numarasını kullanmak; sistemi otomatik araçlarla zorlamak.',
      'Reşit olmayanlar: uygulama 18 yaşından küçüklere yönelik değildir; 18 yaşından küçüksen yalnızca velinin ya da vasinin izniyle kullanabilirsin. Hiç kimse bir çocuğu ya da başka birini, onun bilgisi olmadan izlemek için uygulamayı kullanamaz.',
      'Kurallara aykırı kullanımda hesabını askıya alabilir ya da kapatabiliriz.',
    ],
    closing: ['Karşı tarafa ulaşmış konumu geri alamayız ve ekran görüntüsü alınmasını engelleyemeyiz. Konumunu yalnızca güvendiğin kişilerle paylaş.'],
  },
  {
    id: 'veriler',
    heading: '3. İşlenen kişisel veriler',
    bullets: [
      'Kimlik ve iletişim: görünen adın ve telefon numaran. Numaran giriş ve arkadaş bulma için kullanılır, arkadaşlarına gösterilmez. Numaran Firebase Authentication’da, yalnızca senin okuyabildiğin özel profil kaydında ve numarayla arkadaş bulma dizininde (yalnızca sunucu okur) açık hâliyle saklanır; yalnızca engelleme kayıtlarında numaranın gizli anahtarlı özeti tutulur.',
      'Profil: profil fotoğrafın (yeniden kodlanır, içindeki konum bilgisi silinir), cinsiyetin (yalnızca profil çerçevesinin rengi için) ve davet kodun.',
      'Konum: paylaşım sırasında uygulama açıkken ve arka planda alınan konumun; doğruluk, hız, yön, hareket durumu (duruyor, yürüyor, araçta gibi) ve ölçüm zamanı; bağlantı koptuğunda biriken iz noktaları; ping, buluşma ve SOS konumu.',
      'Cihaz: pil seviyesi ve şarj durumu, bildirim jetonu, platform ve uygulama sürümü, uygulama bütünlüğü doğrulaması (App Check).',
      'Sosyal: arkadaşların, arkadaşlık ve izin istekleri, verdiğin ve aldığın izinler, engellediğin kişiler, favorilerin, acil durum kişilerin.',
      'İçerik: durum ve yer notların, kayıtlı bölgelerin (Ev, İş gibi; merkez ve yarıçap), koordinatsız bölge olay kaydı, buluşma önerileri ve SOS kayıtları (tam konum, adres, pil).',
      'Güvenlik kayıtları: işlem kimlikleri (aynı işlemin iki kez uygulanmasını önler), hız sınırı sayaçları ve onay kayıtların (sürüm, metin özeti, zaman, platform, uygulama sürümü).',
    ],
    closing: ['Hareket etkinliği bilgisi telefonundan çıkmaz; paylaşımda yalnızca hareket durumu gönderilir. Konum geçmişi tutmayız.'],
  },
  {
    id: 'amaclar',
    heading: '4. İşleme amaçları',
    bullets: [
      'Konumunu yalnızca izin verdiğin ve paylaşım başlattığın kişilere canlı göstermek, süreyi yönetmek ve süre bitince paylaşımı kapatmak.',
      'Ping, not, varış / ayrılış bildirimi, buluşma noktası, rota ve varış süresi, widget ile hızlı paylaşım gibi kullandığın özellikleri çalıştırmak.',
      'Acil durumda seçtiğin kişilere tam konumunu ulaştırmak.',
      'İstek, süre bitiyor ve düşük pil gibi bildirimleri göndermek. Bildirimlerde koordinat yer almaz; yalnızca SOS bildiriminde adres bulunur.',
      'Pilini korumak için güncelleme sıklığını hareket durumuna göre ayarlamak.',
      'Hesabını korumak; sahte hesapları, SMS dolandırıcılığını, taciz amaçlı istekleri ve kötüye kullanımı önlemek; hukuki yükümlülükleri yerine getirmek ve onayını ispat etmek.',
    ],
  },
  {
    id: 'hukuki_sebepler',
    heading: '5. Hukuki sebepler',
    bullets: [
      'KVKK m.5/2-c, sözleşmenin kurulması ve ifası: hesabın, arkadaşlıkların, izinlerin, bildirimlerin ve başlattığın özelliklerin çalışması.',
      'KVKK m.5/2-ç, hukuki yükümlülük: yetkili kurumların kanuna dayalı talepleri ve saklama yükümlülükleri.',
      'KVKK m.5/2-f, meşru menfaat: güvenlik, kötüye kullanımın önlenmesi, hız sınırları ve işlem kayıtları; temel hak ve özgürlüklerine zarar vermemek kaydıyla.',
      'KVKK m.5/1, açık rıza: konum verilerinin (anlık ve arka plan konumu, iz noktaları, ping, buluşma ve SOS konumu) işlenmesi ve gerekli olduğu ölçüde KVKK m.9 kapsamında yurt dışına aktarılması.',
    ],
    closing: ['Özel nitelikli kişisel veri (KVKK m.6) işlemeyiz: Face ID / Touch ID doğrulaması telefonunda yapılır, biyometrik veri bize ulaşmaz.'],
  },
  {
    id: 'uygulama_izinleri',
    heading: '6. Uygulama izinleri',
    paragraphs: [
      'İzinleri açılışta toplu istemeyiz; her birini ilk gerektiği anda, nedenini açıklayarak isteriz. Hepsini telefonunun ayarlarından istediğin an kapatabilirsin; o zaman yalnızca ilgili özellik çalışmaz.',
    ],
    bullets: [
      'Konum (uygulama açıkken): ilk paylaşımda istenir; kısa paylaşımlar için yeterlidir.',
      'Konum (arka planda, “Her zaman”): 8 saat ve üzeri, gün sonuna kadar, haftalık ya da süresiz paylaşımda, paylaşım sürerken uygulama arka plana geçtiğinde ya da bölge bildirimlerini açtığında, önce açıklama gösterilerek istenir. Arka planda konumun yalnızca paylaşım sürerken sunucuya gönderilir; bölge izleme telefonunda çalışır, sunucuya yalnızca koordinatsız varış / ayrılış olayı gider. Rota, buluşma önerisi, ping ve SOS kullandığında o anki konumun da gönderilir.',
      'Kesin konum: kapalıysa arkadaşların seni 1–3 km sapmayla görür; buluşma ve SOS için açmanı öneririz.',
      'Bildirimler: istekler, süre bitiyor, ping, bölge ve SOS bildirimleri için; ilk paylaşımda istenir.',
      "Pil: pil seviyesi ve şarj durumu izinsiz okunur, yalnızca paylaşım ya da SOS sırasında konumunu görenlere gider. Android'de uzun paylaşım kesilmesin diye pil optimizasyonu istisnası için seni ayarlara yönlendirebiliriz; karar senindir.",
      "Hareket ve fiziksel etkinlik: hareketsizken GPS'i kapatıp pili korumak için; isteğe bağlıdır.",
      'Kamera ve fotoğraflar: yalnızca profil fotoğrafı için; yalnızca seçtiğin fotoğraf yüklenir.',
      "Face ID / Touch ID (ya da ekran kilidi): kilitli telefonda widget'tan hızlı paylaşım başlatırken kimliğini telefonun doğrular.",
    ],
  },
  {
    id: 'aktarim',
    heading: '7. Aktarım',
    bullets: [
      "Google Firebase (hizmet sağlayıcımız): Cloud Firestore ve profil fotoğraflarının saklandığı Cloud Storage Avrupa'da (eur3), Realtime Database ve Cloud Functions Belçika'da (europe-west1) çalışır. Türkiye'de Firebase bölgesi olmadığından bu veriler yurt dışında işlenir ve saklanır.",
      "Firebase Authentication (telefon numarası, SMS doğrulaması) ve Firebase Cloud Messaging (bildirim jetonu ve içeriği) için bölge seçilemez; bu veriler ABD'de de işlenebilir. iOS bildirimleri Apple üzerinden iletilir.",
      'Google Maps Platform: harita, rota, varış süresi, adres ve buluşma yeri araması için. Adres sorgusunda tam konumun yerine yaklaşık 150 metrelik bir alanın merkezi gönderilir; buluşma hesabındaki konumlar saklanmaz.',
      'Arkadaşların: görünen adını, fotoğrafını ve çerçeve rengini görür; gerisini yalnızca verdiğin izinler kadar görür. Konum izni verdiysen paylaşım sürerken canlı konumunu (doğruluk, hız, yön ve hareket durumuyla), pil seviyeni ve şarj durumunu, bağlantı koptuğunda biriken iz noktalarını, durum notunu ve paylaşımın bitiş saatini; ayrıca gönderdiğin pingleri (konum izni verdiysen konumuyla), görmelerine izin verdiğin yer notlarını, bölge bildirimi izni verdiysen varış / ayrılış bildirimlerini ve buluşma önerilerini (önerdiğin buluşmada senin varış süren dahil) görür.',
      'QR bağlantısı: bağlantıyı açan herkes, bağlantı süresince görünen adını, son konumunu (doğruluk, hız ve yön dahil), pil durumunu ve bağlantının bitiş saatini görür; numaran ve kullanıcı kimliğin gösterilmez.',
      'Yetkili kamu kurum ve kuruluşları: yalnızca kanunen zorunlu olduğunda.',
    ],
    closing: [
      'Yurt dışına aktarım KVKK m.9 kapsamındadır; Google ile yapılan standart sözleşmelere ve gerekli olduğu ölçüde açık rızana dayanır. Verilerini satmayız ve reklam için kullanmayız.',
    ],
  },
  {
    id: 'saklama',
    heading: '8. Saklama süreleri',
    bullets: [
      'Konum geçmişi tutulmaz. Canlı konum alıcı başına yalnızca son noktadır ve paylaşım bitince (durdurma, süre dolumu, izin geri alma, görünmez mod, rızanı geri çekme) hemen silinir.',
      'Bağlantı koptuğunda biriken iz noktaları en çok 24 saat tutulur ve paylaşımla birlikte silinir.',
      'Biten paylaşım ve yanıtlanan istek kayıtları (koordinatsız) 7 gün sonra silinir. Gönderdiğin arkadaşlık isteğinin kendi kaydın (maskelenmiş numarayla) ve düşük pil bildirimi durumu (koordinatsız) 30 gün tutulur. Konum istekleri 15 dakika, izin istekleri 48 saat içinde yanıtlanmazsa geçersiz olur. Süresi dolan kayıtlar, süre dolduktan sonra en geç bir gün içinde silinir.',
      'Ping konumu 15 dakika, buluşma önerileri 12 saat sonra, yer notları seçtiğin sürenin (en çok 1 hafta) sonunda silinir. Rota ve buluşma sonuçları birkaç dakikalık önbellekte kalır ve en geç bir gün içinde silinir. Adres sorgularının sonucu yaklaşık 150 metrelik alana göre, kişiyle ilişkilendirilmeden 30 gün önbellekte tutulur. Koordinatsız bölge olay kaydı 30 gün tutulur.',
      'SOS kayıtları çözüldükten en geç 7 gün sonra silinir; açık kalan SOS 24 saat sonra kendiliğinden kapanır.',
      'İşlem kimlikleri yaklaşık 1 gün, widget oturumları en çok 30 gün tutulur; hız sınırı sayaçları hesabınla birlikte silinir.',
      'Onay kayıtların, onayını ispat edebilmek için hesabın silinene kadar saklanır.',
      'Hesabını silince profilin, numaran, fotoğrafların, arkadaşlıkların, izinlerin, notların, bölgelerin ve cihaz kayıtların silinir. Silme kaydı (yalnızca kullanıcı kimliği ve zaman) 30 gün, karşı tarafta görünen biten paylaşım kayıtları en geç 7 gün sonra silinir. Başkalarının seni engellediği kayıt (numaranın gizli anahtarlı özeti dahil) onların güvenliği için kalır.',
    ],
  },
  {
    id: 'haklar',
    heading: '9. KVKK m.11 kapsamındaki hakların ve başvuru',
    paragraphs: ['Veri sorumlusuna başvurarak şunları isteyebilirsin:'],
    bullets: [
      'verilerinin işlenip işlenmediğini öğrenme ve işlenmişse bilgi isteme,',
      'işlenme amacını ve amacına uygun kullanılıp kullanılmadığını öğrenme,',
      'yurt içinde veya yurt dışında aktarıldığı üçüncü kişileri bilme,',
      'eksik veya yanlış işlenmişse düzeltilmesini, KVKK m.7 çerçevesinde silinmesini veya yok edilmesini isteme ve bunların aktarılan üçüncü kişilere bildirilmesini isteme,',
      'yalnızca otomatik sistemlerle analiz sonucu aleyhine bir sonuç çıkmasına itiraz etme,',
      'kanuna aykırı işleme nedeniyle zarara uğrarsan zararın giderilmesini isteme.',
    ],
    closing: [
      "Başvurunu [KEP / e-posta] ya da [Adres] adresine yazılı iletebilirsin. Başvurun en geç 30 gün içinde ücretsiz sonuçlandırılır; işlem ayrıca maliyet gerektirirse Kurul'un belirlediği ücret alınabilir.",
      "Başvurun reddedilirse, yanıtı yetersiz bulursan ya da süresinde yanıt alamazsan, yanıtı öğrendiğin tarihten itibaren 30 gün, her hâlde başvurudan itibaren 60 gün içinde Kişisel Verileri Koruma Kurulu'na şikâyette bulunabilirsin.",
    ],
  },
  {
    id: 'acik_riza',
    heading: '10. Açık rıza beyanı',
    paragraphs: [
      '“Okudum, Onaylıyorum” düğmesine basarak; konum verilerimin (anlık ve arka plan konumu, doğruluk, hız, yön, hareket durumu, iz noktaları, ping, buluşma ve SOS konumu) bu metinde anlatılan amaçlarla işlenmesine ve 7. bölümdeki hizmet sağlayıcılar aracılığıyla yurt dışına aktarılmasına açık rıza veriyorum.',
      'Açık rızamı istediğim an Profil > Sözleşme ve KVKK > “Açık rızamı geri çek” ile geri alabilirim. Geri aldığımda tüm paylaşımlarım ve QR bağlantılarım hemen durur, süren SOS uyarım kapanır (kişilerime güvende olduğum bildirilir), yer notlarım silinir ve önerdiğim buluşmalar iptal edilir; bundan sonra konumum işlenmez. Uygulamayı yeniden kullanmak için metni yeniden onaylamam gerekir. Geri alma, önceki işlemlerin hukuka uygunluğunu etkilemez.',
    ],
  },
  {
    id: 'degisiklikler',
    heading: '11. Değişiklikler ve sürüm',
    paragraphs: [
      `Bu metnin sürümü ${CONSENT_VERSION}. Metin değişince uygulama değişikliklerin özetini gösterir ve yeniden onayını ister. Onaylayana kadar uygulamayı kullanamazsın ve konumun gönderilmez; onay ekranındaki “Paylaşımlarımı durdur ve görünmez ol” ile onay vermeden tüm paylaşımlarını ve QR bağlantılarını durdurabilirsin. Hesabının silinmesini 9. bölümdeki başvuru yoluyla her zaman isteyebilirsin.`,
      'Onayla birlikte metnin sürümü, özeti (SHA-256), onay zamanı, platform ve uygulama sürümü kaydedilir; böylece gösterilen metinle onaylanan metnin aynı olduğu ispatlanabilir.',
    ],
  },
  {
    id: 'onay',
    heading: '12. Onay',
    paragraphs: ['“Okudum, Onaylıyorum” düğmesine basman, bu aydınlatma metnini okuduğunu, güvenlik sözleşmesini kabul ettiğini ve açık rıza verdiğini gösterir.'],
  },
];

/** Bölümleri deterministik düz metne çevirir (özet bunun üzerinden alınır; satır sonu `\n`). */
export function flattenConsentDocument(title: string, version: string, sections: readonly ConsentSection[]): string {
  const parts = sections.map((s) =>
    [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? []).map((b) => `• ${b}`), ...(s.closing ?? [])].join('\n'),
  );
  return [`${title}\nSürüm: ${version}`, ...parts].join('\n\n');
}

export const CONSENT_TEXT: string = flattenConsentDocument(CONSENT_TITLE, CONSENT_VERSION, CONSENT_DOCUMENT);

/** `CONSENT_TEXT`in SHA-256 özeti (küçük harf hex). Testle sabitlenir. */
export const CONSENT_TEXT_SHA256: string = sha256Hex(CONSENT_TEXT);

/** Yeniden onayda "Neler değişti?" altında gösterilir (bu sürüm için). */
export const CONSENT_CHANGES: readonly string[] = [
  'Arkadaşlık artık konum izni değil: her izin kişiye özel ve tek yönlü.',
  'Konum, ping, bölge bildirimi ve buluşma izinlerini Kişi izinleri sayfasından ayrı ayrı yönetebilirsin.',
  'Görünmez mod eklendi: tek dokunuşla tüm paylaşımların durur.',
  "Açık rızanı Profil > Sözleşme ve KVKK'dan istediğin an geri çekebilirsin.",
];

const TR_MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

/** '2026-11-25' → '25 Kasım 2026' (tarih biçimi değilse olduğu gibi). */
export function formatConsentVersionDate(version: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version);
  const month = m ? TR_MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : version;
}

export const CONSENT_UI_TEXT = {
  title: CONSENT_TITLE,
  accept: 'Okudum, Onaylıyorum',
  scrollHint: 'Onaylamak için metni sonuna kadar kaydır',
  updatedBadge: 'Metin güncellendi',
  changesTitle: 'Neler değişti?',
  /** "Sürüm 2026-11-25 · 25 Kasım 2026" */
  versionLine: (version: string = CONSENT_VERSION): string => `Sürüm ${version} · ${formatConsentVersionDate(version)}`,
  cardTitle: 'Sözleşme ve KVKK',
  acceptedAtLabel: 'Onay tarihi',
  viewText: 'Metni görüntüle',
  withdraw: 'Açık rızamı geri çek',
  withdrawConfirmTitle: 'Açık rızan geri çekilsin mi?',
  withdrawConfirmBody:
    'Tüm paylaşımların ve QR bağlantıların hemen durur, süren SOS uyarın kapanır, yer notların silinir ve önerdiğin buluşmalar iptal edilir. Uygulamayı yeniden kullanmak için metni yeniden onaylaman gerekir.',
  withdrawAction: 'Geri çek',
  cancel: 'Vazgeç',
  outdated: 'Metin güncellendi. Yeni metni okuyup onaylaman gerekiyor.',
  /** Onay kapısında, onay vermeden: tüm paylaşımları ve QR bağlantılarını bitirir (`invisible_set`, onaydan muaf). */
  stopAll: 'Paylaşımlarımı durdur ve görünmez ol',
  stopAllDone: 'Görünmezsin: paylaşımların ve QR bağlantıların durduruldu.',
  /** Profildeki onay bu uygulamanın bildiğinden yeni (başka cihazda onaylandı): bu sürüm onu gösteremez. */
  updateApp: 'Sözleşmenin daha yeni bir sürümünü onayladın. Bu cihazda uygulamayı güncelle.',
  /** Sunucunun güncel sürümü bu uygulamanınkinden yeni: eski metin onaylanamaz. */
  updateAppToAccept: 'Sözleşmenin yeni bir sürümü yayımlandı. Onaylamak için uygulamayı güncelle.',
} as const;

// --- kayıtlar ve kararlar ---------------------------------------------------------------------

export const CONSENT_PLATFORMS = ['ios', 'android', 'web'] as const;
export type ConsentPlatform = (typeof CONSENT_PLATFORMS)[number];

/** `users/{uid}.consent` (profil özeti). */
export interface ProfileConsent {
  version: string;
  accepted_at: EpochMs;
}

/** Aynı sürümün önceki onayı (geri çekilip yeniden onaylandıysa; kayıt üzerine yazılmaz, buraya eklenir). */
export interface ConsentHistoryEntry {
  text_sha256: string;
  accepted_at: EpochMs;
  withdrawn_at: EpochMs | null;
  platform: ConsentPlatform;
  app_version: string;
}

/**
 * `users/{uid}/consents/{version}` (yalnızca sahibi okur, yalnızca callable yazar). Ekleme amaçlıdır: aynı sürüm
 * geri çekilip yeniden onaylanınca önceki onay ve geri çekme anı `history` içine taşınır (ispat kaybolmaz).
 */
export interface ConsentRecord {
  user_id: UserId;
  version: string;
  text_sha256: string;
  scrolled_to_bottom: true;
  accepted_at: EpochMs;
  platform: ConsentPlatform;
  app_version: string;
  withdrawn_at: EpochMs | null;
  /** Eskiden yeniye önceki onaylar (yoksa boş / alan yok). */
  history?: ConsentHistoryEntry[];
}

/** Yeniden onayda önceki kaydı geçmişe ekler (en çok son 50 giriş tutulur). */
export function withConsentHistory(prev: ConsentRecord | null | undefined): ConsentHistoryEntry[] {
  if (!prev) return [];
  const entry: ConsentHistoryEntry = {
    text_sha256: prev.text_sha256,
    accepted_at: prev.accepted_at,
    withdrawn_at: prev.withdrawn_at ?? null,
    platform: prev.platform,
    app_version: prev.app_version,
  };
  return [...(prev.history ?? []), entry].slice(-50);
}

/** Onay ekranı gösterilmeli mi? (Onay yok ya da eski sürüm.) */
export function consentRequired(profileConsent: ProfileConsent | null | undefined, current: string = CONSENT_VERSION): boolean {
  return !profileConsent || profileConsent.version !== current;
}

/**
 * Profildeki onay bu uygulamanın sürümünden YENİ mi? (Başka cihazda yeni sürüm onaylandı; ISO tarih sürümleri dizgi
 * olarak sıralanır.) Eski uygulama yeni metni gösteremez ve eski metnin onayı sunucuda reddedilir: istemci kapıyı
 * göstermez, "uygulamayı güncelle" der (sunucu kararı yine sunucunun güncel sürümüne göredir).
 */
export function consentNewerThanApp(profileConsent: ProfileConsent | null | undefined, current: string = CONSENT_VERSION): boolean {
  return !!profileConsent && profileConsent.version > current;
}

/** İstemci onay kapısı: onay yok ya da bu uygulamanınkinden ESKİ sürüm (yenisi kapı değil, güncelleme uyarısıdır). */
export function clientConsentRequired(profileConsent: ProfileConsent | null | undefined, current: string = CONSENT_VERSION): boolean {
  return consentRequired(profileConsent, current) && !consentNewerThanApp(profileConsent, current);
}

/** İstemcinin gönderdiği sürüm + özet güncel metinle aynı mı? (Sunucu `consent_accept`; değilse `consent_required`.) */
export function isCurrentConsent(
  req: { version: string; text_sha256: string },
  current: { version: string; text_sha256: string } = { version: CONSENT_VERSION, text_sha256: CONSENT_TEXT_SHA256 },
): boolean {
  return req.version === current.version && req.text_sha256 === current.text_sha256;
}

export interface ScrollMetrics {
  /** Kaydırma konumu (üst kenar), px. */
  offsetY: number;
  /** Görünen alanın yüksekliği, px. */
  viewportH: number;
  /** İçeriğin toplam yüksekliği, px. */
  contentH: number;
}

/**
 * Metin sonuna kadar kaydırıldı mı? İçerik ekrana sığıyorsa doğrudan true. Ölçüm henüz yoksa (0 / NaN) false:
 * düğme yerleşim ölçülmeden açılmaz.
 */
export function isScrolledToBottom(m: ScrollMetrics, tol = 24): boolean {
  const { offsetY, viewportH, contentH } = m;
  if (![offsetY, viewportH, contentH, tol].every(Number.isFinite)) return false;
  if (viewportH <= 0 || contentH <= 0) return false;
  if (contentH <= viewportH) return true;
  return offsetY + viewportH >= contentH - Math.max(0, tol);
}

/**
 * Onay olmadan da çalışan callable'lar (§1.6). `user_bootstrap` da muaftır: cinsiyet kapısı onay kapısından önce
 * gelir ve profil kurulumu sözleşmenin kurulması içindir. Koşullu olanlar `consentExemptCall` ile denetlenir.
 * Kendi verisini kapatan / silen işlemler de muaftır (SOS'u kapatmak, yer notunu / bölgeyi silmek, buluşmayı iptal
 * etmek, giden arkadaşlık isteğini geri çekmek): onayı olmayan kullanıcı kendi verisini her zaman kaldırabilir.
 */
export const CONSENT_EXEMPT_CALLABLES: readonly CallableName[] = [
  CALLABLES.userBootstrap,
  CALLABLES.shareStop,
  CALLABLES.shareRevoke,
  CALLABLES.linkShareStop,
  CALLABLES.permissionSet,
  CALLABLES.invisibleSet,
  CALLABLES.friendshipRemove,
  CALLABLES.friendRequestCancel,
  CALLABLES.locationRequestCancel,
  CALLABLES.locationRequestRespond,
  CALLABLES.userBlock,
  CALLABLES.accountDelete,
  CALLABLES.widgetTokenRevoke,
  CALLABLES.sosResolve,
  CALLABLES.placeNoteDelete,
  CALLABLES.zoneDelete,
  CALLABLES.meetupCancel,
  CALLABLES.consentAccept,
  CALLABLES.consentWithdraw,
];

/**
 * Bu çağrı onaysız çalışabilir mi? `permission_set` yalnızca geri alırken (`granted: false`), `invisible_set` yalnızca
 * görünmez olurken (`invisible: true`) muaftır.
 */
export function consentExemptCall(name: string, data?: unknown): boolean {
  if (!(CONSENT_EXEMPT_CALLABLES as readonly string[]).includes(name)) return false;
  const d = (data ?? {}) as Record<string, unknown>;
  if (name === CALLABLES.permissionSet) return d.granted === false;
  if (name === CALLABLES.invisibleSet) return d.invisible === true;
  // Konum isteğini reddetmek kendi verini korur; onaylamak (paylaşım başlatır) onay ister.
  if (name === CALLABLES.locationRequestRespond) return d.accept === false;
  return true;
}

// --- callable şemaları ------------------------------------------------------------------------

export const ConsentAcceptRequestSchema = z.object({
  op_id: z.uuid(),
  version: z.string().min(1).max(32),
  text_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** İstemci ancak metin sonuna kadar kaydırıldıysa gönderir; başka değer şemada reddedilir. */
  scrolled_to_bottom: z.literal(true),
  platform: z.enum(CONSENT_PLATFORMS),
  app_version: z.string().min(1).max(32),
});
export type ConsentAcceptRequest = z.input<typeof ConsentAcceptRequestSchema>;

export interface ConsentAcceptResponse {
  consent: ProfileConsent;
  server_now: EpochMs;
}

export const ConsentWithdrawSchema = z.object({ op_id: z.uuid() });
export type ConsentWithdrawRequest = z.input<typeof ConsentWithdrawSchema>;

export interface ConsentWithdrawResponse {
  consent: null;
  /** Biten giden paylaşım ve QR bağlantısı sayıları. */
  shares_ended: number;
  links_ended: number;
  server_now: EpochMs;
}
