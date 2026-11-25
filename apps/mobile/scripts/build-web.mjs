#!/usr/bin/env node
/**
 * Tarayıcı önizlemesi (demo) için TEK DOSYALIK statik derleme → apps/mobile/dist-web/index.html
 *
 *   npm run web:export
 *
 * Ne yapar:
 *  1. `expo export --platform web` çalıştırır; paket bölme kapalıdır (EXPO_NO_BUNDLE_SPLITTING=1), böylece
 *     tüm uygulama tek bir JS dosyasına girer ve sonradan hiçbir parça (chunk) indirilmez.
 *  2. Bu JS'i index.html'in İÇİNE gömer. Çıktı başka dosyaya, sunucuya ya da başka bir kökene istek atmaz.
 *  3. Küçük bir ön betik ekler: uygulama içi geçişler adres çubuğundaki yolu değiştirmez. Böylece sayfa
 *     hangi alt yoldan (ör. /paylasim/demo/) açıldıysa yeniden yüklemede de aynı yol kalır; SPA yönlendirmesi
 *     olmayan sunucularda (python3 -m http.server) bile 404 olmaz. Tanınmayan ilk yol app/+not-found.web.tsx
 *     ile "/" yoluna yönlendirilir.
 *
 * Sonuç `<iframe sandbox="allow-scripts">` içinde de açılır: localStorage erişimi hata verirse demo
 * verileri bellekte tutulur (src/demo/web/asyncStorage.ts, src/demo/server/storage.ts).
 *
 * Native (android/ios) derlemelerini etkilemez.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-web');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'konum-web-'));

const env = {
  ...process.env,
  CI: process.env.CI ?? '1',
  EXPO_OFFLINE: process.env.EXPO_OFFLINE ?? '1',
  EXPO_NO_BUNDLE_SPLITTING: '1',
  NODE_ENV: 'production',
};

console.log('› expo export --platform web (tek paket)…');
const r = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', tmp], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (r.status !== 0) {
  console.error('expo export başarısız oldu.');
  process.exit(r.status ?? 1);
}

let html = fs.readFileSync(path.join(tmp, 'index.html'), 'utf8');

/** `</script` ve `<!--` dizileri gömülü betiği erken kapatmasın (JS anlamı değişmez). */
const escapeInline = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const scripts = [...html.matchAll(/<script src="([^"]+)"[^>]*><\/script>/g)];
if (scripts.length === 0) {
  console.error('index.html içinde paket betiği bulunamadı.');
  process.exit(1);
}
for (const [tag, src] of scripts) {
  const file = path.join(tmp, decodeURIComponent(src.replace(/^\//, '')));
  const js = fs.readFileSync(file, 'utf8');
  html = html.replace(tag, () => `<script>${escapeInline(js)}</script>`);
}

function buildStamp() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const hash = r.status === 0 ? r.stdout.trim() : 'yerel';
  const dirty = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: root, encoding: 'utf8' });
  return hash + (dirty.status === 0 && dirty.stdout.trim() ? '+' : '');
}

const prelude = `<script>
(function () {
  // Uygulama içi geçişler adres çubuğundaki yolu değiştirmesin (bkz. scripts/build-web.mjs).
  try {
    var h = window.history;
    var push = h.pushState, replace = h.replaceState;
    h.pushState = function (state) { return push.call(h, state, '', window.location.href); };
    h.replaceState = function (state) { return replace.call(h, state, '', window.location.href); };
  } catch (e) {}
})();
</script>`;

const head = `<meta name="color-scheme" content="light dark" />
    <meta name="description" content="Konum uygulamasının tarayıcı önizlemesi: arkadaşlar, harita ve konum simüle edilir." />
    <link rel="icon" href="data:," />
    <style>
      html, body { background: #F6F7F9; }
      @media (prefers-color-scheme: dark) { html, body { background: #0B1220; } }
    </style>
    ${prelude}
  </head>`;

html = html
  .replace('<html lang="en">', '<html lang="tr">')
  .replace(/<title>[^<]*<\/title>/, '<title>Konum · Web önizleme</title>')
  .replace('<meta httpEquiv="X-UA-Compatible" content="IE=edge" />', '')
  .replace('</head>', () => head)
  .replace('<noscript> You need to enable JavaScript to run this app. </noscript>', '<noscript>Bu önizleme için JavaScript gerekir.</noscript>')
  // Sürüm damgası: kullanıcının hangi dosyayı açtığı ekran görüntüsünden anlaşılsın (eski kopya karışmasın).
  .replace('</body>', () => `<div id="konum-build" aria-hidden="true" style="position:fixed;left:4px;bottom:2px;z-index:2147483647;pointer-events:none;font:10px/1.2 system-ui,sans-serif;color:#6B7280;opacity:.6">sürüm ${buildStamp()}</div></body>`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
fs.rmSync(tmp, { recursive: true, force: true });

const kb = (fs.statSync(path.join(outDir, 'index.html')).size / 1024).toFixed(0);
console.log(`✓ dist-web/index.html (${kb} KB): tek dosya, dış istek yok.`);
console.log('  Denemek için: cd dist-web && python3 -m http.server 8080  →  http://localhost:8080/');
