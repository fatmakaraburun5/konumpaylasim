/**
 * Web önizleme · Faz 9 (yalnızca tarayıcı paketi): "FAZ 9 SENARYOLARI" panel grubu + telefon içi simüle ekranlar.
 *
 *  - "Ayşe anlık fotoğraf paylaşsın": kamerayla çekilmiş kare + "Mekana geçtim, masamız burası" notu → pinde 📷,
 *    kişi kartında küçük resim ve kalan süre. "1 saat ileri sar": sunucu, Storage nesnesi ve önbellekler siler.
 *  - "Ayşe hedefine 200 m yaklaşsın": bana "Ayşe: Neredeyse vardım (1 dk)" + haritada "Neredeyse vardı"; tek sefer.
 *  - Güvenli Dönüş: benim zamanlayıcımda süreyi bitir (son uyarı) / alarmı tetikle; "Ayşe başlatsın ve yanıt
 *    vermesin" (acil kişisi benim) → başladı bildirimi, kısa süre sonra SOS alarmı (son konum + pil).
 *  - "İnterneti kes + SOS": SOS sunucuya ulaşamaz → "SMS ile gönder" → telefon içinde hazır dolu Mesajlar ekranı.
 *  - "Rehber / SMS izinlerini sıfırla": rehber izni "sorulmadı", SMS yedeği kapalı; ilk açılış yeni adımları gösterir.
 * Telefon içinde: simüle iOS Mesajlar ekranı (`smsComposer.web.ts`) ve kişi seçici (`contactsPermissions.web.ts`).
 */
import { formatClock, MINUTE, onboardingDoneForUpgrade, SMS_FALLBACK_TEXT } from '@konum/core';
import { useEffect, useState, type ReactElement } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { onboardingStore } from '../../state/onboardingStore';
import { permissionsStore } from '../../state/permissionsStore';
import { proofStore } from '../../state/proofStore';
import { selectSmsReady, smsFallbackStore } from '../../state/smsFallbackStore';
import { Text, useTheme } from '../../ui';
import { demoControls, type DemoSnapshot } from '../controls';
import { currentContactPick, currentSmsRequest, DEMO_CONTACTS, onF9SimChange } from '../web/f9Sim';
import { ScreenPortal } from '../web/screenHost';
import type { ControlRow } from './Faz3.web';

interface Faz9Props {
  snap: DemoSnapshot | null;
  renderRow: (r: ControlRow) => ReactElement;
}

const IOS_BLUE = '#0A84FF';
const leftText = (ms: number) => (ms <= 0 ? 'doldu' : ms < MINUTE ? `${Math.ceil(ms / 1000)} sn` : `${Math.ceil(ms / MINUTE)} dk`);
const SR_STATUS: Record<string, string> = { active: 'sürüyor', arrived: 'vardı', checked_in: 'güvende', alarm: 'ALARM', cancelled: 'iptal' };
const APPROACH_STATUS: Record<string, string> = { sent: 'gönderildi', already_sent: 'zaten gönderilmiş (tek sefer)', no_recipients: 'alıcı yok', stale: 'eski rapor', invisible: 'görünmez' };

/** Uygulama tarafı: fotoğraf kayıtlarının bitişi geçmişe çekilir ve süpürülür (sunucuyla aynı an). */
async function fastForwardAppProofs(): Promise<void> {
  const st = proofStore.getState();
  const past = Date.now() - 1;
  proofStore.setState({
    mine: st.mine ? { ...st.mine, expires_at: Math.min(st.mine.expires_at, past) } : null,
    friends: Object.fromEntries(Object.entries(st.friends).map(([k, f]) => [k, { ...f, expires_at: Math.min(f.expires_at, past) }])),
  });
  await proofStore.getState().tick().catch(() => undefined);
}

export function Faz9Section({ snap, renderRow }: Faz9Props) {
  const f9 = snap?.f9 ?? null;
  const now = Date.now();
  const nextApproach = f9?.ayseDest?.state === 'near' ? 'arrived' : 'near';

  const rows: ControlRow[] = [
    {
      key: 'f9-ayse-photo',
      title: 'Ayşe anlık fotoğraf paylaşsın',
      hint: 'Yalnızca kamerayla o an çekilmiş kare + "Mekana geçtim, masamız burası". Pinde 📷, kişi kartında küçük resim ve kalan süre; 1 saat sonra her yerden silinir.',
      run: () => {
        const r = demoControls.aysePhotoProof();
        if (r.ok) return `Ayşe anlık fotoğraf ekledi (${formatClock(r.expires_at)}'e kadar). Haritada Ayşe'ye dokun.`;
        if (r.code === 'not_friends') return 'Ayşe ile arkadaş değilsin.';
        return `Fotoğraf eklenemedi (${r.code}).`;
      },
    },
    {
      key: 'f9-proof-ff',
      title: 'Fotoğrafların süresini 1 saat ileri sar',
      hint: 'Etkin fotoğraflar (Ayşe\'nin ve seninki) sunucudan, sahte Storage\'dan ve iki tarafın önbelleğinden silinir; görüntüleyici "Fotoğrafın süresi doldu" der.',
      run: async () => {
        const n = demoControls.fastForwardProofs();
        await fastForwardAppProofs();
        return n > 0 ? `${n} fotoğrafın süresi doldu: sunucudan ve önbellekten silindi.` : 'Etkin fotoğraf yok.';
      },
    },
    {
      key: 'f9-ayse-approach',
      title: nextApproach === 'near' ? 'Ayşe hedefine 200 m yaklaşsın' : 'Ayşe hedefine varsın',
      hint:
        nextApproach === 'near'
          ? 'Bana "Ayşe: Neredeyse vardım (1 dk)" bildirimi + pin altında "Neredeyse vardı · Kitap Kafe". Oturum başına tek bildirim.'
          : 'Durum "vardı"ya geçer; "Neredeyse vardım" bildirimi ikinci kez gitmez (tek sefer).',
      run: () => {
        const r = demoControls.ayseApproach();
        if (!r) return 'Ayşe şu an seninle konum paylaşmıyor.';
        if (r.dest_state === 'arrived') return `Ayşe Kitap Kafe'ye vardı. Bildirim: ${APPROACH_STATUS[r.status] ?? r.status}.`;
        return r.status === 'sent' ? 'Ayşe: "Neredeyse vardım (1 dk)" — bildirim geldi.' : `Ayşe yaklaştı; bildirim ${APPROACH_STATUS[r.status] ?? r.status}.`;
      },
    },
    {
      key: 'f9-ayse-safe-return',
      title: 'Ayşe Güvenli Dönüş başlatsın ve yanıt vermesin',
      hint: 'Acil kişisi sensin: önce "Ayşe Güvenli Dönüş başlattı"; demo kısaltması: 20 sn sonra süre dolar, 20 sn son uyarı, sonra sunucu alarmı (SOS, son konum + pil %31).',
      tone: 'danger',
      run: () => {
        const r = demoControls.ayseSafeReturnNoReply();
        return r.ok ? `Ayşe Güvenli Dönüş başlattı. Yanıt vermezse ${r.alarm_in_s} sn sonra alarm gelir.` : `Başlatılamadı (${r.code}).`;
      },
    },
    {
      key: 'f9-sr-due',
      title: 'Güvenli Dönüş: süreyi bitir (son uyarı)',
      hint: 'Senin süren zamanlayıcının süresi şimdi dolar: "Güvende misin?" tam ekranı + 2 dk geri sayım ("Güvendeyim" / "+15 dk").',
      run: () => {
        const r = demoControls.expireMySafeReturn('due');
        if (r === null) return 'Önce uygulamada Güvenli Dönüş zamanlayıcısı başlat (harita > Güvenli Dönüş).';
        return r === 'due' ? 'Süre doldu: son uyarı başladı.' : 'Son uyarı zaten sürüyor.';
      },
    },
    {
      key: 'f9-sr-alarm',
      title: 'Güvenli Dönüş: alarmı tetikle',
      hint: 'Son uyarı da biter: sunucu acil kişilerine SOS gönderir (son doğrulanmış konum, doğruluk, pil, harita bağlantısı).',
      tone: 'danger',
      run: () => {
        const r = demoControls.expireMySafeReturn('alarm');
        if (r === null) return 'Önce uygulamada Güvenli Dönüş zamanlayıcısı başlat.';
        if (r === 'alarm') return 'Alarm gönderildi: kişilerin son konumunu görüyor.';
        if (r === 'alarm_no_contacts') return 'Alarm: geçerli acil kişi kalmadı, kimseye gitmedi.';
        return 'Alarm tetiklenemedi.';
      },
    },
    {
      key: 'f9-offline-sos',
      title: 'İnterneti kes + SOS (SMS yedeği)',
      hint: '3 dk bağlantı yok. Haritada SOS\'a basılı tut: SOS sunucuya ulaşamazsa "SMS ile gönder" çıkar ve telefonda hazır dolu Mesajlar ekranı açılır.',
      run: () => {
        demoControls.cutInternet(3 * MINUTE);
        const sms = smsFallbackStore.getState();
        if (selectSmsReady(sms)) return `İnternet kesildi (3 dk). Şimdi SOS'a basılı tut → "${SMS_FALLBACK_TEXT.sendSms(sms.settings.numbers.length)}".`;
        return 'İnternet kesildi (3 dk). SMS yedeği kapalı: Gizlilik Merkezi > SMS ile acil durum yedeği (ya da aşağıdaki "SMS yedeğini demo numarasıyla aç").';
      },
    },
    {
      key: 'f9-restore-internet',
      title: 'İnterneti geri getir',
      hint: 'Bağlantı hemen döner. SOS gönderilemeden kaldıysa aynı istekle (op_id) uygulama üzerinden de gider.',
      run: () => {
        demoControls.restoreInternet();
        return 'İnternet geri geldi.';
      },
    },
    {
      key: 'f9-sms-demo',
      title: 'SMS yedeğini demo numarasıyla aç',
      hint: 'Demo kısayolu: açık onay kutusu işaretlenmiş ve rehberden "Annem" seçilmiş gibi. Numara yalnızca bu tarayıcıda kalır.',
      run: async () => {
        const st = smsFallbackStore.getState();
        if (!st.hydrated) await st.hydrate();
        await smsFallbackStore.getState().enable(true);
        const a = DEMO_CONTACTS[0];
        if (a) await smsFallbackStore.getState().addNumber({ label: a.name, phone: a.phones[0]?.number ?? '', source: 'contacts' });
        return `SMS yedeği açık · ${smsFallbackStore.getState().settings.numbers.length} numara.`;
      },
    },
    {
      key: 'f9-reset-contacts-sms',
      title: 'Rehber / SMS izinlerini sıfırla',
      hint: 'Rehber izni "sorulmadı", SMS yedeği kapalı ve numarasız; kurulum rehberi yalnızca yeni "Rehber" ve "SMS" adımlarını yeniden gösterir.',
      run: async () => {
        demoControls.resetContactsPermission();
        await smsFallbackStore.getState().reset();
        await smsFallbackStore.getState().hydrate();
        onboardingStore.setState({ completed: false, done: onboardingDoneForUpgrade(1, ['done']), previousVersion: 1 });
        await permissionsStore.getState().refresh().catch(() => undefined);
        return 'Rehber ve SMS izinleri sıfırlandı; kurulum rehberi yeni adımlarla açılır.';
      },
    },
  ];

  const lines: string[] = [];
  if (f9) {
    lines.push(
      `Anlık fotoğraf: Ayşe ${f9.ayseProof ? `${leftText(f9.ayseProof.expires_at - now)} kaldı` : 'yok'} · sen ${f9.myProof ? `${leftText(f9.myProof.expires_at - now)} kaldı` : 'yok'} · sunucudaki nesne: ${f9.proofObjects}`,
    );
    lines.push(`Ayşe'nin hedefi: ${f9.ayseDest ? `${f9.ayseDest.name} · ${f9.ayseDest.state === 'near' ? 'neredeyse vardı' : f9.ayseDest.state === 'arrived' ? 'vardı' : 'yolda'}` : 'yok'}`);
    if (f9.lastApproach) lines.push(`Son "Neredeyse vardım" raporun: ${f9.lastApproach.dest_name} · ${APPROACH_STATUS[f9.lastApproach.status] ?? f9.lastApproach.status} (${f9.lastApproach.notified} kişi)`);
    const sr = f9.mySafeReturn;
    lines.push(
      sr
        ? `Güvenli Dönüş'ün: ${sr.destination} · ${SR_STATUS[sr.status] ?? sr.status}${sr.status === 'active' ? ` · ${now < sr.due_at ? `${leftText(sr.due_at - now)} kaldı` : `son uyarı ${leftText(sr.grace_until - now)}`}` : ''} · kişiler: ${sr.contacts.join(', ') || 'yok'}`
        : "Güvenli Dönüş'ün: yok",
    );
    const as = f9.ayseSafeReturn;
    if (as) lines.push(`Ayşe'nin Güvenli Dönüşü: ${SR_STATUS[as.status] ?? as.status}${as.status === 'active' ? ` · ${now < as.due_at ? `süre ${leftText(as.due_at - now)}` : `son uyarı ${leftText(as.grace_until - now)}`}` : ''}`);
    if (f9.lastSms) lines.push(`Son SMS (demo): ${f9.lastSms.result === 'sent' ? 'gönderildi' : 'vazgeçildi'} · ${f9.lastSms.numbers.length} kişi · ${formatClock(f9.lastSms.at)}`);
  }

  return (
    <View style={{ gap: 6 }} testID="faz9-section">
      <Text variant="caption" color="textSecondary" style={{ letterSpacing: 1 }}>
        FAZ 9 SENARYOLARI
      </Text>
      {rows.map(renderRow)}
      {lines.map((l) => (
        <Text key={l} variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          {l}
        </Text>
      ))}
    </View>
  );
}

// --- telefon içi simüle ekranlar ---------------------------------------------------------------

function useF9Sim(): number {
  const [v, setV] = useState(0);
  useEffect(() => onF9SimChange(() => setV((x) => x + 1)), []);
  return v;
}

/** Simüle iOS Mesajlar (MFMessageComposeViewController): hazır dolu alıcı + gövde, tek dokunuşla "Gönder". */
function SmsComposer() {
  const { scheme } = useTheme();
  useF9Sim();
  const req = currentSmsRequest();
  if (!req) return null;
  const dark = scheme === 'dark';
  const bg = dark ? '#000000' : '#FFFFFF';
  const fg = dark ? '#FFFFFF' : '#000000';
  const sep = dark ? 'rgba(84,84,88,0.65)' : 'rgba(60,60,67,0.29)';
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: bg, zIndex: 80, paddingTop: 48 }]} accessibilityViewIsModal testID="sms-composer">
      <View style={[styles.smsNav, { borderColor: sep }]}>
        <View style={{ width: 70 }} />
        <Text variant="label" style={{ color: fg, fontWeight: '600' }}>
          Yeni Mesaj
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Vazgeç" onPress={() => req.resolve('cancelled')} hitSlop={8} testID="sms-cancel" style={{ width: 70, alignItems: 'flex-end' }}>
          <Text variant="label" style={{ color: IOS_BLUE }}>
            Vazgeç
          </Text>
        </Pressable>
      </View>
      <View style={[styles.smsTo, { borderColor: sep }]}>
        <Text variant="label" style={{ color: '#8E8E93' }}>
          Kime:
        </Text>
        <View style={styles.smsChips}>
          {req.numbers.map((n) => (
            <View key={n} style={styles.smsChip}>
              <Text variant="caption" style={{ color: IOS_BLUE, fontWeight: '600' }}>
                {n}
              </Text>
            </View>
          ))}
        </View>
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text variant="caption" style={{ color: '#8E8E93', textAlign: 'center', fontWeight: '400' }}>
          Metin Mesajı · SMS{'\n'}Mesaj, mobil operatörün üzerinden gider. Uygulama SMS göndermez; Gönder'e sen dokunursun.
        </Text>
      </View>
      <View style={[styles.smsCompose, { borderColor: sep }]}>
        <ScrollView style={[styles.smsInput, { borderColor: sep }]} contentContainerStyle={{ padding: 10 }}>
          <Text variant="label" style={{ color: fg, fontWeight: '400' }} testID="sms-body">
            {req.body}
          </Text>
        </ScrollView>
        <Pressable accessibilityRole="button" accessibilityLabel="Gönder" onPress={() => req.resolve('sent')} style={styles.smsSend} testID="sms-send">
          <Text variant="label" style={{ color: '#FFFFFF', fontWeight: '700' }}>
            ↑
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Simüle iOS kişi seçici (CNContactPickerViewController; izin istemez): demo rehberi. */
function ContactPicker() {
  const { scheme } = useTheme();
  useF9Sim();
  const req = currentContactPick();
  if (!req) return null;
  const dark = scheme === 'dark';
  const bg = dark ? '#1C1C1E' : '#F2F2F7';
  const cell = dark ? '#2C2C2E' : '#FFFFFF';
  const fg = dark ? '#FFFFFF' : '#000000';
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)', zIndex: 80, paddingTop: 60 }]} accessibilityViewIsModal testID="contact-picker">
      <View style={[styles.pickerSheet, { backgroundColor: bg }]}>
        <View style={styles.smsNav}>
          <View style={{ width: 70 }} />
          <Text variant="label" style={{ color: fg, fontWeight: '600' }}>
            Kişiler
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Vazgeç" onPress={() => req.resolve(null)} hitSlop={8} testID="contact-picker-cancel" style={{ width: 70, alignItems: 'flex-end' }}>
            <Text variant="label" style={{ color: IOS_BLUE }}>
              Vazgeç
            </Text>
          </Pressable>
        </View>
        <Text variant="caption" style={{ color: '#8E8E93', paddingHorizontal: 16, paddingBottom: 8, fontWeight: '400' }}>
          Demo rehberi · yalnızca seçtiğin numara uygulamaya verilir
        </Text>
        <View style={[styles.pickerGroup, { backgroundColor: cell }]}>
          {DEMO_CONTACTS.map((c, i) => (
            <Pressable
              key={c.name}
              accessibilityRole="button"
              accessibilityLabel={c.name}
              onPress={() => req.resolve(c)}
              style={[styles.pickerRow, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(60,60,67,0.29)' } : null]}
              testID={`contact-${i}`}
            >
              <Text variant="body" style={{ color: fg }}>
                {c.name}
              </Text>
              <Text variant="caption" style={{ color: '#8E8E93', fontWeight: '400' }}>
                {c.phones.map((p) => `${p.label ?? 'tel'} ${p.number}`).join(' · ')}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

/** Demo kabuğu telefon ekranında çizer (Mesajlar, kişi seçici). */
export function Faz9Hosts() {
  return (
    <ScreenPortal>
      <SmsComposer />
      <ContactPicker />
    </ScreenPortal>
  );
}

const styles = StyleSheet.create({
  smsNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  smsTo: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  smsChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, flex: 1 },
  smsChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: 'rgba(10,132,255,0.12)' },
  smsCompose: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 30, borderTopWidth: StyleSheet.hairlineWidth },
  smsInput: { flex: 1, maxHeight: 220, borderWidth: 1, borderRadius: 18 },
  smsSend: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#34C759', alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  pickerSheet: { flex: 1, borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  pickerGroup: { marginHorizontal: 16, borderRadius: 10, overflow: 'hidden' },
  pickerRow: { paddingHorizontal: 16, paddingVertical: 11, gap: 2 },
});
