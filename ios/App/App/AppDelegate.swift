import UIKit
import Capacitor

@objc(BonjourDiscoveryPlugin)
public class BonjourDiscoveryPlugin: CAPPlugin, CAPBridgedPlugin, NetServiceBrowserDelegate, NetServiceDelegate {
    public let identifier = "BonjourDiscoveryPlugin"
    public let jsName = "BonjourDiscovery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDevices", returnType: CAPPluginReturnPromise)
    ]

    private var serviceBrowser: NetServiceBrowser?
    private var services: [String: NetService] = [:]
    private var devices: [String: [String: Any]] = [:]

    @objc func startDiscovery(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.serviceBrowser == nil {
                let browser = NetServiceBrowser()
                browser.delegate = self
                self.serviceBrowser = browser
                browser.searchForServices(ofType: "_chromabay._tcp.", inDomain: "local.")
            }
            call.resolve()
        }
    }

    @objc func stopDiscovery(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stop()
            call.resolve()
        }
    }

    @objc func getDevices(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["devices": self.serializedDevices()])
        }
    }

    private func key(for service: NetService) -> String {
        "\(service.name)|\(service.type)|\(service.domain)"
    }

    private func stop() {
        serviceBrowser?.stop()
        serviceBrowser = nil
        for service in services.values {
            service.stop()
            service.delegate = nil
        }
        services.removeAll()
        devices.removeAll()
        emitDevices()
    }

    private func serializedDevices() -> [[String: Any]] {
        devices.values.sorted {
            (($0["name"] as? String) ?? "").localizedCaseInsensitiveCompare(
                ($1["name"] as? String) ?? ""
            ) == .orderedAscending
        }
    }

    private func emitDevices() {
        notifyListeners("devicesChanged", data: ["devices": serializedDevices()])
    }

    private func displayName(for service: NetService) -> String {
        guard let data = service.txtRecordData() else { return service.name }
        let record = NetService.dictionary(fromTXTRecord: data)
        guard let nameData = record["name"],
              let name = String(data: nameData, encoding: .utf8),
              !name.isEmpty else {
            return service.name
        }
        return name
    }

    public func netServiceBrowser(
        _ browser: NetServiceBrowser,
        didFind service: NetService,
        moreComing: Bool
    ) {
        let serviceKey = key(for: service)
        services[serviceKey] = service
        service.delegate = self
        service.resolve(withTimeout: 5)
    }

    public func netServiceBrowser(
        _ browser: NetServiceBrowser,
        didRemove service: NetService,
        moreComing: Bool
    ) {
        let serviceKey = key(for: service)
        services.removeValue(forKey: serviceKey)?.stop()
        devices.removeValue(forKey: serviceKey)
        if !moreComing {
            emitDevices()
        }
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        let code = errorDict[NetService.errorCode]?.intValue ?? -1
        notifyListeners(
            "discoveryError",
            data: ["message": "Bonjour discovery failed (code \(code)). Check Local Network permission."]
        )
    }

    public func netServiceDidResolveAddress(_ sender: NetService) {
        let serviceKey = key(for: sender)
        guard services[serviceKey] === sender, var host = sender.hostName else { return }
        while host.hasSuffix(".") {
            host.removeLast()
        }
        guard !host.isEmpty else { return }

        devices[serviceKey] = [
            "name": displayName(for: sender),
            "host": host.lowercased(),
            "port": sender.port
        ]
        emitDevices()
    }

}

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BonjourDiscoveryPlugin())
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
