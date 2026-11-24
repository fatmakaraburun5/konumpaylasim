/** Yan etkili modül: index.ts'ten içe aktarıldığı anda FCM arka plan işleyicisini kaydeder. */
import { registerBackgroundMessageHandler } from './push';

registerBackgroundMessageHandler();
