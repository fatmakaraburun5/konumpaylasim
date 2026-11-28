# SOS düğmesi: basılı tutma sağlamlaştırması

Kod: `apps/mobile/src/features/sos/SosHoldButton.tsx`, `holdModel.ts`, `SosLauncher.tsx`.

## Neden bozuluyordu

1. **Metin seçimi / bağlam menüsü (web / WebView demo APK).** "SOS" yazısı react-native-web'de seçilebilir bir
   `<div>` idi. Uzun basışta tarayıcı metni seçmeye ve bağlam menüsünü açmaya çalışıyor; bu da `contextmenu` /
   `selectionchange` / `pointercancel` üretip basılı tutmayı kesiyordu.
2. **Jest devralma.** Pressable varsayılanı `cancelable = true`: başka bir dokunma isteği (ikinci parmak, üst
   kaydırma, react-native-web'de herhangi bir başka öğe) basışı sonlandırıyor → `onPressOut` → akış `idle`. Üstelik
   react-native-web Pressable'ı `cancelable` özelliğini hiç iletmiyor. Parmak düğmeden ~20 px kayınca da
   (`pressRetentionOffset` varsayılanı) basış bitiyordu.
3. **Başa sarma.** İlerleme üst bileşendeki (`SosLauncher`) akış durumundan ve 32 ms'lik `setInterval` saatinden
   hesaplanıyordu; her erken `press_out` durumu anında `idle` yapıp halkayı sıfırlıyordu.

## Çözüm

- **Seçim yok:** "SOS" `selectable={false}`, dokunma almayan katmanda. Web'de kökte `user-select: none`,
  `-webkit-touch-callout: none`, `touch-action: none`; `contextmenu` / `selectstart` / `dragstart` engellenir.
- **İzole jest:** native'de `cancelable={false}` (üst kaydırma/sürükleme devralamaz), `pressRetentionOffset` 56,
  `hitSlop` 12. Web'de Pressable'ın yanıtlayıcı sistemi yerine doğrudan işaretçi olayları + `setPointerCapture`
  (başka dokunuşlar ve bağlam menüsü basışı kesemez; 56 px dışına çıkınca bırakılmış sayılır).
- **Kararlı ilerleme:** başlangıç anı bileşen içindeki ref'te; ilerleme her `requestAnimationFrame` karesinde
  zamandan hesaplanır. Üst bileşen yeniden çizilse de (harita, tema, kitapçık) ilerleme sürer.
- **Akıcı geri sarma:** erken bırakmada 0'a 300 ms × ilerleme sürede iner; bu sırada yeniden basılırsa kalan
  yerden devam eder. "Göndermek için basılı tut" ipucu görünür.
- **Tek tetikleme:** %100'de `onTrigger` bir kez; düğme kilitlenir (geri sayım / gönderim / aktif SOS sürerken
  `locked`), `SosLauncher` `triggering` ref'i ve 1,5 sn bekleme ikinci tetiklemeyi engeller. `sosStore.send` zaten
  tek uçuşlu ve aynı `op_id` ile yeniden dener (sunucu bir kez uygular).
- **Geri bildirim:** basışta orta titreşim (iOS/Android), tetiklemede güçlü titreşim (`expo-haptics` hata bildirimi;
  Android ve web'de ek titreşim deseni). Sonrası değişmedi: 5 sn geri sayım → tam konum, adres, pil, rota → alarm
  sesi kanalı → internet yoksa SMS yedeği.

## Kontrol listesi (cihazda)

| Senaryo | Beklenen |
| --- | --- |
| Hızlı dokunuş (< 1,5 sn) | Tetiklenmez; halka akıcı geri sarılır; "Göndermek için basılı tut" ipucu |
| Basılı tut, parmak kenara doğru kayar (≤ ~56 px) | İlerleme sürer, %100'de tetikler |
| Parmak düğmeden çok uzağa kayar | Bırakılmış sayılır, geri sarar |
| Basılı tutarken diğer parmakla haritayı kaydır / yakınlaştır | SOS ilerlemesi kesilmez |
| Basılı tutarken kitapçık kartı / bildirim / tema değişir (yeniden çizim) | İlerleme kesilmez |
| Uzun basış (Android / iOS / WebView) | Metin seçici, büyüteç ya da kopyala menüsü AÇILMAZ |
| %100 | Tek güçlü titreşim, geri sayım ekranı bir kez açılır |
| Geri sayımda "Hemen gönder"e çift dokunuş | Tek SOS paketi, "Uyarı gönderildi" |
| İptal sonrası hemen yeniden basış | 1,5 sn bekleme; sonra normal çalışır |
| Acil kişi yok | %100'de kişi seçimi açılır; "Kaydet ve devam et" → geri sayım |
| Ekran okuyucu "Etkinleştir" eylemi | Doğrudan geri sayım (tek sefer) |
| İnternet yok | Geri sayım sonrası "SMS ile gönder (N kişi)" |

Otomatik: `apps/mobile/e2e/sos-hold-smoke.cjs` (dokunmatik CDP; kayma + bağlam menüsü + yeniden çizim, çift tık),
`__tests__/faz4Ui.test.ts` (holdModel), `e2e/faz9-smoke.cjs` (çevrimdışı SOS → SMS).
