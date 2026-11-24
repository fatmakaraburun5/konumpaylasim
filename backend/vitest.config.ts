import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreEntry = fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@konum/core': coreEntry },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Tüm dosyalar aynı emülatörleri paylaşır: sırayla çalışsınlar.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
