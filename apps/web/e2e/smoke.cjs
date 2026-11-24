/**
 * Playwright duman testi: SAHTE veri kaynağıyla (`npm run build:mock`) gerçek sayfa.
 * Firebase emülatörü gerekmez; uçtan uca emülatör testi entegrasyon adımındadır.
 *
 *   npm run build:mock && node e2e/smoke.cjs
 *   DIST=dist-mock OUT_DIR=/yol/ekran-goruntuleri PORT=4317 node e2e/smoke.cjs
 *
 * İsteğe bağlı Google Maps bölümü: anahtarla derlenmiş ikinci mock paketi verilirse
 * (`VITE_GOOGLE_MAPS_WEB_KEY=stub npx vite build --mode mock --outDir dist-mock-maps`, `DIST_MAPS=...`)
 * maps.googleapis.com isteği Playwright'ta SAHTE bir betikle karşılanır (gerçek Google'a gidilmez):
 * haritanın yalnızca ilk canlı konumdan sonra yüklendiği, isteğin token içermediği, Referer'ın yalnızca
 * kaynak (origin) olduğu, pinin bindirme katmanında çizildiği ve anahtar reddedilince yedek haritaya
 * geçildiği denetlenir.
 *
 * Denetlenenler: durumlar (canlı, bekliyor, sona erdi, geçersiz, çevrimdışı, hata), pinin yumuşak
 * kayması, süre dolunca kendiliğinden bitiş, token'ın adresten silinmesi ve hiçbir isteğe çıkmaması,
 * üçüncü taraf istek olmaması, CSP ihlali / konsol hatası olmaması. Ekran görüntüleri 390x844.
 *
 * Faz 3: gönderenin kalp atışına (`hb`) göre "Güncelleme gecikiyor" → "Bağlantısı kopmuş olabilir"
 * (paket gelmeden, yalnızca sunucu saati ilerleyerek), son doğrulanmış konum etiketi (saat + pil),
 * pinin kalması, kuyruktan (`q: 1`) gelen paket notu, %15 altı düşük pil notu, kötü doğruluklu ölçümün
 * doğrulanmış noktayı ezmemesi ve sabit duran gönderende sahte alarm olmaması.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(ROOT, process.env.DIST || 'dist-mock');
const DIST_MAPS = process.env.DIST_MAPS ? path.resolve(ROOT, process.env.DIST_MAPS) : null;
const OUT = path.resolve(process.env.OUT_DIR || path.join(ROOT, 'e2e-output'));
const PORT = Number(process.env.PORT || 4317);
let ORIGIN = `http://127.0.0.1:${PORT}`;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain' };

/** Firebase Hosting benzeri: dosya yoksa /s/** → index.html; /s/** başlıkları backend/firebase.json ile aynı. */
function serve(dist = DIST, port = PORT) {
  const DIST = dist;
  const base = `http://127.0.0.1:${port}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base);
    let file = path.join(DIST, decodeURIComponent(url.pathname));
    const isFile = file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile();
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (!isFile) {
      if (!url.pathname.startsWith('/s/') && url.pathname !== '/') {
        res.writeHead(404, headers).end('not found');
        return;
      }
      file = path.join(DIST, 'index.html');
      Object.assign(headers, { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    }
    headers['Content-Type'] = TYPES[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const token = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function newPage(browser, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    colorScheme: 'light',
    ...opts,
  });
  const page = await context.newPage();
  const log = { errors: [], requests: [], csp: [] };
  page.on('console', (m) => m.type() === 'error' && log.errors.push(m.text()));
  page.on('pageerror', (e) => log.errors.push(String(e)));
  page.on('request', (r) => log.requests.push(r.url()));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window.__csp = window.__csp || []).push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return { context, page, log };
}

const phase = (page) => page.getAttribute('[data-testid=app]', 'data-phase');
const waitPhase = (page, p, timeout = 5000) => page.waitForSelector(`[data-testid=app][data-phase=${p}]`, { timeout });
const mock = (page) => page.waitForFunction(() => window.__konumMock && window.__konumMock.ready, null, { timeout: 5000 });

function assertClean(name, log, page, secret) {
  const thirdParty = log.requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('data:'));
  check(`${name}: üçüncü taraf istek yok`, thirdParty.length === 0, thirdParty.join(', '));
  if (secret) {
    // İlk belge isteği (adres) dışında hiçbir istek token içermez.
    const leaks = log.requests.slice(1).filter((u) => u.includes(secret));
    check(`${name}: token başka isteğe çıkmadı`, leaks.length === 0, leaks.join(', '));
  }
  check(`${name}: konsol hatası yok`, log.errors.length === 0, log.errors.join(' | '));
  return page.evaluate(() => window.__csp || []).then((v) => check(`${name}: CSP ihlali yok`, v.length === 0, v.join(', ')));
}


/** maps.googleapis.com/maps/api/js yerine verilen sahte betik: yalnızca kullandığımız API yüzeyi. */
const MAPS_STUB = `(() => {
  const src = document.currentScript && document.currentScript.src;
  window.__mapsStub = { src, maps: [] };
  class Map {
    constructor(el, opts) {
      this.el = el; this.opts = opts; this.center = opts.center; this.zoom = opts.zoom; this.overlays = []; this.pans = 0;
      this.pane = document.createElement('div'); this.pane.className = 'stub-pane'; el.appendChild(this.pane);
      el.setAttribute('data-stub', 'map'); window.__mapsStub.maps.push(this);
    }
    addListener() { return { remove() {} }; }
    setOptions(o) { Object.assign(this.opts, o); }
    setCenter(c) { this.center = c; this.overlays.forEach((o) => o.draw()); }
    setZoom(z) { this.zoom = z; }
    panTo(c) { this.center = c; this.pans++; this.overlays.forEach((o) => o.draw()); }
  }
  class OverlayView {
    setMap(m) { if (m) { this.map = m; m.overlays.push(this); this.onAdd(); this.draw(); } else if (this.map) { this.onRemove(); this.map = null; } }
    getPanes() { return { overlayMouseTarget: this.map.pane }; }
    getProjection() {
      const m = this.map;
      return { fromLatLngToDivPixel: (p) => ({ x: m.el.clientWidth / 2 + (p.lng - m.center.lng) * 1e5 * 0.75, y: m.el.clientHeight / 2 - (p.lat - m.center.lat) * 1e5 }) };
    }
  }
  class Circle { constructor(o) { this.o = o; window.__mapsStub.circle = this; } setCenter(c) { this.c = c; } setRadius(r) { this.r = r; } setVisible(v) { this.v = v; } setMap() {} }
  google.maps.importLibrary = async () => ({ Map, OverlayView, Circle });
  google.maps.__ib__();
})();`;

async function mapsSection(browser) {
  const port = PORT + 1;
  const server = await serve(DIST_MAPS, port);
  const prevOrigin = ORIGIN;
  ORIGIN = `http://127.0.0.1:${port}`;
  try {
    const t = token();
    const { context, page, log } = await newPage(browser);
    const mapsRequests = [];
    await context.route('https://maps.googleapis.com/**', (route) => {
      const r = route.request();
      mapsRequests.push({ url: r.url(), referer: r.headers()['referer'] || null });
      route.fulfill({ status: 200, contentType: 'text/javascript', body: MAPS_STUB });
    });
    await page.goto(`${ORIGIN}/s/${t}`);
    await mock(page);
    const meta = await page.evaluate(() => ({
      referrer: document.querySelector('meta[name=referrer]')?.content,
      csp: document.querySelector('meta[http-equiv=Content-Security-Policy]')?.content || '',
    }));
    check('maps: referrer meta strict-origin', meta.referrer === 'strict-origin', meta.referrer);
    check('maps: CSP Google alanlarına izin veriyor', /script-src [^;]*googleapis/.test(meta.csp));
    await page.evaluate(() => {
      window.__konumMock.setConnected(true);
      window.__konumMock.emit(null);
    });
    await waitPhase(page, 'waiting');
    await page.waitForTimeout(400);
    check('maps: konum gelmeden Maps JS yüklenmedi (maliyet)', mapsRequests.length === 0, `${mapsRequests.length} istek`);
    await page.evaluate(() => window.__konumMock.emitLive({ lat: 40.98712, lng: 29.02561 }));
    await waitPhase(page, 'live');
    await page.waitForSelector('[data-testid=google-map][data-stub=map]');
    await page.waitForSelector('.gm-pin-host .pin');
    check('maps: tek yükleme isteği', mapsRequests.length === 1, `${mapsRequests.length}`);
    const req = mapsRequests[0] || { url: '', referer: '' };
    check('maps: istek token içermiyor', !req.url.includes(t));
    check('maps: dil tr / bölge TR', /language=tr/.test(req.url) && /region=TR/.test(req.url), req.url.replace(/key=[^&]+/, 'key=…'));
    check('maps: Referer yalnızca kaynak (yol/token yok)', req.referer === `${ORIGIN}/`, String(req.referer));
    const pageUrlSeenByMaps = await page.evaluate(() => location.href);
    check('maps: Maps betiğinin gördüğü adres token içermiyor', !pageUrlSeenByMaps.includes(t), pageUrlSeenByMaps);
    const stub = await page.evaluate(() => {
      const m = window.__mapsStub.maps[0];
      return { count: window.__mapsStub.maps.length, zoom: m.zoom, styles: Array.isArray(m.opts.styles) && m.opts.styles.length, circle: window.__mapsStub.circle && window.__mapsStub.circle.r };
    });
    check('maps: tek Map örneği, zoom 16, JSON stil', stub.count === 1 && stub.zoom === 16 && stub.styles > 10, JSON.stringify(stub));
    check('maps: doğruluk dairesi = accuracy', stub.circle === 12, String(stub.circle));
    // Yeni konum: pin bindirme katmanında kayar, harita takip eder; yeni Map yüklenmez.
    const x0 = await page.evaluate(() => document.querySelector('.gm-pin-host').style.transform);
    await page.evaluate(() => window.__konumMock.emitLive({ lat: 40.98689, lng: 29.02634, timestamp: Date.now() + 4000 }));
    const xs = new Set();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(100);
      xs.add(await page.evaluate(() => document.querySelector('.gm-pin-host').style.transform));
    }
    xs.delete(x0);
    check('maps: pin bindirmede yumuşak kaydı', xs.size >= 3, `${xs.size} ara değer`);
    await page.waitForTimeout(1200);
    check('maps: harita takip etti (panTo), tek yükleme', (await page.evaluate(() => window.__mapsStub.maps[0].pans)) >= 1 && mapsRequests.length === 1);
    // Paylaşım durdu: pin kalkar, harita yeniden yüklenmez.
    await page.evaluate(() => window.__konumMock.remove());
    await waitPhase(page, 'ended');
    check('maps: sona erince pin kalktı', (await page.locator('.gm-pin-host .pin').count()) === 0);
    check('maps: daire gizlendi', (await page.evaluate(() => window.__mapsStub.circle.v)) === false);
    // Anahtar reddedildi (Google gm_authFailure çağırır) → yedek harita.
    await page.evaluate(() => {
      window.__konumMock.emitLive();
    });
    await waitPhase(page, 'live');
    await page.evaluate(() => window.gm_authFailure && window.gm_authFailure());
    await page.waitForSelector('[data-testid=fallback-map]');
    check('maps: anahtar reddedilince yedek harita', (await page.locator('[data-testid=google-map]').count()) === 0);
    const others = log.requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('https://maps.googleapis.com/maps/api/js?'));
    check('maps: Maps JS dışında üçüncü taraf istek yok', others.length === 0, others.join(', '));
    check('maps: konsol hatası yok', log.errors.length === 0, log.errors.join(' | '));
    const csp = await page.evaluate(() => window.__csp || []);
    check('maps: CSP ihlali yok', csp.length === 0, csp.join(', '));
    await context.close();
  } finally {
    ORIGIN = prevOrigin;
    server.close();
  }
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`${DIST}/index.html yok: önce npm run build:mock`);
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch();
  try {
    // ------------------------------------------------------------ canlı → hareket → sona erdi
    {
      const t = token();
      const { context, page, log } = await newPage(browser);
      await page.goto(`${ORIGIN}/s/${t}`);
      await mock(page);
      check('adres token içermiyor (/s/canli)', (await page.evaluate(() => location.pathname)) === '/s/canli');
      check('abone olunan yol = sha256(token)', (await page.evaluate(() => window.__konumMock.subscribedHash)) === sha256(t));
      check('ilk durum loading', (await phase(page)) === 'loading');

      const meta = await page.evaluate(() => ({
        robots: document.querySelector('meta[name=robots]')?.content,
        referrer: document.querySelector('meta[name=referrer]')?.content,
        csp: document.querySelector('meta[http-equiv=Content-Security-Policy]')?.content || '',
      }));
      check('noindex meta', /noindex/.test(meta.robots || ''), meta.robots);
      check('referrer meta no-referrer (anahtarsız)', meta.referrer === 'no-referrer', meta.referrer);
      check('CSP meta', meta.csp.includes("default-src 'none'"));

      await page.evaluate(() => window.__konumMock.setConnected(true));
      await page.evaluate(() => window.__konumMock.emitLive({ lat: 40.98712, lng: 29.02561 }));
      await waitPhase(page, 'live');
      const name = await page.textContent('[data-testid=sender-name]');
      const fresh = await page.textContent('[data-testid=freshness]');
      const until = await page.textContent('[data-testid=until]');
      check('gönderen adı', name === 'Ayşe Yılmaz', name);
      check('tazelik "Canlı · şimdi"', /Canlı · şimdi/.test(fresh), fresh);
      check("bitiş \"HH:MM'e kadar · N dk kaldı\"", /\d{2}:\d{2}'(e|a|ye|ya) kadar · 4[12] dk kaldı/.test(until), until);
      const appHref = await page.getAttribute('a.btn-primary', 'href');
      check('Uygulamada aç → konum://s/<token>', appHref === `konum://s/${t}`, appHref);
      const mapsHref = await page.getAttribute('[data-testid=maps-link]', 'href');
      check('Haritada göster → google.com/maps?q=lat,lng', mapsHref === 'https://www.google.com/maps?q=40.98712,29.02561', mapsHref);
      check('Haritada göster yeni sekme, referrer yok', (await page.getAttribute('[data-testid=maps-link]', 'rel')).includes('noreferrer'));
      check('yedek harita (anahtarsız)', (await page.locator('[data-testid=fallback-map]').count()) === 1);
      check('koordinat ekranda yazılı değil', !(await page.textContent('body')).includes('40.98712'));
      check('pin görünür', (await page.locator('.pin').count()) === 1);

      // Yumuşak hareket: ~65 m öteye yeni konum; desen kaydırması birkaç ara değerden geçmeli.
      const before = await page.getAttribute('[data-testid=fallback-map]', 'data-shift');
      await page.evaluate(() => window.__konumMock.emitLive({ lat: 40.98689, lng: 29.02634, timestamp: Date.now() + 4000 }));
      const samples = new Set();
      let sawMoving = false;
      for (let i = 0; i < 14; i++) {
        await page.waitForTimeout(120);
        samples.add(await page.getAttribute('[data-testid=fallback-map]', 'data-shift'));
        if ((await page.getAttribute('[data-testid=fallback-map]', 'data-anim')) === 'moving') sawMoving = true;
      }
      await page.waitForTimeout(700);
      const after = await page.getAttribute('[data-testid=fallback-map]', 'data-shift');
      samples.delete(before);
      samples.delete(after);
      check('pin yumuşak kaydı (ara konumlar)', sawMoving && samples.size >= 4, `${samples.size} ara değer`);
      check('hareket bitti', (await page.getAttribute('[data-testid=fallback-map]', 'data-anim')) === 'idle' && after !== before);
      await page.screenshot({ path: path.join(OUT, 'live.png') });

      // Yenileme: adres /s/canli, token sekme deposundan.
      await page.reload();
      await mock(page);
      check('yenileme sonrası aynı özet', (await page.evaluate(() => window.__konumMock.subscribedHash)) === sha256(t));
      await page.evaluate(() => {
        window.__konumMock.setConnected(true);
        window.__konumMock.emitLive();
      });
      await waitPhase(page, 'live');

      // Çevrimdışı: canlıyken bağlantı koparsa son konum kalır, uyarı çıkar.
      await page.evaluate(() => window.__konumMock.setConnected(false));
      await page.waitForSelector('.chip-warning');
      check('canlı + çevrimdışı: Çevrimdışı çipi', (await page.textContent('.chip-warning')).includes('Çevrimdışı'));
      check('canlı + çevrimdışı: "Bağlantı yok"', (await page.textContent('[data-testid=freshness]')).includes('Bağlantı yok'));
      await page.evaluate(() => window.__konumMock.setConnected(true));

      // Paylaşımı Durdur: sunucu düğümü siler → pin kalkar.
      await page.evaluate(() => window.__konumMock.remove());
      await waitPhase(page, 'ended');
      check('sona erdi: başlık', (await page.textContent('[data-testid=status-title]')) === 'Paylaşım sona erdi');
      check('sona erdi: pin kalktı', (await page.locator('.pin').count()) === 0);
      check('sona erdi: Uygulamada aç yok', (await page.locator('a[href^="konum://"]').count()) === 0);
      await page.screenshot({ path: path.join(OUT, 'ended.png') });
      await assertClean('canlı/sona erdi', log, page, t);
      await context.close();
    }

    // ------------------------------------------------------------ canlıyken permission_denied → sona erdi
    {
      const { context, page } = await newPage(browser);
      await page.goto(`${ORIGIN}/s/${token()}`);
      await mock(page);
      await page.evaluate(() => {
        window.__konumMock.setConnected(true);
        window.__konumMock.emitLive();
      });
      await waitPhase(page, 'live');
      await page.evaluate(() => window.__konumMock.deny());
      await waitPhase(page, 'ended');
      check('canlıyken reddedildi → sona erdi', true);
      await context.close();
    }

    // ------------------------------------------------------------ süre dolunca kendiliğinden biter
    {
      const { context, page } = await newPage(browser);
      await page.goto(`${ORIGIN}/s/${token()}`);
      await mock(page);
      await page.evaluate(() => {
        window.__konumMock.setConnected(true);
        window.__konumMock.emitLive({ expires_at: Date.now() + 1500 });
      });
      await waitPhase(page, 'live');
      await waitPhase(page, 'ended', 4000);
      check('expires_at geçince sunucu beklenmeden sona erdi', (await page.locator('.pin').count()) === 0);
      await context.close();
    }

    // ------------------------------------------------------------ hiç erişim yok → geçersiz ya da süresi dolmuş
    {
      const t = token();
      const { context, page, log } = await newPage(browser);
      await page.goto(`${ORIGIN}/s/${t}`);
      await mock(page);
      await page.evaluate(() => {
        window.__konumMock.setConnected(true);
        window.__konumMock.deny();
      });
      await waitPhase(page, 'unavailable');
      const title = await page.textContent('[data-testid=status-title]');
      check('reddedildi (veri hiç yok) → "Bağlantı geçersiz ya da süresi dolmuş"', title === 'Bağlantı geçersiz ya da süresi dolmuş', title);
      check('geçersiz: mağaza rozetleri', (await page.locator('.badge').count()) === 2);
      await page.screenshot({ path: path.join(OUT, 'invalid.png') });
      await assertClean('geçersiz', log, page, t);
      await context.close();
    }

    // ------------------------------------------------------------ bozuk bağlantı: veri kaynağı hiç yüklenmez
    {
      const { context, page, log } = await newPage(browser);
      await page.goto(`${ORIGIN}/s/bozuk-baglanti`);
      await waitPhase(page, 'invalid');
      await page.waitForTimeout(300);
      check('bozuk token: "Bağlantı geçersiz"', (await page.textContent('[data-testid=status-title]')) === 'Bağlantı geçersiz');
      check('bozuk token: veri kaynağı yüklenmedi', (await page.evaluate(() => typeof window.__konumMock)) === 'undefined');
      await page.screenshot({ path: path.join(OUT, 'invalid-malformed.png') });
      await page.goto(`${ORIGIN}/`);
      await waitPhase(page, 'invalid');
      check('kök yol: geçersiz', true);
      await assertClean('bozuk', log, page);
      await context.close();
    }

    // ------------------------------------------------------------ bekliyor, çevrimdışı, hata
    {
      const { context, page } = await newPage(browser);
      await page.goto(`${ORIGIN}/s/${token()}`);
      await mock(page);
      await context.setOffline(true);
      await waitPhase(page, 'offline');
      check('yüklenirken ağ yok → offline', (await page.textContent('[data-testid=status-title]')) === 'İnternet bağlantısı yok');
      await page.screenshot({ path: path.join(OUT, 'offline.png') });
      await context.setOffline(false);
      await waitPhase(page, 'loading');
      await page.evaluate(() => {
        window.__konumMock.setConnected(true);
        window.__konumMock.emit(null);
      });
      await waitPhase(page, 'waiting');
      check('erişim var, konum yok → bekliyor', (await page.textContent('[data-testid=status-title]')) === 'Paylaşan kişinin konumu bekleniyor');
      await page.screenshot({ path: path.join(OUT, 'waiting.png') });
      await page.evaluate(() => window.__konumMock.fail());
      await waitPhase(page, 'error');
      check('dinleyici hatası → "Konum şu an alınamıyor"', (await page.textContent('[data-testid=status-title]')) === 'Konum şu an alınamıyor');
      await context.close();
    }

    // ------------------------------------------------------------ Faz 3: hb'ye göre gecikme / kopma, kuyruk notu
    {
      const t = token();
      const { context, page, log } = await newPage(browser);
      await page.goto(`${ORIGIN}/s/${t}`);
      await mock(page);
      const HB = 2 * 60 * 1000; // araçtaki gönderen
      await page.evaluate((hb) => {
        window.__konumMock.setConnected(true);
        window.__konumMock.emitLive({ hb });
      }, HB);
      await waitPhase(page, 'live');
      const status = () => page.getAttribute('[data-testid=app]', 'data-status');
      check('faz3: hb 2 dk, taze paket → live', (await status()) === 'live');
      check('faz3: canlıyken doğrulanmış etiket yok', (await page.locator('[data-testid=verified]').count()) === 0);
      // Yeni paket gelmiyor; sunucu saati ilerler (sekme açık, gönderen tünelde).
      await page.evaluate(() => window.__konumMock.setServerOffset(5 * 60 * 1000));
      await page.waitForSelector('[data-testid=app][data-status=delayed]', { timeout: 4000 });
      const fDelayed = await page.textContent('[data-testid=freshness]');
      check('faz3: 5 dk sessizlik → "Güncelleme gecikiyor · 5 dk önce"', fDelayed.includes('Güncelleme gecikiyor · 5 dk önce'), fDelayed);
      const vDelayed = await page.textContent('[data-testid=verified]');
      check('faz3: "Son doğrulanmış konum · HH:MM · %64"', /^Son doğrulanmış konum · \d{2}:\d{2} · %64/.test(vDelayed), vDelayed);
      await page.screenshot({ path: path.join(OUT, 'delayed.png') });
      await page.evaluate(() => window.__konumMock.setServerOffset(9 * 60 * 1000));
      await page.waitForSelector('[data-testid=app][data-status=offline_suspected]', { timeout: 4000 });
      const fLost = await page.textContent('[data-testid=freshness]');
      check('faz3: 9 dk sessizlik → "Bağlantısı kopmuş olabilir"', fLost.includes('Bağlantısı kopmuş olabilir · 9 dk önce'), fLost);
      check('faz3: kopukken açıklama', (await page.textContent('[data-testid=verified]')).includes('kapalı olabilir'));
      check('faz3: kopukken pin son doğrulanmış konumda kalır (gri)', (await page.locator('.pin.pin-stale').count()) === 1);
      check('faz3: kopukken faz hâlâ live (paylaşım bitmedi)', (await phase(page)) === 'live');
      check('faz3: ekran okuyucu duyurusu', (await page.textContent('[aria-live=polite]')).includes('Bağlantısı kopmuş olabilir'));
      check('faz3: koordinat ekranda yazılı değil', !(await page.textContent('body')).includes('40.98712'));
      await page.screenshot({ path: path.join(OUT, 'offline-suspected.png') });
      // Gönderen bağlantıyı geri aldı: kuyruktaki son nokta (3 dk önce ölçülmüş) q: 1 ile gelir.
      await page.evaluate((hb) => {
        const now = Date.now() + 9 * 60 * 1000;
        window.__konumMock.emitLive({ hb, q: 1, lat: 40.98689, lng: 29.02634, timestamp: now - 3 * 60 * 1000, server_ts: now });
      }, HB);
      await page.waitForSelector('[data-testid=sync-note]', { timeout: 3000 });
      check('faz3: kuyruk notu', (await page.textContent('[data-testid=sync-note]')).includes('çevrimdışıyken kaydedilen konum eşitlendi'));
      check('faz3: kuyruk paketi sonrası durum güncel', (await status()) === 'recent');
      check('faz3: kuyruk paketi doğrulanmış konum oldu', (await page.getAttribute('[data-testid=maps-link]', 'href')) === 'https://www.google.com/maps?q=40.98689,29.02634');
      await page.waitForTimeout(2200); // pin hareketi bitsin
      await page.screenshot({ path: path.join(OUT, 'synced.png') });
      await assertClean('faz3 kopma/eşitleme', log, page, t);
      await context.close();
    }

    // ------------------------------------------------------------ Faz 3: %15 altı pil, doğrulanmış nokta, sabit gönderen
    {
      const t = token();
      const { context, page, log } = await newPage(browser);
      await page.goto(`${ORIGIN}/s/${t}`);
      await mock(page);
      await page.evaluate(() => {
        window.__konumMock.setConnected(true);
        window.__konumMock.emitLive({ hb: 120000, battery_pct: 16 });
      });
      await waitPhase(page, 'live');
      check('faz3: %16 → düşük pil notu yok', (await page.locator('[data-testid=low-battery]').count()) === 0);
      await page.evaluate(() => window.__konumMock.emitLive({ battery_pct: 14, timestamp: Date.now() + 1000 }));
      await page.waitForSelector('[data-testid=low-battery]', { timeout: 3000 });
      const lowText = await page.textContent('[data-testid=low-battery]');
      check('faz3: %14 → "Ayşe Yılmaz\'ın pili azaldı" notu (core lowBatteryPushText)', lowText.includes("Ayşe Yılmaz'ın pili azaldı") && lowText.includes('Pil %14. Konum daha seyrek güncellenecek.'), lowText);
      check('faz3: pil kutusu uyarı tonunda', (await page.getAttribute('[data-testid=battery]', 'class')).includes('fact-warning'));
      check('faz3: düşük pil duyurusu', (await page.textContent('[aria-live=polite]')).includes('pili azaldı'));
      await page.screenshot({ path: path.join(OUT, 'low-battery.png') });
      // Kötü doğruluklu (hücre) ölçüm başka yerde: pin ve bağlantı doğrulanmış noktada kalır.
      const before = await page.getAttribute('[data-testid=maps-link]', 'href');
      await page.evaluate(() => window.__konumMock.emitLive({ lat: 41.2, lng: 29.3, accuracy: 900, timestamp: Date.now() + 2000 }));
      await page.waitForTimeout(300);
      check('faz3: ±900 m ölçüm doğrulanmış noktayı ezmez', (await page.getAttribute('[data-testid=maps-link]', 'href')) === before, before);
      // Şarj/yükselme: %20 → not kalkar.
      await page.evaluate(() => window.__konumMock.emitLive({ battery_pct: 20, timestamp: Date.now() + 3000 }));
      await page.waitForTimeout(300);
      check('faz3: %20 → düşük pil notu kalktı', (await page.locator('[data-testid=low-battery]').count()) === 0);
      await assertClean('faz3 pil', log, page, t);
      await context.close();
    }
    {
      // Sabit duran gönderen (hb 15 dk): 12 dk sessizlik sahte "gecikiyor" üretmez.
      const { context, page } = await newPage(browser);
      await page.goto(`${ORIGIN}/s/${token()}`);
      await mock(page);
      await page.evaluate(() => {
        window.__konumMock.setConnected(true);
        window.__konumMock.emitLive({ hb: 15 * 60 * 1000 });
        window.__konumMock.setServerOffset(12 * 60 * 1000);
      });
      await page.waitForSelector('[data-testid=app][data-status=recent]', { timeout: 4000 });
      const f = await page.textContent('[data-testid=freshness]');
      check('faz3: sabit gönderen 12 dk → "Güncel" (sahte alarm yok)', f.includes('Güncel · 12 dk önce'), f);
      await context.close();
    }
    {
      // Koyu tema, bağlantısı kopmuş olabilir + düşük pil.
      const { context, page } = await newPage(browser, { colorScheme: 'dark' });
      await page.goto(`${ORIGIN}/s/${token()}`);
      await mock(page);
      await page.evaluate(() => {
        window.__konumMock.setConnected(true);
        window.__konumMock.emitLive({ hb: 120000, battery_pct: 9, timestamp: Date.now() - 14 * 60 * 1000 });
      });
      await page.waitForSelector('[data-testid=app][data-status=offline_suspected]', { timeout: 4000 });
      await page.screenshot({ path: path.join(OUT, 'offline-suspected-dark.png') });
      await context.close();
    }

    // ------------------------------------------------------------ koyu tema ve geniş ekran
    {
      const { context, page, log } = await newPage(browser, { colorScheme: 'dark' });
      await page.goto(`${ORIGIN}/s/${token()}`);
      await mock(page);
      await page.evaluate(() => {
        window.__konumMock.setConnected(true);
        window.__konumMock.emitLive({ timestamp: Date.now() - 5 * 60 * 1000 });
      });
      await waitPhase(page, 'live');
      // Faz 3: hb yok (Faz 2 göndereni) → varsayılan 10 dk; 5 dk sessizlik zamanında sayılır.
      check('koyu: "Güncel · 5 dk önce"', (await page.textContent('[data-testid=freshness]')).includes('Güncel · 5 dk önce'));
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check('koyu tema arka planı', bg === 'rgb(11, 18, 32)', bg);
      await page.screenshot({ path: path.join(OUT, 'live-dark.png') });
      await assertClean('koyu', log, page);
      await context.close();
    }
    {
      const { context, page } = await newPage(browser, { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
      await page.goto(`${ORIGIN}/s/${token()}`);
      await mock(page);
      await page.evaluate(() => {
        window.__konumMock.setConnected(true);
        window.__konumMock.emitLive({ battery_pct: null, expires_at: null, share_mode: 'indefinite' });
      });
      await waitPhase(page, 'live');
      check('süresiz: "Süresiz"', (await page.textContent('[data-testid=until]')).trim() === 'Süresiz');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      check('yatay kaydırma yok (geniş)', !overflow);
      await page.screenshot({ path: path.join(OUT, 'desktop.png') });
      await context.close();
    }
    {
      // Telefon genişliğinde yatay kaydırma yok
      const { context, page } = await newPage(browser, { viewport: { width: 360, height: 640 } });
      await page.goto(`${ORIGIN}/s/${token()}`);
      await mock(page);
      await page.evaluate(() => {
        window.__konumMock.setConnected(true);
        window.__konumMock.emitLive({ sender_name: 'Çok Uzun İsimli Bir Arkadaşımız Burada Yazıyor' });
      });
      await waitPhase(page, 'live');
      check('yatay kaydırma yok (360 px, uzun ad)', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
      await context.close();
    }
    if (DIST_MAPS) await mapsSection(browser);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(results.join('\n'));
  console.log(`\n${results.length - failures}/${results.length} denetim geçti. Ekran görüntüleri: ${OUT}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
