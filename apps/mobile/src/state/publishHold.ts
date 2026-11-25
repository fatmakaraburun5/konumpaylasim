/**
 * Faz 8: "hiçbir şey yayınlama" kesme anahtarı (görünmez mod + onay kapısı), savunma katmanı.
 *
 * Sunucu görünmez olunca paylaşımları zaten bitirir ve RTDB yazılarını reddeder; bu anahtar istemcinin de AYNI anda
 * susmasını sağlar (ağ yokken, çağrı sürerken, başsız arka plan görevinde):
 *
 *  1. Bellek: `isPublishHeld()` SENKRON. Konum hattı (`pipeline.ts`), yayıncı, ön plan izleme / nabız
 *     (`sharingCoordinator`), takip yeniden başlatma (`resume.ts`), widget benimseme (`widgetBackground.ts`) ve bölge
 *     olayları (`zoneMonitorWiring` / `backgroundTask.ts`) her kararda buna bakar.
 *  2. Disk (`konum.bg.invisible.v1`, persist.ts): başsız bağlam ve yeniden açılış aynı kararı görür. Konum İÇERMEZ.
 *
 * Nedenler:
 *  - `invisible`: kullanıcının görünmez olma niyeti. `invisible_set(true)` çağrılmadan ÖNCE yazılır; sunucu profili
 *    `invisible.on` gösterince `confirmed` olur; sunucu görünür olduğunu söyleyince (ya da `invisible_set(false)`
 *    başarılı olunca) silinir. Onaylanmamış niyet açılışta / bağlantı gelince aynı op_id ile yeniden gönderilir.
 *  - `consent_hold`: güncel Güvenlik Sözleşmesi / KVKK onayı yok (onay kapısı açık): onaylanana kadar yayın yok.
 *  - `consent_version`: profilde görülen onaylı sürüm. Başsız bağlam profili okuyamaz; kayıttaki sürüm uygulamanın
 *    `CONSENT_VERSION`'ından eskiyse (sürüm yükseltildi, kapı henüz gösterilmedi) yayın yok. Kayıt hiç yoksa ve diskteki
 *    hedef listesi Faz 8 öncesi bir sürümün yazdığı boş olmayan listeyse de yayın yok (güncelleme sonrası başsız
 *    yeniden başlatma; `lastTargetsAreLegacy`). İkisi de kapalı başarısızlıktır: ön plan profili okuyunca düzelir.
 *
 * Çıkışta silinir (`clearPublishHold`). Sunucuya ulaştığı doğrulanmamış görünmez niyeti ise hesaba göre ayrı anahtarda
 * saklanır (`konum.f8.pendingInvisible.v1`) ve aynı hesapla yeniden girişte geri gelir (`takePendingInvisible`).
 */
import { CONSENT_VERSION, type EpochMs, type UserId } from '@konum/core';
import {
  lastTargetsAreLegacy,
  loadPendingInvisible,
  loadPublishHold,
  savePendingInvisible,
  savePublishHold,
  type PendingInvisibleIntents,
  type PersistedInvisibleIntent,
  type PersistedPublishHold,
} from './persist';

let hold: PersistedPublishHold | null = null;
/** Çıkışta saklanan, onaylanmamış görünmez niyetleri (hesap → niyet). */
let pending: PendingInvisibleIntents = {};
let pendingWrites: Promise<unknown> = Promise.resolve();
let hydration: Promise<void> | null = null;
let writes: Promise<unknown> = Promise.resolve();
/** Açılıştan beri görünmez niyetine dokunuldu mu (dokunulduysa diskteki eski niyet geri getirilmez). */
let invisibleTouched = false;
const listeners = new Set<() => void>();

function notify() {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // dinleyici hatası anahtarı etkilemez
    }
  }
}

function persist(): Promise<void> {
  const snapshot = hold ? { ...hold } : null;
  const run = writes.then(() => savePublishHold(snapshot));
  writes = run.catch(() => undefined);
  return run;
}

function persistPending(): Promise<void> {
  const snapshot = { ...pending };
  const run = pendingWrites.then(() => savePendingInvisible(snapshot));
  pendingWrites = run.catch(() => undefined);
  return run;
}

/**
 * Diskteki anahtarı belleğe alır (bir kez). Bellekte daha yeni bilgi varsa o kazanır; yalnızca onay kapısı
 * yazılmışsa diskteki görünmez niyeti (aynı hesap) yine geri gelir.
 */
export function hydratePublishHold(): Promise<void> {
  if (!hydration) {
    hydration = (async () => {
      try {
        const stash = await loadPendingInvisible().catch(() => ({}) as PendingInvisibleIntents);
        pending = { ...stash, ...pending };
        const v = await loadPublishHold();
        if (v && hold === null) hold = v;
        else if (v && hold && hold.uid === v.uid && hold.invisible === null && v.invisible && !invisibleTouched) {
          hold.invisible = v.invisible;
          void persist().catch(() => undefined);
        }
      } catch {
        // okunamadı: bellek geçerli
      }
      notify();
    })();
  }
  return hydration;
}

/** Kayıttaki onaylı sürüm uygulamanınkinden eski mi? (ISO tarih sürümleri dizgi olarak sıralanır.) */
function consentOutdated(h: PersistedPublishHold): boolean {
  return h.consent_version !== null && h.consent_version < CONSENT_VERSION;
}

/**
 * Şu an hiçbir şey yayınlanmamalı mı? (bellekte, senkron; görünmez niyeti, onay kapısı, eski onay sürümü; kayıt
 * yokken Faz 8 öncesi hedef listesi)
 */
export function isPublishHeld(): boolean {
  if (!hold) return lastTargetsAreLegacy();
  return hold.invisible !== null || hold.consent_hold || consentOutdated(hold);
}

/** Görünmez olma niyeti (yoksa null). `uid` verilirse yalnızca o hesabınki. */
export function invisibleIntent(uid?: UserId): PersistedInvisibleIntent | null {
  if (!hold || (uid !== undefined && hold.uid !== uid)) return null;
  return hold.invisible;
}

export function isConsentHeld(): boolean {
  return !!hold && (hold.consent_hold || consentOutdated(hold));
}

/** Başka hesabın anahtarı bu hesabı bağlamaz: sahip değişince sıfırdan başlar. */
function ownedBy(uid: UserId): PersistedPublishHold {
  if (!hold || hold.uid !== uid) hold = { uid, invisible: null, consent_hold: false, consent_version: null };
  return hold;
}

/** Görünmez niyetini yazar / siler. Bellek ANINDA güncellenir (yayın bu satırda kesilir); dönen söz diske yazmadır. */
export function setInvisibleIntent(uid: UserId, intent: PersistedInvisibleIntent | null): Promise<void> {
  const h = ownedBy(uid);
  invisibleTouched = true;
  const same = JSON.stringify(h.invisible) === JSON.stringify(intent);
  h.invisible = intent;
  if (same) return persist();
  notify();
  return persist();
}

/** Onaylanmış niyet (sunucu `invisible.on` gösterdi). */
export function confirmInvisibleIntent(uid: UserId, at: EpochMs): Promise<void> {
  const cur = invisibleIntent(uid);
  if (cur?.confirmed) return Promise.resolve();
  return setInvisibleIntent(uid, { op_id: cur?.op_id ?? '', at: cur?.at ?? at, confirmed: true });
}

/**
 * Onay kapısı (profil anlık görüntüsü / onay yanıtı). `acceptedVersion`: profilde görülen onaylı sürüm (geri
 * çekildiyse / yoksa null); başsız bağlam bu sürümü uygulamanınkiyle karşılaştırır.
 */
export function setConsentHold(uid: UserId, on: boolean, acceptedVersion: string | null = on ? null : CONSENT_VERSION): Promise<void> {
  const h = ownedBy(uid);
  const version = on ? null : acceptedVersion;
  if (h.consent_hold === on && h.consent_version === version) return Promise.resolve();
  const wasHeld = isPublishHeld();
  h.consent_hold = on;
  h.consent_version = version;
  if (wasHeld !== isPublishHeld()) notify();
  return persist();
}

/** Çıkışta: bellek + disk. Onaylanmamış görünmez niyeti hesaba göre saklanır (yeniden girişte geri gelir). */
export function clearPublishHold(): Promise<void> {
  const had = hold !== null;
  const unconfirmed = hold?.invisible && !hold.invisible.confirmed ? { uid: hold.uid, intent: hold.invisible } : null;
  hold = null;
  invisibleTouched = true;
  if (had) notify();
  const stash = unconfirmed ? ((pending = { ...pending, [unconfirmed.uid]: unconfirmed.intent }), persistPending()) : Promise.resolve();
  return Promise.all([persist(), stash]).then(() => undefined);
}

/**
 * Girişte (profil geldi): bu hesabın çıkışta saklanan onaylanmamış görünmez niyeti varsa ve şu an niyet yoksa niyet
 * SENKRON geri yazılır (yayın bu satırda kesilir). Geri geldiyse true (çağıran aynı op_id ile yeniden gönderir).
 */
export function takePendingInvisible(uid: UserId): boolean {
  const intent = pending[uid];
  if (!intent) return false;
  const { [uid]: _taken, ...rest } = pending;
  pending = rest;
  void persistPending().catch(() => undefined);
  if (invisibleIntent(uid)) return false;
  void setInvisibleIntent(uid, intent).catch(() => undefined);
  return true;
}

export function onPublishHoldChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Testler: süreç yeniden başlamış gibi belleği boşaltır (disk korunur). */
export function __resetPublishHoldMemoryForTests(): void {
  hold = null;
  pending = {};
  hydration = null;
  writes = Promise.resolve();
  pendingWrites = Promise.resolve();
  invisibleTouched = false;
}
