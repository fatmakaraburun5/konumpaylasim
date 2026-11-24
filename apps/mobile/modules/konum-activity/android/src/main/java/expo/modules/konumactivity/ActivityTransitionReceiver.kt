// Faz 3: Activity Recognition geçiş yayını alıcısı. Son geçişi SharedPreferences'a yazar (başsız uyanışta
// konum görevi okur) ve JS ayaktaysa modül dinleyicisine iletir.
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi.
package expo.modules.konumactivity

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

class ActivityTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!ActivityTransitionResult.hasResult(intent)) return
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val event = result.transitionEvents.lastOrNull { it.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER } ?: return
    val ageMs = (SystemClock.elapsedRealtimeNanos() - event.elapsedRealTimeNanos) / 1_000_000L
    val at = System.currentTimeMillis() - ageMs.coerceAtLeast(0L)
    val type = when (event.activityType) {
      DetectedActivity.STILL -> "still"
      DetectedActivity.WALKING, DetectedActivity.ON_FOOT -> "walking"
      DetectedActivity.RUNNING -> "running"
      DetectedActivity.ON_BICYCLE -> "cycling"
      DetectedActivity.IN_VEHICLE -> "automotive"
      else -> "unknown"
    }
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_TYPE, type)
      .putLong(KEY_AT, at)
      .apply()
    listener?.invoke(mapOf("type" to type, "confidence" to "high", "at" to at.toDouble()))
  }

  companion object {
    const val ACTION = "expo.modules.konumactivity.TRANSITION"
    private const val PREFS = "konum_activity"
    private const val KEY_TYPE = "type"
    private const val KEY_AT = "at"

    @Volatile
    var listener: ((Map<String, Any>) -> Unit)? = null

    fun readLast(context: Context): Map<String, Any>? {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val type = prefs.getString(KEY_TYPE, null) ?: return null
      val at = prefs.getLong(KEY_AT, 0L)
      if (at <= 0L) return null
      return mapOf("type" to type, "confidence" to "high", "at" to at.toDouble())
    }
  }
}
