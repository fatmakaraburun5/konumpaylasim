/**
 * Vite + Vitest yapılandırması.
 *
 * @konum/core derlenmiş paket değil, TypeScript KAYNAĞIDIR (`file:../../packages/core`, node_modules
 * altında sembolik bağ). Vite gerçek yola çözer ve kaynak olarak dönüştürür. core'un içinden gelen
 * `zod` / `libphonenumber-js` importları `dedupe` ile BU uygulamanın node_modules'undan çözülür
 * (tek kopya; core'un kendi node_modules'u kurulu olmasa da derleme çalışır).
 *
 * Hosting sözleşmesi (backend/hosting/assemble.mjs): `base: '/'`, çıktı `dist/index.html`;
 * `/s/**` → `/index.html` yeniden yazımı backend/firebase.json'da.
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { contentSecurityPolicy, referrerPolicy } from './build/htmlPolicy.ts';

const coreRoot = fileURLToPath(new URL('../../packages/core', import.meta.url));

function htmlPolicy(env: Record<string, string>, isBuild: boolean): Plugin {
  const mapsKey = Boolean(env.VITE_GOOGLE_MAPS_WEB_KEY?.trim());
  const emulator = env.VITE_USE_EMULATORS === '1' ? env.VITE_RTDB_EMULATOR_HOST?.trim() || '127.0.0.1:9000' : null;
  return {
    name: 'konum-html-policy',
    transformIndexHtml(html) {
      let out = html.replace('%KONUM_REFERRER%', referrerPolicy({ mapsKey }));
      const csp = isBuild
        ? `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy({
            mapsKey,
            databaseUrl: env.VITE_FIREBASE_DATABASE_URL?.trim() || null,
            emulatorHost: emulator,
          })}" />`
        : '';
      out = out.replace('<!--KONUM_CSP-->', csp);
      return out;
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (command === 'build' && mode !== 'mock' && env.VITE_USE_EMULATORS !== '1' && !env.VITE_FIREBASE_DATABASE_URL) {
    // Derleme yine biter (CI kapısı); bu paket yayınlanırsa sayfa "Konum şu an alınamıyor" gösterir.
    console.warn('[konum-web] UYARI: VITE_FIREBASE_DATABASE_URL / VITE_FIREBASE_PROJECT_ID yok; yayın için .env.production gerekli.');
  }
  return {
    base: '/',
    plugins: [react(), htmlPolicy(env, command === 'build')],
    resolve: {
      dedupe: ['zod', 'libphonenumber-js', 'react', 'react-dom'],
    },
    server: {
      port: 5173,
      strictPort: true,
      fs: { allow: ['.', coreRoot] },
    },
    preview: { port: 4173, strictPort: true },
    build: {
      outDir: 'dist',
      target: 'es2022',
      // Kaynak haritası yayınlanmaz (kaynak zaten açık, ama gereksiz dosya ve boyut).
      sourcemap: false,
      chunkSizeWarningLimit: 700,
    },
    test: {
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  };
});
