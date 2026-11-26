# Alt kitapçık (ShareDeck): çoklu paylaşımda haritayı açık tutmak

Kod: `apps/mobile/src/features/map/ShareDeck.tsx` (arayüz), `shareDeckModel.ts` (saf model, `__tests__/shareDeckModel.test.ts`),
`MapHome.tsx` (bağlantı). Eski `ActiveShareCard` / `ActiveLinkCard` kaldırıldı.

## 1. Sorun (UI/UX notu)

Her giden paylaşım (kişi başına bir oturum, ayrıca her QR bağlantısı) kendi tam boy kartını açıyordu ve kartlar alt
alanda **alt alta diziliyordu**. Kart yüksekliği ~190 pt (başlık + alt metin + alıcı satırı + iki düğme + boşluklar);
yığın kişi sayısıyla doğrusal büyüyordu ve haritanın yerine geçiyordu:

| Aktif paylaşım | Harita görünür (eski) |
|---|---|
| 1 | %62 |
| 2 | %42 |
| 4 | %14 |

Ölçüm: 390×844 telefon görünümü, web demosu; ekranın 8 pt ızgarasında `elementFromPoint` haritaya mı düşüyor.
Üst çubuk, "bana paylaşanlar" şeridi ve sağ alttaki düğmeler de hesaba dahil.

Kök neden: **bilgi tekrarı + yığın düzeni**. Her kartta aynı başlık ("Konumun paylaşılıyor") ve aynı iki düğme vardı.
Asıl ayırt edici bilgi (kim, ne zamana kadar) kartın küçük bir kısmıydı. Aynı anda yalnızca bir paylaşımla
ilgilenildiği halde hepsi aynı anda açık duruyordu.

## 2. Çözüm: tek deste, üç görünüm

```
 ┌ arka katman 2 ───────────────────────┐   6 pt sırt (dokun → sonraki kart)
 ├ arka katman 1 ───────────────────────┤   6 pt sırt
 │              ▬▬  tutamaç              │   dokun / aşağı sürükle → küçült
 │ (◯AY) Ayşe Yılmaz           [2/4 ⌃]  │   ⌃ → "Tüm aktif paylaşımlar (4)"
 │       ● Konumun paylaşılıyor          │
 │       18:09'a kadar · 60 dk kaldı     │
 │ [  Süreyi uzat  ]  [   Durdur   ]     │   44 pt dokunma hedefi
 │   ─────── kalan süre çizgisi ───────  │
 └───────────────────────────────────────┘
```

| Görünüm | Ne zaman | Yükseklik (390×844) |
|---|---|---|
| **Deste** (varsayılan) | öndeki tek kart + en çok 2 arka katman | ~140 pt, kişi sayısından bağımsız |
| **Liste** | "2/4 ⌃" ya da desteyi yukarı sürükle (tek paylaşımda da: "1/1 ⌃") | ekranın en çok %28'i, içi kaydırılır |
| **İnce çubuk** | tutamaca dokun ya da aşağı sürükle | 44 pt ("4 paylaşım · ilk bitiş 18:09") |

### Kart içeriği
- Avatar + cinsiyet çerçevesi (kadın pembe `#EC4899`, erkek mavi `#3B82F6`, bilinmiyorsa gri). Birden çok alıcılı
  oturumda ilk avatar + "+2" rozeti. QR bağlantısında QR rozeti.
- Ad (tek satır), durum satırı (renkli nokta + "Konumun paylaşılıyor"; uyarı ya da hata varsa onun metni),
  zaman satırı ("18:09'a kadar · 60 dk kaldı").
- Düğmeler kartı büyütmez: "Süreyi uzat"a basınca aynı satır **+30 dk / +1 saat / ✕** çiplerine dönüşür.
  QR kartında "QR'ı göster" + "Durdur". Biten kartta tek "Kapat".
- Kalan süre ince bir çizgiyle gösterilir (eski 44 pt halka yerine): yeşil, son dakikalarda turuncu.

### Sıra ve odak (`shareDeckModel.buildDeckItems`)
1. Süresi dolmak üzere olanlar (en az kalan önde). Kart turuncuya döner, uzatma çipleri doğrudan görünür.
   Kitapçık görünürken ayrı "bitmek üzere" afişi gösterilmez (iki kez yer kaplamasın).
2. Başlatılamayanlar.
3. Sürenler, en kısa süresi kalan önde, süresiz en sonda.
4. Bitenler ("Kapat" bekler).

Yeni başlatılan paylaşım ve "bitmek üzere"ye geçen paylaşım **öne gelir**. Kitapçık küçültülmüşse ya da listedeyse
yeniden açılır. Kullanıcının seçtiği görünüm, rota kartından dönünce de korunur.

Kısa ekranda (yükseklik < 720 pt, ör. 375×667) kitapçık ince çubuk olarak başlar, çünkü açık deste orada haritayı
%65'in altına indirir. Yeni paylaşım çubuğu açmaz; yalnızca "bitmek üzere"ye geçen paylaşım desteyi açar.

Arkada bekleyen bir kart bitmek üzereyse sayfa düğmesi ("2/4 ⌃") ve o kartın katmanı turuncuya döner.

Tek paylaşımda da sayfa düğmesi ("1/1 ⌃") görünür ve yukarı sürükleme listeyi açar: paylaşım sürerken haritadaki
paylaş düğmesi gizli olduğundan "+ Yeni paylaşım"ın tek yeri listedir. Sola / sağa kaydırma tek kartta yapılmaz.

### Etkileşim
| Hareket | Sonuç |
|---|---|
| Öndeki kartı sola / sağa kaydır (64 pt ya da hızlı fırlatma) | sonraki / önceki kart (halka) |
| Sırta (arka katman şeridi) dokun | sonraki kart |
| "2/4 ⌃" ya da yukarı sürükle | Tüm aktif paylaşımlar listesi |
| Listede satıra dokun | o kart öne gelir, deste görünümüne dönülür |
| Tutamaca dokun ya da aşağı sürükle | ince çubuk |
| Çubuğa dokun ya da yukarı sürükle | deste |
| Listede "Tümünü durdur (n)" | ikinci adım: "n paylaşım durdurulsun mu?" ve altında [Evet, durdur] [Vazgeç]. Parmağın altına "Vazgeç" gelir; ilk 0,6 sn'deki onay sayılmaz, böylece çift dokunma yanlışlıkla durdurmaz. 6 sn'de kendiliğinden kapanır. Durdurulanlar listeden silinir. |

Sürükleme yalnızca belirgin harekette (10 pt, baskın eksen) devralınır; düğmelere dokunmak normal çalışır.
"Durdur" üstünde başlayan bir kaydırma paylaşımı durdurmaz (web'de sürükleme sonrası tıklama yutulur).
Tek kartta yatay sürükleme lastik gibi geri döner. Dokunma hedefleri: tutamaç 96×28 pt (+16 pt pay), sayfa düğmesi
ve kart düğmeleri 44 pt, sırt en az 22 pt.

### Animasyon
- Kaydırma: kart parmağı izler (hafif ±5° dönüş). Bırakınca 150 ms'de ekran dışına çıkar. Yeni öndeki kart
  arkadan gelir (ölçek 0,96 → 1, 6 pt aşağı, opaklık 0,5 → 1, yay).
- Kart kaydıkça birinci arka katman bir adım öne yaklaşır (genişler, iner).
- Görünüm geçişleri: 200 ms kayma (14 pt) ve belirme.
- RN `Animated` + `PanResponder`: native'de transform'lar yerel sürücüde, web'de aynı kod.

### Harita ve tema
- Kapsayıcı `pointerEvents="box-none"`: kartların dışındaki her nokta haritaya gider (kaydır, yakınlaştır, pine dokun).
- Kitapçığın yüksekliği haritanın alt dolgusuna yazılır. Konuma ortala ve pin sığdırma kartın üstünde kalır.
- Renkler tema belirteçlerinden (`surface`, `border`, `live`, `warning`, `danger`), açık ve koyu temada aynı derinlik:
  kart gölgesi + ince kenar, arka katmanlar daha hafif gölge ve opaklık.
- Masaüstü web'de kitapçık en çok 560 pt genişlikte, ortada.

## 3. Ekran kaplama

Haritanın görünür oranı (8 pt ızgara, `elementFromPoint`; son sürüm, açık tema; koyu temada aynı):

| Aktif paylaşım | Eski kartlar | Deste | İnce çubuk | Liste (geçici) |
|---|---|---|---|---|
| 1 | %62 | %67,4 | %76,9 | (liste yok) |
| 2 | %42 | %65,8 | %76,9 | %56 |
| 3 | — | %65,7 | %76,9 | %56 |
| 4 | %14 | %65,7 | %76,9 | %56 |
| 4, 430×932 | — | %68,4 | — | — |
| 4, 375×667 | — | %55,6 (bu yüzden çubukla başlar) | %70,5 | — |

Telefon 390×844 değilse aynı kural geçerli: deste yüksekliği pt cinsinden sabit, ekran büyüdükçe oran artar.

Neden sabit kalıyor: deste yüksekliği = tek kart + en çok 2×6 pt sırt. 2. kişiden sonra kişi sayısı yükseklik
eklemez; 5., 10. kişi de aynı yeri kaplar. Liste geçici bir görünümdür (satıra dokununca kapanır) ve ekranın en çok
%28'ini kaplar, fazlası kaydırılır. Haritanın kalan ~%20'sini kitapçık değil, üst çubuk, "bana paylaşanlar" şeridi ve
sağ alttaki düğmeler kaplar; kitapçığın kendi payı deste görünümünde ~%15, çubukta ~%5.

Tüm paylaşımlar durdurulunca kitapçık kaybolur. "Konumumu paylaş" düğmesi her zaman kitapçığın altında durur (2026-11-26, Erim: paylaşım sürerken de başka birini kolayca ekleyebilmeli); paylaşım sürerken bir boy küçüktür ve haritadaki "QR ile paylaş" kısayolu kalktı (QR, paylaşım sayfasının "Bağlantı (QR)" sekmesinde).
