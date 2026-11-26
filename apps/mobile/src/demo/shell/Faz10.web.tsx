/**
 * Web önizleme · Faz 10 (yalnızca tarayıcı paketi): "FAZ 10 SENARYOLARI" panel grubu + telefon içi simüle Takvim.
 *
 *  - "Ayşe 40 dk sonrası için buluşma kursun": kesin etkinlik (Moda Sahili Çay Bahçesi); Mehmet, Zeynep ve ben
 *    "Katılacağım". 45 dk penceresi hemen açık: haritada ve etkinlik kartında "Kim ne kadar uzakta?" şeridi.
 *    "Ayşe mekana vardı" → "Ayşe · Vardı"; "Buluşma saatini geçir" → şerit kapanır.
 *  - Takvime Ekle: etkinlik kartında; ilk eklemede resmi onay sayfası → simüle iOS "Etkinlik Eklemeye İzin Ver"
 *    → simüle Takvim kartı. "Takvim iznini sıfırla" onay akışını yeniden gösterir.
 *  - "Yeni telefona geç": bu oturum eski telefon olur (konum yayını açık, her 30 sn paket), kurtarma e-postası
 *    doğrulanır, oturum kapanır. Yeni telefonda SMS (123456) + e-posta kodu → Aktif Cihazlar → "Eski Cihazdaki
 *    Oturumu ve Konum Yayınını Kapat" → eski telefonun yazımı reddedilir, sessiz push'la yayın durur.
 */
import { formatClock } from '@konum/core';
import { router } from 'expo-router';
import { useEffect, useState, type ReactElement } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { calendarStore } from '../../state/calendarStore';
import { Text } from '../../ui';
import { demoControls, type DemoSnapshot } from '../controls';
import { currentCalendarSheet, demoCalendarClear, demoCalendarEvents, onCalendarSimChange } from '../web/calendarSim';
import { setDemoPerms } from '../web/permissions';
import { ScreenPortal } from '../web/screenHost';
import { demoCurrentDsid, demoSwitchToNewPhone } from '../web/session';
import type { ControlRow } from './Faz3.web';

interface Faz10Props {
  snap: DemoSnapshot | null;
  renderRow: (r: ControlRow) => ReactElement;
}

const STATUS: Record<string, string> = { active: 'etkin', pending: 'doğrulama bekliyor', revoked: 'kapatıldı' };

export function Faz10Section({ snap, renderRow }: Faz10Props) {
  const f10 = snap?.f10 ?? null;
  const rows: ControlRow[] = [
    {
      key: 'f10-soon-event',
      title: 'Ayşe 40 dk sonrası için buluşma kursun',
      hint: 'Kesinleşmiş etkinlik: Moda Sahili Çay Bahçesi, Mehmet + Zeynep + sen "Katılacağım". 45 dk penceresi açık → haritada ve kartta "Kim ne kadar uzakta?". Kartta "Takvime Ekle".',
      navigates: true,
      run: () => {
        const r = demoControls.ayseCreatesSoonEvent();
        if (!r.ok) return `Etkinlik kurulamadı (${r.code}).`;
        router.push(`/events/${r.event_id}`);
        return `Kesinleşti: ${formatClock(r.starts_at)}. Şerit açık; Zeynep'in konumu eski olduğu için "+1 kişi konum paylaşmıyor".`;
      },
    },
    {
      key: 'f10-ayse-arrive',
      title: 'Ayşe mekana varsın',
      hint: 'Faz 9 hedef alanı "vardı" (mekan adıyla): şeritte "Ayşe · Vardı" en başa geçer.',
      run: () => (demoControls.ayseArrivesAtEvent() ? 'Ayşe vardı.' : 'Önce "Ayşe 40 dk sonrası için buluşma kursun".'),
    },
    {
      key: 'f10-end-event',
      title: 'Buluşma saatini 31 dk geçir',
      hint: 'Başlangıçtan 30 dk sonra şerit kendiliğinden kapanır (herkes vardıysa daha önce).',
      run: () => (demoControls.endSoonEvent() ? 'Buluşma saati geçti: şerit kapandı.' : 'Yakın buluşma yok.'),
    },
    {
      key: 'f10-calendar-reset',
      title: 'Takvim iznini sıfırla',
      hint: 'Takvim izni "sorulmadı", simüle takvim ve eşleme boşalır: "Takvime Ekle" yeniden resmi onay sayfasını ve iOS izin penceresini gösterir.',
      run: async () => {
        setDemoPerms({ calendar: 'undetermined', asked: { calendar: false } });
        demoCalendarClear();
        const uid = calendarStore.getState().uid;
        await calendarStore.getState().reset();
        if (uid) await calendarStore.getState().hydrate(uid);
        return 'Takvim izni sıfırlandı.';
      },
    },
    {
      key: 'f10-new-phone',
      title: 'Yeni telefona geç (iPhone 16)',
      hint: 'Bu oturum "eski telefon" olur (konum yayını açık). Kurtarma e-postası yoksa deniz.kaya@gmail.com doğrulanmış eklenir. Çıkış → SMS 123456 → e-posta kodu (ekranda) → Aktif Cihazlar.',
      tone: 'danger',
      navigates: true,
      run: async () => {
        const r = demoControls.prepareNewPhone(demoCurrentDsid());
        if (!r.ok) return r.reason;
        await demoSwitchToNewPhone('iPhone 16');
        return `${r.old_model} konum yayınlamaya devam ediyor. Yeni telefonda giriş yap: SMS 123456, sonra ${r.email} adresine giden kod.`;
      },
    },
  ];

  const lines: string[] = [];
  if (f10) {
    lines.push(`Cihaz oturumları: ${f10.activeDevices} etkin / ${f10.devices} kayıt`);
    const o = f10.oldPhone;
    if (o) {
      lines.push(
        o.status === 'active'
          ? `Eski telefon (${o.model}): yayın AÇIK · ${o.writesOk} paket · son ${o.lastWriteAgoS} sn önce${o.newSigninPush ? ' · "yeni cihaz girişi" bildirimi aldı' : ''}`
          : `Eski telefon: oturum ${STATUS[o.status] ?? o.status}${o.denied ? ' · son yazım reddedildi (PERMISSION_DENIED)' : ''}${o.stopped ? ' · push alındı, yayın durdu, çıkış yapıldı' : ''}`,
      );
    }
    const rc = f10.recovery;
    lines.push(`Kurtarma: SMS ${rc.sms?.verified_at ? '✓' : '–'} · e-posta ${rc.email ? `${rc.email.masked} ${rc.email.verified_at ? '✓' : '–'}` : 'yok'}${rc.two_step ? ' · iki aşamalı' : ''}`);
    if (f10.lastCode) lines.push(`Son gönderilen kod (demo): ${f10.lastCode.code} → ${f10.lastCode.to_masked} · ${formatClock(f10.lastCode.at)}`);
    if (f10.soonEvent?.starts_at) lines.push(`Yakın buluşma: ${f10.soonEvent.title} · ${formatClock(f10.soonEvent.starts_at)} · ${f10.soonEvent.venue}`);
  }
  const cal = demoCalendarEvents();
  if (cal.length) lines.push(`Telefon takvimi (demo): ${cal.length} etkinlik · son: ${cal[cal.length - 1]!.title}`);

  return (
    <View style={{ gap: 6 }} testID="faz10-section">
      <Text variant="caption" color="textSecondary" style={{ letterSpacing: 1 }}>
        FAZ 10 SENARYOLARI
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

// --- telefon içi simüle Takvim -------------------------------------------------------------------

function useCalendarSim(): number {
  const [v, setV] = useState(0);
  useEffect(() => onCalendarSimChange(() => setV((x) => x + 1)), []);
  return v;
}

const fmt = (at: number, tz: string) => {
  try {
    return new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(at));
  } catch {
    return new Date(at).toLocaleString('tr-TR');
  }
};
const clock = (at: number, tz: string) => {
  try {
    return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(at));
  } catch {
    return '';
  }
};

/** iOS Takvim: "Etkinlik eklendi" kartı ya da (izinsiz) "Yeni Etkinlik" sistem formu. */
function CalendarSheet() {
  useCalendarSim();
  const s = currentCalendarSheet();
  if (!s) return null;
  const e = s.event;
  const red = '#FF3B30';
  return (
    <View style={[StyleSheet.absoluteFill, styles.dim]} accessibilityViewIsModal testID={s.kind === 'form' ? 'calendar-sim-form' : 'calendar-sim-added'}>
      <View style={styles.sheet}>
        <View style={styles.nav}>
          {s.kind === 'form' ? (
            <Pressable accessibilityRole="button" onPress={() => s.resolve('canceled')}>
              <Text variant="label" style={{ color: red }}>
                Vazgeç
              </Text>
            </Pressable>
          ) : (
            <View style={{ width: 50 }} />
          )}
          <Text variant="label" style={{ fontWeight: '700' }}>
            {s.kind === 'form' ? 'Yeni Etkinlik' : 'Takvim'}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => s.resolve(s.kind === 'form' ? 'saved' : 'closed')} testID="calendar-sim-done">
            <Text variant="label" style={{ color: red, fontWeight: '700' }}>
              {s.kind === 'form' ? 'Ekle' : 'Bitti'}
            </Text>
          </Pressable>
        </View>
        {s.kind === 'added' ? (
          <Text variant="caption" style={styles.ok}>
            ✓ Etkinlik eklendi · {e.calendar}
          </Text>
        ) : null}
        <View style={styles.group}>
          <Text variant="heading">{e.title}</Text>
          <Text variant="label" style={styles.muted}>
            {e.location}
          </Text>
        </View>
        <View style={styles.group}>
          <Text variant="label">{fmt(e.startDate, e.timeZone)}</Text>
          <Text variant="label" style={styles.muted}>{`${clock(e.startDate, e.timeZone)} – ${clock(e.endDate, e.timeZone)} · ${e.timeZone}`}</Text>
          <Text variant="caption" style={styles.muted}>
            {`Uyarılar: ${e.alarms.map((m) => `${m} dk önce`).join(', ')}`}
          </Text>
        </View>
        <View style={styles.group}>
          <Text variant="caption" style={{ color: '#0A84FF' }} numberOfLines={1}>
            {e.url}
          </Text>
          <Text variant="caption" style={styles.muted} numberOfLines={6}>
            {e.notes}
          </Text>
        </View>
      </View>
    </View>
  );
}

export function Faz10Hosts() {
  return (
    <ScreenPortal>
      <CalendarSheet />
    </ScreenPortal>
  );
}

const styles = StyleSheet.create({
  dim: { backgroundColor: 'rgba(0,0,0,0.35)', zIndex: 85, paddingTop: 60 },
  sheet: { flex: 1, backgroundColor: '#F2F2F7', borderTopLeftRadius: 14, borderTopRightRadius: 14, padding: 14, gap: 12 },
  nav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  group: { backgroundColor: '#FFFFFF', borderRadius: 10, padding: 12, gap: 4 },
  muted: { color: '#6B7280' },
  ok: { color: '#16A34A', textAlign: 'center' },
});
