/**
 * Süre dolumu görevleri (Cloud Tasks, BACKEND_SPEC §5): her aktif ve süreli paylaşım sürümü için
 * `expires_at` anına bir görev kuyruğa alınır. Görev o sürüm hâlâ geçerliyse paylaşımı `expired` ile bitirir,
 * ACL mezar taşını yazar ve alıcıdaki son paketi siler. Dakikalık tarama yedektir.
 *
 * Görev kimliği `{share_id}-v{version}-{expires_at}`: aynı sürüm iki kez kuyruğa girmez (op tekrarı,
 * uzlaştırıcı). Uzatma yeni sürüm = yeni görev; eski sürümün görevi gelince "eski sürüm" diye hiçbir şey yapmaz.
 * `expires_at` eki: mezar taşı + belge temizlendikten sonra sürüm 1'den yeniden başlarsa Cloud Tasks'ın silinmiş
 * görev adlarını bir süre ayırması yüzünden yeni görev "zaten var" diye düşmesin.
 *
 * Kalan pencere (bilinçli): okuma kuralı yalnızca kimliğe bağlıdır (alıcı tüm gelen kutusunu tek dinleyiciyle
 * dinler), bu yüzden `expires_at` ile görevin çalışması arasındaki birkaç saniyede eski alıcı SON paketi
 * (bitişten önceki konumu) hâlâ okuyabilir. Yazma ise kural gereği tam süresinde kesilir. [Varsayım: doğrulanmalı]
 * Cloud Tasks gecikmesi tipik olarak saniyeler; görev başarısız olursa tarama ≤ 1 dk.
 */
import type { EpochMs } from '@konum/core';
import { getFunctions } from 'firebase-admin/functions';
import * as logger from 'firebase-functions/logger';
import type { AclSource } from './acl';
import type { LinkAclSource } from './linkAcl';
import { adminApp } from './admin';
import { EXPIRY_TASK_FUNCTION, IS_EMULATOR, IS_LOCAL_TEST, REGION } from './config';

export interface ExpiryTaskData {
  share_id: string;
  version: number;
}

/**
 * Faz 2: bağlantı (QR) süre dolumu AYNI kuyruğa (`shareexpirytask`) alınır; yeni kuyruk / IAM gerekmez.
 * Görev verisi `share_id` yerine `link_id` taşır; işleyici bu alana göre ayırır (index.ts).
 */
export interface LinkExpiryTaskData {
  link_id: string;
  version: number;
}

/**
 * Faz 9: anlık fotoğrafın 1 saatlik silinmesi (`expires_at` anında) ve Güvenli Dönüş sunucu zamanlayıcısı
 * (`due_at` ve `grace_until` anlarında) AYNI kuyruğa alınır. İşleyici alana göre ayırır (index.ts): `proof_id`,
 * `safe_return_id`. Uzatılan Güvenli Dönüş'ün eski görevi gelince tick hiçbir şey yapmaz (belge yeniden okunur).
 */
export interface ProofExpiryTaskData {
  proof_id: string;
}

export interface SafeReturnTaskData {
  safe_return_id: string;
  /** Görevin hedef anı (due_at ya da grace_until). */
  at: number;
}

export type ExpiryTaskPayload = ExpiryTaskData | LinkExpiryTaskData | ProofExpiryTaskData | SafeReturnTaskData;

/** Cloud Tasks en çok 30 gün sonrasına zamanlanabilir; paylaşımlar en çok 7 gün sürer. */
const MAX_SCHEDULE_AHEAD_MS = 29 * 24 * 60 * 60 * 1000;

export function expiryTaskFor(s: Pick<AclSource, 'share_id' | 'status' | 'expires_at' | 'version'>, now: EpochMs = Date.now()) {
  if (s.status !== 'active' || s.expires_at === null) return null;
  if (s.expires_at - now > MAX_SCHEDULE_AHEAD_MS) return null;
  return {
    id: `${s.share_id}-v${s.version}-${s.expires_at}`.replace(/[^A-Za-z0-9_-]/g, '-'),
    data: { share_id: s.share_id, version: s.version } satisfies ExpiryTaskData,
    scheduleTime: new Date(Math.max(s.expires_at, now)),
  };
}

/** Bağlantı görevi: kimlik `link-{link_id}-v{version}-{expires_at}` (paylaşım kimlikleriyle çakışmaz). */
export function linkExpiryTaskFor(
  s: Pick<LinkAclSource, 'link_id' | 'status' | 'expires_at' | 'version'>,
  now: EpochMs = Date.now(),
) {
  if (s.status !== 'active' || s.expires_at === null) return null;
  if (s.expires_at - now > MAX_SCHEDULE_AHEAD_MS) return null;
  return {
    id: `link-${s.link_id}-v${s.version}-${s.expires_at}`.replace(/[^A-Za-z0-9_-]/g, '-'),
    data: { link_id: s.link_id, version: s.version } satisfies LinkExpiryTaskData,
    scheduleTime: new Date(Math.max(s.expires_at, now)),
  };
}

/** Kuyruğa alma: hata fırlatmaz (yedek tarama var). */
export async function scheduleExpiryTasks(effects: readonly AclSource[], now: EpochMs = Date.now()): Promise<void> {
  const tasks = effects.map((s) => expiryTaskFor(s, now)).filter((t): t is NonNullable<typeof t> => t !== null);
  await enqueueExpiryTasks(tasks);
}

/** Faz 2: bağlantı süre dolumu görevleri (aynı kuyruk). Hata fırlatmaz. */
export async function scheduleLinkExpiryTasks(effects: readonly LinkAclSource[], now: EpochMs = Date.now()): Promise<void> {
  const tasks = effects.map((s) => linkExpiryTaskFor(s, now)).filter((t): t is NonNullable<typeof t> => t !== null);
  await enqueueExpiryTasks(tasks);
}

/** Faz 9: fotoğraf silme görevi (kimlik `proof-{id}`; aynı fotoğraf iki kez kuyruğa girmez). Hata fırlatmaz. */
export async function scheduleProofExpiryTask(p: { proof_id: string; expires_at: EpochMs }, now: EpochMs = Date.now()): Promise<void> {
  await enqueueExpiryTasks([
    { id: `proof-${p.proof_id}`.replace(/[^A-Za-z0-9_-]/g, '-'), data: { proof_id: p.proof_id }, scheduleTime: new Date(Math.max(p.expires_at, now)) },
  ]);
}

/**
 * Faz 9: Güvenli Dönüş görevleri `due_at` ("Güvende misin?") ve `grace_until` (alarm) anlarına. Kimlik
 * `sr-{id}-{an}`: uzatma yeni anlar = yeni görevler. Hata fırlatmaz (dakikalık süpürücü yedektir).
 */
export async function scheduleSafeReturnTasks(d: { safe_return_id: string; due_at: EpochMs; grace_until: EpochMs }, now: EpochMs = Date.now()): Promise<void> {
  await enqueueExpiryTasks(
    [d.due_at, d.grace_until].map((at) => ({
      id: `sr-${d.safe_return_id}-${at}`.replace(/[^A-Za-z0-9_-]/g, '-'),
      data: { safe_return_id: d.safe_return_id, at } satisfies SafeReturnTaskData,
      scheduleTime: new Date(Math.max(at, now)),
    })),
  );
}

async function enqueueExpiryTasks(tasks: { id: string; data: ExpiryTaskPayload; scheduleTime: Date }[]): Promise<void> {
  if (tasks.length === 0) return;
  // Emülatöre bağlı test süreci (işleyiciler doğrudan çağrılır): görev emülatörü yoksa atla.
  if (IS_LOCAL_TEST && !process.env.CLOUD_TASKS_EMULATOR_HOST) return;
  const queue = getFunctions(adminApp()).taskQueue<ExpiryTaskPayload>(`locations/${REGION}/functions/${EXPIRY_TASK_FUNCTION}`);
  const results = await Promise.allSettled(
    tasks.map((t) => queue.enqueue(t.data, { id: t.id, scheduleTime: t.scheduleTime, dispatchDeadlineSeconds: 60 })),
  );
  for (const r of results) {
    if (r.status === 'fulfilled') continue;
    const code = (r.reason as { code?: string } | null)?.code;
    if (code === 'functions/task-already-exists') continue;
    (IS_EMULATOR ? logger.debug : logger.warn)('süre dolumu görevi kuyruğa alınamadı (tarama yedeği devralır)', {
      err: String(r.reason),
    });
  }
}
