// Faz 6: Hızlı Ayarlar kutucuğu "Konum: 1 sa paylaş" — kilit ekranından da erişilir, ama `unlockAndRun` ile kilit
// açılmadan HİÇBİR şey yapmaz (telefonu bulan biri paylaşım başlatamasın). Hedef: anlık görüntüdeki default_uid
// (ilk favori). Arka plan yolu → QuickShareReceiver yayını (goAsync süreç ömrünü korur); uygulamayı aç yolu →
// startActivityAndCollapse (API 34+ PendingIntent sürümü). Paylaşım sürerken kutucuk ETKİN ve kalan süreyi gösterir.
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi.
package expo.modules.konumwidgets

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

class QuickShareTileService : TileService() {
  override fun onStartListening() {
    super.onStartListening()
    render()
  }

  override fun onClick() {
    super.onClick()
    if (isLocked) {
      unlockAndRun { handleClick() }
    } else {
      handleClick()
    }
  }

  private fun handleClick() {
    val app = applicationContext
    val now = System.currentTimeMillis()
    val snap = WidgetStore.snapshot(app)
    val fav = if (snap != null && snap.signedIn) snap.selected() else null
    if (fav == null) {
      launch(WidgetIntents.openAppIntent(app))
      return
    }
    if (fav.activeShareEnd(now) != null || fav.sharingWithoutEnd) {
      // Zaten paylaşıyorum: uygulamada geri sayım + "Durdur" görünür.
      launch(WidgetIntents.openAppIntent(app))
      return
    }
    when (WidgetRoute.route(snap, fav.uid, WidgetStore.tokenExpiresAt(app), WidgetStore.quickState(app), now)) {
      is QuickRoute.Background -> {
        qsTile?.let { t ->
          t.state = Tile.STATE_ACTIVE
          if (Build.VERSION.SDK_INT >= 29) t.subtitle = getString(R.string.konum_w_pending)
          t.updateTile()
        }
        sendBroadcast(WidgetIntents.quickShareBroadcastIntent(app, fav.uid, SOURCE))
      }
      is QuickRoute.OpenApp -> launch(WidgetIntents.deepLinkIntent(app, fav.uid, SOURCE))
    }
  }

  private fun launch(intent: Intent) {
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      if (Build.VERSION.SDK_INT >= 34) {
        startActivityAndCollapse(
          PendingIntent.getActivity(this, 2, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
        )
      } else {
        @Suppress("DEPRECATION")
        startActivityAndCollapse(intent)
      }
    } catch (e: Exception) {
    }
  }

  private fun render() {
    val tile = qsTile ?: return
    val app = applicationContext
    val now = System.currentTimeMillis()
    val snap = WidgetStore.snapshot(app)
    val fav = if (snap != null && snap.signedIn) snap.selected() else null
    tile.label = getString(R.string.konum_w_tile_label)
    val end = fav?.activeShareEnd(now)
    val q = WidgetStore.quickState(app)
    val subtitle: String
    if (fav == null) {
      tile.state = Tile.STATE_UNAVAILABLE
      subtitle = WidgetText.emptyText(snap)
    } else if (end != null) {
      tile.state = Tile.STATE_ACTIVE
      subtitle = fav.name + " · " + WidgetText.countdown(end - now)
    } else if (fav.sharingWithoutEnd) {
      tile.state = Tile.STATE_ACTIVE
      subtitle = fav.name + " · " + getString(R.string.konum_w_sharing_now)
    } else if (q != null && q.toUid == fav.uid && q.phase == "pending" && now - q.at < WidgetLimits.PENDING_MS) {
      tile.state = Tile.STATE_ACTIVE
      subtitle = getString(R.string.konum_w_pending)
    } else if (q != null && q.toUid == fav.uid && q.phase == "error" && now - q.at < WidgetLimits.ERROR_FALLBACK_MS) {
      tile.state = Tile.STATE_INACTIVE
      subtitle = WidgetText.quickError(q.error)
    } else {
      tile.state = Tile.STATE_INACTIVE
      subtitle = fav.name
    }
    if (Build.VERSION.SDK_INT >= 29) tile.subtitle = subtitle
    tile.updateTile()
  }

  companion object {
    private const val SOURCE = "android_tile"

    /** Panel açıksa kutucuğu yeniden çizdirir (widget çiziminden sonra çağrılır). */
    fun requestRefresh(ctx: Context) {
      try {
        TileService.requestListeningState(ctx, ComponentName(ctx, QuickShareTileService::class.java))
      } catch (e: Exception) {
      }
    }
  }
}
