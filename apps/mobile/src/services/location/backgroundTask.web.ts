/**
 * Web demo: TaskManager yerine simüle motorun "arka plan görevi" kayıtları. Örnekler gerçek hattan geçer.
 * index.ts bu modülü native'deki gibi en başta içe aktarır.
 * Faz 3: uyku çiti görevi (native `GEOFENCE_TASK_NAME`) → `handleMotionEvent({ type: 'geofence_exit' })`.
 * Kuyruk deposu: native SQLite yerine AsyncStorage yedeği (outboxStore.ts, kayıt gerekmez).
 */
import { defineDemoGeofenceTask, defineDemoLocationTask } from '../../demo/web/device';
import { handleMotionEvent, handleSamples } from './pipeline';
// Faz 5: bölge filtresi bağlantısı ve demo kancaları (simüle bölge izleme zoneMonitor.web.ts içinde).
import './zoneMonitor';

defineDemoLocationTask((samples) => handleSamples(samples, 'task'));
defineDemoGeofenceTask(() => handleMotionEvent({ type: 'geofence_exit' }));
