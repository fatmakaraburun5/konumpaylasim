/**
 * Testlerde Node'un yerleşik modüllerine karşılaştırma için en küçük tip bildirimi.
 * core `@types/node` bağımlılığı almaz (kaynak kod Hermes / tarayıcıda da çalışmalı).
 */
declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'hex' | 'base64url'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
  export function randomBytes(size: number): Uint8Array;
}

declare module 'node:buffer' {
  interface NodeBuffer extends Uint8Array {
    toString(encoding?: 'utf8' | 'hex' | 'base64url'): string;
  }
  export const Buffer: {
    from(data: string, encoding?: 'utf8'): NodeBuffer;
    from(data: Uint8Array): NodeBuffer;
  };
}

/** Simülasyon özet tablosunu test çıktısına yazmak için. */
declare const console: { log(...args: unknown[]): void };
