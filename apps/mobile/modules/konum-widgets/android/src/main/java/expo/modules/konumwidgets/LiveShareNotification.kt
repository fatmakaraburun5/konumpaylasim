// Faz 12: kilit ekranı canlı sayacının Android karşılığı — süren ("ongoing") canlı bildirim.
//
// JS: src/services/live/liveActivityBridge.ts · veri: core `LiveShareContent` JSON'u (v = 1).
//
//  - Kanal `konum_live_share` (IMPORTANCE_LOW: ses / titreşim yok, kilit ekranında görünür).
//  - Kalan süre: `setUsesChronometer(true) + setChronometerCountDown(true) + setWhen(ends_at)` → sistem kendisi sayar,
//    her dakika güncelleme gerekmez. İlerleme çubuğu `setProgress(1000, kalan)`; süresizde çubuk yok.
//  - Büyük simge: pembe / mavi çerçeveli avatar (AvatarRenderer, Faz 6 widget dosyası `live_<uid>.jpg`).
//  - Eylemler: "Mola 15 dk" / "Devam et" ve "Durdur" → `konum://live?action=…` (uygulama açılır, eylem uygulanır).
//  - Android 16+ (API 36): `requestPromotedOngoing` → durum çubuğu çipi + kilit ekranında üstte "canlı güncelleme".
//    Eski sürümlerde sıradan süren bildirim (aynı içerik).
//  - VISIBILITY_PUBLIC: iOS Live Activity ile aynı içerik kilit ekranında görünür (ad + süre; koordinat yok).
//  - "sona erdi" (end + dismissAt): sayaç durur, bildirim kaydırılabilir olur ve `setTimeoutAfter` ile kalkar.
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi, cihazda doğrulanmalı.
package expo.modules.konumwidgets

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

object LiveShareNotification {
  private const val CHANNEL_ID = "konum_live_share"
  private const val NOTIFICATION_ID = 0x4B4C53 // "KLS"
  private const val EXTRA_PROMOTED = "android.requestPromotedOngoing"

  private fun ensureChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val ch = NotificationChannel(CHANNEL_ID, "Canlı paylaşım sayacı", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Konum paylaşımı sürerken kalan süre, varış ve mola durumu"
      setShowBadge(false)
      lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
    }
    nm.createNotificationChannel(ch)
  }

  fun enabled(ctx: Context): Boolean = NotificationManagerCompat.from(ctx).areNotificationsEnabled()

  private fun link(ctx: Context, action: String, code: Int): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("konum://live?action=$action")).apply {
      setPackage(ctx.packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    return PendingIntent.getActivity(ctx, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun tint(phase: String): Int = when (phase) {
    "expiring" -> Color.parseColor("#F59E0B")
    "paused" -> Color.parseColor("#A16207")
    "ended" -> Color.parseColor("#6B7280")
    else -> Color.parseColor("#16A34A")
  }

  private fun ringHex(ring: String): String = when (ring) {
    "female" -> "#EC4899"
    "male" -> "#3B82F6"
    else -> "#9CA3AF"
  }

  /** Alt metin + ETA ("42 dk kaldı · Ayşe ~12 dk"); ETA dakikası her güncellemede yeniden hesaplanır. */
  private fun contentText(o: JSONObject, now: Long): String {
    val base = o.optString("subtitle")
    val eta = o.optJSONObject("eta") ?: return base
    val min = ((eta.optLong("arrive_at") - now) / 60_000L).coerceAtLeast(1)
    return "$base · ${eta.optString("label")} ~$min dk"
  }

  /** content JSON → bildirim; `dismissAtMs` verilirse "sona erdi" hâli. */
  fun show(ctx: Context, contentJson: String, dismissAtMs: Long? = null): Boolean {
    if (!enabled(ctx)) return false
    val o = try { JSONObject(contentJson) } catch (e: Exception) { return false }
    if (o.optInt("v") != 1) return false
    ensureChannel(ctx)
    val now = System.currentTimeMillis()
    val phase = o.optString("phase", "sharing")
    val ended = phase == "ended"
    val endsAt = if (o.isNull("ends_at")) null else o.optLong("ends_at")
    val startedAt = o.optLong("started_at", now)
    val breakUntil = if (o.isNull("break_until")) null else o.optLong("break_until")
    val lead = o.optJSONObject("lead") ?: JSONObject()
    val fav = WFavorite(
      uid = lead.optString("uid"),
      name = lead.optString("name"),
      initials = lead.optString("initials"),
      gender = null,
      ring = ringHex(lead.optString("ring")),
      avatarFile = if (lead.isNull("avatar_key")) null else WidgetStore.avatarFileName(lead.optString("avatar_key")),
      status = "none",
      lastSeenAt = null,
      place = null,
      batteryPct = null,
      batteryLow = false,
      myShareExpiresAt = null,
      myShareActive = false,
    )
    val b = NotificationCompat.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(ctx.applicationInfo.icon)
      .setContentTitle(o.optString("title"))
      .setContentText(contentText(o, now))
      .setLargeIcon(AvatarRenderer.render(ctx, fav, 144))
      .setColor(tint(phase))
      .setColorized(false)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(true)
      .setContentIntent(link(ctx, "open", 1))

    if (ended) {
      b.setOngoing(false).setAutoCancel(true).setUsesChronometer(false)
      dismissAtMs?.let { b.setTimeoutAfter((it - now).coerceAtLeast(1_000L)) }
    } else {
      b.setOngoing(true)
      val countTo = if (phase == "paused") breakUntil else endsAt
      if (countTo != null && countTo > now) {
        b.setUsesChronometer(true).setWhen(countTo)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) b.setChronometerCountDown(true)
      } else {
        b.setUsesChronometer(false).setWhen(startedAt)
      }
      if (endsAt != null && endsAt > startedAt) {
        val left = ((endsAt - now).toDouble() / (endsAt - startedAt).toDouble()).coerceIn(0.0, 1.0)
        b.setProgress(1000, (left * 1000).toInt(), false)
      }
      if (phase == "paused") b.addAction(0, "Devam et", link(ctx, "resume", 2))
      else b.addAction(0, "Mola 15 dk", link(ctx, "break15", 3))
      b.addAction(0, "Durdur", link(ctx, "stop", 4))
      // Android 16 canlı güncelleme (promoted ongoing): kısa metin durum çubuğu çipinde görünür.
      b.extras.putBoolean(EXTRA_PROMOTED, true)
      // EXTRA_SHORT_CRITICAL_TEXT (API 36); eski sürümler anahtarı yok sayar.
      b.extras.putString("android.shortCriticalText", if (phase == "paused") "Mola" else endsAt?.let { "${((it - now) / 60_000L).coerceAtLeast(0)} dk" } ?: "∞")
    }
    return try {
      NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, b.build())
      true
    } catch (e: SecurityException) {
      false // POST_NOTIFICATIONS verilmemiş
    }
  }

  fun cancel(ctx: Context) {
    NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_ID)
  }
}
