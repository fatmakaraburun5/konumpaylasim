/**
 * Faz 9 web önizleme duman testi (Playwright, tek dosyalık `dist-web/index.html`).
 *
 *   EXPO_OFFLINE=1 CI=1 npm run web:export && node e2e/faz9-smoke.cjs
 *   SHOTS=/yol/ekran-goruntuleri PORT=4391 node e2e/faz9-smoke.cjs
 *
 * Denetlenenler: demo açılır; giriş + KVKK onayı (2026-11-26); ilk açılış rehberinde Rehber ve SMS adımları;
 * "FAZ 9 SENARYOLARI" paneli; Ayşe'nin anlık fotoğrafı → kişi kartında küçük resim + "dk kaldı"; 1 saat ileri
 * sarınca resim gider / "Süresi doldu"; Ayşe 200 m yaklaşınca "Neredeyse vardım"; Deniz Güvenli Dönüş başlatır →
 * süre bitince son uyarı → "Güvendeyim" bitirir; internet kesik + SOS → "SMS ile gönder" → simüle Mesajlar
 * ekranında koordinat + maps.google.com bağlantısı; Gizlilik Merkezi'nde Rehber ve SMS satırları; konsol hatası yok.
 * Denetim adımları deviceScaleFactor 1 ile; SHOTS verilirse insan için ekran görüntüleri deviceScaleFactor 2 ile.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(ROOT, process.env.DIST || 'dist-web');
const PORT = Number(process.env.PORT || 4391);
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const phone = (p) => p.getByTestId('demo-phone');
const phoneText = (p) => phone(p).innerText().catch(() => '');
const panel = (p) => p.getByTestId('faz9-section');

/** Telefonda metin görünene kadar bekler (true/false). */
async function waitPhone(p, re, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await phoneText(p);
    if (typeof re === 'string' ? t.includes(re) : re.test(t)) return true;
    await p.waitForTimeout(250);
  }
  return false;
}

/** Telefonda görünen (en sondaki) metne/etikete dokunur. */
async function tapPhone(p, text, opts = {}) {
  const loc = phone(p).getByText(text, { exact: opts.exact ?? true }).filter({ visible: true }).last();
  await loc.click({ timeout: opts.timeout ?? 8000 });
}
async function tapPhoneLabel(p, label, opts = {}) {
  const loc = phone(p).getByLabel(label, { exact: opts.exact ?? true }).filter({ visible: true }).last();
  await loc.click({ timeout: opts.timeout ?? 8000 });
}
/** Demo panelindeki satır (erişilebilirlik etiketi = satır başlığı). */
async function runRow(p, title) {
  const row = p.getByLabel(title, { exact: true }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await p.waitForTimeout(400);
  return (await p.getByTestId('demo-feedback').innerText().catch(() => '')).trim();
}

async function shot(p, name) {
  if (!SHOTS) return;
  await p.waitForTimeout(300);
  await phone(p).screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function login(p) {
  await p.goto(`${ORIGIN}/`);
  await p.getByPlaceholder('5XX XXX XX XX').fill('532 123 45 67');
  await p.getByText('Kod gönder', { exact: true }).click();
  await p.locator('input[autocomplete="sms-otp"]').fill('123456', { timeout: 15000 });
  await p.getByPlaceholder('Ad Soyad').fill('Deniz Kaya', { timeout: 15000 });
  await phone(p).getByRole('radio', { name: 'Erkek' }).click();
  await tapPhone(p, 'Devam');
  const scroll = p.getByTestId('consent-scroll');
  await scroll.waitFor({ timeout: 15000 });
  await scroll.evaluate((el) => {
    const s = el.scrollHeight ? el : el.querySelector('*');
    el.scrollTop = el.scrollHeight;
    if (s) s.dispatchEvent(new Event('scroll'));
  });
  await p.waitForTimeout(500);
  await p.getByTestId('consent-accept').click();
}

/** İlk açılış rehberini adım adım geçer; görülen adımları döndürür. */
async function walkOnboarding(p, { onStep } = {}) {
  const seen = [];
  for (let i = 0; i < 14; i++) {
    const ob = p.getByTestId('onboarding');
    if (!(await ob.isVisible().catch(() => false))) {
      await p.waitForTimeout(800);
      if (!(await ob.isVisible().catch(() => false))) break;
    }
    const header = ob.locator('[data-testid^="onboarding-step-"]').first();
    const id = ((await header.getAttribute('data-testid').catch(() => '')) || '').replace('onboarding-step-', '');
    if (!id) break;
    if (seen[seen.length - 1] !== id) seen.push(id);
    if (onStep) await onStep(id);
    await p.getByTestId('onboarding-primary').click();
    await p.waitForTimeout(500);
    // Simüle sistem izin istemi: "İzin Ver" / "Uygulamayı Kullanırken İzin Ver" / "Tüm Kişilere İzin Ver" ...
    for (let k = 0; k < 3; k++) {
      const allow = phone(p).getByText(/^(İzin Ver|Uygulamayı Kullanırken İzin Ver|Tüm Kişilere İzin Ver|Her Zaman İzin Ver|Her Zaman Kullan|Tamam)$/).filter({ visible: true }).last();
      if (await allow.isVisible().catch(() => false)) {
        await allow.click().catch(() => undefined);
        await p.waitForTimeout(400);
      } else break;
    }
  }
  return seen;
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`${DIST}/index.html yok: önce npm run web:export`);
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: SHOTS ? 2 : 1,
      locale: 'tr-TR',
      timezoneId: 'Europe/Istanbul',
    });
    const p = await context.newPage();
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text().slice(0, 300));
    });
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

    // 1) açılış + giriş + onay
    await p.goto(`${ORIGIN}/`);
    check('demo açılır (giriş ekranı)', await waitPhone(p, 'Telefon numaran', 15000));
    await login(p);

    // 2) ilk açılış rehberi: Rehber + SMS adımları
    const steps = await walkOnboarding(p, {
      onStep: async (id) => {
        if (id === 'contacts') {
          check('Rehber adımı açıklaması', /Rehber/.test(await phoneText(p)));
          await shot(p, '01-onboarding-rehber');
        }
        if (id === 'sms') {
          check('SMS adımı açıklaması + onay kutusu', /SMS/.test(await phoneText(p)) && (await p.getByTestId('onboarding-sms-consent').isVisible().catch(() => false)));
          await shot(p, '02-onboarding-sms');
          // açık onay kutusunu işaretle → SMS yedeği açılır (numara sonra panel kısayoluyla)
          const cb = p.getByTestId('onboarding-sms-consent');
          if (await cb.isVisible().catch(() => false)) await cb.click();
        }
      },
    });
    check('ilk açılış: Rehber adımı', steps.includes('contacts'), steps.join(' → '));
    check('ilk açılış: SMS adımı', steps.includes('sms'));
    check('harita açılır', await waitPhone(p, /Ayşe/, 15000));

    // 3) Faz 9 paneli
    check('FAZ 9 SENARYOLARI paneli', (await panel(p).innerText().catch(() => '')).includes('FAZ 9 SENARYOLARI'));

    // 4) Ayşe anlık fotoğraf → kişi kartında küçük resim + "dk kaldı"
    const fb1 = await runRow(p, 'Ayşe anlık fotoğraf paylaşsın');
    check('Ayşe fotoğraf ekledi', /fotoğraf ekledi/.test(fb1), fb1);
    await p.waitForTimeout(1500);
    await tapPhone(p, 'Ayşe', { exact: false });
    const cardHasLeft = await waitPhone(p, /dk kaldı/, 10000);
    check('kişi kartında "dk kaldı"', cardHasLeft);
    const proofRow = p.getByTestId('eta-card-proof');
    check('kişi kartında fotoğraf satırı', await proofRow.isVisible().catch(() => false));
    let thumbImgs = 0;
    for (let i = 0; i < 20 && thumbImgs === 0; i++) {
      thumbImgs = await proofRow.locator('img').count().catch(() => 0);
      if (!thumbImgs) await p.waitForTimeout(250);
    }
    check('kişi kartında fotoğraf küçük resmi', thumbImgs > 0, `img=${thumbImgs}`);
    await shot(p, '03-ayse-foto-kart');
    await proofRow.click();
    const viewer = p.getByTestId('proof-viewer');
    await viewer.waitFor({ timeout: 8000 }).catch(() => undefined);
    await p.waitForTimeout(800);
    check('fotoğraf görüntüleyici açılır (resim + kalan süre)', (await viewer.locator('img').count()) > 0 && /kaldı/.test(await viewer.innerText().catch(() => '')));
    await shot(p, '04-foto-goruntuleyici');

    // 5) 1 saat ileri sar → resim gider / süresi doldu
    const fb2 = await runRow(p, 'Fotoğrafların süresini 1 saat ileri sar');
    check('fotoğraf süresi ileri sarıldı', /süresi doldu|silindi/.test(fb2), fb2);
    await p.waitForTimeout(1500);
    const vText = await viewer.innerText().catch(() => '');
    check('görüntüleyicide "süresi doldu", resim yok', /süresi doldu/i.test(vText) && (await viewer.locator('img').count()) === 0, vText.replace(/\s+/g, ' ').slice(0, 120));
    await shot(p, '05-foto-suresi-doldu');
    await tapPhoneLabel(p, 'Fotoğrafı kapat').catch(() => undefined);
    await p.waitForTimeout(500);
    check('kişi kartından fotoğraf kalktı', !(await proofRow.isVisible().catch(() => false)) && !/dk kaldı/.test(await phoneText(p)));

    // 6) Ayşe 200 m yaklaşma
    const fb3 = await runRow(p, 'Ayşe hedefine 200 m yaklaşsın');
    check('yaklaşma bildirimi gönderildi', /Neredeyse vardım/.test(fb3), fb3);
    check('telefonda "Neredeyse vardım"', await waitPhone(p, /Neredeyse vard/, 8000));
    await shot(p, '06-ayse-neredeyse-vardi');
    await tapPhone(p, 'Rotayı kapat').catch(() => undefined);
    await tapPhoneLabel(p, 'Kapat').catch(() => undefined);
    await p.waitForTimeout(500);

    // 7) Güvenli Dönüş (Deniz): Ev bölgesi + acil kişisi → başlat → süreyi bitir → son uyarı → "Güvendeyim"
    const fbHome = await runRow(p, 'Ev bölgemi buraya kaydet (demo)');
    check('Ev bölgesi kaydedildi (hedef)', fbHome.length > 0, fbHome);
    await tapPhoneLabel(p, 'Güvenli Dönüş');
    await p.getByTestId('safe-return-screen').waitFor({ timeout: 8000 });
    await p.getByTestId('safe-return-duration-15').click().catch(() => undefined);
    await tapPhone(p, 'Acil durum kişilerini düzenle');
    await p.waitForTimeout(600);
    await tapPhone(p, 'Ayşe Yılmaz', { exact: false });
    await tapPhone(p, 'Kaydet');
    await p.waitForTimeout(1000);
    await shot(p, '07-guvenli-donus-kurulum');
    await p.getByTestId('safe-return-start').click();
    const active = await p.getByTestId('safe-return-active').waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('Güvenli Dönüş başladı (geri sayım)', active, active ? '' : (await p.getByTestId('safe-return-error').innerText().catch(() => '')));
    await shot(p, '08-guvenli-donus-aktif');
    const fb4 = await runRow(p, 'Güvenli Dönüş: süreyi bitir (son uyarı)');
    check('süre bitirildi', /Süre doldu|son uyarı/i.test(fb4), fb4);
    const fw = p.getByTestId('safe-return-final-warning');
    const fwVisible = await fw.waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('son uyarı ekranı görünür', fwVisible);
    await shot(p, '09-son-uyari');
    if (fwVisible) await fw.getByLabel('Güvendeyim', { exact: true }).click();
    const fwGone = await fw.waitFor({ state: 'hidden', timeout: 8000 }).then(() => true, () => false);
    check('"Güvendeyim" son uyarıyı kapatır', fwGone);
    await p.waitForTimeout(800);
    const snapSr = await p.evaluate(() => window.__konumDemo.snapshot().f9?.mySafeReturn?.status ?? null);
    check('sunucuda zamanlayıcı "güvende"', snapSr === 'checked_in', String(snapSr));
    // ekrandan geri (haritaya)
    if (await p.getByTestId('safe-return-screen').isVisible().catch(() => false)) await tapPhoneLabel(p, 'Geri').catch(() => undefined);
    await p.waitForTimeout(500);

    // 8) çevrimdışı SOS → SMS
    const fb5 = await runRow(p, 'SMS yedeğini demo numarasıyla aç');
    check('SMS yedeği açık', /SMS yedeği açık · [1-9]/.test(fb5), fb5);
    const fb6 = await runRow(p, 'İnterneti kes + SOS (SMS yedeği)');
    check('internet kesildi', /İnternet kesildi/.test(fb6), fb6);
    const sos = p.getByTestId('sos-button');
    const box = await sos.boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    await p.waitForTimeout(3500);
    await p.mouse.up();
    await p.getByTestId('sos-countdown').waitFor({ timeout: 8000 });
    const sendNow = p.getByTestId('sos-countdown').getByLabel('Hemen gönder', { exact: true });
    if (await sendNow.isVisible().catch(() => false)) await sendNow.click().catch(() => undefined);
    const smsBtn = p.getByTestId('sos-countdown').getByText(/^SMS ile gönder/).last();
    const offerSms = await smsBtn.waitFor({ timeout: 25000 }).then(() => true, () => false);
    check('SOS çevrimdışı → "SMS ile gönder"', offerSms);
    await shot(p, '10-cevrimdisi-sos');
    if (offerSms) await smsBtn.click();
    const composer = p.getByTestId('sms-composer');
    const composerOk = await composer.waitFor({ timeout: 8000 }).then(() => true, () => false);
    const body = composerOk ? await p.getByTestId('sms-body').innerText() : '';
    check('Mesajlar ekranı açılır', composerOk);
    check('SMS gövdesi: koordinat', /\d{1,2}\.\d{4,},\s?\d{1,3}\.\d{4,}/.test(body), body.replace(/\s+/g, ' ').slice(0, 160));
    check('SMS gövdesi: maps.google.com bağlantısı', /maps\.google\.com/.test(body));
    check('SMS gövdesi: pil %', /%\s?\d{1,3}|\d{1,3}\s?%/.test(body));
    await shot(p, '11-sms-mesajlar');
    if (composerOk) await p.getByTestId('sms-send').click();
    await p.waitForTimeout(800);
    const lastSms = await p.evaluate(() => window.__konumDemo.snapshot().f9?.lastSms?.result ?? null);
    check('demo SMS günlüğü: gönderildi', lastSms === 'sent', String(lastSms));
    // internet dönünce bekleyen SOS aynı op_id ile uygulama üzerinden de gider → "Güvendeyim" ile kapat
    const fb8 = await runRow(p, 'İnterneti geri getir');
    check('internet geri geldi', /geri geldi/.test(fb8), fb8);
    const activeSos = p.getByTestId('sos-active-screen');
    const sosDelivered = await activeSos.waitFor({ timeout: 25000 }).then(() => true, () => false);
    check('internet dönünce SOS sunucuya ulaştı (etkin SOS ekranı)', sosDelivered);
    if (sosDelivered) {
      await activeSos.getByLabel('Güvendeyim', { exact: true }).click();
      await activeSos.getByLabel('Evet, güvendeyim', { exact: true }).click();
      await p.waitForTimeout(1200);
      const closeBtn = activeSos.getByLabel(/^(Kapat|Haritaya dön)$/);
      if (await closeBtn.first().isVisible().catch(() => false)) await closeBtn.first().click().catch(() => undefined);
    }
    for (const t of ['Kapat', 'İptal']) {
      const b = p.getByTestId('sos-countdown').getByLabel(t, { exact: true });
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => undefined);
    }
    await p.waitForTimeout(600);
    check('SOS ekranları kapandı', !(await p.getByTestId('sos-countdown').isVisible().catch(() => false)) && !(await activeSos.isVisible().catch(() => false)));

    // 9) İzin & Gizlilik Merkezi: Rehber + SMS satırları
    await tapPhoneLabel(p, 'Hesap menüsü', { exact: false });
    await tapPhone(p, 'İzin ve Gizlilik');
    const perms = p.getByTestId('privacy-permissions');
    await perms.waitFor({ timeout: 8000 });
    const rowC = await p.getByTestId('privacy-row-contacts').innerText().catch(() => '');
    const rowS = await p.getByTestId('privacy-row-sms').innerText().catch(() => '');
    check('Gizlilik Merkezi: Rehber satırı', /Rehber/.test(rowC), rowC.replace(/\s+/g, ' '));
    check('Gizlilik Merkezi: SMS satırı', /SMS/.test(rowS), rowS.replace(/\s+/g, ' '));
    await p.getByTestId('privacy-row-sms').scrollIntoViewIfNeeded();
    await shot(p, '12-gizlilik-merkezi');
    await tapPhoneLabel(p, 'Geri').catch(() => undefined);
    await p.waitForTimeout(800);

    // 10) Ayşe Güvenli Dönüş başlatır ve yanıt vermez → bana SOS (kaynak: Güvenli Dönüş)
    const fb7 = await runRow(p, 'Ayşe Güvenli Dönüş başlatsın ve yanıt vermesin');
    check('Ayşe Güvenli Dönüş başlattı', /Güvenli Dönüş başlattı/.test(fb7), fb7);
    const banner = p.locator('[data-testid^="sos-banner-"]').first();
    const alarm = await banner.waitFor({ timeout: 75000 }).then(() => true, () => false);
    const bText = alarm ? await banner.innerText().catch(() => '') : '';
    check('Ayşe yanıt vermeyince alarm (SOS) geldi', alarm, bText.replace(/\s+/g, ' ').slice(0, 120));
    if (alarm) {
      await p.waitForTimeout(1000);
      if (!(await p.getByTestId('sos-incoming-screen').isVisible().catch(() => false))) await banner.click({ timeout: 5000 }).catch(() => undefined);
      const inc = p.getByTestId('sos-incoming-safe-return');
      const incOk = await inc.waitFor({ timeout: 8000 }).then(() => true, () => false);
      const incText = incOk ? await p.getByTestId('sos-incoming-screen').innerText() : '';
      check('gelen SOS: Güvenli Dönüş kaynağı + son konum + pil', incOk && /Güvenli Dönüş/.test(incText) && /%\s?\d+/.test(incText), incText.replace(/\s+/g, ' ').slice(0, 160));
    }
    await shot(p, '13-ayse-guvenli-donus-alarm');
  } finally {
    await browser.close();
    server.close();
  }
  const relevant = errors.filter((e) => !/favicon|DevTools/.test(e));
  check('konsol hatası yok', relevant.length === 0, relevant.slice(0, 3).join(' | '));
  console.log(results.join('\n'));
  console.log(failures ? `\n${failures} denetim BAŞARISIZ` : `\nTümü geçti (${results.length} denetim)`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log(results.join('\n'));
  process.exit(1);
});
