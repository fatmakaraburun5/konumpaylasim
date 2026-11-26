/**
 * Web önizleme kabuğu (yalnızca tarayıcı paketi; native karşılığı `DemoShell.tsx` çocukları olduğu gibi döndürür).
 *
 *  - Geniş ekran (>= 900 px): uygulama 390x844 telefon çerçevesinde, yanında "Demo kontrolleri" paneli
 *    ve simüle telefon bildirimi.
 *  - Dar ekran: uygulama tam ekran; sağ kenardaki "Demo" sekmesi aynı paneli alttan sayfa olarak açar,
 *    bildirim kartı üstten kayar.
 *  - Faz 3 (Faz3.web.tsx): "FAZ 3 SENARYOLARI" + canlı gösterge, alıcı tarafı önizlemesi, simüle izinler; telefonun
 *    içinde kilit ekranı, push afişi ve iOS sistem izin pencereleri.
 *  - Faz 5 (Faz5.web.tsx): "FAZ 5 SENARYOLARI" (Ev bölgesi, evden çık / eve var, GPS sapması, Ayşe eve vardı, Ayşe
 *    buluşma noktası önersin) ve son filtre kararları.
 *  - Faz 4 (Faz4.web.tsx): "FAZ 4 SENARYOLARI" (ping, durum / yer notu, Ayşe SOS + güvende); ping / SOS push'ları
 *    aynı afiş ve kilit ekranında (SOS kırmızı) görünür, dokununca uygulamada ilgili ekran açılır.
 *  - Faz 6 (Faz6.web.tsx): "FAZ 6 · WIDGET'LAR" — core snapshot'ıyla çizilen iOS / kilit ekranı / Android widget
 *    galerisi, tek tuşla 1 saatlik paylaşım (oturumsuz `widget_quick_share`) ve hata / izin düşüşü senaryoları.
 *  - Faz 7 (Faz7.web.tsx): "FAZ 7 SENARYOLARI" (Ayşe etkinliğe davet etsin, hatırlatmayı şimdi gönder, Mehmet yola
 *    çıksın) ve gizlilik tercihleri.
 *  - Faz 10 (Faz10.web.tsx): "FAZ 10 SENARYOLARI" (yakın buluşma + "Kim ne kadar uzakta?", Takvime Ekle, yeni
 *    telefona geç + eski cihazı kapat) ve telefon içi simüle Takvim.
 *  - Faz 9 (Faz9.web.tsx): "FAZ 9 SENARYOLARI" (Ayşe anlık fotoğraf, süreyi ileri sar, Ayşe hedefe yaklaşsın,
 *    Güvenli Dönüş son uyarı / alarm, Ayşe yanıt vermesin, internetsiz SOS → SMS, rehber / SMS sıfırla); telefonun
 *    içinde simüle Mesajlar ekranı ve rehber seçici.
 */
// Ekran kilidi simülasyonu `document.visibilityState`'i bu modül yüklenirken bağlar (AppState'ten önce olmalı).
import '../web/screen';
import { parseLinkToken } from '@konum/core';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type ViewStyle } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import {
  DEMO_DEFAULT_BATTERY_PCT,
  DEMO_ME_INVITE,
  DEMO_ME_NAME,
  DEMO_OTP,
  demoControls,
  subscribeDemoEvents,
  type DemoSnapshot,
} from '../controls';
import { linkDomains } from '../../lib/linkConfig';
import { linkStore, selectLinkSessions } from '../../state/linkStore';
import { Text, useTheme } from '../../ui';
import { AlertHost } from './AlertHost.web';
import { ExpiryNotice } from './ExpiryNotice.web';
import {
  Faz3Section,
  LockScreen,
  PermissionsSection,
  PushBanner,
  ScreenHostLayer,
  SystemPromptHost,
  useDemoDevice,
  type ControlRow,
} from './Faz3.web';
import { Faz4Section } from './Faz4.web';
import { Faz5Section } from './Faz5.web';
import { Faz6Section } from './Faz6.web';
import { Faz7Section } from './Faz7.web';
import { Faz8Section } from './Faz8.web';
import { Faz9Hosts, Faz9Section } from './Faz9.web';
import { Faz10Hosts, Faz10Section } from './Faz10.web';

const WIDE_MIN = 900;
const SCREEN_W = 390;
const SCREEN_H = 844;
const BEZEL = 12;
const STATUS_H = 47;
const LOW_BATTERY_DEMO = 12;

function useDocumentMeta() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = 'Konum · Web önizleme';
    document.documentElement.lang = 'tr';
    // Telefondaki gibi: metin kutularının tarayıcı odak çerçevesi yok (kutuların kendi kenarlığı var).
    const style = document.createElement('style');
    style.textContent = 'input:focus, textarea:focus { outline: none; }';
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
}

/** Demo olaylarından simüle pil yüzdesi. */
function useDemoBattery(): number {
  const [pct, setPct] = useState(DEMO_DEFAULT_BATTERY_PCT);
  useEffect(
    () =>
      subscribeDemoEvents((e) => {
        if (e.type === 'battery') setPct(e.pct);
      }),
    [],
  );
  return pct;
}

/** Demo sunucusunun anlık görüntüsü (bağlantı / izleyici sayısı, Maps sayaçları). */
function useDemoSnapshot(): DemoSnapshot | null {
  const [snap, setSnap] = useState<DemoSnapshot | null>(() => {
    try {
      return demoControls.snapshot();
    } catch {
      return null;
    }
  });
  useEffect(
    () =>
      subscribeDemoEvents((e) => {
        if (e.type === 'snapshot') setSnap(e.snapshot);
      }),
    [],
  );
  return snap;
}

/**
 * "Bağlantıyı aç (izleyici)": en yeni süren QR bağlantımı, QR'ı okutan kişinin göreceği salt okunur izleyicide
 * (app/s/[token].tsx) uygulama içinde açar. Token kasadan (QR sayfasının kullandığı URL) okunur.
 */
async function openLatestLinkViewer(): Promise<string> {
  const st = linkStore.getState();
  const latest = selectLinkSessions(st).find((l) => l.phase !== 'ended' && l.phase !== 'stopping');
  if (!latest) return 'Önce "Konumumu paylaş" → "Bağlantı (QR)" ile bir bağlantı oluştur.';
  const url = latest.url ?? (await st.ensureUrl(latest.link_id));
  const token = url ? parseLinkToken(url, linkDomains()) : null;
  if (!token) return 'Bu bağlantının QR adresi bu tarayıcıda yok; yeni bir bağlantı oluştur.';
  router.push(`/s/${token}`);
  return 'İzleyici açıldı: QR\'ı okutan kişi bu ekranı görür.';
}

function useClock(): string {
  const fmt = () => {
    const d = new Date();
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const [t, setT] = useState(fmt);
  useEffect(() => {
    const id = setInterval(() => setT(fmt()), 15_000);
    return () => clearInterval(id);
  }, []);
  return t;
}

// ── Telefon çerçevesi ─────────────────────────────────────────────────────────────────────────

function StatusBarMock({ battery }: { battery: number }) {
  const { colors } = useTheme();
  const clock = useClock();
  const device = useDemoDevice(5000);
  const low = battery <= 20;
  const fill = low ? '#F59E0B' : colors.text;
  // Kilit ekranında koyu zemin: simgeler beyaz.
  const ink = device.locked ? '#FFFFFF' : colors.text;
  const bar = (on: boolean) => (on ? ink : device.locked ? 'rgba(255,255,255,0.3)' : colors.border);
  return (
    <View style={[styles.status, { backgroundColor: device.locked ? 'transparent' : colors.bg }]} pointerEvents="none">
      <View style={styles.statusLeft}>
        <Text variant="label" style={{ fontWeight: '600', color: ink }} maxFontSizeMultiplier={1}>
          {device.locked ? '' : clock}
        </Text>
        {device.engine.running ? (
          // iOS: konum kullanılırken saatin yanında konum oku.
          <Svg width={11} height={11} viewBox="0 0 24 24" testID="status-location-arrow">
            <Path d="M21 3 3 10.5l7.5 3 3 7.5L21 3Z" fill={ink} />
          </Svg>
        ) : null}
      </View>
      <View style={styles.island} />
      <View style={styles.statusRight}>
        {device.online ? (
          <Svg width={17} height={11} viewBox="0 0 17 11">
            <Rect x={0} y={7} width={3} height={4} rx={1} fill={bar(true)} />
            <Rect x={4.5} y={5} width={3} height={6} rx={1} fill={bar(true)} />
            <Rect x={9} y={2.5} width={3} height={8.5} rx={1} fill={bar(true)} />
            <Rect x={13.5} y={0} width={3} height={11} rx={1} fill={bar(true)} />
          </Svg>
        ) : (
          // iOS: hücresel bağlantı yokken çubuklar yerine "Servis Yok".
          <Text variant="caption" numberOfLines={1} style={{ fontSize: 12, lineHeight: 14, fontWeight: '600', color: ink }} maxFontSizeMultiplier={1}>
            Servis Yok
          </Text>
        )}
        {device.online ? (
          <Svg width={15} height={11} viewBox="0 0 15 11">
            <Path d="M7.5 10.5 5.3 8.2a3.2 3.2 0 0 1 4.4 0L7.5 10.5Z" fill={ink} />
            <Path d="M3.3 6.2a6 6 0 0 1 8.4 0" stroke={ink} strokeWidth={1.6} fill="none" strokeLinecap="round" />
            <Path d="M1 3.8a9.3 9.3 0 0 1 13 0" stroke={ink} strokeWidth={1.6} fill="none" strokeLinecap="round" />
          </Svg>
        ) : null}
        <View style={styles.batteryWrap}>
          <View style={[styles.battery, { borderColor: device.locked ? 'rgba(255,255,255,0.75)' : colors.textSecondary }]}>
            <View style={{ width: `${Math.max(6, battery)}%`, height: '100%', backgroundColor: low ? fill : ink, borderRadius: 2 }} />
          </View>
          <Text variant="caption" style={{ fontSize: 11, lineHeight: 13, fontWeight: '600', color: low ? '#F59E0B' : ink }} maxFontSizeMultiplier={1}>
            {battery}
          </Text>
        </View>
      </View>
    </View>
  );
}

function PhoneFrame({ children, scale }: { children: ReactNode; scale: number }) {
  const { colors } = useTheme();
  const battery = useDemoBattery();
  const locked = useDemoDevice(5000).locked;
  const outerW = SCREEN_W + BEZEL * 2;
  const outerH = SCREEN_H + BEZEL * 2;
  return (
    <View style={{ width: outerW * scale, height: outerH * scale }}>
      <View
        style={[
          styles.frame,
          {
            width: outerW,
            height: outerH,
            left: (outerW * scale - outerW) / 2,
            top: (outerH * scale - outerH) / 2,
            transform: [{ scale }],
          },
        ]}
      >
        <View style={[styles.screen, { backgroundColor: colors.bg }]} testID="demo-phone">
          <View style={styles.app}>
            {children}
            <ScreenHostLayer />
            <PushBanner />
          </View>
          <LockScreen />
          <SystemPromptHost />
          <Faz9Hosts />
          <Faz10Hosts />
          {/* Durum çubuğu en üstte (kilit ekranında da görünür). */}
          <View style={styles.statusLayer} pointerEvents="none">
            <StatusBarMock battery={battery} />
          </View>
          <View style={[styles.homeIndicator, { backgroundColor: locked ? '#FFFFFF' : colors.text }]} pointerEvents="none" />
        </View>
      </View>
    </View>
  );
}

// ── Demo kontrolleri ──────────────────────────────────────────────────────────────────────────

function DemoPanel({ showNotice, onNavigate, padding, footer }: { showNotice: boolean; onNavigate?: () => void; padding: ViewStyle; footer?: ReactNode }) {
  const { colors, radius } = useTheme();
  const battery = useDemoBattery();
  const snap = useDemoSnapshot();
  const [feedback, setFeedback] = useState<string | null>(null);
  const lowOn = battery === LOW_BATTERY_DEMO;
  const mapsDown = snap?.mapsDown ?? false;

  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 6000);
    return () => clearTimeout(t);
  }, [feedback]);

  const rows: ControlRow[] = [
    {
      key: 'shorten',
      title: 'Bitişe 2 dk kalsın',
      hint: 'Süren paylaşımın bitmek üzere uyarısını görmek için.',
      run: () =>
        demoControls.shortenMyShare(2) > 0
          ? 'Paylaşımının bitmesine 2 dk kaldı.'
          : 'Önce haritada "Konumumu paylaş" ile bir paylaşım başlat.',
    },
    {
      key: 'ayse',
      title: 'Ayşe paylaşımı durdursun',
      hint: 'Ayşe haritadan hemen kaybolur (sana verdiği konum izni durur).',
      run: () => (demoControls.aysheStop() ? 'Ayşe paylaşımını durdurdu.' : 'Ayşe şu anda paylaşmıyor.'),
    },
    {
      key: 'mehmet',
      title: 'Mehmet yeniden paylaşsın',
      hint: '1 saatlik yeni paylaşım, taze konumla (Mehmet sana konum izni verdiği için).',
      run: () => (demoControls.mehmetRestart() ? 'Mehmet konumunu yeniden paylaşıyor.' : 'Mehmet sana konum izni vermemiş.'),
    },
    {
      key: 'request',
      title: 'Arkadaşlık isteği gelsin',
      hint: 'Arkadaşlar ekranında onaylayabilirsin.',
      run: () => `${demoControls.sendFriendRequest()} sana arkadaşlık isteği gönderdi.`,
    },
    {
      key: 'battery',
      title: lowOn ? `Pilim normale dönsün (%${DEMO_DEFAULT_BATTERY_PCT})` : `Pilim %${LOW_BATTERY_DEMO} olsun`,
      hint: lowOn ? 'Uyarı %20 üstünde yeniden kurulur.' : 'Alıcılara bir kez "pili azaldı" bildirimi gider (%15 eşiği), rozet görünür.',
      run: () => {
        demoControls.setMyBattery(lowOn ? null : LOW_BATTERY_DEMO);
        return lowOn
          ? `Pil %${DEMO_DEFAULT_BATTERY_PCT}.`
          : `Pil %${LOW_BATTERY_DEMO}: alıcılarına bildirim gider, konum daha seyrek güncellenir.`;
      },
    },
    {
      key: 'reset',
      title: 'Demoyu sıfırla',
      hint: 'Tüm demo verisi silinir, sayfa yeniden yüklenir.',
      run: () => {
        demoControls.reset();
        return 'Demo sıfırlanıyor…';
      },
      tone: 'danger',
    },
  ];

  // Faz 2: QR bağlantısı ve harita servisleri (Google Routes / Geocoding simülasyonu).
  const linkRows: ControlRow[] = [
    {
      key: 'link-open',
      title: 'Bağlantıyı aç (izleyici)',
      hint: 'QR\'ı okutan kişinin gördüğü salt okunur canlı harita.',
      run: openLatestLinkViewer,
      navigates: true,
    },
    {
      key: 'link-revoke',
      title: 'Bağlantıyı sunucudan iptal et',
      hint: 'Açık izleyici 2 sn içinde "Paylaşım sona erdi" der.',
      run: () =>
        demoControls.revokeLatestLink()
          ? 'Bağlantı sunucuda iptal edildi; konum verisi silindi.'
          : 'İptal edilecek aktif QR bağlantın yok.',
    },
  ];
  const mapsRows: ControlRow[] = [
    {
      key: 'maps-down',
      title: mapsDown ? 'Google yeniden yanıt versin' : 'Google yanıt vermesin',
      hint: 'Önbellekte olmayan rota ve adres istekleri başarısız olur.',
      run: () => {
        demoControls.setMapsDown(!mapsDown);
        return mapsDown ? 'Rota ve adres servisleri yeniden çalışıyor.' : 'Rota ve adres servisleri yanıt vermiyor.';
      },
    },
  ];

  const press = async (r: ControlRow) => {
    try {
      setFeedback(await r.run());
      if (r.navigates) onNavigate?.();
    } catch (e) {
      console.warn('[demo]', e);
      setFeedback('Bu işlem şu an yapılamadı.');
    }
  };

  const renderRow = (r: ControlRow) => (
    <Pressable
      key={r.key}
      accessibilityRole="button"
      accessibilityLabel={r.title}
      onPress={() => void press(r)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.row,
        {
          borderRadius: radius.md,
          borderColor: colors.border,
          backgroundColor: pressed ? colors.surfaceAlt : hovered ? colors.bg : colors.surface,
        },
      ]}
    >
      <Text variant="label" style={{ color: r.tone === 'danger' ? colors.danger : colors.text, fontWeight: '600' }}>
        {r.title}
      </Text>
      <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
        {r.hint}
      </Text>
    </Pressable>
  );

  const m = snap?.maps;

  return (
    <View style={styles.panelBody}>
      <ScrollView contentContainerStyle={padding}>
    <View style={{ gap: 12 }}>
      <View style={{ gap: 6 }}>
        <View style={styles.titleRow}>
          <Text variant="title">Demo kontrolleri</Text>
          <View style={[styles.pill, { backgroundColor: colors.primarySoft }]}>
            <Text variant="caption" style={{ color: colors.primary }}>
              Web önizleme
            </Text>
          </View>
        </View>
        <Text variant="label" color="textSecondary" style={{ fontWeight: '400' }}>
          Bu, Konum uygulamasının tarayıcıdaki önizlemesi; arkadaşlar ve konumları simüle ediliyor.
        </Text>
        <Text variant="label" color="textSecondary" style={{ fontWeight: '400' }}>
          Harita çizimi yalnızca önizleme içindir; telefonda harita Google Maps'tir.
        </Text>
      </View>

      <Faz3Section snap={snap} renderRow={renderRow} />
      <Faz4Section snap={snap} renderRow={renderRow} />
      <Faz5Section snap={snap} renderRow={renderRow} />
      <Faz6Section snap={snap} renderRow={renderRow} onNavigate={onNavigate} />
      <Faz7Section snap={snap} renderRow={renderRow} />
      <Faz8Section snap={snap} renderRow={renderRow} />
      <Faz9Section snap={snap} renderRow={renderRow} />
      <Faz10Section snap={snap} renderRow={renderRow} />
      <PermissionsSection renderRow={renderRow} />

      {showNotice ? (
        <View style={{ gap: 8 }}>
          <Text variant="caption" color="textSecondary" style={styles.section}>
            TELEFON BİLDİRİMİ
          </Text>
          <ExpiryNotice mode="panel" />
        </View>
      ) : null}

      <View style={{ gap: 6 }}>
        <Text variant="caption" color="textSecondary" style={styles.section}>
          SENARYOLAR
        </Text>
        {rows.filter((r) => r.key !== 'reset').map(renderRow)}
      </View>

      <View style={{ gap: 6 }}>
        <Text variant="caption" color="textSecondary" style={styles.section}>
          QR BAĞLANTISI
        </Text>
        {linkRows.map(renderRow)}
        <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          {snap
            ? `Aktif bağlantı: ${snap.myActiveLinks} · açık izleyici: ${snap.linkViewers}`
            : 'Bağlantı durumu okunamadı.'}
        </Text>
      </View>

      <View style={{ gap: 6 }}>
        <Text variant="caption" color="textSecondary" style={styles.section}>
          ROTA VE ADRES (GOOGLE SİMÜLASYONU)
        </Text>
        {mapsRows.map(renderRow)}
        {m ? (
          <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
            {`Bugün rota ${m.route}/${m.routeLimit} (önbellekten ${m.routeHits}) · adres ${m.geocode}/${m.geocodeLimit} (önbellekten ${m.geocodeHits})`}
          </Text>
        ) : null}
      </View>

      <View style={{ gap: 6 }}>{rows.filter((r) => r.key === 'reset').map(renderRow)}</View>

      <View style={[styles.footer, { borderColor: colors.border }]}>
        <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          {`Demo kodu: ${DEMO_OTP} · Hesap: ${DEMO_ME_NAME} (${DEMO_ME_INVITE})`}
        </Text>
        <Text variant="caption" color="textSecondary" style={{ fontWeight: '400' }}>
          Veriler yalnızca bu tarayıcıda tutulur; ağ bağlantısı kullanılmaz.
        </Text>
      </View>
      {footer}
    </View>
      </ScrollView>
      {/* Geri bildirim: panelin altında sabit (uzun panelde düğmeden uzakta kaybolmasın). */}
      <View style={styles.toastWrap} pointerEvents="none" accessibilityLiveRegion="polite">
        {feedback ? (
          <View testID="demo-feedback" style={[styles.toast, { backgroundColor: colors.text, borderRadius: radius.md }]}>
            <Text variant="caption" style={{ color: colors.bg, fontWeight: '500' }}>
              {feedback}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ── Kabuk ─────────────────────────────────────────────────────────────────────────────────────

export function DemoShell({ children }: { children: ReactNode }) {
  useDocumentMeta();
  const { width, height } = useWindowDimensions();
  const { colors, scheme } = useTheme();
  const [sheetOpen, setSheetOpen] = useState(false);
  const wide = width >= WIDE_MIN;

  if (wide) {
    const scale = Math.min(1, (height - 32) / (SCREEN_H + BEZEL * 2));
    const pageBg = scheme === 'dark' ? '#070C16' : '#E7EBF0';
    return (
      <View style={[styles.page, { backgroundColor: pageBg }]}>
        <PhoneFrame scale={scale}>
          {children}
          <AlertHost />
        </PhoneFrame>
        <View style={[styles.panel, { maxHeight: Math.max(480, height - 48), backgroundColor: colors.surface, borderColor: colors.border }]}>
          <DemoPanel showNotice padding={{ paddingHorizontal: 22, paddingVertical: 18 }} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.full}>
      {children}
      <ScreenHostLayer />
      <AlertHost />
      <ExpiryNotice mode="banner" />
      <PushBanner />
      <LockScreen />
      <SystemPromptHost />
      <Faz9Hosts />
      <Faz10Hosts />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Demo kontrollerini aç"
        onPress={() => setSheetOpen(true)}
        style={[styles.tab, { backgroundColor: colors.text }]}
      >
        {/* Dar, dikey sekme: haritada olabildiğince az yer kaplasın. */}
        {'DEMO'.split('').map((ch, i) => (
          <Text key={i} variant="caption" style={{ color: colors.bg, fontWeight: '700', fontSize: 9, lineHeight: 11 }} maxFontSizeMultiplier={1}>
            {ch}
          </Text>
        ))}
      </Pressable>
      {sheetOpen ? (
        <View style={[StyleSheet.absoluteFill, styles.sheetRoot]}>
          <Pressable accessibilityLabel="Kapat" style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={() => setSheetOpen(false)} />
          <View style={[styles.sheet, { backgroundColor: colors.surface, maxHeight: height * 0.86 }]}>
            <View style={[styles.grabber, { backgroundColor: colors.border }]} />
            <DemoPanel
              showNotice={false}
              onNavigate={() => setSheetOpen(false)}
              padding={{ paddingHorizontal: 20, paddingBottom: 28, paddingTop: 8 }}
              footer={
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setSheetOpen(false)}
                  style={[styles.closeBtn, { backgroundColor: colors.surfaceAlt }]}
                >
                  <Text variant="heading">Kapat</Text>
                </Pressable>
              }
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 56, padding: 16 },
  frame: {
    position: 'absolute',
    padding: BEZEL,
    borderRadius: 58,
    backgroundColor: '#0B0F17',
    boxShadow: '0px 30px 80px rgba(15, 23, 42, 0.35), 0px 0px 0px 2px #2A3242',
  },
  screen: { flex: 1, borderRadius: 46, overflow: 'hidden' },
  status: { height: STATUS_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 6 },
  statusLayer: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 60 },
  statusLeft: { width: 90, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  island: { position: 'absolute', top: 11, left: SCREEN_W / 2 - 60, width: 120, height: 34, borderRadius: 20, backgroundColor: '#000000' },
  statusRight: { minWidth: 90, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  batteryWrap: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  battery: { width: 22, height: 11, borderWidth: 1, borderRadius: 3, padding: 1 },
  app: { flex: 1, marginTop: STATUS_H, position: 'relative', overflow: 'hidden' },
  homeIndicator: { position: 'absolute', bottom: 7, left: SCREEN_W / 2 - 67, width: 134, height: 5, borderRadius: 3, opacity: 0.85 },
  panel: { width: 360, borderRadius: 24, borderWidth: 1, boxShadow: '0px 8px 24px rgba(15, 23, 42, 0.12)', overflow: 'hidden' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  section: { letterSpacing: 1 },
  row: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, gap: 1, cursor: 'pointer' },
  footer: { borderTopWidth: 1, paddingTop: 12, gap: 4 },
  panelBody: { flexShrink: 1, minHeight: 0, position: 'relative' },
  toastWrap: { position: 'absolute', left: 12, right: 12, bottom: 12, alignItems: 'stretch' },
  toast: { paddingHorizontal: 12, paddingVertical: 9, boxShadow: '0px 6px 18px rgba(15, 23, 42, 0.25)' },
  full: { flex: 1 },
  tab: {
    position: 'absolute',
    right: 0,
    top: '44%',
    // 14 px: ekran kenarındaki 16 px boşluğa sığar, onay kutuları ve harita etiketleriyle çakışmaz.
    width: 14,
    alignItems: 'center',
    paddingVertical: 7,
    borderTopLeftRadius: 7,
    borderBottomLeftRadius: 7,
    opacity: 0.88,
    zIndex: 40,
    boxShadow: '0px 4px 12px rgba(15, 23, 42, 0.25)',
  },
  sheetRoot: { zIndex: 60, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, boxShadow: '0px -8px 24px rgba(15, 23, 42, 0.18)' },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, marginTop: 8 },
  closeBtn: { marginTop: 16, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
