// Firebase Hosting yayın klasörünü (hosting/dist) hazırlar: apps/web derlemesi (salt okunur web haritası)
// + hosting/public (Universal Links / App Links doğrulama dosyaları). `firebase deploy --only hosting`
// öncesinde firebase.json `hosting.predeploy` ile çalışır.
//
//   node hosting/assemble.mjs                 # ../apps/web/dist zorunlu (yoksa hata)
//   node hosting/assemble.mjs --placeholder   # web derlemesi yoksa yer tutucu sayfa (yalnızca yerel deneme)
//   WEB_DIST=/yol/dist node hosting/assemble.mjs
//
// Sözleşme (apps/web): Vite `base: '/'`, SPA girişi dist/index.html. /s/<token> isteği firebase.json'daki
// rewrite ile /index.html'e gider; token tarayıcıda okunur, sunucuya hiç gönderilmez (statik dosya).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'dist');
const publicDir = path.join(here, 'public');
const webDist = path.resolve(process.env.WEB_DIST || path.join(here, '../../apps/web/dist'));
const placeholder = process.argv.includes('--placeholder');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (existsSync(path.join(webDist, 'index.html'))) {
  cpSync(webDist, out, { recursive: true });
  console.log(`hosting: web görüntüleyici kopyalandı (${path.relative(process.cwd(), webDist) || webDist})`);
} else if (placeholder) {
  cpSync(path.join(here, 'placeholder'), out, { recursive: true });
  console.warn('hosting: UYARI web derlemesi yok, yer tutucu sayfa kullanılıyor (yalnızca yerel deneme)');
} else {
  console.error(`hosting: ${webDist}/index.html bulunamadı. Önce apps/web derlenmeli (npm --prefix ../apps/web run build).`);
  process.exit(1);
}

// Doğrulama dosyaları web derlemesindekileri EZER (tek kaynak: backend/hosting/public).
cpSync(publicDir, out, { recursive: true });

const aasa = JSON.parse(readFileSync(path.join(out, '.well-known/apple-app-site-association'), 'utf8'));
const links = JSON.parse(readFileSync(path.join(out, '.well-known/assetlinks.json'), 'utf8'));
const appIds = aasa.applinks.details.flatMap((d) => d.appIDs ?? []);
const prints = links.flatMap((l) => l.target?.sha256_cert_fingerprints ?? []);
if (appIds.some((id) => id.startsWith('TEAMID.')) || prints.some((p) => /^(00:)+00$/.test(p))) {
  console.warn('hosting: UYARI AASA appID (TEAMID) ya da assetlinks SHA-256 hâlâ yer tutucu [Varsayım]; bağlantılar uygulamada açılmaz.');
}
console.log(`hosting: ${path.relative(process.cwd(), out) || out} hazır`);
