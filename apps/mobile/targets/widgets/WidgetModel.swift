// Faz 6: widget anlık görüntüsü (core `packages/core/src/widget.ts` WidgetSnapshot, snake_case JSON, v = 1).
// Çözümleme savunmacıdır: bozuk JSON / bilinmeyen sürüm → nil → widget "giriş yap / uygulamayı aç" boş durumunu çizer.
// Metin kuralları core `widgetStatusText` / `formatCountdown` / `quickShareErrorText` ile eş tutulmalı (Türkçe, kısa).
// [Varsayım] Bu ortamda Xcode yok: derlenmedi, cihazda doğrulanmalı.
import Foundation

struct WFavorite: Decodable {
  let uid: String
  let name: String
  let initials: String
  let gender: String?
  let ring: String?
  let avatarFile: String?
  let status: String
  let lastSeenAt: Double?
  let place: String?
  let batteryPct: Double?
  let batteryLow: Bool?
  let myShareExpiresAt: Double?
  /// [Ek alan] süresiz paylaşımda `my_share_expires_at` null olduğundan (eski görüntüde yok → nil).
  let myShareActive: Bool?

  /// Cinsiyet çerçevesi (core GENDER_RING): kadın pembe, erkek mavi, bilinmiyor gri.
  var ringHex: String {
    if let r = ring, r.hasPrefix("#"), r.count == 7 { return r }
    switch gender {
    case "female": return "#EC4899"
    case "male": return "#3B82F6"
    default: return "#9CA3AF"
    }
  }

  func activeShareEnd(nowMs: Double) -> Double? {
    guard let e = myShareExpiresAt, e > nowMs else { return nil }
    return e
  }

  /// Bitişi olmayan (süresiz / gün sonu bilinmeyen) etkin paylaşımım: geri sayım yok, düğme de yok.
  var sharingWithoutEnd: Bool {
    return (myShareActive ?? false) && myShareExpiresAt == nil
  }
}

struct WQuick: Decodable {
  let tokenOk: Bool
  let bgLocationOk: Bool
}

struct WPrivacy: Decodable {
  let lockScreenDetails: Bool
}

struct WSnapshot: Decodable {
  let v: Int
  let generatedAt: Double
  let signedIn: Bool
  let meInitials: String?
  let defaultUid: String?
  let favorites: [WFavorite]
  let quick: WQuick
  let privacy: WPrivacy

  static func decode(_ json: String?) -> WSnapshot? {
    guard let json = json, let data = json.data(using: .utf8) else { return nil }
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    guard let snap = try? decoder.decode(WSnapshot.self, from: data), snap.v == 1 else { return nil }
    return snap
  }

  func favorite(_ uid: String?) -> WFavorite? {
    guard let uid = uid else { return nil }
    return favorites.first { $0.uid == uid }
  }

  /// Seçili kişi: yapılandırmadaki uid (hâlâ favoriyse) → default_uid → ilk favori.
  func selected(_ configured: String?) -> WFavorite? {
    return favorite(configured) ?? favorite(defaultUid) ?? favorites.first
  }
}

/// Widget'ın kendi geçici durumu (uygulamanın anlık görüntüsünden ayrı; uygulama yazınca silinmez).
struct WQuickState: Codable {
  let toUid: String
  let phase: String // "pending" | "error"
  let error: String?
  let at: Double

  enum CodingKeys: String, CodingKey {
    case toUid = "to_uid"
    case phase
    case error
    case at
  }
}

enum WidgetLimits {
  static let staleAfterMs: Double = 15 * 60_000
  static let quickShareDurationMs: Double = 60 * 60_000
  /// core WIDGET_TOKEN_EXPIRY_MARGIN_MS: bitişe bu kadar (ya da daha az) kalan belirteç arka planda kullanılmaz.
  static let tokenMinRemainingMs: Double = 5 * 60_000
  static let errorFallbackMs: Double = 2 * 60_000
  static let pendingMs: Double = 20_000
}

enum QuickRoute: Equatable {
  case background
  case openApp(String)
}

extension Date {
  init(ms: Double) {
    self.init(timeIntervalSince1970: ms / 1000)
  }

  var ms: Double {
    return timeIntervalSince1970 * 1000
  }
}

enum WidgetText {
  static let minuteMs: Double = 60_000
  static let hourMs: Double = 3_600_000
  static let dayMs: Double = 86_400_000

  /// core `effectiveWidgetStatus`: canlı ama son paket yok / 15 dk'dan eski → bağlantı yok.
  static func effectiveStatus(_ f: WFavorite, nowMs: Double) -> String {
    if f.status == "sharing_live" {
      guard let t = f.lastSeenAt, nowMs - t <= WidgetLimits.staleAfterMs else { return "sharing_stale" }
    }
    return f.status
  }

  static func isLive(_ f: WFavorite, nowMs: Double) -> Bool {
    return effectiveStatus(f, nowMs: nowMs) == "sharing_live"
  }

  /// core `formatAgeShort`: "şimdi", "3 dk", "2 sa", "1 gün".
  static func ageShort(_ ms: Double) -> String {
    let d = max(0, ms)
    if d < minuteMs { return "şimdi" }
    if d < hourMs { return "\(Int(d / minuteMs)) dk" }
    if d < dayMs { return "\(Int(d / hourMs)) sa" }
    return "\(Int(d / dayMs)) gün"
  }

  /// core `widgetStatusText`: "Paylaşıyor · 3 dk önce" (kilit: "Paylaşıyor · 3 dk"), "Paylaşıyor · şimdi",
  /// "Paylaşmıyor", "Bağlantı yok · 22 dk", "Duraklatıldı", "Konum bekleniyor".
  static func status(_ f: WFavorite, nowMs: Double, lock: Bool = false) -> String {
    let st = effectiveStatus(f, nowMs: nowMs)
    if st == "not_sharing" { return "Paylaşmıyor" }
    if st == "paused" { return "Duraklatıldı" }
    guard let t = f.lastSeenAt else { return "Konum bekleniyor" }
    let age = nowMs - t
    if st == "sharing_stale" { return "Bağlantı yok · " + ageShort(age) }
    if age < minuteMs { return "Paylaşıyor · şimdi" }
    return lock ? "Paylaşıyor · " + ageShort(age) : "Paylaşıyor · " + ageShort(age) + " önce"
  }

  /// core `formatCountdown`: "59 dk", "1 sa", "1 sa 30 dk", "2 gün" (dakika yukarı yuvarlanır).
  static func countdown(_ msLeft: Double) -> String {
    if msLeft <= 0 { return "0 dk" }
    let total = Int((msLeft / minuteMs).rounded(.up))
    if total < 60 { return "\(total) dk" }
    if total < 24 * 60 {
      let h = total / 60
      let m = total % 60
      return m == 0 ? "\(h) sa" : "\(h) sa \(m) dk"
    }
    return "\(total / (24 * 60)) gün"
  }

  static func detail(_ f: WFavorite) -> String? {
    var parts: [String] = []
    if let p = f.place, !p.isEmpty { parts.append(p) }
    if let b = f.batteryPct { parts.append("%\(Int(b.rounded()))" + ((f.batteryLow ?? false) ? " düşük" : "")) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  /// core `quickShareErrorText` (widget boyutunda kısa Türkçe metin).
  static func quickError(_ code: String?) -> String {
    switch code ?? "" {
    case "token_invalid": return "Uygulamayı açıp tekrar dene"
    case "token_expired": return "Oturum yenilenmeli"
    case "not_favorite": return "Kişi favorilerde değil"
    case "not_friend": return "Artık arkadaş değilsiniz"
    case "rate_limited": return "Çok sık denendi, bekle"
    case "unavailable": return "Bağlantı yok"
    default: return "Bir sorun oluştu"
    }
  }

  /// core `quickShareErrorAction`: hız sınırı / bağlantı yok → widget'ta metin (düğme kalır); diğerleri → uygulama.
  static func errorOpensApp(_ code: String?) -> Bool {
    return !(code == "rate_limited" || code == "unavailable")
  }

  static func emptyText(_ snap: WSnapshot?) -> String {
    guard let snap = snap else { return "Konum'u bir kez aç" }
    if !snap.signedIn { return "Konum'a giriş yap" }
    return "Favori ekle: Arkadaşlar ★"
  }
}

enum WidgetRoute {
  /// core `quickShareRoute` ile aynı sıra: oturum → hedef → (iOS 17 hedefi: etkileşim hep var) → belirteç → bitişe
  /// ≤ 5 dk → arka plan konumu; ek olarak son 2 dk'daki "uygulamayı aç" türü hata (core `quickShareErrorAction`).
  static func route(snapshot: WSnapshot?, targetUid: String?, tokenExpMs: Double?, quick: WQuickState?, nowMs: Double) -> QuickRoute {
    guard let snap = snapshot, snap.signedIn else { return .openApp("signed_out") }
    guard let uid = targetUid, snap.favorite(uid) != nil else { return .openApp("no_favorite") }
    guard snap.quick.tokenOk, let exp = tokenExpMs else { return .openApp("no_token") }
    if exp - nowMs <= WidgetLimits.tokenMinRemainingMs { return .openApp("token_expiring") }
    if !snap.quick.bgLocationOk { return .openApp("no_bg_location") }
    if let q = quick, q.phase == "error", q.toUid == uid, nowMs - q.at < WidgetLimits.errorFallbackMs,
       WidgetText.errorOpensApp(q.error) {
      return .openApp("error_fallback")
    }
    return .background
  }
}

enum WidgetLinks {
  /// `konum://quick-share?to=<uid>&src=<src>` (core `quickShareDeepLink`).
  static func quickShare(_ uid: String, src: String) -> URL {
    var c = URLComponents()
    c.scheme = "konum"
    c.host = "quick-share"
    c.queryItems = [URLQueryItem(name: "to", value: uid), URLQueryItem(name: "src", value: src)]
    return c.url ?? openApp
  }

  static var openApp: URL {
    return URL(string: "konum://") ?? URL(fileURLWithPath: "/")
  }
}
