/**
 * Faz 10 web önizleme duman testi (Playwright, tek dosyalık `dist-web/index.html`).
 *
 *   EXPO_OFFLINE=1 CI=1 npm run web:export && node e2e/faz10-smoke.cjs
 *   SHOTS=/yol/ekran-goruntuleri node e2e/faz10-smoke.cjs
 *
 * Denetlenenler: yakın buluşma → "Kim ne kadar uzakta?" şeridi (kart + harita); "Takvime Ekle" → resmi onay →
 * simüle iOS izni → simüle Takvim kartı; kurtarma e-postası; "Yeni telefona geç" → SMS + e-posta kodu → Aktif
 * Cihazlar → eski cihaz kapatılır, eski telefon yayını durur; konsol hatası yok.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(ROOT, process.env.DIST || 'dist-web');
const PORT = Number(process.env.PORT || 4392);
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
const panel = (p) => p.getByTestId('faz10-section');

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
      const allow = phone(p).getByText(/^(İzin Ver|Uygulamayı Kullanırken İzin Ver|Tüm Kişilere İzin Ver|Her Zaman İzin Ver|Her Zaman Kullan|Etkinlik Eklemeye İzin Ver|Tamam)$/).filter({ visible: true }).last();
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
  const snap = (p) => p.evaluate(() => window.__konumDemo.snapshot().f10);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: SHOTS ? 2 : 1, locale: 'tr-TR', timezoneId: 'Europe/Istanbul' });
    const p = await context.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

    await p.goto(`${ORIGIN}/`);
    check('demo açılır', await waitPhone(p, 'Telefon numaran', 15000));
    await login(p);
    const steps = await walkOnboarding(p, {
      onStep: async (id) => {
        if (id === 'calendar') await shot(p, '00-onboarding-takvim');
        const cb = p.getByTestId('onboarding-sms-consent');
        if (id === 'sms' && (await cb.isVisible().catch(() => false))) await cb.click();
      },
    });
    check('ilk açılış: Takvim adımı', steps.includes('calendar'), steps.join(' → '));
    check('harita açılır', await waitPhone(p, /Ayşe/, 15000));
    check('FAZ 10 SENARYOLARI paneli', (await panel(p).innerText().catch(() => '')).includes('FAZ 10 SENARYOLARI'));

    // 1) yakın buluşma + ETA şeridi
    const fb1 = await runRow(p, 'Ayşe 40 dk sonrası için buluşma kursun');
    check('buluşma kesinleşti', /Kesinleşti/.test(fb1), fb1);
    const strip = p.getByTestId('eta-strip').filter({ visible: true }).first();
    const stripOk = await strip.waitFor({ timeout: 10000 }).then(() => true, () => false);
    const stripText = stripOk ? await strip.innerText() : '';
    check('etkinlik kartında "Kim ne kadar uzakta?"', stripOk && /\d+ dk|Vardı/.test(stripText), stripText.replace(/\s+/g, ' ').slice(0, 140));
    await shot(p, '01-etkinlik-eta-seridi');

    // 2) Takvime Ekle → onay → iOS izni → simüle Takvim
    // rehberde izin verildi; resmi onay + iOS izin akışını göstermek için izni sıfırla
    const fbr = await runRow(p, 'Takvim iznini sıfırla');
    check('takvim izni sıfırlandı', /sıfırlandı/.test(fbr), fbr);
    await p.waitForTimeout(600);
    await p.getByTestId('calendar-add').scrollIntoViewIfNeeded();
    await shot(p, '02-takvime-ekle-kart');
    await p.getByTestId('calendar-add').click();
    const consent = await p.getByTestId('calendar-consent').waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('resmi takvim onay sayfası', consent);
    await shot(p, '03-takvim-onay');
    if (consent) await p.getByTestId('calendar-consent-accept').click();
    const allow = phone(p).getByText('Etkinlik Eklemeye İzin Ver', { exact: true }).filter({ visible: true }).last();
    const prompt = await allow.waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('simüle iOS takvim izni', prompt);
    await shot(p, '04-ios-takvim-izni');
    if (prompt) await allow.click();
    const sheet = p.getByTestId('calendar-sim-added');
    const added = await sheet.waitFor({ timeout: 8000 }).then(() => true, () => false);
    const sheetText = added ? await sheet.innerText() : '';
    check('simüle Takvim: etkinlik eklendi', added && /Moda Sahili/.test(sheetText) && /maps/.test(sheetText), sheetText.replace(/\s+/g, ' ').slice(0, 160));
    await shot(p, '05-takvim-eklendi');
    if (added) await p.getByTestId('calendar-sim-done').click();
    check('kartta "Takvimde"', await p.getByTestId('calendar-added').waitFor({ timeout: 8000 }).then(() => true, () => false));

    // 3) Ayşe vardı → şeritte "Vardı"
    const fb2 = await runRow(p, 'Ayşe mekana varsın');
    check('Ayşe vardı', /vardı/.test(fb2), fb2);
    let st2 = '';
    for (let i = 0; i < 24 && !/Vardı/.test(st2); i++) { await p.waitForTimeout(250); st2 = await strip.innerText().catch(() => ''); }
    check('şeritte "Ayşe · Vardı"', /Vardı/.test(st2), st2.replace(/\s+/g, ' ').slice(0, 140));

    // haritada da şerit
    await tapPhoneLabel(p, 'Geri').catch(() => undefined);
    await p.waitForTimeout(1200);
    check('haritada ETA şeridi', await p.getByTestId('eta-strip').filter({ visible: true }).first().isVisible().catch(() => false));
    await shot(p, '06-harita-eta-seridi');

    // 4) Güvenlik: kurtarma e-postası
    await tapPhoneLabel(p, 'Hesap menüsü', { exact: false });
    await tapPhone(p, 'Profili düzenle');
    await p.getByTestId('profile-security').click({ timeout: 8000 });
    await p.getByTestId('security-screen').waitFor({ timeout: 8000 });
    await p.getByTestId('recovery-email-input').fill('deniz.kaya@gmail.com');
    await p.getByTestId('recovery-email-send').click();
    await p.getByTestId('recovery-code-input').waitFor({ timeout: 8000 });
    const code1 = (await snap(p))?.lastCode?.code;
    await p.getByTestId('recovery-code-input').fill(String(code1));
    await p.waitForTimeout(300);
    await tapPhone(p, 'Doğrula', { exact: true }).catch(() => undefined);
    await p.waitForTimeout(1200);
    const rs = await p.getByTestId('recovery-status').innerText().catch(() => '');
    check('kurtarma e-postası doğrulandı', (await snap(p))?.recovery?.email?.verified_at > 0, rs);
    await shot(p, '07-guvenlik-kurtarma');

    // 5) yeni telefona geç
    const fb3 = await runRow(p, 'Yeni telefona geç (iPhone 16)');
    check('eski telefon yayında', /yayınlamaya devam/.test(fb3), fb3);
    check('yeni telefon: giriş ekranı', await waitPhone(p, 'Telefon numaran', 15000));
    await p.getByPlaceholder('5XX XXX XX XX').fill('532 123 45 67');
    await p.getByText('Kod gönder', { exact: true }).click();
    await p.locator('input[autocomplete="sms-otp"]').fill('123456', { timeout: 15000 });
    const sf = p.getByTestId('second-factor-code');
    const sfOk = await sf.waitFor({ timeout: 15000 }).then(() => true, () => false);
    check('ikinci adım: e-posta kodu ekranı', sfOk);
    await shot(p, '08-yeni-telefon-eposta-kodu');
    const code2 = (await snap(p))?.lastCode?.code;
    if (sfOk) await sf.fill(String(code2));
    const secOk = await p.getByTestId('security-migration').waitFor({ timeout: 20000 }).then(() => true, () => false);
    check('yeni telefon: taşınan veriler + Aktif Cihazlar', secOk);
    await shot(p, '09-aktif-cihazlar');
    const o1 = (await snap(p))?.oldPhone;
    check('eski telefon hâlâ yayında', o1?.status === 'active', JSON.stringify(o1));

    // 6) eski cihazı kapat
    await p.getByTestId('device-revoke-open').first().click();
    await p.getByTestId('device-revoke-sheet').waitFor({ timeout: 8000 });
    await shot(p, '10-eski-cihazi-kapat-onay');
    await p.getByTestId('device-revoke-confirm').click();
    await p.getByTestId('security-toast').waitFor({ timeout: 8000 }).catch(() => undefined);
    let o2 = null;
    for (let i = 0; i < 60; i++) { o2 = (await snap(p))?.oldPhone; if (o2?.stopped) break; await p.waitForTimeout(500); }
    check('eski oturum kapatıldı', o2?.status === 'revoked', JSON.stringify(o2));
    check('eski telefon yayını durdu', !!o2?.stopped, JSON.stringify(o2));
    await shot(p, '11-eski-cihaz-kapatildi');
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
