// Faz 6: RemoteViews çizimi (2x2 ve 4x2) + PendingIntent'ler.
//
// Düğme kararı ÇİZİM anında verilir (core `quickShareRoute` eşleniği WidgetRoute):
//  - arka plan → PendingIntent.getBroadcast(QuickShareReceiver): uygulama açılmadan istek atılır;
//  - uygulamayı aç (oturum yok / favori yok / belirteç yok-bitiyor / arka plan konumu yok / son 2 dk hata) →
//    PendingIntent.getActivity(`konum://quick-share?to=<uid>&src=android_widget`).
// Böylece Android 10+ "arka plandan etkinlik başlatma" kısıtına takılmayız: alıcı hiçbir zaman etkinlik açmaz.
// Paylaşımım sürüyorsa düğme yerine Chronometer geri sayımı (countDown, API 24+) gösterilir.
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi.
package expo.modules.konumwidgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat

object WidgetIntents {
  private const val FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

  /** `konum://quick-share?to=<uid>&src=<src>` (core `quickShareDeepLink`). */
  fun deepLinkIntent(ctx: Context, toUid: String, source: String): Intent {
    val uri = Uri.Builder()
      .scheme("konum")
      .authority("quick-share")
      .appendQueryParameter("to", toUid)
      .appendQueryParameter("src", source)
      .build()
    return Intent(Intent.ACTION_VIEW, uri)
      .setPackage(ctx.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  }

  fun deepLink(ctx: Context, toUid: String, source: String): PendingIntent =
    PendingIntent.getActivity(ctx, 0, deepLinkIntent(ctx, toUid, source), FLAGS)

  fun openAppIntent(ctx: Context): Intent {
    val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      ?: Intent(Intent.ACTION_VIEW, Uri.parse("konum://")).setPackage(ctx.packageName)
    return launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  }

  fun openApp(ctx: Context): PendingIntent = PendingIntent.getActivity(ctx, 1, openAppIntent(ctx), FLAGS)

  fun quickShareBroadcastIntent(ctx: Context, toUid: String, source: String): Intent =
    Intent(ctx, QuickShareReceiver::class.java)
      .setAction(QuickShareReceiver.ACTION)
      // Veri URI'si yalnızca PendingIntent'leri kişi başına ayırmak için (açık bileşen; filtre gerekmez).
      .setData(Uri.parse("konum-widget://quick/" + Uri.encode(toUid) + "?src=" + source))
      .putExtra(QuickShareReceiver.EXTRA_TO, toUid)
      .putExtra(QuickShareReceiver.EXTRA_SRC, source)

  fun quickShare(ctx: Context, toUid: String, source: String): PendingIntent =
    PendingIntent.getBroadcast(ctx, 0, quickShareBroadcastIntent(ctx, toUid, source), FLAGS)
}

object WidgetRenderer {
  private val CELL = intArrayOf(R.id.konum_w_fav0, R.id.konum_w_fav1, R.id.konum_w_fav2, R.id.konum_w_fav3)
  private val CELL_AVATAR = intArrayOf(R.id.konum_w_fav0_avatar, R.id.konum_w_fav1_avatar, R.id.konum_w_fav2_avatar, R.id.konum_w_fav3_avatar)
  private val CELL_NAME = intArrayOf(R.id.konum_w_fav0_name, R.id.konum_w_fav1_name, R.id.konum_w_fav2_name, R.id.konum_w_fav3_name)
  private val CELL_STATUS = intArrayOf(R.id.konum_w_fav0_status, R.id.konum_w_fav1_status, R.id.konum_w_fav2_status, R.id.konum_w_fav3_status)
  private val CELL_BUTTON = intArrayOf(R.id.konum_w_fav0_button, R.id.konum_w_fav1_button, R.id.konum_w_fav2_button, R.id.konum_w_fav3_button)
  private val CELL_TIMER = intArrayOf(R.id.konum_w_fav0_timer, R.id.konum_w_fav1_timer, R.id.konum_w_fav2_timer, R.id.konum_w_fav3_timer)
  private const val SOURCE = "android_widget"

  private class State(
    val snap: WSnapshot?,
    val tokenExp: Long?,
    val quick: WQuickState?,
    val now: Long,
  ) {
    fun route(uid: String): QuickRoute = WidgetRoute.route(snap, uid, tokenExp, quick, now)

    fun errorFor(uid: String): String? {
      val q = quick ?: return null
      if (q.phase != "error" || q.toUid != uid || now - q.at >= WidgetLimits.ERROR_FALLBACK_MS) return null
      return WidgetText.quickError(q.error)
    }

    fun pending(uid: String): Boolean {
      val q = quick ?: return false
      return q.phase == "pending" && q.toUid == uid && now - q.at < WidgetLimits.PENDING_MS
    }
  }

  private fun ids(ctx: Context, cls: Class<*>): IntArray =
    try {
      AppWidgetManager.getInstance(ctx).getAppWidgetIds(ComponentName(ctx, cls))
    } catch (e: Exception) {
      IntArray(0)
    }

  fun hasAnyWidget(ctx: Context): Boolean {
    val app = ctx.applicationContext
    return ids(app, KonumWidgetSmallProvider::class.java).isNotEmpty() ||
      ids(app, KonumWidgetLargeProvider::class.java).isNotEmpty()
  }

  /** Tüm widget'ları + kutucuğu yeniden çizer ve bir sonraki sınır (bayatlık / bitiş) için işi planlar. */
  @Synchronized
  fun updateAll(ctx: Context) {
    val app = ctx.applicationContext
    val mgr = AppWidgetManager.getInstance(app)
    val now = System.currentTimeMillis()
    val st = State(WidgetStore.snapshot(app), WidgetStore.tokenExpiresAt(app), WidgetStore.quickState(app), now)
    val small = ids(app, KonumWidgetSmallProvider::class.java)
    val large = ids(app, KonumWidgetLargeProvider::class.java)
    for (id in small) {
      try {
        mgr.updateAppWidget(id, renderSmall(app, st))
      } catch (e: Exception) {
        // Tek widget'ın hatası diğerlerini durdurmasın (ör. bit eşlem sınırı).
      }
    }
    for (id in large) {
      try {
        mgr.updateAppWidget(id, renderLarge(app, st))
      } catch (e: Exception) {
      }
    }
    if (small.isNotEmpty() || large.isNotEmpty()) {
      WidgetRefreshWorker.ensurePeriodic(app)
      WidgetRefreshWorker.scheduleBoundary(app, st.snap, st.quick, now)
    }
    QuickShareTileService.requestRefresh(app)
  }

  private fun dp(ctx: Context, v: Int): Int = (v * ctx.resources.displayMetrics.density).toInt()

  private fun color(ctx: Context, id: Int): Int = ContextCompat.getColor(ctx, id)

  private fun renderSmall(ctx: Context, st: State): RemoteViews {
    val v = RemoteViews(ctx.packageName, R.layout.konum_widget_small)
    v.setOnClickPendingIntent(R.id.konum_w_root, WidgetIntents.openApp(ctx))
    val snap = st.snap
    val fav = if (snap != null && snap.signedIn) snap.selected() else null
    if (fav == null) {
      v.setViewVisibility(R.id.konum_w_content, View.GONE)
      v.setViewVisibility(R.id.konum_w_empty, View.VISIBLE)
      v.setTextViewText(R.id.konum_w_empty, WidgetText.emptyText(snap))
      return v
    }
    v.setViewVisibility(R.id.konum_w_content, View.VISIBLE)
    v.setViewVisibility(R.id.konum_w_empty, View.GONE)
    v.setImageViewBitmap(R.id.konum_w_avatar, AvatarRenderer.render(ctx, fav, dp(ctx, 48)))
    v.setTextViewText(R.id.konum_w_name, fav.name)
    v.setTextViewText(R.id.konum_w_status, WidgetText.status(fav, st.now))
    v.setTextColor(
      R.id.konum_w_status,
      color(ctx, if (WidgetText.isLive(fav, st.now)) R.color.konum_w_live else R.color.konum_w_text2),
    )

    // Ana ekran widget'ı kilit ekranında görünmez: yer / pil burada gösterilir (hata varsa onun yerine hata metni).
    val err = st.errorFor(fav.uid)
    val detail = err ?: WidgetText.detail(fav)
    if (detail != null) {
      v.setViewVisibility(R.id.konum_w_detail, View.VISIBLE)
      v.setTextViewText(R.id.konum_w_detail, detail)
      v.setTextColor(R.id.konum_w_detail, color(ctx, if (err != null) R.color.konum_w_danger else R.color.konum_w_text2))
    } else {
      v.setViewVisibility(R.id.konum_w_detail, View.GONE)
    }

    val end = fav.activeShareEnd(st.now)
    if (end != null) {
      v.setViewVisibility(R.id.konum_w_button, View.GONE)
      v.setViewVisibility(R.id.konum_w_timer_box, View.VISIBLE)
      v.setChronometer(R.id.konum_w_timer, SystemClock.elapsedRealtime() + (end - st.now), null, true)
      v.setChronometerCountDown(R.id.konum_w_timer, true)
    } else {
      v.setViewVisibility(R.id.konum_w_timer_box, View.GONE)
      v.setViewVisibility(R.id.konum_w_button, View.VISIBLE)
      bindButton(ctx, v, R.id.konum_w_button, fav, st, short = false)
    }
    return v
  }

  private fun renderLarge(ctx: Context, st: State): RemoteViews {
    val v = RemoteViews(ctx.packageName, R.layout.konum_widget_large)
    v.setOnClickPendingIntent(R.id.konum_w_root, WidgetIntents.openApp(ctx))
    val snap = st.snap
    val favs = if (snap != null && snap.signedIn) snap.favorites.take(CELL.size) else emptyList()
    if (favs.isEmpty()) {
      v.setViewVisibility(R.id.konum_w_content, View.GONE)
      v.setViewVisibility(R.id.konum_w_empty, View.VISIBLE)
      v.setTextViewText(R.id.konum_w_empty, WidgetText.emptyText(snap))
      return v
    }
    v.setViewVisibility(R.id.konum_w_content, View.VISIBLE)
    v.setViewVisibility(R.id.konum_w_empty, View.GONE)
    for (i in CELL.indices) {
      val fav = favs.getOrNull(i)
      if (fav == null) {
        v.setViewVisibility(CELL[i], View.GONE)
        continue
      }
      v.setViewVisibility(CELL[i], View.VISIBLE)
      v.setOnClickPendingIntent(CELL[i], WidgetIntents.openApp(ctx))
      v.setImageViewBitmap(CELL_AVATAR[i], AvatarRenderer.render(ctx, fav, dp(ctx, 40)))
      v.setTextViewText(CELL_NAME[i], fav.name)
      val err = st.errorFor(fav.uid)
      v.setTextViewText(CELL_STATUS[i], err ?: WidgetText.status(fav, st.now))
      v.setTextColor(
        CELL_STATUS[i],
        color(
          ctx,
          when {
            err != null -> R.color.konum_w_danger
            WidgetText.isLive(fav, st.now) -> R.color.konum_w_live
            else -> R.color.konum_w_text2
          },
        ),
      )
      val end = fav.activeShareEnd(st.now)
      if (end != null) {
        v.setViewVisibility(CELL_BUTTON[i], View.GONE)
        v.setViewVisibility(CELL_TIMER[i], View.VISIBLE)
        v.setChronometer(CELL_TIMER[i], SystemClock.elapsedRealtime() + (end - st.now), null, true)
        v.setChronometerCountDown(CELL_TIMER[i], true)
      } else {
        v.setViewVisibility(CELL_TIMER[i], View.GONE)
        v.setViewVisibility(CELL_BUTTON[i], View.VISIBLE)
        bindButton(ctx, v, CELL_BUTTON[i], fav, st, short = true)
      }
    }
    return v
  }

  private fun bindButton(ctx: Context, v: RemoteViews, id: Int, fav: WFavorite, st: State, short: Boolean) {
    if (fav.sharingWithoutEnd) {
      // Süresiz paylaşım zaten açık: geri sayım yok, hızlı paylaşım gereksiz.
      v.setTextViewText(id, ctx.getString(R.string.konum_w_sharing_now))
      v.setOnClickPendingIntent(id, WidgetIntents.openApp(ctx))
      return
    }
    if (st.pending(fav.uid)) {
      v.setTextViewText(id, ctx.getString(R.string.konum_w_pending))
      v.setOnClickPendingIntent(id, WidgetIntents.openApp(ctx))
      return
    }
    when (st.route(fav.uid)) {
      is QuickRoute.Background -> {
        v.setTextViewText(id, ctx.getString(if (short) R.string.konum_w_quick_short else R.string.konum_w_quick))
        v.setOnClickPendingIntent(id, WidgetIntents.quickShare(ctx, fav.uid, SOURCE))
      }
      is QuickRoute.OpenApp -> {
        v.setTextViewText(id, ctx.getString(if (short) R.string.konum_w_open_short else R.string.konum_w_open))
        v.setOnClickPendingIntent(id, WidgetIntents.deepLink(ctx, fav.uid, SOURCE))
      }
    }
  }
}
