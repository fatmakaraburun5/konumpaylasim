// Faz 6: uygulama ↔ widget köprüsü (iOS). JS sarmalayıcı: src/services/widgets/widgetBridge.ts
//
// Paylaşılan alanlar (App Group `group.<BUNDLE_ID>`; kimlik Info.plist `KonumAppGroup`, config eklentisi yazar):
//  - UserDefaults(suiteName:) `konum.widget.snapshot.v1`  : core `WidgetSnapshot` JSON'u (snake_case, v = 1)
//  - UserDefaults `konum.widget.token_exp.v1`             : hızlı paylaşım belirtecinin bitişi (ms; gizli değil,
//                                                            widget yönlendirme kararını anahtarlığa dokunmadan verir)
//  - UserDefaults `konum.widget.events.v1`                : widget'ın kaydettiği olaylar (consumeEvents okur + siler)
//  - Kapsayıcı `konum_widget_avatars/<uid>.jpg`           : 120 px kare JPEG (saveAvatar)
//  - Anahtarlık (kSecAttrAccessGroup = App Group)          : { token, endpoint, expires_at } JSON
// Anahtar adları widget hedefindeki targets/widgets/WidgetStore.swift ile AYNI tutulmalı.
// [Varsayım] Bu ortamda Xcode yok: derlenmedi, cihazda doğrulanmalı.
import ExpoModulesCore
import Foundation
import Security
import UIKit
import WidgetKit

enum KonumWidgetKeys {
  static let snapshot = "konum.widget.snapshot.v1"
  static let tokenExp = "konum.widget.token_exp.v1"
  static let events = "konum.widget.events.v1"
  static let quickState = "konum.widget.quick_state.v1"
  static let keychainService = "konum.widget"
  static let keychainAccount = "quick_share"
  static let avatarsDir = "konum_widget_avatars"
  static let avatarPx: CGFloat = 120
}

enum KonumWidgetShared {
  static var appGroup: String {
    if let v = Bundle.main.object(forInfoDictionaryKey: "KonumAppGroup") as? String, !v.isEmpty {
      return v
    }
    return "group." + (Bundle.main.bundleIdentifier ?? "")
  }

  static var defaults: UserDefaults? {
    return UserDefaults(suiteName: appGroup)
  }

  static func avatarsDirectory() -> URL? {
    guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
      return nil
    }
    let dir = root.appendingPathComponent(KonumWidgetKeys.avatarsDir, isDirectory: true)
    if !FileManager.default.fileExists(atPath: dir.path) {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    return dir
  }

  /// Dosya adı yalnızca [A-Za-z0-9_-] (en çok 64): uid'den yol kaçışı olmasın.
  static func avatarFileName(_ uid: String) -> String? {
    let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
    let safe = String(uid.filter { allowed.contains($0) }.prefix(64))
    if safe.isEmpty { return nil }
    return safe + ".jpg"
  }

  static func saveAvatar(uid: String, uri: String) -> String? {
    guard let name = avatarFileName(uid), let dir = avatarsDirectory() else { return nil }
    let source: URL?
    if uri.hasPrefix("file://") {
      source = URL(string: uri)
    } else if uri.hasPrefix("/") {
      source = URL(fileURLWithPath: uri)
    } else {
      source = nil // Uzak URL kabul edilmez: JS önce yerel dosyaya indirir.
    }
    guard let src = source, let data = try? Data(contentsOf: src), let image = UIImage(data: data) else {
      return nil
    }
    let side = KonumWidgetKeys.avatarPx
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
    let out = renderer.image { _ in
      let w = max(image.size.width, 1)
      let h = max(image.size.height, 1)
      let s = max(side / w, side / h) // ortadan kare kırpma
      let dw = w * s
      let dh = h * s
      image.draw(in: CGRect(x: (side - dw) / 2, y: (side - dh) / 2, width: dw, height: dh))
    }
    guard let jpeg = out.jpegData(compressionQuality: 0.85) else { return nil }
    do {
      try jpeg.write(to: dir.appendingPathComponent(name), options: .atomic)
    } catch {
      return nil
    }
    return name
  }

  static func removeAvatar(uid: String) {
    guard let name = avatarFileName(uid), let dir = avatarsDirectory() else { return }
    try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
  }

  private static func keychainQuery() -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: KonumWidgetKeys.keychainService,
      kSecAttrAccount as String: KonumWidgetKeys.keychainAccount,
      kSecAttrAccessGroup as String: appGroup,
    ]
  }

  /// Uç nokta: tam http(s) URL'si aynen; yalnızca callable adı (core `endpoint_path`, ör. "widget_quick_share")
  /// verilirse GoogleService-Info.plist PROJECT_ID + europe-west1 ile tam URL kurulur (uzantıda plist yok).
  static func resolveEndpoint(_ raw: String) -> String? {
    let e = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if e.hasPrefix("https://") || e.hasPrefix("http://") { return URL(string: e) != nil ? e : nil }
    let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789_")
    guard !e.isEmpty, e.count <= 64, e.allSatisfy({ allowed.contains($0) }) else { return nil }
    guard let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
          let dict = NSDictionary(contentsOfFile: path),
          let projectId = dict["PROJECT_ID"] as? String, !projectId.isEmpty else { return nil }
    return "https://\(functionsRegion)-\(projectId).cloudfunctions.net/\(e)"
  }

  /// backend `REGION` (functions/src/config.ts).
  static let functionsRegion = "europe-west1"

  /// Belirteci anahtarlığa yazar. Başarısızsa (ör. imzasız simülatör: errSecMissingEntitlement) bitiş zamanı da
  /// yazılmaz → widget "belirteç yok" sayar ve uygulamayı açar.
  static func writeCredential(token: String, endpoint: String, expiresAt: Double) -> Bool {
    guard let url = resolveEndpoint(endpoint) else {
      clearCredential()
      return false
    }
    let payload: [String: Any] = ["token": token, "endpoint": url, "expires_at": expiresAt]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return false }
    let query = keychainQuery()
    SecItemDelete(query as CFDictionary)
    var add = query
    add[kSecValueData as String] = data
    // Kilit açıkken (widget niyeti `requiresAuthentication`) ve ilk kilit açılışından sonra okunabilir; yedeğe/başka
    // cihaza taşınmaz.
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(add as CFDictionary, nil)
    if status == errSecSuccess {
      defaults?.set(expiresAt, forKey: KonumWidgetKeys.tokenExp)
      return true
    }
    defaults?.removeObject(forKey: KonumWidgetKeys.tokenExp)
    return false
  }

  static func clearCredential() {
    SecItemDelete(keychainQuery() as CFDictionary)
    defaults?.removeObject(forKey: KonumWidgetKeys.tokenExp)
  }

  static func writeSnapshot(_ json: String) {
    defaults?.set(json, forKey: KonumWidgetKeys.snapshot)
  }

  static func consumeEvents() -> String {
    guard let d = defaults else { return "[]" }
    let raw = d.string(forKey: KonumWidgetKeys.events) ?? "[]"
    d.removeObject(forKey: KonumWidgetKeys.events)
    return raw
  }
}

public class KonumWidgetsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KonumWidgets")

    AsyncFunction("setSnapshot") { (json: String) in
      KonumWidgetShared.writeSnapshot(json)
    }

    // JS `reload()` dönüşü beklemez (void); iki platformda da AsyncFunction.
    AsyncFunction("reload") {
      WidgetCenter.shared.reloadAllTimelines()
    }

    AsyncFunction("saveAvatar") { (uid: String, uri: String) -> String? in
      return KonumWidgetShared.saveAvatar(uid: uid, uri: uri)
    }

    AsyncFunction("removeAvatar") { (uid: String) in
      KonumWidgetShared.removeAvatar(uid: uid)
    }

    AsyncFunction("setQuickShareCredential") { (token: String, endpoint: String, expiresAt: Double) -> Bool in
      return KonumWidgetShared.writeCredential(token: token, endpoint: endpoint, expiresAt: expiresAt)
    }

    AsyncFunction("clearQuickShareCredential") {
      KonumWidgetShared.clearCredential()
    }

    AsyncFunction("consumeEvents") { () -> String in
      return KonumWidgetShared.consumeEvents()
    }

    Function("capabilities") { () -> [String: Any] in
      var interactive = false
      if #available(iOS 17.0, *) {
        interactive = true
      }
      // Widget hedefi iOS 17+ (targets/widgets/expo-target.config.js): daha eski sürümde widget hiç listelenmez.
      return [
        "platform": "ios",
        "interactive": interactive,
        "lockScreen": interactive,
        "quickTile": false,
        "available": interactive,
      ]
    }
  }
}
