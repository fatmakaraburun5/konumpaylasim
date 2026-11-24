// e2e/faz3/lib.ts → e2e-output/faz3/lib.cjs (Faz 2 integration/build-lib.mjs ile aynı çözümleme: tek core, tek zod).
// React Native modülleri (AsyncStorage, @react-native-firebase/database) rn-stub.ts'e yönlendirilir.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const fnDir = path.join(repo, 'backend/functions');
const require = createRequire(path.join(fnDir, 'package.json'));
const { build } = require('esbuild');
const coreEntry = path.join(repo, 'packages/core/src/index.ts');
const stub = path.join(here, 'rn-stub.ts');
const outfile = path.resolve(here, '../../e2e-output/faz3/lib.cjs');

const konumResolve = {
  name: 'konum-resolve',
  setup(b) {
    b.onResolve({ filter: /^@konum\/core$/ }, () => ({ path: coreEntry }));
    b.onResolve({ filter: /^(@react-native-async-storage\/async-storage|@react-native-firebase\/database|react-native)$/ }, () => ({ path: stub }));
    b.onResolve({ filter: /^(zod|libphonenumber-js)(\/.*)?$/ }, async (args) => {
      if (args.pluginData?.pinned) return undefined;
      const r = await b.resolve(args.path, { kind: args.kind, resolveDir: fnDir, pluginData: { pinned: true } });
      if (r.errors.length > 0) return { errors: r.errors };
      return { path: r.path, namespace: r.namespace, sideEffects: r.sideEffects };
    });
  },
};

await build({
  entryPoints: [path.join(here, 'lib.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  logLevel: 'warning',
  define: { __DEV__: 'false' },
  external: ['firebase-functions', 'firebase-functions/*', 'firebase-admin', 'firebase-admin/*', 'firebase', 'firebase/*'],
  plugins: [konumResolve],
});
console.log(`faz3 e2e kütüphanesi: ${path.relative(process.cwd(), outfile)}`);
