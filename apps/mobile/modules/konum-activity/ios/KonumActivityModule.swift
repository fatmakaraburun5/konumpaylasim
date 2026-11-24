// Faz 3: iOS hareket etkinliği (CMMotionActivityManager) → JS "onActivity" olayı.
//
// Olay: { type: still|walking|running|cycling|automotive|unknown, confidence: low|medium|high, at: ms (cihaz saati) }
// - Uygulama arka planda konum oturumuyla ayaktayken güncellemeler gelmeye devam eder.
// - Son olay bellekte tutulur (`getLastActivity`): konum görevi her uyanışta okur.
// - İzin: ilk sorguda sistem "Hareket ve Fitness" penceresini gösterir (NSMotionUsageDescription zorunlu).
// [Varsayım] Bu ortamda Xcode yok: derlenmedi, cihazda doğrulanmalı.
import CoreMotion
import ExpoModulesCore

public class KonumActivityModule: Module {
  private let manager = CMMotionActivityManager()
  private let queue: OperationQueue = {
    let q = OperationQueue()
    q.name = "konum.activity"
    q.maxConcurrentOperationCount = 1
    return q
  }()
  private var running = false
  private var last: [String: Any]?

  public func definition() -> ModuleDefinition {
    Name("KonumActivity")

    Events("onActivity")

    Function("isAvailable") { () -> Bool in
      return CMMotionActivityManager.isActivityAvailable()
    }

    AsyncFunction("getPermissionStatusAsync") { () -> String in
      return KonumActivityModule.statusString(CMMotionActivityManager.authorizationStatus())
    }

    AsyncFunction("requestPermissionAsync") { (promise: Promise) in
      guard CMMotionActivityManager.isActivityAvailable() else {
        promise.resolve("restricted")
        return
      }
      if CMMotionActivityManager.authorizationStatus() != .notDetermined {
        promise.resolve(KonumActivityModule.statusString(CMMotionActivityManager.authorizationStatus()))
        return
      }
      // iOS izin penceresini ilk sorguda gösterir: kısa bir geçmiş sorgusu yeterli.
      let now = Date()
      self.manager.queryActivityStarting(from: now.addingTimeInterval(-60), to: now, to: self.queue) { _, _ in
        promise.resolve(KonumActivityModule.statusString(CMMotionActivityManager.authorizationStatus()))
      }
    }

    AsyncFunction("startAsync") { () -> Bool in
      guard CMMotionActivityManager.isActivityAvailable() else { return false }
      let status = CMMotionActivityManager.authorizationStatus()
      if status == .denied || status == .restricted { return false }
      if self.running { return true }
      self.running = true
      self.manager.startActivityUpdates(to: self.queue) { [weak self] activity in
        guard let self = self, let activity = activity else { return }
        let payload = KonumActivityModule.payload(activity)
        self.last = payload
        self.sendEvent("onActivity", payload)
      }
      return true
    }

    AsyncFunction("stopAsync") {
      self.manager.stopActivityUpdates()
      self.running = false
    }

    Function("getLastActivity") { () -> [String: Any]? in
      return self.last
    }

    OnDestroy {
      self.manager.stopActivityUpdates()
    }
  }

  static func statusString(_ s: CMAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "undetermined"
    @unknown default: return "undetermined"
    }
  }

  static func payload(_ a: CMMotionActivity) -> [String: Any] {
    let type: String
    if a.automotive {
      type = "automotive"
    } else if a.cycling {
      type = "cycling"
    } else if a.running {
      type = "running"
    } else if a.walking {
      type = "walking"
    } else if a.stationary {
      type = "still"
    } else {
      type = "unknown"
    }
    let confidence: String
    switch a.confidence {
    case .high: confidence = "high"
    case .medium: confidence = "medium"
    default: confidence = "low"
    }
    return ["type": type, "confidence": confidence, "at": a.startDate.timeIntervalSince1970 * 1000.0]
  }
}
