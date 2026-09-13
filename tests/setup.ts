import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Keep the runtime's own fetch/WebSocket reachable for tests that talk to a
// real local server: happy-dom's fetch enforces a same-origin policy against
// about:blank and would refuse them.
(globalThis as unknown as { __nativeFetch: typeof fetch }).__nativeFetch = globalThis.fetch;

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
