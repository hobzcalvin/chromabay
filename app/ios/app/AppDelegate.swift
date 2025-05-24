import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import react_native_ota_hot_update

@main
class AppDelegate: RCTAppDelegate {
  override var window: UIWindow {
    get { return super.window }
    set { super.window = newValue }
  }

  var taskIdentifier: UIBackgroundTaskIdentifier = .invalid

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let moduleName = "app"
    guard let bridge = bridge else {
      return false
    }
    let rootView = RCTRootView(
      bridge: bridge,
      moduleName: moduleName,
      initialProperties: nil
    )
    rootView.backgroundColor = UIColor.white
    let rootViewController = UIViewController()
    rootViewController.view = rootView
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = rootViewController
    window.makeKeyAndVisible()
    self.window = window
    return true
  }

  override func bundleURL() -> URL? {
    #if DEBUG
      return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
    #else
      return OtaHotUpdate.getBundle()
    #endif
  }

  override func applicationWillResignActive(_ application: UIApplication) {
    if taskIdentifier != .invalid {
      application.endBackgroundTask(taskIdentifier)
      taskIdentifier = .invalid
    }
    taskIdentifier = application.beginBackgroundTask(withName: nil) { [weak self] in
      if let strongSelf = self {
        application.endBackgroundTask(strongSelf.taskIdentifier)
        strongSelf.taskIdentifier = .invalid
      }
    }
  }
}
