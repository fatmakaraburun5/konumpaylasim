// Faz 6: widget anlık görüntüsü (core packages/core/src/widget.ts `WidgetSnapshot`, snake_case JSON, v = 1).
// Çözümleme savunmacıdır (org.json): bozuk JSON / bilinmeyen sürüm → null → widget boş / "giriş yap" durumunu çizer.
// Metin kuralları core `widgetStatusText` / `formatCountdown` / `quickShareErrorText` ile eş tutulmalı.
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi.
package expo.modules.konumwidgets

import org.json.JSONObject

data class WFavorite(
  val uid: String,
  val name: String,
  val initials: String,
  val gender: String?,
  val ring: String,
  val avatarFile: String?,
  val status: String,
  val lastSeenAt: Long?,
  val place: String?,
  val batteryPct: Int?,
  val batteryLow: Boolean,
  val myShareExpiresAt: Long?,
  /** [Ek alan] süresiz paylaşımda `my_share_expires_at` null olduğundan (eski görüntüde yok → false). */
  val myShareActive: Boolean,
) {
  fun activeShareEnd(now: Long): Long? = myShareExpiresAt?.takeIf { it > now }

  /** Bitişi olmayan etkin paylaşımım: geri sayım yok, düğme de yok. */
  val sharingWithoutEnd: Boolean
    get() = myShareActive && myShareExpiresAt == null
}

data class WSnapshot(
  val generatedAt: Long,
  val signedIn: Boolean,
  val meInitials: String?,
  val defaultUid: String?,
  val favorites: List<WFavorite>,
  val tokenOk: Boolean,
  val bgLocationOk: Boolean,
  val lockScreenDetails: Boolean,
) {
  fun favorite(uid: String?): WFavorite? = if (uid == null) null else favorites.firstOrNull { it.uid == uid }

  /** default_uid → ilk favori. */
  fun selected(): WFavorite? = favorite(defaultUid) ?: favorites.firstOrNull()
}

data class WQuickState(val toUid: String, val phase: String, val error: String?, val at: Long) {
  fun toJson(): String = JSONObject()
    .put("to_uid", toUid)
    .put("phase", phase)
    .put("error", error ?: JSONObject.NULL)
    .put("at", at)
    .toString()

  companion object {
    fun parse(json: String?): WQuickState? {
      if (json.isNullOrEmpty()) return null
      return try {
        val o = JSONObject(json)
        val uid = WidgetJson.str(o, "to_uid") ?: return null
        val phase = WidgetJson.str(o, "phase") ?: return null
        WQuickState(uid, phase, WidgetJson.str(o, "error"), o.optLong("at", 0L))
      } catch (e: Exception) {
        null
      }
    }
  }
}

sealed class QuickRoute {
  object Background : QuickRoute()
  data class OpenApp(val reason: String) : QuickRoute()
}

object WidgetLimits {
  const val STALE_AFTER_MS = 15 * 60_000L
  const val QUICK_SHARE_DURATION_MS = 60 * 60_000L
  /** core WIDGET_TOKEN_EXPIRY_MARGIN_MS: bitişe bu kadar (ya da daha az) kalan belirteç arka planda kullanılmaz. */
  const val TOKEN_MIN_REMAINING_MS = 5 * 60_000L
  const val ERROR_FALLBACK_MS = 2 * 60_000L
  const val PENDING_MS = 20_000L
}

object WidgetJson {
  /** JSON null / eksik → null (org.json `optString` null için "null" döndürür). */
  fun str(o: JSONObject, key: String): String? =
    if (!o.has(key) || o.isNull(key)) null else o.optString(key, "").takeIf { it.isNotEmpty() }

  fun long(o: JSONObject, key: String): Long? {
    if (!o.has(key) || o.isNull(key)) return null
    val d = o.optDouble(key, Double.NaN)
    return if (d.isNaN()) null else d.toLong()
  }

  fun parseSnapshot(json: String?): WSnapshot? {
    if (json.isNullOrEmpty()) return null
    return try {
      val o = JSONObject(json)
      if (o.optInt("v", -1) != 1) return null
      val favs = ArrayList<WFavorite>()
      val arr = o.optJSONArray("favorites")
      if (arr != null) {
        for (i in 0 until arr.length()) {
          val f = arr.optJSONObject(i) ?: continue
          val uid = str(f, "uid") ?: continue
          val name = str(f, "name") ?: continue
          val gender = str(f, "gender")
          favs.add(
            WFavorite(
              uid = uid,
              name = name,
              initials = str(f, "initials") ?: name.take(1).uppercase(),
              gender = gender,
              ring = str(f, "ring")?.takeIf { it.length == 7 && it.startsWith("#") } ?: ringFor(gender),
              avatarFile = str(f, "avatar_file"),
              status = str(f, "status") ?: "not_sharing",
              lastSeenAt = long(f, "last_seen_at"),
              place = str(f, "place"),
              batteryPct = long(f, "battery_pct")?.toInt(),
              batteryLow = f.optBoolean("battery_low", false),
              myShareExpiresAt = long(f, "my_share_expires_at"),
              myShareActive = f.optBoolean("my_share_active", false),
            ),
          )
        }
      }
      val quick = o.optJSONObject("quick")
      val privacy = o.optJSONObject("privacy")
      WSnapshot(
        generatedAt = long(o, "generated_at") ?: 0L,
        signedIn = o.optBoolean("signed_in", false),
        meInitials = str(o, "me_initials"),
        defaultUid = str(o, "default_uid"),
        favorites = favs,
        tokenOk = quick?.optBoolean("token_ok", false) ?: false,
        bgLocationOk = quick?.optBoolean("bg_location_ok", false) ?: false,
        lockScreenDetails = privacy?.optBoolean("lock_screen_details", false) ?: false,
      )
    } catch (e: Exception) {
      null
    }
  }

  /** core GENDER_RING: kadın pembe, erkek mavi, bilinmiyor gri. */
  fun ringFor(gender: String?): String = when (gender) {
    "female" -> "#EC4899"
    "male" -> "#3B82F6"
    else -> "#9CA3AF"
  }
}

object WidgetText {
  private const val MINUTE = 60_000L
  private const val HOUR = 3_600_000L
  private const val DAY = 86_400_000L

  /** core `effectiveWidgetStatus`: canlı ama son paket yok / 15 dk'dan eski → bağlantı yok. */
  fun effectiveStatus(f: WFavorite, now: Long): String {
    if (f.status == "sharing_live") {
      val t = f.lastSeenAt
      if (t == null || now - t > WidgetLimits.STALE_AFTER_MS) return "sharing_stale"
    }
    return f.status
  }

  fun isLive(f: WFavorite, now: Long): Boolean = effectiveStatus(f, now) == "sharing_live"

  /** core `formatAgeShort`: "şimdi", "3 dk", "2 sa", "1 gün". */
  fun ageShort(ms: Long): String {
    val d = ms.coerceAtLeast(0L)
    return when {
      d < MINUTE -> "şimdi"
      d < HOUR -> "${d / MINUTE} dk"
      d < DAY -> "${d / HOUR} sa"
      else -> "${d / DAY} gün"
    }
  }

  /**
   * core `widgetStatusText`: "Paylaşıyor · 3 dk önce" (lock: "Paylaşıyor · 3 dk"), "Paylaşıyor · şimdi", "Paylaşmıyor",
   * "Bağlantı yok · 22 dk", "Duraklatıldı", "Konum bekleniyor".
   */
  fun status(f: WFavorite, now: Long, lock: Boolean = false): String {
    val st = effectiveStatus(f, now)
    if (st == "not_sharing") return "Paylaşmıyor"
    if (st == "paused") return "Duraklatıldı"
    val t = f.lastSeenAt ?: return "Konum bekleniyor"
    val age = now - t
    if (st == "sharing_stale") return "Bağlantı yok · " + ageShort(age)
    if (age < MINUTE) return "Paylaşıyor · şimdi"
    return if (lock) "Paylaşıyor · " + ageShort(age) else "Paylaşıyor · " + ageShort(age) + " önce"
  }

  /** core `formatCountdown`: "59 dk", "1 sa", "1 sa 30 dk", "2 gün" (dakika yukarı yuvarlanır). */
  fun countdown(msLeft: Long): String {
    if (msLeft <= 0L) return "0 dk"
    val total = (msLeft + MINUTE - 1) / MINUTE
    if (total < 60) return "$total dk"
    if (total < 24 * 60) {
      val h = total / 60
      val m = total % 60
      return if (m == 0L) "$h sa" else "$h sa $m dk"
    }
    return "${total / (24 * 60)} gün"
  }

  fun detail(f: WFavorite): String? {
    val parts = ArrayList<String>()
    f.place?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
    f.batteryPct?.let { parts.add("%$it" + (if (f.batteryLow) " düşük" else "")) }
    return if (parts.isEmpty()) null else parts.joinToString(" · ")
  }

  /** core `quickShareErrorText` (widget boyutunda kısa Türkçe metin). */
  fun quickError(code: String?): String = when (code) {
    "token_invalid" -> "Uygulamayı açıp tekrar dene"
    "token_expired" -> "Oturum yenilenmeli"
    "not_favorite" -> "Kişi favorilerde değil"
    "not_friend" -> "Artık arkadaş değilsiniz"
    "rate_limited" -> "Çok sık denendi, bekle"
    "unavailable" -> "Bağlantı yok"
    else -> "Bir sorun oluştu"
  }

  /** core `quickShareErrorAction`: hız sınırı / bağlantı yok → widget'ta metin (düğme kalır); diğerleri → uygulama. */
  fun errorOpensApp(code: String?): Boolean = !(code == "rate_limited" || code == "unavailable")

  fun emptyText(s: WSnapshot?): String = when {
    s == null -> "Konum'u bir kez aç"
    !s.signedIn -> "Konum'a giriş yap"
    else -> "Favori ekle: Arkadaşlar ★"
  }
}

object WidgetRoute {
  /**
   * core `quickShareRoute` ile aynı sıra: oturum → hedef → (Android: etkileşim hep var) → belirteç → bitişe ≤ 5 dk →
   * arka plan konumu; ek olarak son 2 dk'daki "uygulamayı aç" türü hata (core `quickShareErrorAction`).
   */
  fun route(s: WSnapshot?, targetUid: String?, tokenExpiresAt: Long?, quick: WQuickState?, now: Long): QuickRoute {
    if (s == null || !s.signedIn) return QuickRoute.OpenApp("signed_out")
    if (targetUid == null || s.favorite(targetUid) == null) return QuickRoute.OpenApp("no_favorite")
    if (!s.tokenOk || tokenExpiresAt == null) return QuickRoute.OpenApp("no_token")
    if (tokenExpiresAt - now <= WidgetLimits.TOKEN_MIN_REMAINING_MS) return QuickRoute.OpenApp("token_expiring")
    if (!s.bgLocationOk) return QuickRoute.OpenApp("no_bg_location")
    if (quick != null && quick.phase == "error" && quick.toUid == targetUid && now - quick.at < WidgetLimits.ERROR_FALLBACK_MS &&
      WidgetText.errorOpensApp(quick.error)
    ) {
      return QuickRoute.OpenApp("error_fallback")
    }
    return QuickRoute.Background
  }
}
