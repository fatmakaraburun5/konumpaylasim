/**
 * Faz 12 web önizleme duman testi (Playwright, tek dosyalık `dist-web/index.html`).
 *
 *   EXPO_OFFLINE=1 CI=1 npm run web:export && node e2e/faz12-smoke.cjs
 *   SHOTS=/yol/ekran-goruntuleri node e2e/faz12-smoke.cjs
 *
 * Denetlenenler: sık paylaşım geçmişi → "Sık paylaştıkların" şeridi; kişiye dokun → 15 dk / 1 saat; tek dokunuşla
 * paylaşım; izin eksikse "İzin ver ve paylaş"; kitapçık altında aynı satırda "＋ Paylaş"; kilit ekranı canlı sayacı
 * (iOS + Android görünümü, ETA, pembe/mavi çerçeve), Dynamic Island; mola → "Molada"; Görünmez Ol → sayaç kalkar ve
 * kısayol "Görünür ol" der; konsol hatası yok.
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
const panel = (p) => p.getByTestId('faz12-section');

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



async function startShare(p, who) {
  await tapPhoneLabel(p, 'Konumumu paylaş', { timeout: 4000, exact: false });
  await p.waitForTimeout(500);
  await tapPhone(p, who, { exact: false, timeout: 4000 });
  await tapPhone(p, '1 saat', { timeout: 4000 });
  await p.waitForTimeout(300);
  await tapPhoneLabel(p, 'Paylaşımı başlat', { timeout: 4000 });
  await p.waitForTimeout(500);
  const allow = phone(p).getByText('İzin ver ve paylaş', { exact: true }).filter({ visible: true }).last();
  if (await allow.isVisible().catch(() => false)) await allow.click();
  await p.waitForTimeout(800);
  const ok = phone(p).getByText(/^(Tamam|Kapat)$/).filter({ visible: true }).last();
  if (await ok.isVisible().catch(() => false)) await ok.click();
  await p.waitForTimeout(800);
}

const byId = (p, id) => phone(p).getByTestId(id).filter({ visible: true }).first();
const visible = (p, id, timeout = 6000) => byId(p, id).waitFor({ timeout }).then(() => true, () => false);

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
    check('FAZ 12 SENARYOLARI paneli', (await panel(p).innerText().catch(() => '')).includes('FAZ 12 SENARYOLARI'));

    // 1) Sık paylaştıkların
    const fb = await runRow(p, 'Sık paylaşım geçmişini doldur');
    check('geçmiş tohumlanır', fb.includes('Geçmiş dolduruldu'), fb);
    check('kısayol şeridi görünür', await visible(p, 'shortcut-chip-ayse'));
    const order = await phone(p).locator('[data-testid^="shortcut-chip-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('shortcut-chip-', '')));
    check('en sık paylaşılan önde', order[0] === 'ayse', order.join(','));
    await shot(p, '01-sik-paylastiklarin');

    // 2) Ayşe → 15 dk (tek dokunuş)
    await byId(p, 'shortcut-chip-ayse').click();
    await p.waitForTimeout(400);
    check('süre düğmeleri açılır', await visible(p, 'shortcut-m15'));
    const m1 = await byId(p, 'shortcut-msg').innerText().catch(() => '');
    check('karşılıklı izin bilgisi', /paylaşabiliyor|izin vermedi|vermedin/.test(m1), m1);
    await shot(p, '02-ayse-15dk-1saat');
    await byId(p, 'shortcut-m15').click();
    await p.waitForTimeout(400);
    // Konum izni akışı çıkarsa izin ver
    for (let k = 0; k < 3; k++) {
      const allow = phone(p).getByText(/^(İzin Ver|Uygulamayı Kullanırken İzin Ver|Her Zaman İzin Ver|Devam|İzin ver ve paylaş)$/).filter({ visible: true }).last();
      if (await allow.isVisible().catch(() => false)) { await allow.click().catch(() => undefined); await p.waitForTimeout(500); } else break;
    }
    const grant = byId(p, 'shortcut-grant');
    if (await grant.isVisible().catch(() => false)) {
      await shot(p, '03-izin-ver-ve-paylas');
      await grant.click();
    }
    check('Ayşe ile 15 dk başladı', await waitPhone(p, /Ayşe ile 15 dk paylaşım başladı/, 8000));
    await shot(p, '04-ayse-basladi');
    await p.waitForTimeout(2800);

    // 3) Kitapçık altında aynı satırda "＋ Paylaş"; Can'a 1 saat (izin yok → İzin ver ve paylaş)
    check('kitapçık altında ＋ Paylaş', await visible(p, 'map-share-button'));
    await shot(p, '05-kitapcik-kisayol');
    await byId(p, 'shortcut-chip-can').click();
    await p.waitForTimeout(300);
    await byId(p, 'shortcut-h1').click();
    await p.waitForTimeout(400);
    const hasGrant = await visible(p, 'shortcut-grant', 3000);
    check('izin eksik → İzin ver ve paylaş', hasGrant);
    await shot(p, '06-can-izin-gerekli');
    if (hasGrant) await byId(p, 'shortcut-grant').click();
    check('Can ile 1 saat başladı', await waitPhone(p, /Can ile 1 saat paylaşım başladı/, 8000));
    await p.waitForTimeout(2800);

    // 4) Ayşe'yi seç (ETA) → kilit ekranı
    const strip = phone(p).getByLabel(/Ayşe/).filter({ visible: true }).first();
    await strip.click().catch(() => undefined);
    await p.waitForTimeout(2500);
    await runRow(p, 'Telefonu kilitle (canlı sayacı gör)');
    check('kilit ekranında canlı kart (iOS)', await visible(p, 'live-ios'));
    const lockText = await byId(p, 'live-ios').innerText().catch(() => '');
    check('kalan süre + kişi', /konumunu görüyor/.test(lockText) && /\d+:\d\d/.test(lockText), lockText.replace(/\n/g, ' | '));
    check('ETA satırı', /dk içinde/.test(lockText), lockText.replace(/\n/g, ' | '));
    await shot(p, '07-kilit-ekrani-ios');
    await runRow(p, 'Android görünümüne geç');
    check('Android canlı bildirim', await visible(p, 'live-android'));
    await shot(p, '08-kilit-ekrani-android');
    await runRow(p, 'iOS görünümüne geç');
    await tapPhoneLabel(p, 'Kilidi aç');
    await p.waitForTimeout(400);
    // Kartı kapat (rota açıksa), Dynamic Island
    const closeRoute = phone(p).getByText('Rotayı kapat', { exact: false }).filter({ visible: true }).last();
    check('Dynamic Island kompakt', await visible(p, 'live-island'));
    await shot(p, '09-dynamic-island');
    await byId(p, 'live-island').click();
    check('Dynamic Island genişler', await visible(p, 'live-island-expanded'));
    await shot(p, '10-dynamic-island-genis');
    await byId(p, 'live-island-expanded').click();
    if (await closeRoute.isVisible().catch(() => false)) await closeRoute.click().catch(() => undefined);
    await p.waitForTimeout(400);

    // 5) Mola
    await runRow(p, '15 dk mola ver');
    await p.waitForTimeout(600);
    check('haritada "Moladasın"', await waitPhone(p, /Moladasın/, 4000));
    await shot(p, '11-mola-harita');
    await runRow(p, 'Telefonu kilitle (canlı sayacı gör)');
    const breakText = await byId(p, 'live-ios').innerText().catch(() => '');
    check('kilit ekranında Molada', /Moladasın/.test(breakText), breakText.replace(/\n/g, ' | '));
    await shot(p, '12-kilit-mola');
    await byId(p, 'live-break').click(); // Devam et (kilit açılır)
    await p.waitForTimeout(800);
    check('Devam et → mola biter', !(await phoneText(p)).includes('Moladasın'));

    // 6) Görünmez Ol → sayaç kalkar, kısayol "Görünür ol"
    const inv = await runRow(p, 'Görünmez ol (canlı sayaç hemen kalkar)');
    await p.waitForTimeout(1500);
    check('görünmez → canlı sayaç kalkar', !(await byId(p, 'live-island').isVisible().catch(() => false)), inv);
    await byId(p, 'shortcut-chip-ayse').click().catch(() => undefined);
    await p.waitForTimeout(400);
    const m2 = await byId(p, 'shortcut-msg').innerText().catch(() => '');
    check('kısayol görünmez uyarısı', m2.includes('Görünmez moddasın'), m2);
    await shot(p, '13-gorunmez-kisayol');

    check('konsol hatası yok', errors.length === 0, errors.slice(0, 3).join(' || '));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(results.join('\n'));
  if (failures) {
    console.log(`\n${failures} denetim başarısız`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  console.log(results.join('\n'));
  process.exit(1);
});
