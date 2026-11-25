// Faz 6: widget uzantısının paylaşılan depoları (App Group UserDefaults + kapsayıcı + anahtarlık).
// Anahtar adları modules/konum-widgets/ios/KonumWidgetsModule.swift (`KonumWidgetKeys`) ile AYNI olmalı.
// [Varsayım] Bu ortamda Xcode yok: derlenmedi, cihazda doğrulanmalı.
import Foundation
import Security
import UIKit

enum WidgetKeys {
  static let snapshot = "konum.widget.snapshot.v1"
  static let tokenExp = "konum.widget.token_exp.v1"
  static let events = "konum.widget.events.v1"
  static let quickState = "konum.widget.quick_state.v1"
  static let keychainService = "konum.widget"
  static let keychainAccount = "quick_share"
  static let avatarsDir = "konum_widget_avatars"
  static let maxEvents = 20
}

struct QuickCredential {
  let token: String
  let endpoint: URL
  let expiresAt: Double
}

enum WidgetStore {
  /// Uzantının paket kimliği `<BUNDLE_ID>.widgets` → App Group `group.<BUNDLE_ID>` (sabit kodlanmaz).
  static var appGroup: String {
    if let v = Bundle.main.object(forInfoDictionaryKey: "KonumAppGroup") as? String, !v.isEmpty {
      return v
    }
    let bid = Bundle.main.bundleIdentifier ?? ""
    let suffix = ".widgets"
    let base = bid.hasSuffix(suffix) ? String(bid.dropLast(suffix.count)) : bid
    return "group." + base
  }

  static var defaults: UserDefaults? {
    return UserDefaults(suiteName: appGroup)
  }

  // MARK: Anlık görüntü

  static func loadSnapshot() -> WSnapshot? {
    return WSnapshot.decode(defaults?.string(forKey: WidgetKeys.snapshot))
  }

  static func tokenExpiresAt() -> Double? {
    guard let d = defaults, d.object(forKey: WidgetKeys.tokenExp) != nil else { return nil }
    let v = d.double(forKey: WidgetKeys.tokenExp)
    return v > 0 ? v : nil
  }

  /// Hızlı paylaşım sonrası anlık görüntüyü yerinde yamalar (bilinmeyen alanlar korunur: JSONSerialization).
  /// core `applyQuickShareToSnapshot` ile aynı: `my_share_expires_at` (süresizse null) + `my_share_active = true`.
  static func patchSnapshot(myShareUid: String?, expiresAt: Double?, tokenOk: Bool?) {
    guard let d = defaults, let raw = d.string(forKey: WidgetKeys.snapshot), let data = raw.data(using: .utf8),
          var root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
    if let uid = myShareUid, var favs = root["favorites"] as? [[String: Any]] {
      for i in favs.indices where (favs[i]["uid"] as? String) == uid {
        if let exp = expiresAt {
          favs[i]["my_share_expires_at"] = NSNumber(value: Int64(exp))
        } else {
          favs[i]["my_share_expires_at"] = NSNull()
        }
        favs[i]["my_share_active"] = true
      }
      root["favorites"] = favs
    }
    if let ok = tokenOk, var quick = root["quick"] as? [String: Any] {
      quick["token_ok"] = ok
      root["quick"] = quick
    }
    guard let out = try? JSONSerialization.data(withJSONObject: root), let str = String(data: out, encoding: .utf8) else { return }
    d.set(str, forKey: WidgetKeys.snapshot)
  }

  // MARK: Geçici hızlı paylaşım durumu

  static func quickState() -> WQuickState? {
    guard let raw = defaults?.string(forKey: WidgetKeys.quickState), let data = raw.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(WQuickState.self, from: data)
  }

  static func setQuickState(_ s: WQuickState?) {
    guard let d = defaults else { return }
    guard let s = s, let data = try? JSONEncoder().encode(s), let str = String(data: data, encoding: .utf8) else {
      d.removeObject(forKey: WidgetKeys.quickState)
      return
    }
    d.set(str, forKey: WidgetKeys.quickState)
  }

  // MARK: Olaylar (uygulama `consumeEvents` ile okur ve siler)

  static func appendEvent(_ event: [String: Any]) {
    guard let d = defaults else { return }
    var list: [[String: Any]] = []
    if let raw = d.string(forKey: WidgetKeys.events), let data = raw.data(using: .utf8),
       let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] {
      list = parsed
    }
    list.append(event)
    if list.count > WidgetKeys.maxEvents { list = Array(list.suffix(WidgetKeys.maxEvents)) }
    guard let out = try? JSONSerialization.data(withJSONObject: list), let str = String(data: out, encoding: .utf8) else { return }
    d.set(str, forKey: WidgetKeys.events)
  }

  // MARK: Anahtarlık (yalnızca okunur; uygulama yazar)

  static func readCredential() -> QuickCredential? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: WidgetKeys.keychainService,
      kSecAttrAccount as String: WidgetKeys.keychainAccount,
      kSecAttrAccessGroup as String: appGroup,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    guard status == errSecSuccess, let data = out as? Data,
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let token = obj["token"] as? String, !token.isEmpty,
          let endpointStr = obj["endpoint"] as? String, let endpoint = URL(string: endpointStr),
          let exp = (obj["expires_at"] as? NSNumber)?.doubleValue else { return nil }
    return QuickCredential(token: token, endpoint: endpoint, expiresAt: exp)
  }

  // MARK: Avatarlar

  static func avatarImage(_ file: String?) -> UIImage? {
    guard let file = file, !file.isEmpty, !file.contains("/"), !file.contains(".."),
          let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
    let url = root.appendingPathComponent(WidgetKeys.avatarsDir, isDirectory: true).appendingPathComponent(file)
    return UIImage(contentsOfFile: url.path)
  }
}
