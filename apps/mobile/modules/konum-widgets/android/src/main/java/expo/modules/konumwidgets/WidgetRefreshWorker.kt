// Faz 6: widget yenileme işleri (WorkManager).
//  - Periyodik (30 dk): "N dk önce" / bayatlık metinleri uygulama açılmasa da güncellensin. Widget varken HER ZAMAN
//    kuyrukta tutulur: WorkManager kuyruğu boşalınca kendi RescheduleReceiver bileşenini kapatır → PACKAGE_CHANGED →
//    APPWIDGET_UPDATE → yeniden iş → sonsuz döngü (bilinen WorkManager + widget sorunu) oluşmasın.
//  - Sınır (tek seferlik, REPLACE): en yakın paylaşım bitişi / bayatlık sınırı / hata-bekleme durumunun sonu.
//    Chronometer sıfırın altına inmesin diye bitişte yeniden çizilir (Doze'da birkaç dk gecikebilir [Varsayım]).
//  - `updatePeriodMillis = 30 dk` (sağlayıcı XML'i) WorkManager başlatılamazsa yedektir.
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi.
package expo.modules.konumwidgets

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

class WidgetRefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    WidgetRenderer.updateAll(applicationContext)
    return Result.success()
  }

  companion object {
    private const val PERIODIC = "konum_widget_periodic"
    private const val BOUNDARY = "konum_widget_boundary"

    fun ensurePeriodic(ctx: Context) {
      try {
        val req = PeriodicWorkRequest.Builder(WidgetRefreshWorker::class.java, 30, TimeUnit.MINUTES).build()
        WorkManager.getInstance(ctx.applicationContext)
          .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
      } catch (e: Exception) {
        // WorkManager başlatılamadı (ör. varsayılan başlatıcı kapatıldı): updatePeriodMillis yedeği çalışır.
      }
    }

    fun cancelAll(ctx: Context) {
      try {
        val wm = WorkManager.getInstance(ctx.applicationContext)
        wm.cancelUniqueWork(PERIODIC)
        wm.cancelUniqueWork(BOUNDARY)
      } catch (e: Exception) {
      }
    }

    fun scheduleBoundary(ctx: Context, snap: WSnapshot?, quick: WQuickState?, now: Long) {
      var next = Long.MAX_VALUE
      fun consider(at: Long) {
        if (at > now && at < next) next = at
      }
      snap?.favorites?.forEach { f ->
        f.myShareExpiresAt?.let { consider(it) }
        val t = f.lastSeenAt
        if (f.status == "sharing_live" && t != null) consider(t + WidgetLimits.STALE_AFTER_MS)
      }
      if (quick != null) {
        consider(quick.at + (if (quick.phase == "pending") WidgetLimits.PENDING_MS else WidgetLimits.ERROR_FALLBACK_MS))
      }
      try {
        val wm = WorkManager.getInstance(ctx.applicationContext)
        if (next == Long.MAX_VALUE) {
          wm.cancelUniqueWork(BOUNDARY)
          return
        }
        val req = OneTimeWorkRequest.Builder(WidgetRefreshWorker::class.java)
          .setInitialDelay(next - now + 1_000L, TimeUnit.MILLISECONDS)
          .build()
        wm.enqueueUniqueWork(BOUNDARY, ExistingWorkPolicy.REPLACE, req)
      } catch (e: Exception) {
      }
    }
  }
}
