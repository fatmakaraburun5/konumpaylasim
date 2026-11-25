// Faz 6: tek dokunuşla favori kişiye 1 saatlik canlı konum paylaşımı (iOS 17 etkileşimli widget niyeti).
//
// Akış: widget düğmesi → StartQuickShareIntent (UZANTI sürecinde çalışır, uygulama açılmaz)
//   1. `authenticationPolicy = .requiresAuthentication`: kilitli telefonda Face ID / parola istenmeden çalışmaz.
//   2. Anahtarlıktan { token, endpoint, expires_at } okunur (uygulama `setQuickShareCredential` ile yazar).
//   3. Callable HTTP protokolü: POST {"data":{token,to_uid,op_id,source}} → {"result":{...}} | {"error":{...}}
//      (URLSession, 8 sn zaman aşımı; Firebase kimliği / App Check YOK — belirteç sunucuda sha256 ile doğrulanır).
//   4. Başarı: anlık görüntüde `my_share_expires_at` yamalanır, olay kaydedilir, tüm zaman çizelgeleri yenilenir.
//      Sunucu ayrıca göndericiye `resume_tracking` uyandırma push'u + görünür "1 saatlik paylaşım başladı" push'u yollar.
//   5. Hata: olay + 2 dk'lık hata durumu kaydedilir; widget o kişi için düğme yerine `konum://quick-share?...`
//      bağlantısını gösterir (iOS 17 niyeti uygulamayı koşullu açamaz; iOS 18 `OpenURLIntent` özel şemayı
//      desteklemediği için kullanılmadı [Varsayım]).
// [Varsayım] Bu ortamda Xcode yok: derlenmedi, cihazda doğrulanmalı.
import AppIntents
import Foundation
import WidgetKit

enum QuickShareOutcome {
  case success(status: String, shareId: String?, expiresAt: Double?, toName: String?)
  case failure(code: String)
}

enum QuickShareClient {
  static let knownErrors: Set<String> = [
    "token_invalid", "token_expired", "not_favorite", "not_friend", "rate_limited", "unavailable", "internal",
  ]

  static func call(_ cred: QuickCredential, toUid: String, source: String) async -> QuickShareOutcome {
    let body: [String: Any] = [
      "data": [
        "token": cred.token,
        "to_uid": toUid,
        "op_id": UUID().uuidString.lowercased(),
        "source": source,
      ],
    ]
    guard let payload = try? JSONSerialization.data(withJSONObject: body) else { return .failure(code: "internal") }
    var req = URLRequest(url: cred.endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
    req.httpMethod = "POST"
    req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
    req.httpBody = payload
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 8
    config.timeoutIntervalForResource = 8
    config.waitsForConnectivity = false
    let session = URLSession(configuration: config)
    defer { session.finishTasksAndInvalidate() }
    do {
      let (data, response) = try await session.data(for: req)
      let http = (response as? HTTPURLResponse)?.statusCode ?? 0
      return parse(httpStatus: http, data: data)
    } catch {
      return .failure(code: "unavailable")
    }
  }

  static func parse(httpStatus: Int, data: Data) -> QuickShareOutcome {
    let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    if (200...299).contains(httpStatus), let result = root?["result"] as? [String: Any],
       let status = result["status"] as? String {
      return .success(
        status: status,
        shareId: result["share_id"] as? String,
        expiresAt: (result["expires_at"] as? NSNumber)?.doubleValue,
        toName: result["to_name"] as? String
      )
    }
    let err = root?["error"] as? [String: Any]
    let details = err?["details"] as? [String: Any]
    return .failure(code: mapError(
      code: details?["code"] as? String,
      message: err?["message"] as? String,
      status: err?["status"] as? String,
      httpStatus: httpStatus
    ))
  }

  /// details.code (core QuickShareError ya da genel ERROR_CODES) → QuickShareError.
  static func mapError(code: String?, message: String?, status: String?, httpStatus: Int) -> String {
    if let c = code {
      if knownErrors.contains(c) { return c }
      switch c {
      case "not_friends": return "not_friend"
      case "unauthenticated": return "token_invalid"
      case "rate_limited", "quota_exceeded": return "rate_limited"
      case "unavailable": return "unavailable"
      default: break
      }
    }
    if let m = message, knownErrors.contains(m) { return m }
    switch status ?? "" {
    case "UNAUTHENTICATED", "PERMISSION_DENIED": return "token_invalid"
    case "RESOURCE_EXHAUSTED": return "rate_limited"
    case "UNAVAILABLE", "DEADLINE_EXCEEDED": return "unavailable"
    default: break
    }
    if httpStatus == 401 || httpStatus == 403 { return "token_invalid" }
    if httpStatus == 429 { return "rate_limited" }
    if httpStatus == 503 || httpStatus == 504 || httpStatus == 0 { return "unavailable" }
    return "internal"
  }
}

struct StartQuickShareIntent: AppIntent {
  // Apple örnekleriyle aynı biçim (Swift 5 dil kipi; @bacons/apple-targets SWIFT_VERSION = 5.0).
  static var title: LocalizedStringResource = "1 saat konum paylaş"
  static var description = IntentDescription("Seçili favori kişiye 1 saatlik canlı konum paylaşımı başlatır.")
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static var isDiscoverable: Bool = false

  @Parameter(title: "Kişi")
  var toUid: String

  @Parameter(title: "Kaynak")
  var source: String

  init() {}

  init(toUid: String, source: String) {
    self.toUid = toUid
    self.source = source
  }

  func perform() async throws -> some IntentResult {
    let now = Date().ms
    let src = (source == "ios_lock") ? "ios_lock" : "ios_widget"
    guard let cred = WidgetStore.readCredential(), cred.expiresAt - now > WidgetLimits.tokenMinRemainingMs else {
      finishFailure(code: "token_invalid", now: now, src: src, tokenGone: true)
      return .result()
    }
    // Çift dokunuş: aynı kişiye 20 sn içinde süren istek varsa yenisi gönderilmez.
    if let q = WidgetStore.quickState(), q.phase == "pending", q.toUid == toUid, now - q.at < WidgetLimits.pendingMs {
      return .result()
    }
    WidgetStore.setQuickState(WQuickState(toUid: toUid, phase: "pending", error: nil, at: now))

    switch await QuickShareClient.call(cred, toUid: toUid, source: src) {
    case let .success(status, shareId, expiresAt, toName):
      WidgetStore.setQuickState(nil)
      WidgetStore.patchSnapshot(myShareUid: toUid, expiresAt: expiresAt, tokenOk: nil)
      var event: [String: Any] = ["type": "quick_share", "to_uid": toUid, "status": status, "at": Date().ms, "source": src]
      if let exp = expiresAt { event["expires_at"] = exp }
      if let sid = shareId { event["share_id"] = sid }
      if let name = toName { event["to_name"] = name }
      WidgetStore.appendEvent(event)
    case let .failure(code):
      finishFailure(code: code, now: Date().ms, src: src, tokenGone: code == "token_invalid" || code == "token_expired")
    }
    WidgetCenter.shared.reloadAllTimelines()
    return .result()
  }

  private func finishFailure(code: String, now: Double, src: String, tokenGone: Bool) {
    WidgetStore.setQuickState(WQuickState(toUid: toUid, phase: "error", error: code, at: now))
    if tokenGone {
      WidgetStore.patchSnapshot(myShareUid: nil, expiresAt: nil, tokenOk: false)
    }
    WidgetStore.appendEvent(["type": "quick_share", "to_uid": toUid, "status": "error", "error": code, "at": now, "source": src])
    WidgetCenter.shared.reloadAllTimelines()
  }
}
