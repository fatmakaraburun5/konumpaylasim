/**
 * Faz 2 entegrasyon e2e (kabul testleri): GERÇEK emülatörler (auth, firestore, database, functions + otomatik
 * Cloud Tasks) + GERÇEK web derlemesi (VITE_USE_EMULATORS=1, `vite preview` :8211) + Playwright.
 * Gönderen tarafı mobil uygulamanın kendi kodudur (mobil `publishLinkSample` + `LinkDocSchema`, core
 * `normalizeSample` / `selectLinkPublishTargets`): istemci SDK'sıyla, kimliği doğrulanmış kullanıcı olarak,
 * RTDB/Firestore kuralları UYGULANARAK yazar ve okur.
 *
 * Kabul ölçütleri: doğru token canlı konumu görür; yanlış token okuyamaz; "Paylaşımı Durdur" sonrası açık sekme
 * 2 sn içinde "Paylaşım sona erdi" der ve pin kalkar; süre dolunca okuma ve yazma reddedilir; aynı op_id ile
 * tekrarlanan oluşturma token'ı yeniler ve eski token'lı sekmeyi kapatır.
 *
 * Çalıştırma: bkz. e2e/run-emulator.sh (emulators:exec içinden).
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const H = '127.0.0.1';
const PROJECT = 'demo-konum';
const WEB_DIR = path.resolve(__dirname, '..');
const REPO = path.resolve(WEB_DIR, '../..');
const OUT = path.resolve(process.env.OUT || path.join(WEB_DIR, 'e2e-output'));
const DIST = path.resolve(WEB_DIR, process.env.DIST || 'dist-emu');
const WEB_PORT = Number(process.env.WEB_PORT || 8211);
const ORIGIN = `http://${H}:${WEB_PORT}`;
const FUNCTIONS = `http://${H}:5001/${PROJECT}/europe-west1`;
const AUTH = `http://${H}:9099`;
const STOP_BUDGET_MS = 2000;

process.env.GCLOUD_PROJECT ??= PROJECT;
process.env.FIRESTORE_EMULATOR_HOST ??= `${H}:8080`;
process.env.FIREBASE_DATABASE_EMULATOR_HOST ??= `${H}:9000`;
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `${H}:9099`;
process.env.METADATA_SERVER_DETECTION ??= 'none';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT, databaseURL: `http://${H}:9000/?ns=${PROJECT}` });

const L = require(path.join(WEB_DIR, 'e2e-output/integration/lib.cjs'));
const { chromium } = require('playwright');
const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require('firebase/auth');
const { getDatabase, connectDatabaseEmulator, ref, get, set, update } = require('firebase/database');
const { getFirestore, connectFirestoreEmulator, collection, query, where, getDocs } = require('firebase/firestore');

const results = [];
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

// --- Auth emülatörü (backend/test/helpers/emulator.ts ile aynı protokol) --------------------------------
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

// --- İstemci SDK (mobil uygulamanın yaptığı gibi: kimlikli istemci, kurallar uygulanır) --------------------
const apps = [];
async function clientFor(user, name) {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake-api-key', databaseURL: `https://${PROJECT}.firebaseio.com` }, name);
  apps.push(app);
  const db = getDatabase(app);
  connectDatabaseEmulator(db, H, 9000);
  const fs_ = getFirestore(app);
  connectFirestoreEmulator(fs_, H, 8080);
  if (user) {
    const auth = getAuth(app);
    connectAuthEmulator(auth, AUTH, { disableWarnings: true });
    const custom = await L.adminAuth().createCustomToken(user.uid);
    const cred = await signInWithCustomToken(auth, custom);
    if (cred.user.uid !== user.uid) throw new Error('istemci kimliği eşleşmedi');
  }
  return { app, db, fs: fs_ };
}

/** Mobil `publisherDeps` ile aynı bağımlılıklar: RTDB update + Firestore'dan tazeleme (sender_id == ben). */
function publisherDeps(client, uid, blocked = new Set()) {
  return {
    write: (map) => update(ref(client.db), map),
    refreshTargets: async () => {
      const snap = await getDocs(query(collection(client.fs, 'link_shares'), where('sender_id', '==', uid)));
      return snap.docs
        .map((d) => L.LinkDocSchema.safeParse({ link_id: d.id, ...d.data() }))
        .filter((r) => r.success && r.data.status === 'active')
        .map((r) => ({ link_id: r.data.link_id, token_hash: r.data.token_hash, share_mode: r.data.share_mode, expires_at: r.data.expires_at }));
    },
    isAllowed: (id) => !blocked.has(id),
  };
}
async function serverViews(client, uid) {
  const snap = await getDocs(query(collection(client.fs, 'link_shares'), where('sender_id', '==', uid)));
  return snap.docs.map((d) => L.LinkDocSchema.parse({ link_id: d.id, ...d.data() })).map(L.toLinkView);
}
function sampleAt(lat, lng, now = Date.now()) {
  const r = L.normalizeSample({ latitude: lat, longitude: lng, accuracy: 12.4, speed: 1.31, heading: 118.2, timestamp: now - 400 }, { serverOffsetMs: 0, now });
  if (!r.ok) throw new Error(`örnek reddedildi: ${r.reason}`);
  return r.sample;
}
const DEVICE = { batteryLevel: 0.64, isCharging: false };

// --- Web sunucusu (vite preview, SPA geri dönüşü /s/<token> → index.html) --------------------------------
function waitPort(port, timeoutMs = 30000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, H, () => {
        s.end();
        resolve();
      });
      s.on('error', () => {
        if (Date.now() - t0 > timeoutMs) reject(new Error(`port ${port} açılmadı`));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}
function startPreview() {
  const child = spawn('npx', ['vite', 'preview', '--outDir', DIST, '--port', String(WEB_PORT), '--strictPort', '--host', H], {
    cwd: WEB_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  return child;
}

const phaseOf = (page) => page.getAttribute('[data-testid=app]', 'data-phase');
const waitPhase = (page, p, timeout = 10000) => page.waitForSelector(`[data-testid=app][data-phase=${p}]`, { timeout });

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // RTDB kuralları (backend testleriyle aynı: firebase.json'daki dosya, ad alanı = proje).
  const rules = fs.readFileSync(path.join(REPO, 'backend/database.rules.json'), 'utf8');
  const put = await fetch(`http://${H}:9000/.settings/rules.json?ns=${PROJECT}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
  if (!put.ok) throw new Error(`RTDB kuralları yüklenemedi: ${put.status}`);

  const preview = startPreview();
  await waitPort(WEB_PORT);
  const browser = await chromium.launch();
  const ctxOpts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'tr-TR', timezoneId: 'Europe/Istanbul', colorScheme: 'light' };
  const context = await browser.newContext(ctxOpts);
  const pageErrors = [];
  const consoleErrors = [];

  try {
    // =========================================================================================
    // A. Gönderen: giriş, bağlantı oluşturma, mobil yayıncıyla ilk konum
    // =========================================================================================
    const ayse = await signInPhone();
    await call('user_bootstrap', { display_name: 'Ayşe' }, ayse);
    const sender = await clientFor(ayse, 'sender');
    const anon = await clientFor(null, 'anon');

    const opId = crypto.randomUUID();
    const created = await call('link_share_create', { op_id: opId, duration: { kind: 'preset', preset: 'h1' }, time_zone: 'Europe/Istanbul' }, ayse);
    const parsedCreate = L.LinkShareCreateResponseSchema.safeParse(created);
    check('link_share_create yanıtı core LinkShareCreateResponseSchema ile geçerli', parsedCreate.success, parsedCreate.success ? '' : JSON.stringify(parsedCreate.error.issues));
    const { token, token_hash: hash, link_id: linkId } = created;
    check('token 43 karakter base64url, token_hash = sha256(token)', /^[A-Za-z0-9_-]{43}$/.test(token) && L.linkTokenHash(token) === hash && crypto.createHash('sha256').update(token).digest('hex') === hash);
    check('URL biçimi https://konum.example.com/s/<token>', created.url === `https://konum.example.com/s/${token}` && created.url === L.buildLinkUrl('konum.example.com', token), created.url.replace(token, '<token>'));
    check('core parseLinkToken: https, konum://s/ ve konum:///s/ aynı token', [created.url, `konum://s/${token}`, `konum:///s/${token}`].every((u) => L.parseLinkToken(u, ['konum.example.com']) === token));
    check('başka alan adı reddedilir', L.parseLinkToken(`https://evil.example.org/s/${token}`, ['konum.example.com']) === null);
    const deep = L.resolveLinkParam(created.url, ['konum.example.com']);
    check('mobil app/s/[token] çözümü (resolveLinkParam) aynı özet', deep && deep.token === token && deep.hash === hash);
    check('1 saat: share_mode timed, expires_at ≈ şimdi + 60 dk', created.share_mode === 'timed' && Math.abs(created.expires_at - (created.server_now + 3600_000)) < 2000);

    // Düz token sunucuda saklanmaz.
    const adminDb = L.adminDb();
    const linkDoc = (await adminDb.collection('link_shares').doc(linkId).get()).data();
    const opDoc = (await adminDb.collection('ops').doc(`${ayse.uid}_${opId}`).get()).data();
    check('Firestore link_shares belgesinde düz token YOK (yalnızca token_hash)', linkDoc && linkDoc.token_hash === hash && !JSON.stringify(linkDoc).includes(token));
    check('ops tekilleştirme kaydında düz token/URL YOK', opDoc && !JSON.stringify(opDoc).includes(token) && opDoc.response.token_omitted === true);

    // link_acl aynası (istemciye kapalı) — sunucunun yazdığı biçim core LinkAclActive ile aynı.
    const acl = (await L.adminRtdb().ref(`link_acl/${hash}`).get()).val();
    const aclKeys = Object.keys(acl).sort().join(',');
    // Faz 3: aktif ayna ayrıca started_at taşır (q / iz alt sınırı; yalnızca ekleme).
    check('link_acl aktif: {status, sender_id, link_id, share_mode, expires_at, version, started_at}', aclKeys === 'expires_at,link_id,sender_id,share_mode,started_at,status,version' && acl.status === 'active' && acl.sender_id === ayse.uid && acl.started_at === created.started_at, aclKeys);
    check('link_acl istemciye kapalı (kimliksiz ve gönderen okuyamaz)', denied(await rejects(get(ref(anon.db, `link_acl/${hash}`)))) && denied(await rejects(get(ref(sender.db, `link_acl/${hash}`)))));

    // Gönderen kendi belgesini okur (kurallar: sender_id == auth.uid sorgusu), mobil LinkDocSchema ile.
    const views = await serverViews(sender, ayse.uid);
    check('istemci link_shares sorgusu (sender_id == ben) + mobil LinkDocSchema', views.length === 1 && views[0].token_hash === hash && views[0].version === created.version);
    const mehmet = await signInPhone();
    await call('user_bootstrap', { display_name: 'Mehmet' }, mehmet);
    const other = await clientFor(mehmet, 'other');
    const otherRead = await rejects(getDocs(query(collection(other.fs, 'link_shares'), where('sender_id', '==', ayse.uid))));
    check('başka kullanıcı Ayşe’nin link_shares kayıtlarını okuyamaz', otherRead && /permission/i.test(String(otherRead.code ?? otherRead.message)));

    // Mobil yayıncı: core selectLinkPublishTargets → publishLinkSample → RTDB update (kurallar uygulanır).
    let targets = L.selectLinkPublishTargets(views, L.linkSenderName('Ayşe'), Date.now());
    const deps = publisherDeps(sender, ayse.uid);
    const pub1 = await L.publishLinkSample({ sample: sampleAt(40.98712, 29.02561), device: DEVICE, targets, now: Date.now() }, deps);
    check('mobil publishLinkSample ilk yazma: published (kurallardan geçti)', pub1.status === 'published' && !pub1.retried && pub1.paths[0] === `link_live/${hash}`, pub1.status);

    const stored = (await L.adminRtdb().ref(`link_live/${hash}`).get()).val();
    const extra = Object.keys(stored).filter((k) => !L.LINK_LIVE_FIELDS.includes(k));
    check('link_live paketi yalnızca core LINK_LIVE_FIELDS (sender_id/link_id/telefon yok)', extra.length === 0 && !('sender_id' in stored), Object.keys(stored).sort().join(','));
    check('server_ts sunucu zamanı, expires_at ACL ile aynı', typeof stored.server_ts === 'number' && stored.expires_at === acl.expires_at && stored.sender_name === 'Ayşe');
    const anonLive = await get(ref(anon.db, `link_live/${hash}`));
    check('token sahibi (kimliksiz) okur, core parseLinkLive geçerli', L.parseLinkLive(anonLive.val())?.sender_name === 'Ayşe');

    // Kural negatifleri.
    check('başka kullanıcı link_live yazamaz', denied(await rejects(set(ref(other.db, `link_live/${hash}`), { ...stored, server_ts: { '.sv': 'timestamp' } }))));
    check('gönderen fazladan alan (sender_id) yazamaz', denied(await rejects(update(ref(sender.db, `link_live/${hash}`), { sender_id: ayse.uid }))));
    check('gönderen farklı expires_at yazamaz', denied(await rejects(update(ref(sender.db, `link_live/${hash}`), { expires_at: stored.expires_at + 1 }))));
    check('kimliksiz kullanıcı link_live listesini okuyamaz', denied(await rejects(get(ref(anon.db, 'link_live')))));

    // =========================================================================================
    // B. Web: canlı görünüm
    // =========================================================================================
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    const requestUrls = [];
    const wsSent = [];
    page.on('request', (r) => requestUrls.push(r.url()));
    page.on('websocket', (ws) => ws.on('framesent', (f) => wsSent.push(String(f.payload))));
    await page.goto(`${ORIGIN}/s/${token}`);
    await waitPhase(page, 'live', 15000);
    check('web: canlı durum, gönderen adı "Ayşe"', (await page.textContent('[data-testid=sender-name]'))?.trim() === 'Ayşe');
    check('web: haritada pin var', (await page.locator('.pin').count()) >= 1);
    check('web: token adres çubuğundan silindi (/s/canli)', new URL(page.url()).pathname === '/s/canli');
    const untilBefore = (await page.textContent('[data-testid=until]'))?.trim();
    check('web: bitiş satırı "HH:MM\'e kadar"', /\d{2}:\d{2}'(e|a|ye|ya) kadar/.test(untilBefore ?? ''), untilBefore);
    await page.waitForTimeout(900); // pin animasyonu otursun
    await page.screenshot({ path: path.join(OUT, 'web-live.png') });

    // Yeni konum: aynı sekme güncellenir.
    const t1 = Date.now();
    const pub2 = await L.publishLinkSample({ sample: sampleAt(40.98689, 29.02634), device: DEVICE, targets, now: Date.now() }, deps);
    await page.waitForFunction(() => document.querySelector('[data-testid=maps-link]')?.getAttribute('href')?.includes('40.98689'), null, { timeout: 5000 });
    check('web: yeni konum aynı sekmeye geldi', pub2.status === 'published', `${Date.now() - t1} ms`);

    // =========================================================================================
    // C. Uzatma (+30 dk): ayna + saklanan paket eşitlenir; eski bitişle yazan yayıncı tazeleyip yeniden dener
    // =========================================================================================
    const ext = await call('link_share_extend', { op_id: crypto.randomUUID(), link_id: linkId, minutes: 30 }, ayse);
    check('link_share_extend +30 dk: core şeması, bitiş +30 dk, version+1', L.LinkShareUpdateResponseSchema.safeParse(ext).success && ext.expires_at === created.expires_at + 30 * 60_000 && ext.version === created.version + 1 && ext.extended_count === 1);
    await page.waitForFunction((before) => document.querySelector('[data-testid=until]')?.textContent?.trim() !== before, untilBefore, { timeout: 5000 });
    check('web: açık sekmede bitiş saati güncellendi (sunucu paketi eşitledi)', true, `${untilBefore} → ${(await page.textContent('[data-testid=until]'))?.trim()}`);
    const pub3 = await L.publishLinkSample({ sample: sampleAt(40.98671, 29.02702), device: DEVICE, targets, now: Date.now() }, deps);
    check('eski bitişli hedef: PERMISSION_DENIED → link_shares tazele → tek tekrar → published', pub3.status === 'published' && pub3.retried === true, pub3.status);
    targets = pub3.targets;

    // =========================================================================================
    // D. Yanlış ve bozuk token
    // =========================================================================================
    const wrong = await context.newPage();
    await wrong.goto(`${ORIGIN}/s/${crypto.randomBytes(32).toString('base64url')}`);
    await waitPhase(wrong, 'unavailable', 15000);
    const wrongTitle = (await wrong.textContent('[data-testid=status-title]'))?.trim();
    check('yanlış token: okuyamaz, "Bağlantı geçersiz ya da süresi dolmuş"', wrongTitle === L.LINK_VIEW_TEXT.unavailable, wrongTitle);
    await wrong.screenshot({ path: path.join(OUT, 'web-wrong-token.png') });
    await wrong.goto(`${ORIGIN}/s/bozuk-token`);
    await waitPhase(wrong, 'invalid', 10000);
    check('bozuk token: "Bağlantı geçersiz" (ağa hiç çıkmadan)', (await wrong.textContent('[data-testid=status-title]'))?.trim() === L.LINK_VIEW_TEXT.invalid);
    await wrong.close();

    // =========================================================================================
    // E. Paylaşımı Durdur: açık sekme 2 sn içinde "Paylaşım sona erdi", pin kalkar
    // =========================================================================================
    const tStop = Date.now();
    const stopped = await call('link_share_stop', { op_id: crypto.randomUUID(), link_id: linkId }, ayse);
    const tReturned = Date.now();
    await waitPhase(page, 'ended', 5000);
    const dtStop = Date.now() - tStop;
    check(`durdurunca ${STOP_BUDGET_MS} ms içinde "Paylaşım sona erdi" (çağrı başından)`, dtStop <= STOP_BUDGET_MS && (await page.textContent('[data-testid=status-title]'))?.trim() === L.LINK_VIEW_TEXT.ended, `${dtStop} ms (callable ${tReturned - tStop} ms)`);
    check('link_share_stop yanıtı: ended / stopped_by_sender', stopped.status === 'ended' && stopped.end_reason === 'stopped_by_sender');
    check('web: pin kalktı', (await page.locator('.pin').count()) === 0);
    await page.screenshot({ path: path.join(OUT, 'web-ended.png') });

    const tomb = (await L.adminRtdb().ref(`link_acl/${hash}`).get()).val();
    check('link_acl mezar taşı {status:ended, version, ended_at, end_reason}', tomb?.status === 'ended' && tomb.end_reason === 'stopped_by_sender' && !('sender_id' in tomb), Object.keys(tomb ?? {}).sort().join(','));
    check('link_live silindi', (await L.adminRtdb().ref(`link_live/${hash}`).get()).val() === null);
    check('durdurulan bağlantı: yeni okuma reddedilir', denied(await rejects(get(ref(anon.db, `link_live/${hash}`)))));
    const pub4 = await L.publishLinkSample({ sample: sampleAt(40.9866, 29.0275), device: DEVICE, targets, now: Date.now() }, deps);
    check('durdurulduktan sonra yayıncı: ret → tazele → no_active_targets (yazma yok)', pub4.status === 'no_active_targets' && pub4.dropped[0] === linkId, pub4.status);
    check('durdurulduktan sonra gönderen yazamaz (kural)', denied(await rejects(set(ref(sender.db, `link_live/${hash}`), { ...stored, server_ts: { '.sv': 'timestamp' }, timestamp: Date.now() }))));

    await page.reload();
    await page.waitForFunction(() => ['unavailable', 'ended'].includes(document.querySelector('[data-testid=app]')?.dataset.phase || ''), null, { timeout: 10000 });
    check('aynı sekmede yenileme (token sekme deposunda): artık okunamaz → unavailable', (await phaseOf(page)) === 'unavailable');

    // Ağ: token yalnızca ilk belge isteğinde (adres), sonra ASLA; RTDB'ye yalnızca özet gider.
    const leaks = requestUrls.slice(1).filter((u) => u.includes(token));
    check('web: token ilk sayfa isteğinden sonra hiçbir isteğe/çerçeveye çıkmadı', leaks.length === 0 && !wsSent.some((f) => f.includes(token)));
    check('web: RTDB dinlemesi özetle (link_live/<hash>)', wsSent.some((f) => f.includes(`link_live/${hash}`)));
    check('web: üçüncü taraf istek yok (yalnızca sayfa + RTDB emülatörü)', requestUrls.every((u) => u.startsWith(ORIGIN) || u.startsWith(`http://${H}:9000`) || u.startsWith(`ws://${H}:9000`)), [...new Set(requestUrls.map((u) => new URL(u).origin))].join(' '));

    // =========================================================================================
    // F. Süre dolumu: 15 dk bağlantı, bitiş yönetici SDK'sıyla şimdi+4 sn'ye çekilir (test kancası)
    // =========================================================================================
    const c15 = await call('link_share_create', { op_id: crypto.randomUUID(), duration: { kind: 'preset', preset: 'm15' }, time_zone: 'Europe/Istanbul' }, ayse);
    check('15 dk bağlantı: expires_at ≈ şimdi + 15 dk', c15.share_mode === 'timed' && Math.abs(c15.expires_at - (c15.server_now + 15 * 60_000)) < 2000);
    let t15 = L.selectLinkPublishTargets(await serverViews(sender, ayse.uid), L.linkSenderName('Ayşe'), Date.now());
    check('yalnızca aktif bağlantı hedef (durdurulan dışarıda)', t15.length === 1 && t15[0].link_id === c15.link_id);
    const p15 = await L.publishLinkSample({ sample: sampleAt(40.9902, 29.0291), device: DEVICE, targets: t15, now: Date.now() }, deps);
    check('15 dk bağlantıya yazma: published', p15.status === 'published');
    const viewer = await context.newPage();
    await viewer.goto(`${ORIGIN}/s/${c15.token}`);
    await waitPhase(viewer, 'live', 15000);

    const T = Date.now() + 4000;
    await adminDb.collection('link_shares').doc(c15.link_id).update({ expires_at: T });
    await L.adminRtdb().ref(`link_acl/${c15.token_hash}/expires_at`).set(T);
    // Yayıncı eski bitişle yazar → ret → Firestore'dan yeni bitiş → tekrar (paket artık T taşır).
    const p15b = await L.publishLinkSample({ sample: sampleAt(40.9905, 29.0296), device: DEVICE, targets: t15, now: Date.now() }, deps);
    check('bitiş değişince yayıncı tazeleyip yeni bitişle yazar', p15b.status === 'published' && p15b.retried && p15b.targets[0].expires_at === T);
    await viewer.waitForSelector('[data-testid=app][data-phase=ended]', { timeout: T - Date.now() + 3000 });
    const lateMs = Date.now() - T;
    check('süre dolunca açık sekme "Paylaşım sona erdi" (istemci saatiyle)', lateMs < 2000, `bitişten ${lateMs} ms sonra`);
    check('süre dolunca yeni okuma reddedilir (RTDB kuralı expires_at > now)', denied(await rejects(get(ref(anon.db, `link_live/${c15.token_hash}`)))));
    check('süre dolunca gönderen yazamaz', denied(await rejects(update(ref(sender.db, `link_live/${c15.token_hash}`), { lat: 40.99, server_ts: { '.sv': 'timestamp' }, timestamp: Date.now() }))));
    const fresh = await context.newPage();
    await fresh.goto(`${ORIGIN}/s/${c15.token}`);
    await waitPhase(fresh, 'unavailable', 15000);
    check('süresi dolmuş bağlantı yeni sekmede: unavailable', true);
    await fresh.close();

    // Sunucu tarafı kapanış: süre dolumu görevi (Cloud Tasks emülatörü, bitiş değişince uzlaştırıcı yeniden kurar)
    // ya da dakikalık tarayıcı (sweepExpired). Hangisi önce gelirse: Firestore ended/expired → mezar taşı → link_live silinir.
    const sw = await L.sweepExpired({ now: Date.now() });
    const doc15 = (await adminDb.collection('link_shares').doc(c15.link_id).get()).data();
    const tomb15 = (await L.adminRtdb().ref(`link_acl/${c15.token_hash}`).get()).val();
    const live15 = (await L.adminRtdb().ref(`link_live/${c15.token_hash}`).get()).val();
    const closer = sw.ended_link_ids.includes(c15.link_id) ? 'dakikalık tarayıcı' : 'süre dolumu görevi (Cloud Tasks)';
    check(
      'süre dolumu sunucuda: link_shares ended/expired, ACL mezar taşı, link_live silindi',
      doc15.status === 'ended' && doc15.end_reason === 'expired' && tomb15?.status === 'ended' && tomb15.end_reason === 'expired' && live15 === null,
      `kapatan: ${closer}`,
    );
    const sw2 = await L.sweepExpired({ now: Date.now() });
    check('tarayıcı idempotent (ikinci çalıştırmada bağlantıya dokunmaz)', !sw2.ended_link_ids.includes(c15.link_id));
    await viewer.close();

    // =========================================================================================
    // G. Yanıtı kaybolan oluşturma (aynı op_id): token yenilenir, eski token'lı sekme kapanır
    // =========================================================================================
    const opG = crypto.randomUUID();
    const g1 = await call('link_share_create', { op_id: opG, duration: { kind: 'preset', preset: 'h8' }, time_zone: 'Europe/Istanbul' }, ayse);
    let tg = L.selectLinkPublishTargets(await serverViews(sender, ayse.uid), L.linkSenderName('Ayşe'), Date.now());
    check('8 saat bağlantı: hedef seçildi', tg.length === 1 && tg[0].token_hash === g1.token_hash && Math.abs(g1.expires_at - (g1.server_now + 8 * 3600_000)) < 2000);
    await L.publishLinkSample({ sample: sampleAt(40.9881, 29.0312), device: DEVICE, targets: tg, now: Date.now() }, deps);
    const oldTab = await context.newPage();
    await oldTab.goto(`${ORIGIN}/s/${g1.token}`);
    await waitPhase(oldTab, 'live', 15000);
    const tRe = Date.now();
    const g2 = await call('link_share_create', { op_id: opG, duration: { kind: 'preset', preset: 'h8' }, time_zone: 'Europe/Istanbul' }, ayse);
    check('aynı op_id tekrarı: aynı link_id, YENİ token/token_hash, version+1', g2.link_id === g1.link_id && g2.token !== g1.token && g2.token_hash !== g1.token_hash && g2.version === g1.version + 1 && L.linkTokenHash(g2.token) === g2.token_hash);
    await waitPhase(oldTab, 'ended', 5000);
    check('eski token’lı açık sekme kapandı', true, `${Date.now() - tRe} ms`);
    await oldTab.close();
    const pg = await L.publishLinkSample({ sample: sampleAt(40.9883, 29.0315), device: DEVICE, targets: tg, now: Date.now() }, deps);
    check('eski özetle yayıncı: ret → tazele → özet değişti → hedef düşer (yazma yok)', pg.status === 'no_active_targets' && pg.dropped[0] === g1.link_id, pg.status);
    tg = L.selectLinkPublishTargets(await serverViews(sender, ayse.uid), L.linkSenderName('Ayşe'), Date.now());
    const pg2 = await L.publishLinkSample({ sample: sampleAt(40.9884, 29.0317), device: DEVICE, targets: tg, now: Date.now() }, deps);
    const newTab = await context.newPage();
    await newTab.goto(`${ORIGIN}/s/${g2.token}`);
    await waitPhase(newTab, 'live', 15000);
    check('güncel özetle yeniden yayın + yeni token’lı sekme canlı', pg2.status === 'published' && tg[0].token_hash === g2.token_hash);
    await call('link_share_stop', { op_id: crypto.randomUUID(), link_id: g1.link_id }, ayse);
    await waitPhase(newTab, 'ended', 5000);
    await newTab.close();

    check('web: sayfa hatası / konsol hatası yok', pageErrors.length === 0 && consoleErrors.length === 0, [...pageErrors, ...consoleErrors].join(' | ').slice(0, 300));
  } finally {
    await browser.close();
    try {
      process.kill(-preview.pid, 'SIGTERM');
    } catch {}
    for (const a of apps) await deleteApp(a).catch(() => {});
    await L.closeAdmin().catch(() => {});
  }
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} denetim geçti`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
