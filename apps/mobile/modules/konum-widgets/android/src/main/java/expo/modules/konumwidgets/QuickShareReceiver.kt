// Faz 6: widget "1 sa paylaş" düğmesinin (ve kutucuğun) yayın alıcısı. Uygulama sürecinde, JS başlatılmadan çalışır:
// goAsync() + arka plan iş parçacığı → QuickShareRunner (HTTP) → widget'lar yeniden çizilir. Etkinlik AÇMAZ
// (Android 10+ arka plandan etkinlik başlatma kısıtı); "uygulamayı aç" kararları çizimde PendingIntent.getActivity ile
// verilir. Dışa kapalı (exported=false): yalnızca kendi PendingIntent'lerimiz tetikler.
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi.
package expo.modules.konumwidgets

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class QuickShareReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION) return
    val toUid = intent.getStringExtra(EXTRA_TO) ?: return
    val source = if (intent.getStringExtra(EXTRA_SRC) == "android_tile") "android_tile" else "android_widget"
    val app = context.applicationContext
    val pending = goAsync()
    Thread {
      try {
        QuickShareRunner.run(app, toUid, source)
      } catch (e: Exception) {
        // Beklenmeyen hata: bir sonraki çizim düzeltir.
      } finally {
        pending.finish()
      }
    }.start()
  }

  companion object {
    const val ACTION = "expo.modules.konumwidgets.QUICK_SHARE"
    const val EXTRA_TO = "to_uid"
    const val EXTRA_SRC = "source"
  }
}
