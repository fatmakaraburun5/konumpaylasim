// Faz 6: hızlı paylaşım isteği (widget düğmesi ve Hızlı Ayarlar kutucuğu ORTAK akış).
//
// Callable HTTP protokolü (Firebase kimliği / App Check YOK; belirteç sunucuda sha256 ile doğrulanır):
//   POST <endpoint>  {"data":{"token","to_uid","op_id","source"}}
//   200 → {"result":{"status":"started|extended|already_active","share_id","expires_at","to_name"}}
//   hata → {"error":{"status":"RESOURCE_EXHAUSTED",...,"message","details":{"code":"rate_limited",...}}}
// details.code / message → core QuickShareError. Ağ hatası / zaman aşımı → "unavailable".
// Zaman aşımı bağlantı 4 sn + okuma 5 sn: BroadcastReceiver.goAsync() ~10 sn sınırının altında kalır.
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi.
package expo.modules.konumwidgets

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

sealed class QuickShareOutcome {
  data class Ok(val status: String, val shareId: String?, val expiresAt: Long?, val toName: String?) : QuickShareOutcome()
  data class Err(val code: String) : QuickShareOutcome()
  object Skipped : QuickShareOutcome()
}

object QuickShareClient {
  private val KNOWN = setOf("token_invalid", "token_expired", "not_favorite", "not_friend", "rate_limited", "unavailable", "internal")

  fun call(cred: QuickCredential, toUid: String, source: String): QuickShareOutcome {
    var conn: HttpURLConnection? = null
    return try {
      val body = JSONObject().put(
        "data",
        JSONObject()
          .put("token", cred.token)
          .put("to_uid", toUid)
          .put("op_id", UUID.randomUUID().toString())
          .put("source", source),
      ).toString()
      val c = URL(cred.endpoint).openConnection() as HttpURLConnection
      conn = c
      c.requestMethod = "POST"
      c.connectTimeout = 4_000
      c.readTimeout = 5_000
      c.doOutput = true
      c.useCaches = false
      c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
      c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      val http = c.responseCode
      val stream = if (http in 200..299) c.inputStream else c.errorStream
      val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
      parse(http, text)
    } catch (e: IOException) {
      QuickShareOutcome.Err("unavailable")
    } catch (e: Exception) {
      QuickShareOutcome.Err("internal")
    } finally {
      conn?.disconnect()
    }
  }

  fun parse(http: Int, text: String): QuickShareOutcome {
    val root = try {
      JSONObject(text)
    } catch (e: Exception) {
      null
    }
    val result = root?.optJSONObject("result")
    if (http in 200..299 && result != null) {
      val status = WidgetJson.str(result, "status") ?: return QuickShareOutcome.Err("internal")
      return QuickShareOutcome.Ok(
        status = status,
        shareId = WidgetJson.str(result, "share_id"),
        expiresAt = WidgetJson.long(result, "expires_at"),
        toName = WidgetJson.str(result, "to_name"),
      )
    }
    val err = root?.optJSONObject("error")
    val details = err?.optJSONObject("details")
    return QuickShareOutcome.Err(
      mapError(
        code = details?.let { WidgetJson.str(it, "code") },
        message = err?.let { WidgetJson.str(it, "message") },
        status = err?.let { WidgetJson.str(it, "status") },
        http = http,
      ),
    )
  }

  fun mapError(code: String?, message: String?, status: String?, http: Int): String {
    if (code != null) {
      if (code in KNOWN) return code
      when (code) {
        "not_friends" -> return "not_friend"
        "unauthenticated" -> return "token_invalid"
        "quota_exceeded" -> return "rate_limited"
      }
    }
    if (message != null && message in KNOWN) return message
    when (status) {
      "UNAUTHENTICATED", "PERMISSION_DENIED" -> return "token_invalid"
      "RESOURCE_EXHAUSTED" -> return "rate_limited"
      "UNAVAILABLE", "DEADLINE_EXCEEDED" -> return "unavailable"
    }
    return when (http) {
      401, 403 -> "token_invalid"
      429 -> "rate_limited"
      0, 503, 504 -> "unavailable"
      else -> "internal"
    }
  }
}

object QuickShareRunner {
  private const val CHANNEL = "konum_widget_quick"
  private const val NOTIFICATION_ID = 46021

  /** Arka plan iş parçacığında çağrılır (QuickShareReceiver.goAsync). */
  fun run(ctx: Context, toUid: String, source: String): QuickShareOutcome {
    val app = ctx.applicationContext
    val now = System.currentTimeMillis()
    val q = WidgetStore.quickState(app)
    // Çift dokunuş: aynı kişiye 20 sn içinde süren istek varsa yenisi gönderilmez.
    if (q != null && q.phase == "pending" && q.toUid == toUid && now - q.at < WidgetLimits.PENDING_MS) {
      return QuickShareOutcome.Skipped
    }
    val cred = WidgetStore.credential(app)
    if (cred == null || cred.expiresAt - now <= WidgetLimits.TOKEN_MIN_REMAINING_MS) {
      fail(app, toUid, source, "token_invalid", now)
      return QuickShareOutcome.Err("token_invalid")
    }
    WidgetStore.setQuickState(app, WQuickState(toUid, "pending", null, now))
    WidgetRenderer.updateAll(app)

    val outcome = QuickShareClient.call(cred, toUid, source)
    when (outcome) {
      is QuickShareOutcome.Ok -> {
        WidgetStore.setQuickState(app, null)
        WidgetStore.patchSnapshot(app, toUid, outcome.expiresAt, null)
        val ev = JSONObject()
          .put("type", "quick_share")
          .put("to_uid", toUid)
          .put("status", outcome.status)
          .put("at", System.currentTimeMillis())
          .put("source", source)
        outcome.expiresAt?.let { ev.put("expires_at", it) }
        outcome.shareId?.let { ev.put("share_id", it) }
        outcome.toName?.let { ev.put("to_name", it) }
        WidgetStore.appendEvent(app, ev)
        WidgetRenderer.updateAll(app)
      }
      is QuickShareOutcome.Err -> fail(app, toUid, source, outcome.code, System.currentTimeMillis())
      is QuickShareOutcome.Skipped -> WidgetRenderer.updateAll(app)
    }
    return outcome
  }

  private fun fail(app: Context, toUid: String, source: String, code: String, now: Long) {
    WidgetStore.setQuickState(app, WQuickState(toUid, "error", code, now))
    if (code == "token_invalid" || code == "token_expired") WidgetStore.patchSnapshot(app, null, null, false)
    WidgetStore.appendEvent(
      app,
      JSONObject()
        .put("type", "quick_share")
        .put("to_uid", toUid)
        .put("status", "error")
        .put("error", code)
        .put("at", now)
        .put("source", source),
    )
    WidgetRenderer.updateAll(app)
    // Kutucuk arayüzü kapanır: hata bildirimle (dokununca derin bağlantı) gösterilir. Widget'ta hata metni + 2 dk
    // boyunca "Uygulamada aç" düğmesi yeterli.
    if (source == "android_tile") notifyFailure(app, toUid, source, code)
  }

  private fun notifyFailure(app: Context, toUid: String, source: String, code: String) {
    try {
      if (Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
      ) {
        return
      }
      val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= 26) {
        nm.createNotificationChannel(
          NotificationChannel(CHANNEL, app.getString(R.string.konum_w_channel_name), NotificationManager.IMPORTANCE_DEFAULT),
        )
      }
      val n = NotificationCompat.Builder(app, CHANNEL)
        .setSmallIcon(R.drawable.konum_w_ic_tile)
        .setContentTitle(app.getString(R.string.konum_w_failed_title))
        .setContentText(app.getString(R.string.konum_w_failed_body, WidgetText.quickError(code)))
        .setContentIntent(WidgetIntents.deepLink(app, toUid, source))
        .setAutoCancel(true)
        .build()
      nm.notify(NOTIFICATION_ID, n)
    } catch (e: Exception) {
    }
  }
}
