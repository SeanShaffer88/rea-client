declare module "*dist/config.js" { export { loadConfig } from "../src/config"; }
declare module "*dist/desktop/EngineBridge.js" { export { EngineBridge } from "../src/desktop/EngineBridge"; }
declare module "*dist/desktop/gateway.js" { export { DesktopGateway } from "../src/desktop/gateway"; }
declare module "*dist/desktop/security.js" { export { isAllowedNavigation, isTrustedRendererUrl, WINDOW_WEB_PREFERENCES } from "../src/desktop/security"; }
