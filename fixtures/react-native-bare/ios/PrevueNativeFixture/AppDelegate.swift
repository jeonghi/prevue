import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
             options connectionOptions: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    window.rootViewController = ShipmentViewController()
    self.window = window
    window.makeKeyAndVisible()
  }
}

final class ShipmentViewController: UIViewController {
  private let openButton = UIButton(type: .system)
  private let container = UIView()
  private let delegate = ShipmentReactDelegate()
  private var factory: RCTReactNativeFactory?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let heading = UILabel()
    heading.text = "운송 현황"
    heading.accessibilityIdentifier = "native-landing-heading"
    heading.font = .preferredFont(forTextStyle: .title1)
    heading.accessibilityTraits = .header
    heading.setContentHuggingPriority(.required, for: .vertical)
    openButton.setTitle("운송 화면 열기", for: .normal)
    openButton.accessibilityIdentifier = "open-regular-shipment"
    openButton.addTarget(self, action: #selector(openShipment), for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [heading, openButton, container])
    stack.axis = .vertical
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    let safe = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12),
      stack.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
    ])
#if DEBUG
    if ShipmentReactDelegate.previewPort != nil { openShipment() }
#endif
  }

  @objc private func openShipment() {
    guard factory == nil else { return }
    openButton.isHidden = true
    delegate.dependencyProvider = RCTAppDependencyProvider()
    let factory = RCTReactNativeFactory(delegate: delegate)
    self.factory = factory
    let child = UIViewController()
    child.view = factory.rootViewFactory.view(withModuleName: "PrevueNativeFixture")
    addChild(child)
    let surface = child.view!
    container.addSubview(surface)
    surface.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      surface.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      surface.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      surface.topAnchor.constraint(equalTo: container.topAnchor),
      surface.bottomAnchor.constraint(equalTo: container.bottomAnchor),
    ])
    child.didMove(toParent: self)
  }
}

class ShipmentReactDelegate: RCTDefaultReactNativeFactoryDelegate {
#if DEBUG
  static var previewPort: UInt16? {
    guard let value = ProcessInfo.processInfo.environment["PREVUE_METRO_PORT"],
          let port = UInt16(value), port != 0 else { return nil }
    return port
  }
#endif
  override func sourceURL(for bridge: RCTBridge) -> URL? { bundleURL() }

  override func bundleURL() -> URL? {
#if DEBUG
    if let port = Self.previewPort {
      return RCTBundleURLProvider.jsBundleURL(forBundleRoot: "index.preview", packagerHost: "127.0.0.1:\(port)",
        enableDev: true, enableMinification: false, inlineSourceMap: false)
    }
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
