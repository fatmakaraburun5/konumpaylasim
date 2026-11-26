/**
 * Web demo · Faz 9: telefon çerçevesinde çizilen simüle sistem ekranları (kuyruk; çizim `shell/Faz9.web.tsx`).
 *
 *  - Mesajlar (iOS `MFMessageComposeViewController` karşılığı): alıcılar + hazır dolu gövde; "Gönder" / "Vazgeç".
 *    Uygulama SMS göndermez: kullanıcı Gönder'e dokunur. Sonuç demo sunucusunun SMS günlüğüne yazılır.
 *  - Kişi seçici (iOS `CNContactPickerViewController` karşılığı; izin istemez): demo rehberi (Annem, Babam, Ablam…).
 */
type Listener = () => void;

export interface DemoSmsRequest {
  id: number;
  numbers: string[];
  body: string;
  resolve: (r: 'sent' | 'cancelled') => void;
}

export interface DemoContact {
  name: string;
  phones: { label: string | null; number: string }[];
}

export interface DemoContactPickRequest {
  id: number;
  resolve: (c: DemoContact | null) => void;
}

/** Demo rehberi (gerçek kişi değil). Babam'ın iki numarası var: uygulama hangisini soracağını gösterir. */
export const DEMO_CONTACTS: readonly DemoContact[] = [
  { name: 'Annem', phones: [{ label: 'cep', number: '0532 555 01 01' }] },
  {
    name: 'Babam',
    phones: [
      { label: 'cep', number: '0533 555 02 02' },
      { label: 'iş', number: '0216 555 02 03' },
    ],
  },
  { name: 'Ablam', phones: [{ label: 'cep', number: '0535 555 03 03' }] },
  { name: 'Komşu Selin', phones: [{ label: 'cep', number: '0541 555 04 04' }] },
];

let seq = 0;
let sms: DemoSmsRequest[] = [];
let picks: DemoContactPickRequest[] = [];
const listeners = new Set<Listener>();
const emit = () => {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // çizim hatası akışı etkilemez
    }
  }
};

export function onF9SimChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const currentSmsRequest = (): DemoSmsRequest | null => sms[0] ?? null;
export const currentContactPick = (): DemoContactPickRequest | null => picks[0] ?? null;

/** Simüle Mesajlar ekranını açar; kullanıcı "Gönder" ya da "Vazgeç" deyince çözülür. */
export function openDemoSmsComposer(numbers: readonly string[], body: string): Promise<'sent' | 'cancelled'> {
  return new Promise((resolve) => {
    const req: DemoSmsRequest = {
      id: ++seq,
      numbers: [...numbers],
      body,
      resolve: (r) => {
        sms = sms.filter((x) => x.id !== req.id);
        emit();
        resolve(r);
      },
    };
    sms = [...sms, req];
    emit();
  });
}

/** Simüle kişi seçici; seçilen kişi ya da null (Vazgeç). */
export function openDemoContactPicker(): Promise<DemoContact | null> {
  return new Promise((resolve) => {
    const req: DemoContactPickRequest = {
      id: ++seq,
      resolve: (c) => {
        picks = picks.filter((x) => x.id !== req.id);
        emit();
        resolve(c);
      },
    };
    picks = [...picks, req];
    emit();
  });
}
