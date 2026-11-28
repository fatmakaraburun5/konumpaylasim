// Faz 12: uygulama tarafı ActivityKit köprüsü (JS: src/services/live/liveActivityBridge.ts).
//
// `KonumShareAttributes` targets/widgets/LiveShareActivity.swift'teki yapıyla AYNI ad ve Codable biçimindedir
// (ActivityKit iki hedefi bu yolla eşler); biri değişirse diğeri de değişmeli.
//
// Kurallar:
//  - Aynı anda tek etkinlik: start, açık kalmış eski etkinlikleri (uygulama çökmüş / yeniden kurulmuş) önce kapatır.
//  - Güncelleme yerel (push token yok): sayaç `Text(timerInterval:)` ile kendi akar, `staleDate` bitiş + 1 dk.
//  - end(content, dismissAt): content varsa "sona erdi" hâli `dismissAt`'e kadar kalır; yoksa hemen kalkar.
//  - Kullanıcı Ayarlar > Konum > Canlı Etkinlikler'i kapattıysa `liveEnabled` false: JS hiç başlatmaz.
// [Varsayım] Derlenmedi (Xcode yok). iOS 16.2 altı: tüm işlevler no-op / false.
import ActivityKit
import Foundation

struct KonumShareAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    struct Person: Codable, Hashable {
      var uid: String
      var name: String
      var initials: String
      var ring: String
      var avatar_key: String?
    }
    struct Eta: Codable, Hashable {
      var label: String
      var kind: String
      var arrive_at: Double
      var computed_at: Double
    }
    var v: Int
    var phase: String
    var ends_at: Double?
    var started_at: Double
    var break_until: Double?
    var lead: Person
    var receivers: Int
    var eta: Eta?
    var title: String
    var subtitle: String
    var at: Double
  }

  var v: Int
  var activity_id: String
  var started_at: Double
}

enum LiveShareBridge {
  private static let decoder = JSONDecoder()

  private static func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? decoder.decode(type, from: data)
  }

  static func enabled() -> Bool {
    if #available(iOS 16.2, *) {
      return ActivityAuthorizationInfo().areActivitiesEnabled
    }
    return false
  }

  private static func staleDate(_ c: KonumShareAttributes.ContentState) -> Date? {
    guard let end = c.ends_at else { return nil }
    return Date(timeIntervalSince1970: end / 1000 + 60)
  }

  static func start(_ attributesJson: String, _ contentJson: String) async -> Bool {
    guard #available(iOS 16.2, *), enabled(),
          let attrs = decode(KonumShareAttributes.self, attributesJson),
          let content = decode(KonumShareAttributes.ContentState.self, contentJson), content.v == 1 else { return false }
    for old in Activity<KonumShareAttributes>.activities {
      await old.end(nil, dismissalPolicy: .immediate)
    }
    do {
      _ = try Activity.request(attributes: attrs, content: .init(state: content, staleDate: staleDate(content)), pushType: nil)
      return true
    } catch {
      return false
    }
  }

  static func update(_ contentJson: String) async {
    guard #available(iOS 16.2, *), let content = decode(KonumShareAttributes.ContentState.self, contentJson) else { return }
    for a in Activity<KonumShareAttributes>.activities {
      await a.update(.init(state: content, staleDate: staleDate(content)))
    }
  }

  static func end(_ contentJson: String?, _ dismissAtMs: Double?) async {
    guard #available(iOS 16.2, *) else { return }
    let content = contentJson.flatMap { decode(KonumShareAttributes.ContentState.self, $0) }
    let policy: ActivityUIDismissalPolicy = {
      if content != nil, let at = dismissAtMs { return .after(Date(timeIntervalSince1970: at / 1000)) }
      return .immediate
    }()
    for a in Activity<KonumShareAttributes>.activities {
      await a.end(content.map { .init(state: $0, staleDate: nil) }, dismissalPolicy: policy)
    }
  }
}
