// Faz 6: uygulama ↔ widget köprüsü (Android). JS sarmalayıcı: src/services/widgets/widgetBridge.ts
// Depolar WidgetStore.kt'de; çizim WidgetRenderer.kt'de. Tüm işlevler Expo'nun arka plan kuyruğunda çalışır.
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi.
package expo.modules.konumwidgets

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KonumWidgetsModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("KonumWidgets")

    AsyncFunction("setSnapshot") { json: String ->
      WidgetStore.setSnapshot(context, json)
    }

    AsyncFunction("reload") {
      WidgetRenderer.updateAll(context)
    }

    AsyncFunction("saveAvatar") { uid: String, uri: String ->
      WidgetStore.saveAvatar(context, uid, uri)
    }

    AsyncFunction("removeAvatar") { uid: String ->
      WidgetStore.removeAvatar(context, uid)
    }

    AsyncFunction("setQuickShareCredential") { token: String, endpoint: String, expiresAt: Double ->
      WidgetStore.setCredential(context, token, endpoint, expiresAt.toLong())
    }

    AsyncFunction("clearQuickShareCredential") {
      WidgetStore.clearCredential(context)
    }

    AsyncFunction("consumeEvents") {
      WidgetStore.consumeEvents(context)
    }

    // Faz 12: kilit ekranı canlı sayacı (LiveShareNotification.kt). start/update aynı bildirimi yeniden yazar.
    AsyncFunction("liveStart") { _attributesJson: String, contentJson: String ->
      LiveShareNotification.show(context, contentJson)
    }

    AsyncFunction("liveUpdate") { contentJson: String ->
      LiveShareNotification.show(context, contentJson)
      Unit
    }

    AsyncFunction("liveEnd") { contentJson: String?, dismissAtMs: Double? ->
      if (contentJson != null && dismissAtMs != null) LiveShareNotification.show(context, contentJson, dismissAtMs.toLong())
      else LiveShareNotification.cancel(context)
      Unit
    }

    Function("liveEnabled") {
      LiveShareNotification.enabled(context)
    }

    Function("capabilities") {
      mapOf(
        "platform" to "android",
        "interactive" to true,
        // Telefon kilit ekranında widget yok; kilit ekranı erişimi Hızlı Ayarlar kutucuğuyla (unlockAndRun).
        "lockScreen" to false,
        "quickTile" to true,
        "available" to true,
      )
    }
  }
}
