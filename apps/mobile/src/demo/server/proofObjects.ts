/**
 * Faz 9 demo: sahte Storage `proofs/{uid}/{proof_id}.jpg` (backend `storage.rules`: istemciye TAMAMEN kapalı;
 * yalnızca demo sunucusu yazar / okur / siler — bayt istemciye yalnızca `proof_get` yanıtında gider).
 *
 * Ana demo durumundan ayrı anahtarda (`konum.demo.proofs.v1`) tutulur: fotoğraf baytları her `commit`'te yeniden
 * yazılmasın. Yalnızca değişiklikte diske yazılır; erişilemezse bellekte kalır.
 */
import { safeStorage } from './storage';

export const DEMO_PROOF_STORAGE_KEY = 'konum.demo.proofs.v1';

export class DemoProofObjects {
  private objects = new Map<string, string>();

  constructor() {
    try {
      const raw = safeStorage.get(DEMO_PROOF_STORAGE_KEY);
      const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      for (const [k, b64] of Object.entries(v)) if (k.startsWith('proofs/') && typeof b64 === 'string') this.objects.set(k, b64);
    } catch {
      // bozuk kayıt: boş başla
    }
  }

  private persist(): void {
    try {
      safeStorage.set(DEMO_PROOF_STORAGE_KEY, JSON.stringify(Object.fromEntries(this.objects)));
    } catch {
      // kota dolu / erişilemez: bellekte kalır
    }
  }

  put(path: string, base64: string): void {
    this.objects.set(path, base64);
    this.persist();
  }

  get(path: string): string | null {
    return this.objects.get(path) ?? null;
  }

  has(path: string): boolean {
    return this.objects.has(path);
  }

  /** Dönen: nesne vardı mı. */
  remove(path: string): boolean {
    const had = this.objects.delete(path);
    if (had) this.persist();
    return had;
  }

  removePrefix(prefix: string): number {
    let n = 0;
    for (const k of [...this.objects.keys()]) {
      if (!k.startsWith(prefix)) continue;
      this.objects.delete(k);
      n++;
    }
    if (n > 0) this.persist();
    return n;
  }

  paths(): string[] {
    return [...this.objects.keys()];
  }

  reset(): void {
    this.objects.clear();
    safeStorage.remove(DEMO_PROOF_STORAGE_KEY);
  }
}
