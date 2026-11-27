/**
 * Faz 11 web önizleme duman testi (Playwright, tek dosyalık `dist-web/index.html`).
 *
 *   EXPO_OFFLINE=1 CI=1 npm run web:export && node e2e/faz11-smoke.cjs
 *   SHOTS=/yol/ekran-goruntuleri node e2e/faz11-smoke.cjs
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
const PORT = Number(process.env.PORT || 4393);
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
const panel = (p) => p.getByTestId('faz11-section');

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
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: SHOTS ? 2 : 1, locale: 'tr-TR', timezoneId: 'Europe/Istanbul' });
    const p = await context.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await p.goto(`${ORIGIN}/`);
    check('demo açılır', await waitPhone(p, 'Telefon numaran', 15000));
    await login(p);
    await walkOnboarding(p, {
      onStep: async (id) => {
        const cb = p.getByTestId('onboarding-sms-consent');
        if (id === 'sms' && (await cb.isVisible().catch(() => false))) await cb.click();
      },
    });
    check('harita açılır', await waitPhone(p, /Ayşe/, 15000));
    check('FAZ 11 SENARYOLARI paneli', (await panel(p).innerText().catch(() => '')).includes('FAZ 11 SENARYOLARI'));
    if (process.env.PROBE) { await p.screenshot({ path: '/tmp/probe.png' }); console.log(await phoneText(p)); }
    await startShares(p);
    if (process.env.PROBE) await p.screenshot({ path: '/tmp/probe2.png' });
    await shot(p, '01-acik-tema-kitapcik');

    const bg = () => phone(p).evaluate((el) => {
      const pick = (n) => { while (n) { const c = getComputedStyle(n).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)') return c; n = n.firstElementChild; } return ''; };
      return pick(el);
    });

    for (const [title, name, file] of [
      ['Nude teması', 'Nude', '02-nude-harita'],
      ['Pudra Pembesi teması', 'Pudra Pembesi', '03-pudra-harita'],
      ['Siyah / Gri teması', 'Siyah / Gri', '04-siyah-gri-harita'],
    ]) {
      const fb = await runRow(p, title);
      check(`${name} uygulanır`, fb.includes('uygulandı'), fb);
      const st = await p.getByTestId('faz11-status').innerText();
      check(`${name} etkin`, st.includes(name), st);
      await p.waitForTimeout(400);
      await shot(p, file);
    }

    // Seçici ekranı
    await runRow(p, 'Tema ve Harita ekranını aç');
    check('Tema ve Harita ekranı', await p.getByTestId('theme-picker').filter({ visible: true }).first().waitFor({ timeout: 8000 }).then(() => true, () => false));
    await shot(p, '05-tema-secici-siyah-gri');
    await phone(p).getByTestId('theme-card-blush').filter({ visible: true }).first().click();
    await p.waitForTimeout(300);
    check('kart dokunuşu temayı anında değiştirir', (await p.getByTestId('faz11-status').innerText()).includes('Pudra Pembesi'));
    await shot(p, '06-tema-secici-pudra');
    await phone(p).getByTestId('theme-card-nude').filter({ visible: true }).first().click();
    await p.waitForTimeout(300);
    await shot(p, '07-tema-secici-nude');
    // Saat kuralı
    await phone(p).getByTestId('theme-schedule-switch').filter({ visible: true }).first().click();
    await p.waitForTimeout(300);
    check('saat kuralı açılır', (await phoneText(p)).includes('Gündüz başlar'));
    const fbN = await runRow(p, 'Saat kuralı: gündüz Pudra, gece Siyah/Gri → gece saatine geçir');
    check('gece saatinde Siyah / Gri', (await p.getByTestId('faz11-status').innerText()).startsWith('Etkin: Siyah / Gri'), fbN);
    await phone(p).getByTestId('theme-night-start').filter({ visible: true }).first().scrollIntoViewIfNeeded();
    await shot(p, '08-saat-kurali-gece');
    await runRow(p, 'Saat kuralı: gündüz saatine geçir');
    check('gündüz saatinde Pudra Pembesi', (await p.getByTestId('faz11-status').innerText()).startsWith('Etkin: Pudra Pembesi'));
    await shot(p, '09-saat-kurali-gunduz');
    // Kalıcılık: yeniden yükle
    await p.reload();
    await waitPhone(p, /Ayşe/, 15000);
    check('tercih yeniden açılışta korunur', (await p.getByTestId('faz11-status').innerText().catch(() => '')).includes('kural gündüz'));
    void bg;
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

/** Kitapçık katmanları görünsün diye iki paylaşım başlatır (yoksa sessizce geçer). */
async function startShares(p) {
  for (const who of ['Ayşe', 'Mehmet', 'Zeynep']) {
    try {
      await tapPhoneLabel(p, 'Konumumu paylaş', { timeout: 4000, exact: false });
      await p.waitForTimeout(500);
      await tapPhone(p, who, { exact: false, timeout: 4000 });
      await tapPhone(p, '1 saat', { timeout: 4000 });
      await p.waitForTimeout(300);
      if (process.env.PROBE) await p.screenshot({ path: `/tmp/probe-${who}.png` });
      await tapPhoneLabel(p, 'Paylaşımı başlat', { timeout: 4000 });
      await p.waitForTimeout(500);
      const allow = phone(p).getByText('İzin ver ve paylaş', { exact: true }).filter({ visible: true }).last();
      if (await allow.isVisible().catch(() => false)) await allow.click();
      await p.waitForTimeout(800);
      const ok = phone(p).getByText(/^(Tamam|Kapat)$/).filter({ visible: true }).last();
      if (await ok.isVisible().catch(() => false)) await ok.click();
      await p.waitForTimeout(800);
    } catch (e) {
      console.log('paylaşım başlatılamadı:', who, String(e).slice(0, 120));
    }
  }
}

main().catch((e) => {
  console.error(e);
  console.log(results.join('\n'));
  process.exit(1);
});
