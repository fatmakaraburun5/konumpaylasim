/**
 * Demo paneli için ince giriş noktası: yalnızca web kabuğu (`demo/shell/DemoShell.web.tsx`) içe aktarır,
 * native pakete girmez. Panel düğmeleri doğrudan demo sunucusunun `demoControls` API'sini çağırır.
 */
export {
  AYSE_BATTERY,
  AYSE_LOW_BATTERY,
  demoControls,
  subscribeDemoEvents,
  presentedDemoNotifications,
  DEMO_DEFAULT_BATTERY_PCT,
  DEMO_ME_INVITE,
  DEMO_ME_NAME,
  DEMO_OTP,
  type DemoBatteryNotice,
  type DemoEvent,
  type DemoNotification,
  type DemoSnapshot,
} from './server';
