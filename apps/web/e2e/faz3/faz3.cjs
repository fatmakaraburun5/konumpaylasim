/**
 * Faz 3 entegrasyon e2e: GERÇEK emülatörler (auth, firestore, database, functions) + GERÇEK üretim kodu.
 *
 * Gönderen tarafı mobil uygulamanın kendi kodudur: `publishSample` / `publishLinkSample` (pakette `hb`),
 * `createOutboxRepo` (çevrimdışı kuyruk → `q: 1` canlı + `live_trail` çok yollu partiler), `stepLowBattery`
 * (oturum başına %15 tetikleyicisi). Sunucu tarafı: Functions emülatöründeki `battery_low_notify`, `share_stop`,
 * `link_share_stop` callable'ları ve backend `sweepStalls` (zamanlanmış bekçinin işi, sahte `now` + yakalayıcı push).
 * İstemci SDK'sı kimliği doğrulanmış kullanıcı olarak yazar/okur: RTDB kuralları UYGULANIR.
 * İsteğe bağlı (DIST varsa + Playwright): web görüntüleyicisi gerçek `hb`/`q` bağlantı paketlerini gösterir.
 *
 * Çalıştırma (emulators:exec içinden): bkz. e2e/faz3/run-faz3.sh
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const H = '127.0.0.1';
const PROJECT = 'demo-konum';
const WEB_DIR = path.resolve(__dirname, '../..');
const REPO = path.resolve(WEB_DIR, '../..');
const OUT = path.resolve(process.env.OUT || path.join(WEB_DIR, 'e2e-output/faz3'));
const DIST = path.resolve(WEB_DIR, process.env.DIST || 'dist-emu');
const WEB_PORT = Number(process.env.WEB_PORT || 8212);
const FUNCTIONS = `http://${H}:5001/${PROJECT}/europe-west1`;
const AUTH = `http://${H}:9099`;
const MIN = 60_000;
const HOUR = 60 * MIN;

process.env.GCLOUD_PROJECT ??= PROJECT;
process.env.FIRESTORE_EMULATOR_HOST ??= `${H}:8080`;
process.env.FIREBASE_DATABASE_EMULATOR_HOST ??= `${H}:9000`;
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `${H}:9099`;
process.env.METADATA_SERVER_DETECTION ??= 'none';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT, databaseURL: `http://${H}:9000/?ns=${PROJECT}` });

const L = require(path.join(WEB_DIR, 'e2e-output/faz3/lib.cjs'));
const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require('firebase/auth');
const { getDatabase, connectDatabaseEmulator, ref, get, update, set } = require('firebase/database');

const results = [];
const counts = {};
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const denied = (e) => /permission[_ -]?denied/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
async function rejects(p) {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

// --- Auth emülatörü + callable (Faz 2 emulator.cjs ile aynı protokol) -----------------------------------
async function authPost(method, body) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/${method}?key=fake-api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`auth ${method}: ${JSON.stringify(json.error || json)}`);
  return json;
}
async function signInPhone() {
  const phone = `+90555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const { sessionInfo } = await authPost('accounts:sendVerificationCode', { phoneNumber: phone, recaptchaToken: 'emulator' });
  const codes = await (await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/verificationCodes`)).json();
  const code = codes.verificationCodes.find((c) => c.sessionInfo === sessionInfo)?.code;
  const r = await authPost('accounts:signInWithPhoneNumber', { sessionInfo, code });
  return { uid: r.localId, idToken: r.idToken, phone };
}
async function call(name, data, user) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${user.idToken}` },
    body: JSON.stringify({ data }),
  });
  const body = await res.json();
  if (body.error) {
    const err = new Error(`${name}: ${body.error.status} ${body.error.message}`);
    err.details = body.error.details;
    throw err;
  }
  return body.result;
}
async function newUser(name) {
  const u = await signInPhone();
  const boot = await call('user_bootstrap', { display_name: name }, u);
  return { ...u, name, invite_code: boot.user.invite_code };
}
async function befriend(a, b) {
  await call('friend_request_send', { op_id: crypto.randomUUID(), via: 'invite_code', invite_code: b.invite_code }, a);
  const ids = [a.uid, b.uid].sort();
  await call('friend_request_respond', { op_id: crypto.randomUUID(), friendship_id: `${ids[0]}_${ids[1]}`, accept: true }, b);
}
const startShare = (sender, receivers, duration) =>
  call('share_start', { op_id: crypto.randomUUID(), receiver_ids: receivers.map((r) => r.uid), duration, time_zone: 'Europe/Istanbul' }, sender);

const apps = [];
async function clientFor(user, name) {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake-api-key', databaseURL: `https://${PROJECT}.firebaseio.com` }, name);
  apps.push(app);
  const db = getDatabase(app);
  connectDatabaseEmulator(db, H, 9000);
  if (user) {
    const auth = getAuth(app);
    connectAuthEmulator(auth, AUTH, { disableWarnings: true });
    const custom = await L.adminAuth().createCustomToken(user.uid);
    await signInWithCustomToken(auth, custom);
  }
  return { app, db };
}

// --- mobil benzeri örnekler ---------------------------------------------------------------------------
const DEVICE = (pct, charging = false) => ({ batteryLevel: pct / 100, isCharging: charging });
function sampleAt(lat, lng, ts) {
  const now = Date.now();
  const r = L.normalizeSample({ latitude: lat, longitude: lng, accuracy: 9, speed: 13.4, heading: 87, timestamp: ts }, { serverOffsetMs: 0, now });
  if (!r.ok) throw new Error(`örnek reddedildi: ${r.reason}`);
  return r.sample;
}
/** Mobil `toOutboxSample` ile aynı biçim (pipeline.ts): `recorded_at` = core `safeRecordedAt(cihaz, sunucu)`. */
function outboxSample(i, ts, hb, pct, deviceTs = ts) {
  return {
    lat: 41.0 + i * 0.0005,
    lng: 29.0 + i * 0.0007,
    accuracy: 10,
    speed_mps: 13.4,
    heading: 87,
    activity_state: 'automotive',
    battery_pct: pct,
    is_charging: false,
    timestamp: ts,
    recorded_at: L.safeRecordedAt(deviceTs, ts),
    hb,
  };
}
function memoryStore() {
  let data = L.emptyPersisted();
  return {
    load: async () => data,
    save: async (_prev, next) => {
      data = next;
    },
    count: async () => data.state.points.length,
    clear: async () => {
      data = L.emptyPersisted();
    },
  };
}
const shareTarget = (s) => ({ kind: 'share', share_id: s.share_id, receiver_id: s.receiver_id, share_mode: s.share_mode, expires_at: s.expires_at, started_at: s.started_at });
const linkTarget = (l, name) => ({ kind: 'link', token_hash: l.token_hash, share_mode: l.share_mode, expires_at: l.expires_at, sender_name: name, started_at: l.started_at });
const publishTarget = (s) => ({ share_id: s.share_id, receiver_id: s.receiver_id, share_mode: s.share_mode, expires_at: s.expires_at });

function counted(client) {
  const w = { calls: 0, paths: 0 };
  w.write = async (map) => {
    w.calls++;
    w.paths += Object.keys(map).length;
    await update(ref(client.db), map);
  };
  return w;
}

// --- web görüntüleyici (isteğe bağlı) ------------------------------------------------------------------
function waitPort(port, timeoutMs = 30000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, H, () => {
        s.end();
        resolve();
      });
      s.on('error', () => (Date.now() - t0 > timeoutMs ? reject(new Error(`port ${port} açılmadı`)) : setTimeout(tryOnce, 200)));
    };
    tryOnce();
  });
}
async function openViewer(token) {
  if (process.env.SKIP_WEB === '1' || !fs.existsSync(path.join(DIST, 'index.html'))) return null;
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return null;
  }
  const child = spawn('npx', ['vite', 'preview', '--outDir', DIST, '--port', String(WEB_PORT), '--strictPort', '--host', H], {
    cwd: WEB_DIR,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  child.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitPort(WEB_PORT);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'tr-TR', timezoneId: 'Europe/Istanbul' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://${H}:${WEB_PORT}/s/${token}`);
  return {
    page,
    errors,
    close: async () => {
      await browser.close().catch(() => undefined);
      try {
        process.kill(-child.pid);
      } catch {
        /* zaten kapalı */
      }
    },
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rules = fs.readFileSync(path.join(REPO, 'backend/database.rules.json'), 'utf8');
  const put = await fetch(`http://${H}:9000/.settings/rules.json?ns=${PROJECT}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
  if (!put.ok) throw new Error(`RTDB kuralları yüklenemedi: ${put.status}`);
  const adminDb = L.adminDb();
  const adminRtdb = L.adminRtdb();
  const val = async (p) => (await adminRtdb.ref(p).get()).val();
  let viewer = null;

  try {
    // =========================================================================================
    // A. Kurulum: Ayşe → Bora (süresiz), Ayşe → Can (haftalık), Ayşe → Ece (1 saat), QR bağlantısı (haftalık)
    // =========================================================================================
    const [ayse, bora, can, deniz, ece] = await Promise.all([newUser('Ayşe'), newUser('Bora'), newUser('Can'), newUser('Deniz'), newUser('Ece')]);
    await befriend(ayse, bora);
    await befriend(ayse, can);
    await befriend(ayse, deniz);
    await befriend(ayse, ece);
    const s1 = (await startShare(ayse, [bora], { kind: 'indefinite' })).shares[0];
    const s1Session = s1.session_id;
    const s2 = (await startShare(ayse, [can], { kind: 'weekly' })).shares[0];
    const s3 = (await startShare(ayse, [ece], { kind: 'preset', preset: 'h1' })).shares[0];
    const link = await call('link_share_create', { op_id: crypto.randomUUID(), duration: { kind: 'weekly' }, time_zone: 'Europe/Istanbul' }, ayse);
    const sender = await clientFor(ayse, 'ayse');
    const boraC = await clientFor(bora, 'bora');
    const canC = await clientFor(can, 'can');
    const anon = await clientFor(null, 'anon');
    const acl1 = await val(`share_acl/${s1.share_id}`);
    const lacl = await val(`link_acl/${link.token_hash}`);
    check('ACL aynaları started_at taşır (share_acl + link_acl)', acl1?.started_at === s1.started_at && lacl?.started_at === link.started_at, `share=${acl1?.started_at} link=${lacl?.started_at}`);
    check('süresiz paylaşım: share_mode indefinite, expires_at yok', s1.share_mode === 'indefinite' && s1.expires_at === null && acl1.expires_at === undefined);

    // =========================================================================================
    // B. Pakette hb: core plan (arka plan, araç, normal pil) → mobil yayıncılar
    // =========================================================================================
    const plan = L.selectTrackingPlan({ hasActiveOutgoingShare: true, appPhase: 'background', motion: 'driving', batteryPct: 64, isCharging: false });
    const hb = plan.row.heartbeatMs;
    check('core matrisi: arka plan/araç/normal → hb 2 dk, gönderim ≥ 10 sn', hb === 2 * MIN && plan.row.sendMinIntervalMs === 10_000, plan.reason);
    const t0 = Date.now();
    const fresh = sampleAt(41.0, 29.0, t0 - 300);
    const pubDeps = { write: (map) => update(ref(sender.db), map), refreshTargets: async () => [publishTarget(s1)] };
    const pub = await L.publishSample({ sample: fresh, device: DEVICE(64), senderId: ayse.uid, targets: [publishTarget(s1)], now: t0, activity: 'automotive', extras: { hb } }, pubDeps);
    check('mobil publishSample (hb ile) kurallardan geçti', pub.status === 'published' && !pub.retried, pub.status);
    const live0 = (await get(ref(boraC.db, `live_locations/${bora.uid}/${s1.share_id}`))).val();
    check('alıcı canlı pakette hb = 120000, q ve recorded_at YOK (taze yayın)', live0?.hb === hb && live0.q === undefined && live0.recorded_at === undefined, JSON.stringify({ hb: live0?.hb, q: live0?.q }));
    check('core DeliveredLocationSchema paketi kabul eder', L.DeliveredLocationSchema.safeParse(live0).success);
    check('core receiverStatusOf: taze paket → live', L.receiverStatusOf({ timestamp: live0.timestamp, server_ts: live0.server_ts, hb: live0.hb }, Date.now()) === 'live');
    check('hb sayesinde 5 dk sessizlik araçta (hb 2 dk) "delayed", masada (hb 15 dk) "recent" (yanlış alarm yok)', L.receiverStatusOf({ ...live0, hb }, live0.server_ts + 5 * MIN) === 'delayed' && L.receiverStatusOf({ ...live0, hb: 15 * MIN }, live0.server_ts + 5 * MIN) === 'recent');
    check('hb sınır dışı (5 sn) kural reddi', denied(await rejects(update(ref(sender.db, `live_locations/${bora.uid}/${s1.share_id}`), { hb: 5000 }))));

    const lt = { link_id: link.link_id, token_hash: link.token_hash, share_mode: link.share_mode, expires_at: link.expires_at, sender_name: L.linkSenderName('Ayşe') };
    const lpub = await L.publishLinkSample(
      { sample: fresh, device: DEVICE(64), targets: [lt], now: t0, extras: { hb } },
      { write: (map) => update(ref(sender.db), map), refreshTargets: async () => [lt], isAllowed: () => true },
    );
    const linkLive0 = (await get(ref(anon.db, `link_live/${link.token_hash}`))).val();
    check('mobil publishLinkSample (hb ile) → bağlantı paketi hb taşır, recorded_at yok', lpub.status === 'published' && linkLive0?.hb === hb && !('recorded_at' in linkLive0), lpub.status);
    check('core parseLinkLive hb’yi korur', L.parseLinkLive(linkLive0)?.hb === hb);

    viewer = await openViewer(link.token);
    if (viewer) {
      await viewer.page.waitForSelector('[data-testid=app][data-phase=live]', { timeout: 15000 });
      check('web görüntüleyici: gerçek RTDB hb paketi → data-status live', (await viewer.page.getAttribute('[data-testid=app]', 'data-status')) === 'live');
    }

    // =========================================================================================
    // C. Çevrimdışı: N nokta kuyruğa (mobil outboxRepo), bağlantı gelince çok yollu boşaltma
    // =========================================================================================
    const N = 12;
    const repoStore = memoryStore();
    const repo = L.createOutboxRepo(() => repoStore);
    await sleep(1500);
    const tEnd = Date.now() - 100;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const ts = Math.round(live0.timestamp + ((i + 1) * (tEnd - live0.timestamp)) / (N + 1));
      pts.push(outboxSample(i + 1, ts, hb, 40 - i, ts - 2000));
      await repo.enqueue(ayse.uid, pts[i], [shareTarget(s1), linkTarget(link, 'Ayşe')], ts);
    }
    check(`kuyrukta ${N} nokta (çevrimdışı; RTDB'ye yazılmadı)`, (await repo.pendingCount()) === N && (await val(`live_trail/${bora.uid}/${s1.share_id}`)) === null);
    const w1 = counted(sender);
    const t1 = Date.now();
    const flush = await repo.flush({
      uid: ayse.uid,
      now: t1,
      targets: [shareTarget(s1), linkTarget(link, 'Ayşe')],
      isAllowed: () => true,
      write: w1.write,
      lastLiveTs: live0.timestamp,
      force: true,
    });
    counts.flushMs = Date.now() - t1;
    check('boşaltma ok: N eşitlendi, kuyruk boş', flush.status === 'ok' && flush.synced === N && flush.pending === 0, JSON.stringify({ status: flush.status, synced: flush.synced, pending: flush.pending }));
    check('yazma sayısı: arkadaş canlı + bağlantı canlı + 1 iz partisi = 3 çağrı', w1.calls === 3 && w1.paths === 2 + N, `calls=${w1.calls} paths=${w1.paths}`);
    const live1 = (await get(ref(boraC.db, `live_locations/${bora.uid}/${s1.share_id}`))).val();
    const last = pts[N - 1];
    check('alıcı canlı: q = 1, recorded_at = cihaz saati, timestamp = en yeni kuyruk noktası, hb korunur', live1?.q === 1 && live1.recorded_at === last.recorded_at && live1.timestamp === last.timestamp && live1.hb === hb, JSON.stringify({ q: live1?.q, rec: live1?.recorded_at, ts: live1?.timestamp }));
    check('alıcı canlı: pil %29 (kuyruğun son noktası)', live1.battery_pct === 29);
    const trailRaw = (await get(ref(boraC.db, `live_trail/${bora.uid}/${s1.share_id}`))).val();
    const keys = Object.keys(trailRaw ?? {});
    const extraFields = new Set(Object.values(trailRaw ?? {}).flatMap((p) => Object.keys(p).filter((k) => !L.TRAIL_FIELDS.includes(k))));
    check(`alıcı izi okur: ${N} nokta, anahtar ^\\d{13}-\\d{3}$, yalnızca TRAIL_FIELDS, q = 1`, keys.length === N && keys.every((k) => /^\d{13}-\d{3}$/.test(k)) && extraFields.size === 0 && Object.values(trailRaw).every((p) => p.q === 1), `n=${keys.length} extra=${[...extraFields]}`);
    const trail = L.parseTrail(trailRaw);
    check('mobil parseTrail: sıralı, timestamp’ler kuyrukla aynı', trail.length === N && trail.every((p, i) => p.timestamp === pts[i].timestamp));
    const verified = L.lastVerifiedLocation(
      [...trail.map((p) => ({ ...p, hb })), { lat: live1.lat, lng: live1.lng, accuracy: live1.accuracy, timestamp: live1.timestamp, server_ts: live1.server_ts, battery_pct: live1.battery_pct, hb: live1.hb, q: live1.q }],
      Date.now(),
    );
    check('core lastVerifiedLocation: kuyruktan (fromQueue), durum live, etiket "Canlı · HH:MM · %29"', verified?.fromQueue === true && verified.status === 'live' && /^Canlı · \d{2}:\d{2} · %29$/.test(verified.label), verified?.label);
    const fixesNow = [{ lat: live1.lat, lng: live1.lng, accuracy: live1.accuracy, timestamp: live1.timestamp, server_ts: live1.server_ts, battery_pct: live1.battery_pct, hb: live1.hb, q: live1.q }];
    const later = L.lastVerifiedLocation(fixesNow, live1.server_ts + 10 * MIN);
    check('10 dk sessizlik (hb 2 dk): "Bağlantısı kopmuş olabilir" + "Son doğrulanmış konum · HH:MM · %29"', later?.status === 'offline_suspected' && later.statusText === 'Bağlantısı kopmuş olabilir' && /^Son doğrulanmış konum · \d{2}:\d{2} · %29$/.test(later.label), `${later?.statusText} | ${later?.label}`);
    const linkLive1 = (await get(ref(anon.db, `link_live/${link.token_hash}`))).val();
    check('bağlantı canlı: q = 1, hb var, recorded_at YOK, iz yok (link_trail düğümü yok)', linkLive1?.q === 1 && linkLive1.hb === hb && !('recorded_at' in linkLive1) && linkLive1.timestamp === last.timestamp && (await val('link_trail')) === null);
    if (viewer) {
      await viewer.page.waitForSelector('[data-testid=sync-note]', { timeout: 5000 }).catch(() => undefined);
      const note = await viewer.page.textContent('[data-testid=sync-note]').catch(() => '');
      check('web görüntüleyici: gerçek q = 1 paketi → "Bağlantı geri geldi" notu', /Bağlantı geri geldi/.test(note || ''), note || '(yok)');
      await viewer.page.screenshot({ path: path.join(OUT, 'web-synced-real.png') });
    }

    // Kural negatifleri
    const stale = L.toQueuedDeliveredWrite({ ...pts[0], id: '0000000000000-000', target_ids: [] }, shareTarget(s1), ayse.uid);
    check('eski kuyruk noktası yeni canlıyı ezemez (q = 1, timestamp < düğüm)', denied(await rejects(set(ref(sender.db, `live_locations/${bora.uid}/${s1.share_id}`), stale))));
    const beforeStart = s1.started_at - 5 * MIN;
    const preStartTrail = { v: 1, lat: 41, lng: 29, accuracy: 10, timestamp: beforeStart, recorded_at: beforeStart, q: 1, server_ts: { '.sv': 'timestamp' } };
    check('paylaşım başlangıcından eski iz noktası reddedilir (started_at alt sınırı)', denied(await rejects(update(ref(sender.db), { [`live_trail/${bora.uid}/${s1.share_id}/${String(beforeStart).padStart(13, '0')}-000`]: preStartTrail }))));
    const nowTs = Date.now() - 1000;
    const aheadTrail = { ...preStartTrail, timestamp: nowTs, recorded_at: nowTs + 2 * HOUR };
    const okTrail = { ...preStartTrail, timestamp: nowTs, recorded_at: L.safeRecordedAt(nowTs + 2 * HOUR, nowTs) };
    check('cihaz saati 2 sa ileri: ham recorded_at reddedilir, core safeRecordedAt değeri kabul edilir', denied(await rejects(update(ref(sender.db), { [`live_trail/${bora.uid}/${s1.share_id}/${nowTs}-900`]: aheadTrail }))) && (await rejects(update(ref(sender.db), { [`live_trail/${bora.uid}/${s1.share_id}/${nowTs}-901`]: okTrail }))) === null);
    await adminRtdb.ref(`live_trail/${bora.uid}/${s1.share_id}/${nowTs}-901`).remove();
    check('üçüncü kişi (Can) Bora’nın izini okuyamaz', denied(await rejects(get(ref(canC.db, `live_trail/${bora.uid}/${s1.share_id}`)))));
    check('gönderen (Ayşe) alıcının izini okuyamaz', denied(await rejects(get(ref(sender.db, `live_trail/${bora.uid}/${s1.share_id}`)))));
    check('alıcı (Bora) iz yazamaz', denied(await rejects(update(ref(boraC.db), { [`live_trail/${bora.uid}/${s1.share_id}/${nowTs}-902`]: okTrail }))));
    check('iz üst düğüme toplu set reddedilir', denied(await rejects(set(ref(sender.db, `live_trail/${bora.uid}/${s1.share_id}`), { [`${nowTs}-903`]: okTrail }))));

    // Büyük kuyruk: tavan + sıkıştırma + 200 yollu partiler (Ayşe → Can, haftalık). Fikstür: paylaşım 4 sa önce
    // başlamış gibi (Firestore + ACL started_at geri alınır); 2100 nokta 5 sn arayla ≈ 2,9 sa'lik tünel/kırsal yol.
    const back = Date.now() - 4 * HOUR;
    await adminDb.doc(`location_shares/${s2.share_id}`).update({ started_at: back });
    await adminRtdb.ref(`share_acl/${s2.share_id}/started_at`).set(back);
    await sleep(1500); // uzlaştırıcı (share_acl_reconciler) aynı değeri yazar
    check('fikstür: S2 started_at 4 sa geri (ACL aynası eşit)', (await val(`share_acl/${s2.share_id}/started_at`)) === back);
    const s2t = { ...s2, started_at: back };
    const bigStore = memoryStore();
    const big = L.createOutboxRepo(() => bigStore);
    const ENQ = 2100;
    const bigNow = Date.now();
    for (let i = 0; i < ENQ; i++) {
      const ts = bigNow - (ENQ - i) * 5000;
      await big.enqueue(ayse.uid, outboxSample(i, ts, hb, 50), [shareTarget(s2t)], ts);
    }
    const bigLoaded = await big.load();
    const kept = bigLoaded.state.points.length;
    counts.bigEnqueued = ENQ;
    counts.bigKept = kept;
    counts.bigThinned = bigLoaded.state.thinned;
    check(`kuyruk tavanı: ${ENQ} eklendi → ≤ ${L.OUTBOX_LIMITS.maxPoints} tutuldu (sıkıştırma)`, kept <= L.OUTBOX_LIMITS.maxPoints && bigLoaded.state.thinned > 0 && kept + bigLoaded.state.thinned === ENQ, `tutulan=${kept} seyreltilen=${bigLoaded.state.thinned}`);
    const w2 = counted(sender);
    const tb = Date.now();
    const bigFlush = await big.flush({ uid: ayse.uid, now: Date.now(), targets: [shareTarget(s2t)], isAllowed: () => true, write: w2.write, lastLiveTs: null, force: true });
    counts.bigFlushMs = Date.now() - tb;
    const bigTrail = Object.keys((await val(`live_trail/${can.uid}/${s2.share_id}`)) ?? {}).length;
    const expectedBatches = Math.ceil(kept / L.OUTBOX_LIMITS.maxPathsPerBatch);
    counts.bigBatches = w2.calls - 1;
    check(`büyük boşaltma: ${kept} nokta iz düğümünde, ${expectedBatches} parti (≤ ${L.OUTBOX_LIMITS.maxPathsPerBatch} yol) + 1 canlı`, bigFlush.status === 'ok' && bigFlush.synced === kept && bigTrail === kept && w2.calls === expectedBatches + 1, `iz=${bigTrail} çağrı=${w2.calls} süre=${counts.bigFlushMs} ms`);

    // =========================================================================================
    // D. Düşük pil: 16 → 14 → 13 → 21 (mobil stepLowBattery → battery_low_notify)
    // =========================================================================================
    let lbStates = {};
    const lbCalls = [];
    const outcomes = [];
    const tb0 = Date.now();
    for (const pct of [16, 14, 13, 21]) {
      const step = L.stepLowBattery(lbStates, [s1Session], pct, false, Date.now());
      lbStates = step.next;
      const action = step.fired.length ? 'fire' : step.rearmed.length ? 'rearm' : null;
      if (action) {
        const op = crypto.randomUUID();
        const r = await call('battery_low_notify', { op_id: op, session_id: s1Session, battery_pct: pct, is_charging: false }, ayse);
        lbCalls.push({ pct, action, op, r });
        outcomes.push(`${pct}:${action}:${r.status}`);
      } else outcomes.push(`${pct}:-`);
    }
    counts.batteryCalls = lbCalls.length;
    check('mobil tetikleyici: yalnızca 14 (fire) ve 21 (rearm) çağrı üretir; 16 ve 13 çağrı yok', outcomes.join(' ') === '16:- 14:fire:notified 13:- 21:rearm:rearmed', outcomes.join(' '));
    const fired = lbCalls.find((c) => c.action === 'fire');
    check('battery_low_notify %14: notified, 1 alıcı, core yanıt şeması', fired?.r.receivers === 1 && fired.r.armed === false && L.BatteryLowNotifyResponseSchema.safeParse(fired.r).success, JSON.stringify(fired?.r));
    const replay = await call('battery_low_notify', { op_id: fired.op, session_id: s1Session, battery_pct: 14, is_charging: false }, ayse);
    check('aynı op_id tekrarı: aynı yanıt (ikinci push yok)', replay.status === 'notified' && replay.server_now === fired.r.server_now);
    const doc1 = (await adminDb.doc(`battery_alerts/${ayse.uid}_${s1Session}`).get()).data();
    check('sunucu durumu: fired = 1, 21 sonrası armed = true', doc1?.fired === 1 && doc1.armed === true, JSON.stringify({ fired: doc1?.fired, armed: doc1?.armed }));
    // Sunucu korumaları: istemci kuralı atlasa bile 13 yeniden bildirmez (14 sonrası, yeniden kurmadan önce).
    const s4 = (await startShare(ayse, [deniz], { kind: 'indefinite' })).shares[0];
    const q14 = await call('battery_low_notify', { op_id: crypto.randomUUID(), session_id: s4.session_id, battery_pct: 14 }, ayse);
    const q13 = await call('battery_low_notify', { op_id: crypto.randomUUID(), session_id: s4.session_id, battery_pct: 13 }, ayse);
    const q21 = await call('battery_low_notify', { op_id: crypto.randomUUID(), session_id: s4.session_id, battery_pct: 21 }, ayse);
    const q14b = await call('battery_low_notify', { op_id: crypto.randomUUID(), session_id: s4.session_id, battery_pct: 14 }, ayse);
    check('sunucu tek başına: 14 notified → 13 suppressed/noop → 21 rearmed → 30 dk içinde 14 suppressed (tak-çıkar)', q14.status === 'notified' && ['suppressed', 'noop'].includes(q13.status) && q21.status === 'rearmed' && q14b.status === 'suppressed', [q14, q13, q21, q14b].map((r) => r.status).join(' → '));
    const notSender = await rejects(call('battery_low_notify', { op_id: crypto.randomUUID(), session_id: s1Session, battery_pct: 10 }, bora));
    check('başkasının oturumu için çağrı: share_not_active', /share_not_active|FAILED_PRECONDITION|NOT_FOUND|PERMISSION/i.test(`${notSender?.message} ${JSON.stringify(notSender?.details ?? {})}`), notSender?.message);
    const pushText = L.lowBatteryPushText('Ayşe', 14);
    check('push metni (core, backend ile aynı): "Ayşe\'nin pili azaldı" / "Pil %14. Konum daha seyrek güncellenecek."', pushText.title === "Ayşe'nin pili azaldı" && pushText.body === 'Pil %14. Konum daha seyrek güncellenecek.');
    counts.batteryMs = Date.now() - tb0;

    // =========================================================================================
    // E. Bekçi: duraksamış süresiz paylaşım dürtülür (sahte now + yakalayıcı push)
    // =========================================================================================
    const pushes = [];
    const allPushes = [];
    const send = async (uid, message) => {
      pushes.push({ uid, message });
      allPushes.push({ uid, message });
      return { sent: 1, removed: 0 };
    };
    const base = Date.now();
    const version0 = (await adminDb.doc(`location_shares/${s1.share_id}`).get()).data().version;
    const sw1 = await L.sweepStalls({ now: base + 50 * MIN, send, pruneTrails: false });
    check('bekçi +50 dk: uzun paylaşımlar denetlenir (1 saatlik Ece paylaşımı DIŞARIDA), S1 ve S2 duraksamış', sw1.stalled.includes(s1.share_id) && sw1.stalled.includes(s2.share_id) && !sw1.stalled.includes(s3.share_id), `checked=${sw1.checked} stalled=${sw1.stalled.length}`);
    const p1 = pushes.filter((p) => p.uid === ayse.uid);
    check('1. kaçırma: gönderene TEK sessiz resume_tracking (level 1, bildirim yok, oturumlar birleşik)', p1.length === 1 && p1[0].message.data.type === 'resume_tracking' && p1[0].message.data.level === '1' && !p1[0].message.notification && p1[0].message.data.session_ids.split(',').includes(s1Session) && p1[0].message.data.session_ids.split(',').includes(s2.session_id), JSON.stringify(p1[0]?.message.data));
    pushes.length = 0;
    const sw2 = await L.sweepStalls({ now: base + 81 * MIN, send, pruneTrails: false });
    const types2 = pushes.filter((p) => p.uid === ayse.uid).map((p) => `${p.message.data.type}:${p.message.data.level ?? ''}`).sort();
    const visible = pushes.find((p) => p.message.data.type === 'tracking_stalled');
    check('2. kaçırma (+31 dk): resume_tracking level 2 + görünür tracking_stalled', types2.join(',') === 'resume_tracking:2,tracking_stalled:' && visible?.message.notification?.body === 'Konum paylaşımın duraksadı. Devam etmek için dokun.', types2.join(','));
    pushes.length = 0;
    await L.sweepStalls({ now: base + 95 * MIN, send, pruneTrails: false });
    check('+95 dk: yeni push yok (sonraki en erken 6 sa)', pushes.length === 0, `push=${pushes.length}`);
    const sDoc = (await adminDb.doc(`location_shares/${s1.share_id}`).get()).data();
    check('stall_nudges kaydı {count 2, visible 1}, sürüm değişmedi', sDoc.stall_nudges?.count === 2 && sDoc.stall_nudges.visible === 1 && sDoc.version === version0, JSON.stringify({ n: sDoc.stall_nudges, v: sDoc.version }));
    check('bekçi push’ları koordinat taşımaz', allPushes.length >= 3 && allPushes.every((p) => !/"lat"|"lng"|accuracy/.test(JSON.stringify(p.message))), `push=${allPushes.length}`);
    // Uyanan cihaz taze kalp atışı yayınlar → kapanış
    const pub2 = await L.publishSample({ sample: sampleAt(41.01, 29.01, Date.now() - 200), device: DEVICE(21), senderId: ayse.uid, targets: [publishTarget(s1)], now: Date.now(), activity: 'automotive', extras: { hb } }, pubDeps);
    pushes.length = 0;
    const sw4 = await L.sweepStalls({ now: Date.now() + MIN, send, pruneTrails: false });
    const sDoc2 = (await adminDb.doc(`location_shares/${s1.share_id}`).get()).data();
    check('taze paket sonrası: dönem kapanır (recovered_at), push yok', pub2.status === 'published' && sw4.recovered.includes(s1.share_id) && typeof sDoc2.stall_nudges?.recovered_at === 'number' && pushes.length === 0, `recovered=${sw4.recovered.length}`);
    counts.watchdogSweeps = 4;

    // =========================================================================================
    // F. Durdurma: canlı + iz silinir, geç boşaltma reddedilir; bağlantı da
    // =========================================================================================
    const lateStore = memoryStore();
    const late = L.createOutboxRepo(() => lateStore);
    for (let i = 0; i < 3; i++) {
      const ts = Date.now() - 300 + i * 50;
      await late.enqueue(ayse.uid, outboxSample(50 + i, ts, hb, 20), [shareTarget(s1), linkTarget(link, 'Ayşe')], ts);
    }
    const ts0 = Date.now();
    await call('share_stop', { op_id: crypto.randomUUID(), session_id: s1Session }, ayse);
    await call('link_share_stop', { op_id: crypto.randomUUID(), link_id: link.link_id }, ayse);
    counts.stopMs = Date.now() - ts0;
    const goneLive = await val(`live_locations/${bora.uid}/${s1.share_id}`);
    const goneTrail = await val(`live_trail/${bora.uid}/${s1.share_id}`);
    const goneLink = await val(`link_live/${link.token_hash}`);
    check('durdurma: alıcının canlı kopyası VE izi silindi; bağlantı canlı düğümü silindi', goneLive === null && goneTrail === null && goneLink === null);
    check('alıcı istemci: canlı ve iz boş', (await get(ref(boraC.db, `live_locations/${bora.uid}/${s1.share_id}`))).val() === null && (await rejects(get(ref(boraC.db, `live_trail/${bora.uid}/${s1.share_id}`)))) === null);
    const w3 = counted(sender);
    const lateFlush = await late.flush({ uid: ayse.uid, now: Date.now(), targets: [shareTarget(s1), linkTarget(link, 'Ayşe')], isAllowed: () => true, write: w3.write, lastLiveTs: null, force: true });
    check('geç boşaltma (uygulama durdurmayı henüz bilmiyor): tüm yazmalar kural reddi, hiçbir şey yazılmadı', lateFlush.status === 'partial' && denied(lateFlush.error) && lateFlush.synced === 0 && (await val(`live_trail/${bora.uid}/${s1.share_id}`)) === null && (await val(`live_locations/${bora.uid}/${s1.share_id}`)) === null && (await val(`link_live/${link.token_hash}`)) === null, `status=${lateFlush.status} pending=${lateFlush.pending}`);
    counts.lateFlushDeniedWrites = w3.calls;
    const w3b = counted(sender);
    const dropFlush = await late.flush({ uid: ayse.uid, now: Date.now(), targets: [], isAllowed: () => true, write: w3b.write, lastLiveTs: null, force: true });
    check('hedef bitti öğrenilince: kuyruk noktaları atılır (gizlilik), ağ çağrısı yok', dropFlush.dropped === 3 && dropFlush.pending === 0 && w3b.calls === 0, `dropped=${dropFlush.dropped} calls=${w3b.calls}`);
    if (viewer) {
      await viewer.page.waitForSelector('[data-testid=app][data-phase=ended]', { timeout: 5000 }).catch(() => undefined);
      check('web görüntüleyici: durdurmada "ended"', (await viewer.page.getAttribute('[data-testid=app]', 'data-phase')) === 'ended');
      check('web görüntüleyici: sayfa hatası yok', viewer.errors.length === 0, viewer.errors.join(' | '));
    }

    // Aynı çift için yeni oturum: önceki oturumun kuyruk noktası yeni started_at'ten eski → planFlush atar.
    const oldTs = Date.now() - 200;
    const carryStore = memoryStore();
    const carry = L.createOutboxRepo(() => carryStore);
    await carry.enqueue(ayse.uid, outboxSample(90, oldTs, hb, 30), [shareTarget(s1)], oldTs);
    await sleep(50);
    const s1b = (await startShare(ayse, [bora], { kind: 'indefinite' })).shares[0];
    check('aynı çift → aynı share_id, yeni started_at', s1b.share_id === s1.share_id && s1b.started_at > oldTs);
    const rawOld = L.toQueuedDeliveredWrite({ ...outboxSample(90, oldTs, hb, 30), id: `${oldTs}-000`, target_ids: [] }, shareTarget(s1b), ayse.uid);
    check('kural: eski oturumun q noktası yeni oturuma yazılamaz', denied(await rejects(set(ref(sender.db, `live_locations/${bora.uid}/${s1.share_id}`), rawOld))));
    const w4 = counted(sender);
    const carryFlush = await carry.flush({ uid: ayse.uid, now: Date.now(), targets: [shareTarget(s1b)], isAllowed: () => true, write: w4.write, lastLiveTs: null, force: true });
    check('mobil started_at dolu → eski nokta atılır, ret yok', carryFlush.status === 'ok' && carryFlush.dropped === 1 && w4.calls === 0, JSON.stringify({ s: carryFlush.status, d: carryFlush.dropped, c: w4.calls }));

    // İz budama (24 sa): bekçi aynı turda budar (S2 izi)
    const sw5 = await L.sweepStalls({ now: Date.now() + 25 * HOUR, send: async () => ({ sent: 0, removed: 0 }), pruneTrails: true });
    const left = Object.keys((await val(`live_trail/${can.uid}/${s2.share_id}`)) ?? {}).length;
    counts.pruned = sw5.pruned_trail_points;
    check('bekçi +25 sa: 24 saatten eski iz noktaları budanır (tur başına ≤ 500)', sw5.pruned_trail_points === Math.min(500, kept) && left === kept - Math.min(500, kept), `budanan=${sw5.pruned_trail_points} kalan=${left}`);
  } finally {
    if (viewer) await viewer.close();
    for (const a of apps) await deleteApp(a).catch(() => undefined);
    await L.closeAdmin().catch(() => undefined);
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    const summary = { total: results.length, passed: results.length - failed.length, failed: failed.length, counts };
    fs.writeFileSync(path.join(OUT, 'faz3-results.json'), JSON.stringify({ summary, results }, null, 2));
    console.log(`\nFaz 3 e2e: ${summary.passed}/${summary.total} denetim geçti ${JSON.stringify(counts)}`);
    process.exit(failed.length ? 1 : 0);
  })
  .catch((e) => {
    console.error('Faz 3 e2e çöktü:', e);
    process.exit(2);
  });
