// lib/index.js paketleyicisi: @konum/core (ve zod, libphonenumber-js) pakete GÖMÜLÜR,
// böylece dağıtım yerel `packages/core` klasörüne ihtiyaç duymaz. firebase-functions ve
// firebase-admin dışarıda kalır (Cloud Functions bunları package.json'dan kurar).
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreEntry = path.resolve(here, '../../packages/core/src/index.ts');

/** core'un import ettiği bağımlılıklar da functions/node_modules'tan çözülür: tek kopya, tekrarlanabilir paket. */
const konumResolve = {
  name: 'konum-resolve',
  setup(b) {
    b.onResolve({ filter: /^@konum\/core$/ }, () => ({ path: coreEntry }));
    b.onResolve({ filter: /^(zod|libphonenumber-js)(\/.*)?$/ }, async (args) => {
      if (args.pluginData?.pinned) return undefined;
      const r = await b.resolve(args.path, { kind: args.kind, resolveDir: here, pluginData: { pinned: true } });
      if (r.errors.length > 0) return { errors: r.errors };
      return { path: r.path, namespace: r.namespace, sideEffects: r.sideEffects };
    });
  },
};

rmSync(path.join(here, 'lib'), { recursive: true, force: true });

await build({
  entryPoints: [path.join(here, 'src/index.ts')],
  outfile: path.join(here, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  external: ['firebase-functions', 'firebase-functions/*', 'firebase-admin', 'firebase-admin/*'],
  plugins: [konumResolve],
});
