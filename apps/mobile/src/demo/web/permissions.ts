/**
 * Web demo: simüle izin durumları ve iOS sistem pencereleri (tarayıcı izni HİÇBİR ZAMAN istenmez).
 *
 * Varsayılan: her şey verilmiş (Faz 1/2 demo akışı değişmesin). Demo panelindeki "İzin akışını baştan göster"
 * ilk kurulum durumuna döner (hepsi "sorulmadı"): sonraki paylaşımda Faz 3 kademeli izin akışı (PermissionFlow)
 * adım adım görünür ve "sistem" pencereleri telefon çerçevesinin içinde açılır (`SystemPromptHost.web.tsx`).
 *
 * iOS davranışı [Varsayım: iOS 17/18]:
 *  - "Kullanırken" penceresi bir kez sorulur; "İzin Verme" sonrası yalnızca Ayarlar.
 *  - "Her Zaman" yükseltme penceresi "Kullanırken" verildikten SONRA ve bir kez gösterilir; "Kullanırken İzin
 *    Vermeye Devam Et" seçilirse sonraki istekler pencere açmaz (Ayarlar).
 *  - Bildirim ve hareket (Hareket ve Fitness) izinleri bir kez sorulur.
 */
import { safeStorage } from '../server/storage';

export type DemoPermStatus = 'undetermined' | 'granted' | 'denied';
export type DemoPermKind = 'foreground' | 'background' | 'notifications' | 'motion' | 'contacts';

export interface DemoPerms {
  foreground: DemoPermStatus;
  /** "Her Zaman". `foreground` granted değilken anlamsızdır. */
  background: DemoPermStatus;
  notifications: DemoPermStatus;
  motion: DemoPermStatus;
  /** Faz 9: Rehber (yalnızca SMS acil numarası seçmek için). Varsayılan "sorulmadı" (ilk açılış adımı görünsün). */
  contacts: DemoPermStatus;
  /** Tam (kesin) konum. */
  precise: boolean;
  /** Sistem penceresi bu izin için bir kez gösterildi mi (iOS: sonrası yalnızca Ayarlar). */
  asked: Partial<Record<DemoPermKind, boolean>>;
}

const KEY = 'konum.demo.perms.v1';

const ALL_GRANTED: DemoPerms = {
  foreground: 'granted',
  background: 'granted',
  notifications: 'granted',
  motion: 'granted',
  contacts: 'granted',
  precise: true,
  asked: { foreground: true, background: true, notifications: true, motion: true, contacts: true },
};

/** Demo açılış varsayılanı: Faz 1–8 izinleri verilmiş, rehber sorulmamış (Faz 9 ilk açılış adımı görünsün). */
const DEFAULT_PERMS: DemoPerms = { ...ALL_GRANTED, contacts: 'undetermined', asked: { foreground: true, background: true, notifications: true, motion: true } };

const FIRST_RUN: DemoPerms = {
  foreground: 'undetermined',
  background: 'undetermined',
  notifications: 'undetermined',
  motion: 'undetermined',
  contacts: 'undetermined',
  precise: true,
  asked: {},
};

const STATUS = new Set<DemoPermStatus>(['undetermined', 'granted', 'denied']);

function load(): DemoPerms {
  try {
    const raw = safeStorage.get(KEY);
    if (!raw) return { ...DEFAULT_PERMS, asked: { ...DEFAULT_PERMS.asked } };
    const v = JSON.parse(raw) as Partial<DemoPerms>;
    const pick = (s: unknown, d: DemoPermStatus): DemoPermStatus => (STATUS.has(s as DemoPermStatus) ? (s as DemoPermStatus) : d);
    return {
      foreground: pick(v.foreground, 'granted'),
      background: pick(v.background, 'granted'),
      notifications: pick(v.notifications, 'granted'),
      motion: pick(v.motion, 'granted'),
      contacts: pick(v.contacts, 'undetermined'),
      precise: v.precise !== false,
      asked: typeof v.asked === 'object' && v.asked ? v.asked : {},
    };
  } catch {
    return { ...DEFAULT_PERMS, asked: { ...DEFAULT_PERMS.asked } };
  }
}

let perms = load();
const listeners = new Set<(p: DemoPerms) => void>();

function save(next: DemoPerms): void {
  perms = next;
  safeStorage.set(KEY, JSON.stringify(next));
  for (const l of [...listeners]) {
    try {
      l({ ...next });
    } catch {
      // dinleyici hatası izin durumunu etkilemez
    }
  }
}

export function demoPerms(): DemoPerms {
  return { ...perms, asked: { ...perms.asked } };
}

export function onDemoPermsChange(l: (p: DemoPerms) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function setDemoPerms(patch: Partial<DemoPerms>): void {
  save({ ...perms, ...patch, asked: { ...perms.asked, ...(patch.asked ?? {}) } });
}

/** "İzin akışını baştan göster": uygulama ilk kez kurulmuş gibi (hiçbir izin sorulmadı). */
export function resetDemoPermsToFirstRun(): void {
  save({ ...FIRST_RUN, asked: {} });
}

/** Demo paneli: her şey verilmiş (varsayılan). */
export function grantAllDemoPerms(): void {
  save({ ...ALL_GRANTED, asked: { ...ALL_GRANTED.asked } });
}

/** iOS'ta "Her Zaman" sistem penceresi hâlâ gösterilebilir mi. */
export function demoCanAsk(kind: DemoPermKind): boolean {
  if (perms[kind] === 'granted') return true;
  if (perms[kind] === 'denied') return false;
  return !perms.asked[kind];
}

// --- simüle sistem penceresi ---------------------------------------------------------------------

export interface SystemPromptButton {
  id: string;
  label: string;
  /** iOS: kalın (önerilen) seçenek. */
  bold?: boolean;
}

export interface SystemPromptRequest {
  id: number;
  /** Ayarlar sayfası mı (iOS Ayarlar → Konum) yoksa sistem uyarısı mı. */
  kind: 'alert' | 'settings';
  title: string;
  message: string;
  buttons: SystemPromptButton[];
  resolve: (buttonId: string) => void;
}

let seq = 0;
let queue: SystemPromptRequest[] = [];
const promptListeners = new Set<() => void>();
const emitPrompts = () => promptListeners.forEach((l) => l());

export function currentSystemPrompt(): SystemPromptRequest | null {
  return queue[0] ?? null;
}

export function onSystemPromptChange(l: () => void): () => void {
  promptListeners.add(l);
  return () => promptListeners.delete(l);
}

function ask(kind: SystemPromptRequest['kind'], title: string, message: string, buttons: SystemPromptButton[]): Promise<string> {
  return new Promise((resolve) => {
    const req: SystemPromptRequest = {
      id: ++seq,
      kind,
      title,
      message,
      buttons,
      resolve: (b) => {
        queue = queue.filter((q) => q.id !== req.id);
        emitPrompts();
        resolve(b);
      },
    };
    queue = [...queue, req];
    emitPrompts();
  });
}

/** app.config `NSLocationWhenInUseUsageDescription` / `NSLocationAlwaysAndWhenInUseUsageDescription` karşılığı. [Varsayım] */
const WHEN_IN_USE_TEXT = 'Konumunu yalnızca seçtiğin kişilerle, seçtiğin süre boyunca paylaşmak için kullanılır.';
const ALWAYS_TEXT = 'Haftalık ve süresiz paylaşımların uygulama kapalıyken ya da ekran kilitliyken de sürmesi için kullanılır.';
const MOTION_TEXT = 'Telefonun masadayken GPS’i kapatıp pil tasarrufu yapmak için hareket etkinliği kullanılır.';
/** app.config `NSContactsUsageDescription` (expo-contacts) ile aynı. */
const CONTACTS_TEXT =
  'İnternet yokken SOS mesajını SMS ile gönderebilmen için acil durum numaralarını rehberinden seçmene izin veriyoruz. Rehberin sunucuya yüklenmez ve taranmaz; yalnızca seçtiğin numaralar bu telefonda saklanır.';

/**
 * Sistem izin penceresi (izin zaten verilmiş/reddedilmişse ya da iOS bir daha sormuyorsa pencere açmadan döner).
 */
export async function requestDemoPermission(kind: DemoPermKind): Promise<DemoPermStatus> {
  if (perms[kind] === 'granted' || !demoCanAsk(kind)) return perms[kind];
  if (kind === 'background' && perms.foreground !== 'granted') return perms.background;
  let next: DemoPermStatus = perms[kind];
  switch (kind) {
    case 'foreground': {
      const b = await ask('alert', '“Konum” uygulamasının konumunu kullanmasına izin verilsin mi?', WHEN_IN_USE_TEXT, [
        { id: 'once', label: 'Bir Kez İzin Ver' },
        { id: 'while', label: 'Uygulamayı Kullanırken İzin Ver', bold: true },
        { id: 'deny', label: 'İzin Verme' },
      ]);
      next = b === 'deny' ? 'denied' : 'granted';
      break;
    }
    case 'background': {
      const b = await ask('alert', '“Konum” uygulamasının, uygulamayı kullanmıyorken de konumunu kullanmasına izin verilsin mi?', ALWAYS_TEXT, [
        { id: 'keep', label: 'Kullanırken İzin Vermeye Devam Et' },
        { id: 'always', label: '“Her Zaman İzin Ver”e Geç', bold: true },
      ]);
      next = b === 'always' ? 'granted' : 'denied';
      break;
    }
    case 'notifications': {
      const b = await ask('alert', '“Konum” Size Bildirim Göndermek İstiyor', 'Bildirimler; uyarılar, sesler ve simge işaretleri içerebilir. Bunlar Ayarlar’dan yapılandırılabilir.', [
        { id: 'deny', label: 'İzin Verme' },
        { id: 'allow', label: 'İzin Ver', bold: true },
      ]);
      next = b === 'allow' ? 'granted' : 'denied';
      break;
    }
    case 'motion': {
      const b = await ask('alert', '“Konum” uygulamasının Hareket ve Fitness etkinliğine erişmesine izin verilsin mi?', MOTION_TEXT, [
        { id: 'deny', label: 'İzin Verme' },
        { id: 'allow', label: 'Tamam', bold: true },
      ]);
      next = b === 'allow' ? 'granted' : 'denied';
      break;
    }
    case 'contacts': {
      const b = await ask('alert', '“Konum” Kişilerinize Erişmek İstiyor', CONTACTS_TEXT, [
        { id: 'deny', label: 'İzin Verme' },
        { id: 'allow', label: 'Tamam', bold: true },
      ]);
      next = b === 'allow' ? 'granted' : 'denied';
      break;
    }
  }
  save({ ...perms, [kind]: next, asked: { ...perms.asked, [kind]: true } });
  return next;
}

/**
 * `Linking.openSettings()` karşılığı: simüle iOS Ayarlar → Konum sayfası. Kullanıcının seçtiği durum kaydedilir;
 * uygulama ön plana dönünce (permissionsStore.refresh) yeni durumu okur.
 */
export async function openDemoSettings(): Promise<void> {
  const current = perms.foreground !== 'granted' ? 'never' : perms.background === 'granted' ? 'always' : 'while';
  const mark = (id: string, label: string) => (id === current ? `${label}  ✓` : label);
  const b = await ask('settings', 'Ayarlar › Konum › Konum', 'Konum erişimine izin ver', [
    { id: 'never', label: mark('never', 'Hiçbir Zaman') },
    { id: 'while', label: mark('while', 'Uygulamayı Kullanırken') },
    { id: 'always', label: mark('always', 'Her Zaman'), bold: true },
    { id: 'precise', label: perms.precise ? 'Tam Konum: Açık' : 'Tam Konum: Kapalı → Aç' },
    { id: 'back', label: '‹ Uygulamaya dön' },
  ]);
  switch (b) {
    case 'never':
      save({ ...perms, foreground: 'denied', background: 'denied' });
      break;
    case 'while':
      save({ ...perms, foreground: 'granted', background: 'denied' });
      break;
    case 'always':
      save({ ...perms, foreground: 'granted', background: 'granted' });
      break;
    case 'precise':
      save({ ...perms, precise: true });
      break;
    default:
      break;
  }
}

/** Faz 9 demo paneli: "Rehber / SMS izinlerini sıfırla" — rehber yeniden "sorulmadı". */
export function resetDemoContactsPerm(): void {
  const asked = { ...perms.asked };
  delete asked.contacts;
  save({ ...perms, contacts: 'undetermined', asked });
}
