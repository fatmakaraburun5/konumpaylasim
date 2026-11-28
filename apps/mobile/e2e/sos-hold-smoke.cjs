/**
 * SOS basılı tutma duman testi (Playwright, tek dosyalık `dist-web/index.html`).
 *
 *   EXPO_OFFLINE=1 CI=1 npm run web:export && node e2e/sos-hold-smoke.cjs
 *   SHOTS=/yol/ekran-goruntuleri node e2e/sos-hold-smoke.cjs
 *
 * Dokunmatik (CDP touch) senaryolar: hızlı dokunuş tetiklemez + ipucu; basılı tutarken parmak 30 px kayar,
 * `contextmenu` olayı gelir ve üst bileşen yeniden çizilir (tema değişir) → yine tetikler, metin seçilmez; geri
 * sayım iptali; ikinci uzun basış; "Hemen gönder" çift tık → uyarı gönderilir; konsol hatası yok.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(ROOT, process.env.DIST || 'dist-web');
const PORT = Number(process.env.PORT || 4394);
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
/** CDP dokunmatik: parmağı (x,y)'ye koyar; `moves` = [[ms, dx, dy], ...] sırayla bekleyip kaydırır; sonra bırakır. */
async function touchHold(p, cdp, x, y, totalMs, moves = [], during) {
  const pt = (px, py) => [{ x: px, y: py, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x, y) });
  let t = 0;
  let cx = x;
  let cy = y;
  for (const [at, dx, dy] of moves) {
    await p.waitForTimeout(Math.max(0, at - t));
    t = at;
    cx = x + dx;
    cy = y + dy;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(cx, cy) });
  }
  if (during) await during();
  await p.waitForTimeout(Math.max(0, totalMs - t));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const countdownVisible = (p) => p.getByTestId('sos-countdown').filter({ visible: true }).first().isVisible().catch(() => false);
const sheetVisible = async (p) => /Acil durum kişi/i.test(await phoneText(p)) && /Kaydet/.test(await phoneText(p));

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`${DIST}/index.html yok: önce npm run web:export`);
  const server = await serve();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true, locale: 'tr-TR', timezoneId: 'Europe/Istanbul' });
    const p = await context.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    const cdp = await context.newCDPSession(p);
    await p.goto(`${ORIGIN}/`);
    await waitPhone(p, 'Telefon numaran', 15000);
    await login(p);
    await walkOnboarding(p, { onStep: async (id) => { const cb = p.getByTestId('onboarding-sms-consent'); if (id === 'sms' && (await cb.isVisible().catch(() => false))) await cb.click(); } });
    check('harita açılır', await waitPhone(p, /Ayşe/, 15000));

    const box = await p.getByTestId('sos-button').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const css = await p.getByTestId('sos-button').evaluate((el) => {
      const s = getComputedStyle(el);
      return { us: s.userSelect || s.webkitUserSelect, ta: s.touchAction, callout: s.webkitTouchCallout || '' };
    });
    check('düğmede user-select: none + touch-action: none', css.us === 'none' && css.ta === 'none', JSON.stringify(css));

    // 1) Hızlı dokunuş: tetiklemez, ipucu çıkar, halka geri sarılır.
    await touchHold(p, cdp, cx, cy, 250);
    await p.waitForTimeout(150);
    check('hızlı dokunuş tetiklemez', !(await countdownVisible(p)) && !(await sheetVisible(p)));
    check('erken bırakma ipucu', (await phoneText(p)).includes('Göndermek için basılı tut'));
    await p.waitForTimeout(700);

    // 2) Basılı tut + parmak 30 px dışarı kayar + bağlam menüsü olayı + üst bileşen yeniden çizilir (tema değişir).
    const t0 = Date.now();
    await touchHold(p, cdp, cx, cy, 2100, [[400, 18, -10], [900, 34, 12]], async () => {
      await p.getByTestId('sos-button').evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      await p.getByLabel('Siyah / Gri teması', { exact: true }).first().click().catch(() => undefined);
    });
    const sel = await p.evaluate(() => String(window.getSelection?.() ?? ''));
    check('metin seçilmedi', sel.trim() === '', JSON.stringify(sel));
    const triggered = (await countdownVisible(p)) || (await sheetVisible(p));
    check('kayma + bağlam menüsü + yeniden çizime rağmen tetiklendi', triggered, `${Date.now() - t0} ms`);
    // Acil kişi yoksa seçim sayfası: Ayşe → Kaydet → geri sayım.
    if (!(await countdownVisible(p)) && (await sheetVisible(p))) {
      await tapPhone(p, 'Ayşe Yılmaz', { exact: false });
      await tapPhone(p, 'Kaydet ve devam et');
    }
    check('geri sayım açıldı', await p.getByTestId('sos-countdown').filter({ visible: true }).first().waitFor({ timeout: 5000 }).then(() => true, () => false));

    // 3) Geri sayım açıkken düğmeye yeniden basılsa da ikinci tetikleme yok; iptal → başa.
    const cancel = p.getByTestId('sos-countdown').getByText('İptal', { exact: true }).last();
    await cancel.click();
    await p.waitForTimeout(300);
    check('iptal sonrası geri sayım kapandı', !(await countdownVisible(p)));

    // 4) Tam tetikleme: tek uzun basış → tek geri sayım; "Hemen gönder" çift tık → tek uyarı.
    await p.waitForTimeout(1600);
    await touchHold(p, cdp, cx, cy, 1900);
    check('ikinci uzun basış tetikler', await p.getByTestId('sos-countdown').filter({ visible: true }).first().waitFor({ timeout: 4000 }).then(() => true, () => false));
    const sendNow = p.getByTestId('sos-countdown').getByLabel('Hemen gönder', { exact: true }).last();
    await sendNow.dblclick().catch(() => undefined);
    const sent = await waitPhone(p, /Uyarı gönderildi/, 15000);
    check('uyarı gönderildi', sent);
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
