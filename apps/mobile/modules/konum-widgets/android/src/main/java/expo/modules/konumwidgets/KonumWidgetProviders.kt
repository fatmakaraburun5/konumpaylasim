// Faz 6: widget sağlayıcıları (klasik AppWidgetProvider; manifest kaydı app.plugin.js'te).
//  - KonumWidgetSmallProvider: 2x2, tek favori (default_uid = ilk favori).
//  - KonumWidgetLargeProvider: 4x2, en çok 4 favori.
// Veri her zaman SharedPreferences'taki anlık görüntüden okunur; sağlayıcı ağa çıkmaz.
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi.
package expo.modules.konumwidgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle

open class KonumWidgetBaseProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    WidgetRenderer.updateAll(context)
  }

  override fun onAppWidgetOptionsChanged(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
    WidgetRenderer.updateAll(context)
  }

  override fun onEnabled(context: Context) {
    WidgetRefreshWorker.ensurePeriodic(context)
  }

  override fun onDisabled(context: Context) {
    // Diğer boyuttan widget kaldıysa periyodik iş sürer.
    if (!WidgetRenderer.hasAnyWidget(context)) WidgetRefreshWorker.cancelAll(context)
  }
}

class KonumWidgetSmallProvider : KonumWidgetBaseProvider()

class KonumWidgetLargeProvider : KonumWidgetBaseProvider()
