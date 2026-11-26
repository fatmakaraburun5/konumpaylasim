/**
 * Bildirim eylemi arka plan görevi (Android: uygulama arka planda/kapalıyken "+30 dk" dokunuşu).
 * Faz 9: Güvenli Dönüş "Güvendeyim" / "+15 dk" eylemleri de buradan (safeReturnActions).
 * Konum göreviyle aynı nedenle modül üst seviyesinde tanımlanır ve index.ts'ten erken içe aktarılır.
 */
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { ensureFirebase } from '../firebase/init';
import { NOTIFICATION_TASK_NAME } from './constants';
import { handleExpiryResponse } from './expiryActions';
import { handleSafeReturnResponse } from './safeReturnActions';

TaskManager.defineTask<Notifications.NotificationTaskPayload>(NOTIFICATION_TASK_NAME, async ({ data, error }) => {
  if (error || !data || !('actionIdentifier' in data)) return Notifications.BackgroundNotificationTaskResult.NoData;
  try {
    await ensureFirebase();
    const sr = await handleSafeReturnResponse(data);
    if (sr === null) await handleExpiryResponse(data, null);
    return Notifications.BackgroundNotificationTaskResult.NewData;
  } catch {
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
});

Notifications.registerTaskAsync(NOTIFICATION_TASK_NAME).catch(() => undefined);
