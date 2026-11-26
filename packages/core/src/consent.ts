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

export const CONSENT_VERSION = '2026-11-27';
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
      'Çevrimdışı SOS SMS yedeği: internet yokken SOS’a basarsan, açık onay verdiysen, son doğrulanmış konumun, zamanı, pil yüzden ve harita bağlantısı seçtiğin numaralara gönderilmek üzere telefonunun mesaj uygulamasında hazır açılır; mesajı sen gönderirsin. SMS yedeği bir yardımcıdır, iletilmesini garanti edemeyiz.',
      'Güvenli Dönüş: başlattığın zamanlayıcının süresi (15, 30, 45 ya da 60 dakika) dolduğunda hedefine varmamışsan ve kısa son uyarıdan sonra da “Güvendeyim” demediysen, seçtiğin acil durum kişilerine son doğrulanmış konumun ve pil durumunla otomatik alarm gider. Telefonun kapalı ya da çevrimdışı olsa da alarm, en son bildirdiğin konumla sunucudan gönderilir. Zamanlayıcıyı istediğin an iptal edebilir ya da uzatabilirsin.',
      'Anlık fotoğraf: paylaşım sırasında yalnızca o an kamerayla çektiğin fotoğrafı ekleyebilirsin (galeriden seçilemez). Fotoğraf, konumunu o an gören kişilere 1 saat gösterilir ve sonra silinir. Başkalarını rızaları olmadan çekme; fotoğrafta başkalarının özel bilgileri görünmesin.',
      'Yasak kullanımlar: birini bilgisi ve rızası olmadan izlemek ya da onun telefonunu kullanarak konumunu paylaştırmak; başkalarının konumunu, fotoğrafını veya bilgilerini izinsiz kaydetmek ya da yaymak; uygulamayı taciz, ısrarlı takip, tehdit veya baskı için kullanmak; sahte kimlik ya da başkasının numarasını kullanmak; sistemi otomatik araçlarla zorlamak.',
      'Reşit olmayanlar: uygulama 18 yaşından küçüklere yönelik değildir; 18 yaşından küçüksen yalnızca velinin ya da vasinin izniyle kullanabilirsin. Hiç kimse bir çocuğu ya da başka birini, onun bilgisi olmadan izlemek için uygulamayı kullanamaz.',
      'Cihazlar ve hesap kurtarma: hesabına telefon numaran (SMS kodu) ve e-posta / Gmail adresin (e-posta kodu) ile iki aşamalı kurtarma kanalı bağlayabilirsin. Kurtarma e-postan doğrulanmışsa yeni bir telefonda giriş için SMS kodunun yanında e-posta kodu da istenir. Hesabının açık olduğu cihazları Profil > Güvenlik > Aktif Cihazlar ve Oturumlar’da görür, eski ya da kaybolan bir cihazdaki oturumu ve konum yayınını tek dokunuşla kapatabilirsin. Doğrulama kodlarını kimseyle paylaşma.',
      'Kurallara aykırı kullanımda hesabını askıya alabilir ya da kapatabiliriz.',
    ],
    closing: ['Karşı tarafa ulaşmış konumu geri alamayız ve ekran görüntüsü alınmasını engelleyemeyiz. Konumunu yalnızca güvendiğin kişilerle paylaş.'],
  },
  {
    id: 'veriler',
    heading: '3. İşlenen kişisel veriler',
    bullets: [
      'Hesap kurtarma: eklediğin e-posta / Gmail adresin ve doğrulama zamanları. E-posta adresin yalnızca doğrulama ve kurtarma kodu göndermek için kullanılır, arkadaşlarına gösterilmez ve pazarlama için kullanılmaz. Doğrulama kodlarının yalnızca gizli anahtarlı özeti saklanır.',
      'Kimlik ve iletişim: görünen adın ve telefon numaran. Numaran giriş ve arkadaş bulma için kullanılır, arkadaşlarına gösterilmez. Numaran Firebase Authentication’da, yalnızca senin okuyabildiğin özel profil kaydında ve numarayla arkadaş bulma dizininde (yalnızca sunucu okur) açık hâliyle saklanır; yalnızca engelleme kayıtlarında numaranın gizli anahtarlı özeti tutulur.',
      'Profil: profil fotoğrafın (yeniden kodlanır, içindeki konum bilgisi silinir), cinsiyetin (yalnızca profil çerçevesinin rengi için) ve davet kodun.',
      'Konum: paylaşım sırasında uygulama açıkken ve arka planda alınan konumun; doğruluk, hız, yön, hareket durumu (duruyor, yürüyor, araçta gibi) ve ölçüm zamanı; bağlantı koptuğunda biriken iz noktaları; ping, buluşma ve SOS konumu.',
      'Cihaz: pil seviyesi ve şarj durumu, bildirim jetonu, platform ve uygulama sürümü, uygulama bütünlüğü doğrulaması (App Check).',
      'Cihaz oturumları: hesabının açık olduğu her cihaz için cihaz modeli, işletim sistemi ve uygulama sürümü, kurulum kimliğinin özeti, oturumun açıldığı ve son görüldüğü zaman, arka plan konum yayınının açık olup olmadığı ve oturumun nasıl doğrulandığı (SMS, e-posta). IP adresi ya da cihazın konumu bu kayda yazılmaz.',
      'Takvim: “Takvime Ekle” ile kesinleşen buluşmayı (başlık, saat, mekan adı ve adresi, harita bağlantısı, katılımcı özeti) telefonunun takvimine yazarız. Takvimin okunmaz ve sunucuya gönderilmez; telefonunda yalnızca hangi etkinliği eklediğin tutulur.',
      'Sosyal: arkadaşların, arkadaşlık ve izin istekleri, verdiğin ve aldığın izinler, engellediğin kişiler, favorilerin, acil durum kişilerin.',
      'İçerik: durum ve yer notların, kayıtlı bölgelerin (Ev, İş gibi; merkez ve yarıçap), koordinatsız bölge olay kaydı, buluşma önerileri ve SOS kayıtları (tam konum, adres, pil).',
      'Anlık fotoğraf: paylaşım sırasında kameranla o an çektiğin fotoğraf, açıklaması (durum notun), çekildiği an ve çekildiği yer. Fotoğraf yeniden kodlanır; içindeki konum ve cihaz bilgisi (EXIF) silinir.',
      'Yaklaşma ve hedef: paylaşımına eklediğin hedefin adı ve durumu (yolda, neredeyse vardı, vardı). Hedefin koordinatı telefonunda kalır; sunucuya yalnızca koordinat içermeyen bir anahtar gider.',
      'Güvenli Dönüş: hedefinin adı, süre, seçtiğin acil durum kişileri ve zamanlayıcı sürerken son doğrulanmış konumun (doğrulukla) ile pil durumun. Bu kayıt yalnızca sana açıktır; acil durum kişilerin konumunu yalnızca alarm anında görür.',
      'Rehber ve SMS: rehberinden seçtiğin SMS acil durum numaraları (ad ve numara) ve SMS yedeği tercihin YALNIZCA telefonunda saklanır. Rehberin, SMS’lerin ve SMS içeriği bize ulaşmaz; uygulama SMS’lerini okumaz.',
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
      'Acil durumda seçtiğin kişilere tam konumunu ulaştırmak; internet yokken SOS mesajını SMS ile göndermene yardım etmek (mesaj telefonunda hazırlanır).',
      'Güvenli Dönüş zamanlayıcın dolduğunda, hedefine varmadıysan ve onay vermediysen seçtiğin acil durum kişilerine alarm, son konumunu ve pil durumunu iletmek.',
      'Hedefine 200 metre kala konumunu görenlere bir kez “Neredeyse vardım” bildirimi göndermek ve haritadaki durumunu güncellemek.',
      'Paylaşım sırasında eklediğin anlık fotoğrafı, konumunu o an görenlere 1 saat göstermek.',
      'İstek, süre bitiyor, düşük pil, neredeyse vardım ve Güvenli Dönüş gibi bildirimleri göndermek. Bildirimlerde koordinat yer almaz; yalnızca SOS ve Güvenli Dönüş alarmı bildiriminde adres bulunur.',
      'Kesinleşen buluşmaya 45 dakika kala, “Katılacağım” diyen ve konumunu sana zaten canlı paylaşan katılımcıların mekana tahmini varış sürelerini sıralı göstermek (“Kim ne kadar uzakta?”). Bu sıralama yalnızca senin zaten görebildiğin konumlardan telefonunda hesaplanır; yeni bir konum paylaşımı açmaz.',
      'Kesinleşen buluşmayı istersen telefonunun takvimine eklemek.',
      'Hesabını kaybettiğinde ya da telefon değiştirdiğinde SMS ve e-posta kodlarıyla kurtarmak, yeni cihazında arkadaşlarını, izinlerini, favorilerini, bölgelerini ve onay kayıtlarını eksiksiz kullanabilmen; eski cihazdaki oturumu ve konum yayınını kapatabilmen.',
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
      'KVKK m.5/1, açık rıza: konum verilerinin (anlık ve arka plan konumu, iz noktaları, ping, buluşma, SOS ve Güvenli Dönüş konumu), anlık fotoğrafların işlenmesi ve gerekli olduğu ölçüde KVKK m.9 kapsamında yurt dışına aktarılması.',
      'KVKK m.5/2-b ve m.5/2-c: Güvenli Dönüş alarmı ve SOS, hayati tehlikede bulunan senin korunman ve başlattığın özelliğin ifası için de işlenir.',
    ],
    closing: ['Özel nitelikli kişisel veri (KVKK m.6) işlemeyiz: Face ID / Touch ID doğrulaması telefonunda yapılır, biyometrik veri bize ulaşmaz.'],
  },
  {
    id: 'uygulama_izinleri',
    heading: '6. Uygulama izinleri',
    paragraphs: [
      'İlk açılıştaki kurulum rehberinde her izni tek tek, nedenini açıklayarak sorarız; her birini “Şimdi değil” ile geçebilirsin, atladığın izni ilk gerektiği anda yeniden sorarız. Hepsini telefonunun ayarlarından ya da İzin & Gizlilik Merkezi’nden istediğin an kapatabilirsin; o zaman yalnızca ilgili özellik çalışmaz.',
    ],
    bullets: [
      'Konum (uygulama açıkken): ilk paylaşımda istenir; kısa paylaşımlar için yeterlidir.',
      'Konum (arka planda, “Her zaman”): 8 saat ve üzeri, gün sonuna kadar, haftalık ya da süresiz paylaşımda, paylaşım sürerken uygulama arka plana geçtiğinde ya da bölge bildirimlerini açtığında, önce açıklama gösterilerek istenir. Arka planda konumun yalnızca paylaşım sürerken sunucuya gönderilir; bölge izleme telefonunda çalışır, sunucuya yalnızca koordinatsız varış / ayrılış olayı gider. Rota, buluşma önerisi, ping ve SOS kullandığında o anki konumun da gönderilir.',
      'Kesin konum: kapalıysa arkadaşların seni 1–3 km sapmayla görür; buluşma ve SOS için açmanı öneririz.',
      'Bildirimler: istekler, süre bitiyor, ping, bölge ve SOS bildirimleri için; ilk paylaşımda istenir.',
      "Pil: pil seviyesi ve şarj durumu izinsiz okunur, yalnızca paylaşım ya da SOS sırasında konumunu görenlere gider. Android'de uzun paylaşım kesilmesin diye pil optimizasyonu istisnası için seni ayarlara yönlendirebiliriz; karar senindir.",
      "Hareket ve fiziksel etkinlik: hareketsizken GPS'i kapatıp pili korumak için; isteğe bağlıdır.",
      'Kamera: profil fotoğrafı ve anlık fotoğraf için. Anlık fotoğraf YALNIZCA kamerayla o an çekilir; galeriden seçim kapalıdır.',
      'Fotoğraflar (galeri): yalnızca profil fotoğrafını galeriden seçmek için; yalnızca seçtiğin fotoğraf yüklenir.',
      'Rehber (Kişiler): yalnızca SMS acil durum numaralarını rehberinden seçmen için, açık onayınla istenir. Rehberin sunucuya yüklenmez ve taranmaz; yalnızca seçtiğin numaralar telefonunda saklanır. Vermezsen numarayı elle yazabilirsin.',
      'SMS: SMS yedeği için açık onayını alırız. iPhone’da uygulamalar SMS’i kendiliğinden gönderemez; internet yokken SOS mesajı Mesajlar uygulamasında hazır açılır ve sen gönderirsin. Android’de de mesaj SMS uygulamanda hazır açılır; bunun için SMS gönderme ya da okuma izni istemeyiz. SMS operatörün üzerinden şifrelenmeden iletilir ve operatör tarifene göre ücretlendirilebilir.',
      'Takvim: yalnızca “Takvime Ekle”ye bastığında, önce ne yazılacağını gösteren onay ekranıyla istenir. iPhone’da yalnızca ekleme izni istenir (diğer etkinliklerin görülmez); takvimdeki kaydı sonradan güncellemek istersen tam erişim ayrıca sorulur. Android’de yazılabilir takvimi bulmak için takvim okuma ve yazma izni gerekir; etkinliklerin okunmaz ve kaydedilmez. Vermezsen telefonun kendi “Etkinlik ekle” ekranıyla izinsiz ekleyebilirsin.',
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
      'QR bağlantısı: bağlantıyı açan herkes, bağlantı süresince görünen adını, son konumunu (doğruluk, hız ve yön dahil), pil durumunu ve bağlantının bitiş saatini görür; numaran ve kullanıcı kimliğin gösterilmez. Anlık fotoğraf ve hedef bilgisi QR bağlantısına gitmez.',
      'Anlık fotoğraf ve hedef: konumunu o an paylaştığın kişiler, eklediğin anlık fotoğrafı (1 saat) ve paylaşımına eklediğin hedefin adını ve durumunu görür.',
      'Güvenli Dönüş: seçtiğin acil durum kişileri zamanlayıcıyı başlattığını ve bitirdiğini (hedefin adıyla) öğrenir; süre dolup yanıt vermezsen son doğrulanmış konumunu, adresini, pil durumunu ve harita bağlantısını görür.',
      'Doğrulama kodları: SMS kodu SMS hizmet sağlayıcısı ve operatörün, e-posta kodu e-posta hizmet sağlayıcısı (ör. Google Gmail / e-posta gönderim servisi) üzerinden iletilir; sağlayıcılar yalnızca alıcı adresini ve kodu görür.',
      'SMS yedeği: mesaj senin telefonundan ve mobil operatörün üzerinden seçtiğin numaraya gider; içeriği (koordinat, zaman, pil, harita bağlantısı) bize ulaşmaz.',
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
      'Anlık fotoğraflar eklendikten 1 saat sonra sunucudan (depolama alanı ve kayıt) ve uygulamanın tüm cihazlardaki önbelleğinden silinir; daha önce kaldırırsan hemen silinir. Fotoğrafsız kayıt özeti en geç 1 gün içinde silinir.',
      'Güvenli Dönüş kayıtları (son konum dahil) bittikten 7 gün sonra, “Neredeyse vardım” tekrar önleme kaydı (koordinatsız) 2 gün sonra silinir.',
      'Rehberden seçtiğin SMS numaraları ve SMS yedeği tercihin yalnızca telefonundadır; uygulamayı silince ya da listeden çıkarınca silinir.',
      'Doğrulama kodu kayıtları (yalnızca özet) en geç 1 gün, kapatılan cihaz oturumları 30 gün sonra silinir; açık cihaz oturumların sen kapatana ya da hesabını silene kadar tutulur. Kurtarma e-postan sen kaldırana kadar saklanır.',
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
      '“Okudum, Onaylıyorum” düğmesine basarak; konum verilerimin (anlık ve arka plan konumu, doğruluk, hız, yön, hareket durumu, iz noktaları, ping, buluşma, SOS ve Güvenli Dönüş konumu) ve anlık fotoğraflarımın bu metinde anlatılan amaçlarla işlenmesine, Güvenli Dönüş süresi dolup yanıt vermediğimde son konumumun ve pil durumumun seçtiğim acil durum kişilerine iletilmesine ve 7. bölümdeki hizmet sağlayıcılar aracılığıyla yurt dışına aktarılmasına açık rıza veriyorum.',
      'Takvim izni için ayrıca onayım alınır: yalnızca seçtiğim kesinleşen buluşmanın telefonumun takvimine yazılmasına onay veriyorum.',
      'Rehber ve SMS izinleri için ayrıca açık onayım alınır: rehberime yalnızca SMS acil durum numarası seçmek için erişilmesine ve internet yokken SOS mesajının telefonumun mesaj uygulamasında hazırlanmasına onay veriyorum. Bu onayları İzin & Gizlilik Merkezi’nden istediğim an geri alabilirim.',
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
  'Hesap kurtarma: telefon numaran (SMS kodu) ve e-posta / Gmail adresinle (e-posta kodu) iki aşamalı kurtarma; e-posta adresin yalnızca kod göndermek için kullanılır.',
  'Aktif Cihazlar ve Oturumlar: hesabının açık olduğu cihazların modeli, son görülme zamanı ve konum yayını durumu kaydedilir; eski cihazdaki oturumu tek dokunuşla kapatabilirsin.',
  'Takvime Ekle: kesinleşen buluşma telefonunun takvimine yazılır; takvimin okunmaz, sunucuya gitmez.',
  '"Kim ne kadar uzakta?": buluşmaya 45 dk kala, konumunu zaten sana paylaşan katılımcıların tahmini varış süreleri telefonunda hesaplanıp gösterilir.',
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
  CALLABLES.eventCancel,
  CALLABLES.eventRespond,
  CALLABLES.privacySettingsSet,
  CALLABLES.consentAccept,
  CALLABLES.consentWithdraw,
  // Faz 9: kendi fotoğrafını kaldırmak ve Güvenli Dönüş'ü bitirmek / iptal etmek her zaman çalışır.
  CALLABLES.proofDelete,
  CALLABLES.safeReturnCheckIn,
  CALLABLES.safeReturnCancel,
  // Faz 10: yeni cihaz girişi (onay henüz verilmemiş olabilir), eski cihazı kapatmak, çıkış ve kurtarma kanalını
  // kaldırmak koruyucudur. Kurtarma kanalı EKLEMEK (e-posta işler) onay ister.
  CALLABLES.deviceRegister,
  CALLABLES.deviceSecondFactorSend,
  CALLABLES.deviceSecondFactorVerify,
  CALLABLES.deviceHeartbeat,
  CALLABLES.deviceRevoke,
  CALLABLES.deviceSignOut,
  CALLABLES.recoveryChannelRemove,
  CALLABLES.accountMigrationManifest,
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
  // Faz 7: davetten çekilmek ("Katılamayacağım") ve paylaşımı KISAN gizlilik ayarı onaysız da yapılabilir.
  if (name === CALLABLES.eventRespond) return d.status === 'not_going';
  if (name === CALLABLES.privacySettingsSet) return d.battery_share !== true && d.movement_alerts !== true;
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
