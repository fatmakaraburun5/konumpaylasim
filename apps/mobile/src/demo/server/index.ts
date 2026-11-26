/**
 * Demo sunucusunun tek örneği ve demo paneli API'si.
 *
 * YALNIZCA web dosyaları (`*.web.ts(x)`, src/demo/**) içe aktarır; native pakete girmemelidir.
 * Sunucu ilk erişimde oluşturulur: kalıcı durum yüklenir ya da dünya tohumlanır, süpürücü başlar.
 */
import { HOUR, MINUTE } from '@konum/core';
import {
  DEMO_DEFAULT_BATTERY_PCT,
  demoBatteryPct,
  demoPosition,
  placeDemoPhone,
  onDemoBatteryChange,
  onDemoEngineChange,
  onDemoMotionChange,
  setDemoBatteryPct,
  setDemoMotion,
  type DemoMotionMode,
} from '../web/device';
import { onDemoNetworkChange, setDemoOnline, startDemoTunnel } from '../web/network';
import { grantAllDemoPerms, onDemoPermsChange, resetDemoContactsPerm, resetDemoPermsToFirstRun } from '../web/permissions';
import { renderProofJpeg } from '../web/proofScene';
import { onDemoScreenChange, setDemoScreenLocked } from '../web/screen';
import {
  onDemoNotification,
  presentedDemoNotifications,
  respondToDemoNotification,
  type DemoNotification,
} from '../../services/notifications/expoNotifications.web';
import { AYSE_BATTERY, AYSE_LOW_BATTERY, DemoServer, type DemoSnapshot } from './server';
import { safeStorage } from './storage';
import { DEMO_ME, DEMO_ME_FAVORITES, PEOPLE } from './world';

let instance: DemoServer | null = null;

export function demoServer(): DemoServer {
  if (!instance) instance = new DemoServer();
  return instance;
}

export {
  AYSE_BATTERY,
  AYSE_LOW_BATTERY,
  DemoHttpsError,
  DemoPermissionDenied,
  DEMO_STORAGE_KEY,
  type DemoBatteryNotice,
  type DemoPushMessage,
  type DemoSmsLogEntry,
  type DemoSnapshot,
  type DemoWidgetSource,
} from './server';
export { DEMO_ME, DEMO_ME_FAVORITES, DEMO_ME_INVITE, DEMO_ME_NAME, DEMO_OTP, MAP_HOME, PEOPLE } from './world';
export { DemoStorageError } from './avatars';
export { DEMO_DEFAULT_BATTERY_PCT, demoBatteryPct } from '../web/device';
export { presentedDemoNotifications, respondToDemoNotification, type DemoNotification };

/** Uygulamanın ve demonun tüm kalıcı anahtarları bu önekle başlar (`konum.bg.*`, `konum.ui.*`, `konum.demo.*`). */
const APP_KEY_PREFIX = 'konum.';

/** Demo paneli düğmeleri. Her biri sunucu durumunu değiştirir; uygulama değişikliği dinleyicilerden alır. */
export const demoControls = {
  /** "Bitişe N dk kalsın": aktif paylaşımlarımın bitişini öne çeker. Dönen: kısaltılan paylaşım sayısı. */
  shortenMyShare(minutesLeft: number): number {
    return demoServer().shortenMyActiveShares(Math.max(0, minutesLeft) * MINUTE);
  },
  /** Ayşe bana paylaşımını durdurur (haritadan kaybolur). Dönen: durduruldu mu. */
  aysheStop(): boolean {
    return demoServer().botStopSharing(PEOPLE.ayse.uid);
  },
  /** Ayşe bana yeniden paylaşmaya başlar (1 saat). */
  aysheStart(): boolean {
    return demoServer().botStartSharing(PEOPLE.ayse.uid);
  },
  /** Mehmet paylaşımını yeniden başlatır (1 saat, hemen taze konum). */
  mehmetRestart(): boolean {
    return demoServer().botStartSharing(PEOPLE.mehmet.uid);
  },
  /** Bana arkadaşlık isteği gelir (önce Elif, sonra sanal kişiler). Dönen: gönderenin adı. */
  sendFriendRequest(): string {
    return demoServer().incomingFriendRequest();
  },
  /**
   * Faz 2 "Bağlantıyı sunucudan iptal et": en yeni aktif QR bağlantımı sunucuda bitirir (mezar taşı + link_live
   * silinir). Açık izleyici 2 sn içinde "Paylaşım sona erdi" der. Dönen: iptal edilecek bağlantı var mıydı.
   */
  revokeLatestLink(): boolean {
    return demoServer().revokeLatestLink();
  },
  /** Faz 2 "Google yanıt vermesin": önbellekte olmayan rota / adres istekleri `maps_unavailable` alır. */
  setMapsDown(down: boolean): void {
    demoServer().setMapsDown(down);
  },
  /** Simüle pil yüzdesi; null = varsayılan (%78). Sonraki konum örneğinden itibaren pakete yansır. */
  setMyBattery(pct: number | null): void {
    setDemoBatteryPct(pct === null || !Number.isFinite(pct) ? DEMO_DEFAULT_BATTERY_PCT : pct);
  },
  // --- Faz 3 ---------------------------------------------------------------------------------------
  /**
   * Simüle telefon hareketi: "still" (masada), "walk" (yürüyüş), "drive" (araç). Hareket izni varsa OS etkinlik olayı
   * da üretilir (demo kısaltması: olay 4 dk geriye tarihlenir, hareketsizliğe giriş beklemesi atlanır).
   */
  setMotion(mode: DemoMotionMode): void {
    setDemoMotion(mode);
  },
  /** "Tünele gir": `ms` boyunca bağlantı yok (GPS sürer, noktalar kuyruğa girer), sonra kendiliğinden gelir. */
  startTunnel(ms: number = 2 * MINUTE): void {
    startDemoTunnel(Math.max(5_000, ms));
  },
  /** Tünelden erken çık. */
  endTunnel(): void {
    setDemoOnline(true);
  },
  /** Simüle ekran kilidi: kilitliyken uygulama arka planda sayılır (matrisin arka plan satırı). */
  setScreenLocked(locked: boolean): void {
    setDemoScreenLocked(locked);
  },
  /** Ayşe'nin pili (%14 → bana "Ayşe'nin pili azaldı" push'u + amber rozet; %64 → yeniden kurulur). */
  setAyseBattery(pct: number): ReturnType<DemoServer['setAyseBattery']> {
    return demoServer().setAyseBattery(pct);
  },
  ayseLowBattery(): ReturnType<DemoServer['setAyseBattery']> {
    return demoServer().setAyseBattery(AYSE_LOW_BATTERY);
  },
  ayseBatteryNormal(): ReturnType<DemoServer['setAyseBattery']> {
    return demoServer().setAyseBattery(AYSE_BATTERY);
  },
  /** Mehmet'in telefonu kapanır: son doğrulanmış konumu 63 dk önce kalır → "Bağlantısı kopmuş olabilir". */
  mehmetDisconnect(): boolean {
    return demoServer().mehmetDisconnect();
  },
  mehmetReconnect(): boolean {
    return demoServer().mehmetReconnect();
  },
  /** Simüle izinleri ilk kurulum durumuna döndürür (hepsi "sorulmadı"); uygulama tarafı kabukta sıfırlanır. */
  resetPermissions(): void {
    resetDemoPermsToFirstRun();
  },
  grantAllPermissions(): void {
    grantAllDemoPerms();
  },
  // --- Faz 4 ---------------------------------------------------------------------------------------
  /** Ayşe bana "📍 Buradayım" (konumlu) gönderir. Dönen: gönderildi mi (arkadaş değilse false). */
  aysePingHere(): boolean {
    return demoServer().botPing(PEOPLE.ayse.uid, 'here');
  },
  /** Mehmet bana "🚶 Yoldayım" gönderir (yaklaşık `etaMin` dk içinde). */
  mehmetPingOnWay(etaMin = 12): boolean {
    return demoServer().botPing(PEOPLE.mehmet.uid, 'on_way', Math.round(etaMin * 60));
  },
  /** Ayşe'nin durum notu ("☕ Kahve molasındayım", 1 saat) açılır / kapanır. Dönen: yeni durum + Ayşe paylaşıyor mu. */
  toggleAyseStatusNote(): { on: boolean; sharing: boolean } {
    const on = !demoServer().hasBotStatusNote(PEOPLE.ayse.uid);
    const sharing = demoServer().setBotStatusNote(PEOPLE.ayse.uid, on ? { emoji: '☕', text: 'Kahve molasındayım', ms: HOUR } : null);
    return { on, sharing };
  },
  /** Ayşe bulunduğu yere "🅿️ Park yeri burası" notu bırakır (yalnızca bana görünür, 4 saat). */
  aysePlaceNote(): boolean {
    return demoServer().botPlaceNote(PEOPLE.ayse.uid);
  },
  /** Ayşe SOS gönderir (acil kişisi benim): tam konum, adres, pil %23, rota. Dönen: sos_id ya da null. */
  ayseSos(): string | null {
    return demoServer().botSos(PEOPLE.ayse.uid);
  },
  /** Ayşe "Güvendeyim" der. Dönen: aktif SOS var mıydı. */
  ayseSafe(): boolean {
    return demoServer().botSosResolve(PEOPLE.ayse.uid);
  },

  // --- Faz 5 ---------------------------------------------------------------------------------------
  /**
   * "Ev bölgemi buraya kaydet (demo)": telefonun şu anki yerinde 150 m Ev bölgesi + "Vardığımda Ayşe'ye bildir" +
   * "Çıkınca Ayşe ile 1 saat paylaş". Telefon orada "masada" bekler (yürüyüş bölgeden kendiliğinden çıkmasın).
   * Dönen: bölge kimliği ya da null (Ayşe arkadaş değil).
   */
  saveHomeZoneHere(): string | null {
    const here = demoPosition();
    placeDemoPhone(here);
    return demoServer().saveDemoHomeZone(here)?.zone_id ?? null;
  },
  /** "Ayşe eve vardı": Ayşe'nin kuralı → bana "Ayşe Ev konumuna vardı" push'u. Dönen: bildirilen kişi sayısı ya da null. */
  ayseArrivedHome(): number | null {
    const r = demoServer().botZoneArrive(PEOPLE.ayse.uid);
    return r ? r.notified : null;
  },
  /** "Ayşe buluşma noktası önersin": Ayşe ile benim aramda bir kafe → bana öneri (push + kart). Dönen: meetup_id. */
  ayseSuggestMeetup(): string | null {
    return demoServer().botMeetupSuggest(PEOPLE.ayse.uid, demoPosition());
  },

  // --- Faz 6 ---------------------------------------------------------------------------------------
  /**
   * "Widget oturumu sunucuda dolsun": benim widget token'larımın süresi SUNUCUDA dolar (cihaz bilmez) → sonraki
   * dokunuş `token_expired` alır, widget uygulamayı derin bağlantıyla açar, uygulama token'ı yeniler. Dönen: token sayısı.
   */
  widgetExpireToken(): number {
    return demoServer().expireWidgetTokens(DEMO_ME, null);
  },
  /** "Hız sınırı dolsun": token'larımın bu saatlik penceresi 6/6 → sonraki dokunuş `rate_limited`. */
  widgetRateLimit(): number {
    return demoServer().exhaustWidgetTokens(DEMO_ME, null);
  },
  /** Favorilerimi ayarlar (`favorites_set` ile aynı temizlik). Dönen: saklanan liste. */
  setMyFavorites(ids: readonly string[]): string[] {
    return demoServer().setFavoritesOf(DEMO_ME, ids);
  },
  /** Favorilerimi demo başlangıcına döndürür (Ayşe, Mehmet, Zeynep; Faz 8: yalnızca konum izni verdiklerim kalır). */
  restoreMyFavorites(): string[] {
    return demoServer().setFavoritesOf(DEMO_ME, DEMO_ME_FAVORITES);
  },

  // --- Konum İste ----------------------------------------------------------------------------------
  /** "Mehmet konumunu istiyor": Mehmet bana konum isteği gönderir (Onayla / Reddet bildirimi + harita kartı). */
  friendRequestsMyLocation(who: 'mehmet' | 'ayse' | 'can' = 'mehmet'): boolean {
    return demoServer().friendRequestsMyLocation(who);
  },

  // --- Faz 7 ---------------------------------------------------------------------------------------
  /** "Ayşe etkinliğe davet etsin": yarın için 3 mekanlı etkinlik → bana davet (push + Etkinlikler). Dönen: kimlik ya da hata kodu. */
  ayseCreatesEvent(): { ok: true; event_id: string } | { ok: false; code: string } {
    return demoServer().botCreateEvent(PEOPLE.ayse.uid);
  },
  /** "Hatırlatmayı şimdi gönder": kesinleşmiş etkinliklerimin sıradaki hatırlatması hemen gider. Dönen: gönderilen sayı. */
  fireEventRemindersNow(): number {
    return demoServer().fireMyEventRemindersNow();
  },
  /** "Mehmet yola çıksın": Mehmet'in hareket raporu → bana "Mehmet yola çıktı" heads-up bildirimi. Dönen: sunucu durumu. */
  mehmetDeparts(): string {
    return demoServer().botDeparture(PEOPLE.mehmet.uid);
  },

  // --- Faz 8 ---------------------------------------------------------------------------------------
  /** "Can konumunu görmek istiyor": bana `location_view` isteği (push + "İzin istekleri" kartı). Dönen: gönderildi mi. */
  canRequestsMyLocation(): boolean {
    return demoServer().canRequestsMyLocation();
  },
  /** "Ayşe iznini geri alsın": konum izni kalkar, paylaşımı biter; tekrar basınca yeniden verir ve paylaşır. */
  ayseRevokes(): 'revoked' | 'granted' | null {
    return demoServer().ayseRevokes();
  },
  /** "Mehmet sana ping izni versin" (bana `permission_granted` push'u). Dönen: yeni izin verildi mi. */
  mehmetGrantsPing(): boolean {
    return demoServer().mehmetGrantsPing();
  },
  /** "Sözleşme güncellendi (yeniden onay)": onayım eski sürüme çekilir → kapı "Metin güncellendi" ile açılır. */
  bumpConsent(): void {
    demoServer().bumpConsent();
  },
  /** Onayımı tamamen siler (ilk açılış kapısı). */
  resetConsent(): void {
    demoServer().resetConsent();
  },

  // --- Faz 9 ---------------------------------------------------------------------------------------
  /** "Ayşe anlık fotoğraf paylaşsın": o an çizilen kafe karesi (tuval yoksa gömülü JPEG) + açıklama, 1 saat. */
  aysePhotoProof(): ReturnType<DemoServer['botProof']> {
    const img = renderProofJpeg('cafe', Date.now(), 960, 720, 0.7);
    return demoServer().botProof(PEOPLE.ayse.uid, 'Mekana geçtim, masamız burası', img);
  },
  /** Etkin fotoğrafların süresini `ms` (varsayılan 1 saat) ileri sarar. Dönen: biten fotoğraf sayısı. */
  fastForwardProofs(ms: number = HOUR): number {
    return demoServer().fastForwardProofs(ms);
  },
  /** "Ayşe hedefine yaklaşsın / varsın" (near → arrived). Ayşe paylaşmıyorsa null. */
  ayseApproach(): ReturnType<DemoServer['botApproach']> {
    return demoServer().botApproach(PEOPLE.ayse.uid);
  },
  /** "Ayşe Güvenli Dönüş başlatsın ve yanıt vermesin" (acil kişisi benim; demo kısaltmalı süreler). */
  ayseSafeReturnNoReply(): ReturnType<DemoServer['botSafeReturnStart']> {
    return demoServer().botSafeReturnStart(PEOPLE.ayse.uid);
  },
  /** Benim Güvenli Dönüş zamanlayıcım: süreyi bitir (`due`) ya da alarmı tetikle (`alarm`). Etkin yoksa null. */
  expireMySafeReturn(stage: 'due' | 'alarm'): string | null {
    return demoServer().expireMySafeReturn(stage);
  },
  /** İnterneti `ms` boyunca keser (tünel simülasyonu; SOS'un SMS yedeği için). */
  cutInternet(ms: number = 3 * MINUTE): void {
    startDemoTunnel(Math.max(5_000, ms));
  },
  /** Kesilen interneti hemen geri getirir (bekleyen SOS yeniden denemesi sunucuya ulaşır). */
  restoreInternet(): void {
    setDemoOnline(true);
  },
  /** Rehber iznini "sorulmadı"ya döndürür. */
  resetContactsPermission(): void {
    resetDemoContactsPerm();
  },

  /** Demoyu baştan başlatır: sunucu + uygulamanın kalıcı anahtarları silinir, sayfa yeniden yüklenir. */
  // --- Faz 10 --------------------------------------------------------------------------------------
  /** "Ayşe 40 dk sonrası için buluşma kursun": kesin etkinlik; Mehmet, Zeynep ve ben katılıyoruz (45 dk penceresi açık). */
  ayseCreatesSoonEvent(): ReturnType<DemoServer['botCreateSoonEvent']> {
    return demoServer().botCreateSoonEvent();
  },
  /** "Ayşe mekana vardı": şeritte "Ayşe · Vardı". */
  ayseArrivesAtEvent(): boolean {
    return demoServer().botArriveAtSoonEvent(PEOPLE.ayse.uid);
  },
  /** "Buluşma saatini 31 dk geçir": şerit kapanır. */
  endSoonEvent(): boolean {
    return demoServer().endSoonEvent();
  },
  /** "Yeni telefona geç" hazırlığı: bu oturum eski telefon olur, kurtarma e-postası doğrulanır. */
  prepareNewPhone(currentDsid: string | null): ReturnType<DemoServer['prepareNewPhoneSwitch']> {
    return demoServer().prepareNewPhoneSwitch(currentDsid);
  },
  reset(): void {
    demoServer().reset();
    safeStorage.removePrefix(APP_KEY_PREFIX);
    if (typeof window !== 'undefined' && window.location) window.location.reload();
  },
  /** Anlık demo durumu (panelde gösterim için). */
  snapshot(): DemoSnapshot {
    return demoServer().snapshot();
  },
};

export type DemoEvent =
  | { type: 'snapshot'; snapshot: DemoSnapshot }
  | { type: 'battery'; pct: number }
  | { type: 'notification'; notification: DemoNotification }
  | { type: 'notification_dismissed'; id: string }
  /** Faz 3: simüle telefonun hareket / bağlantı / kilit / izin / konum motoru durumu değişti (panel yeniden okur). */
  | { type: 'device' };

/**
 * Demo olayları: sunucu durumu değiştikçe `snapshot`, pil değişince `battery`, uygulama yerel bildirim
 * "gösterdiğinde" `notification` (ör. "Konum paylaşımın bitmek üzere" + "+30 dk"/"+1 saat" eylemleri;
 * eylem `respondToDemoNotification(id, actionId)` ile gerçek yanıt yoluna girer). Dönen fonksiyon aboneliği kapatır.
 */
export function subscribeDemoEvents(cb: (e: DemoEvent) => void): () => void {
  const safe = (e: DemoEvent) => {
    try {
      cb(e);
    } catch {
      // panel hatası sunucuyu etkilemez
    }
  };
  const unsubs = [
    demoServer().subscribe(
      () => demoServer().snapshot(),
      (snapshot) => safe({ type: 'snapshot', snapshot }),
    ),
    onDemoBatteryChange((pct) => safe({ type: 'battery', pct })),
    onDemoNotification((n, dismissedId) => {
      if (n) safe({ type: 'notification', notification: n });
      else if (dismissedId) safe({ type: 'notification_dismissed', id: dismissedId });
    }),
    onDemoMotionChange(() => safe({ type: 'device' })),
    onDemoNetworkChange(() => safe({ type: 'device' })),
    onDemoScreenChange(() => safe({ type: 'device' })),
    onDemoPermsChange(() => safe({ type: 'device' })),
    onDemoEngineChange(() => safe({ type: 'device' })),
  ];
  safe({ type: 'battery', pct: demoBatteryPct() });
  return () => unsubs.forEach((u) => u());
}

// Otomasyon / konsoldan deneme için (yalnızca web paketi bu modülü içerir).
if (typeof window !== 'undefined') {
  (window as unknown as { __konumDemo?: typeof demoControls }).__konumDemo = demoControls;
}
