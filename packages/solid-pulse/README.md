# @omniaura/solid-pulse

> Flash what actually updates in a SolidJS app — and give agents the same controls as humans.

`solid-pulse` is dev-only instrumentation for Solid. It watches the reactive graph through Solid's official dev hooks, the DOM through a `MutationObserver`, and the network through `fetch`/`WebSocket`/`EventSource`, and turns what it sees into precisely named events:

| Event | Meaning |
| --- | --- |
| `solid.flush` | a reactive update completed: *n* computations re-ran, by kind (`memo`/`computed`/`effect`/`render`) and by owning component |
| `solid.computation` | one computation re-ran (only with `verboseComputations`) |
| `solid.component.mount` / `.dispose` / `.remount` | a component function ran / its owner was disposed / the same-named child was disposed and recreated within a flush (`gapMs`) |
| `solid.root` | a reactive root was created (multiple roots are counted, not conflated) |
| `dom.mutation` | the DOM actually changed (targets, attribute names, added/removed counts, attribution to the flush's component) |
| `dom.detach` | a subtree left the document, recording the `scrollTop` of every recently-scrolled descendant and whether focus was inside |
| `dom.reattach` | the **same node instance** came back: `gapMs`, `scrollReset: before→after`, `focusLost`, `suspenseInChain`, a stable `selector` |
| `focus.lost` | the focused element vanished from the document |
| `net.fetch.start/end/error` | fetch lifecycle; SSE responses detected by content-type and counted frame by frame; aborts flagged |
| `net.ws.open/message/close/error` | WebSocket lifecycle with subprotocols, direction, counts, `type` field of JSON frames, close codes |
| `net.sse.*` | `EventSource` lifecycle (and fetch-based SSE) |
| `query.observe` | a Solid Query observer subscribed — `role: "initiating"` (first observer, its mount causes the fetch) or `"sharing"` (query already had observers) — attributed to the Solid component |
| `query.fetch.start/success/error` | with `trigger: observer-mount \| invalidation \| background-refetch \| initial` |
| `query.invalidate`, `query.update`, `query.unobserve`, `query.added/removed`, `mutation.*` | the rest of the cache lifecycle |

There is deliberately **no "rerender" event**: Solid never re-runs component bodies. If one ever did, you would see a `pulse.note` saying so.

## Install

```bash
bun add -d @omniaura/solid-pulse
```

```ts
// vite.config.ts — dev server only (`apply: "serve"`), production builds never include it
import solidPulse from "@omniaura/solid-pulse/vite";
export default defineConfig({ plugins: [solidPulse(), solid()] });
```

The plugin injects the runtime as the first module script (so Solid's dev hooks are installed before your first render), mounts the raw-DOM panel, mounts the bridge on the Vite dev server at `/__pulse`, and writes `node_modules/.vite/solid-pulse.json` so the CLI finds it.

Manual setup (no Vite, or custom options):

```ts
import { initPulse } from "@omniaura/solid-pulse";
import { mountPanel } from "@omniaura/solid-pulse/panel";
if (import.meta.env.DEV) {
  const pulse = initPulse({ bridge: "ws://localhost:4567/__pulse/ws" }); // or bridge: true for same-origin
  mountPanel(pulse);
}
```

### Solid Query adapter (optional)

```ts
import { attachQueryClient } from "@omniaura/solid-pulse/query";
attachQueryClient(pulse, queryClient);
```

Read-only: it subscribes to the `QueryCache`/`MutationCache` and never changes query behaviour. With the Vite plugin, point `setupModule: "/src/pulse-setup.ts"` at a module that `export default (pulse) => { attachQueryClient(pulse, queryClient) }` — it is evaluated before your app's entry module, so the very first observers are attributed.

### Bounded capture

The live page buffer retains at most 2,000 events and a 4 MiB **estimated payload** budget (whichever fills first). Old events roll out; status shows evictions. Each event is snapshotted with an 8,192-character / 256-node / 8-level budget, marks truncation, and never retains application object graphs. These are diagnostic budgets, not a claim that the browser process heap is exactly 4 MiB.

Recordings stop at 20,000 events or 4 MiB estimated payload, whichever comes first, with a reported stop reason. Five recent recordings are retained (up to roughly 20 MiB of budgeted payload). Invalid or unlimited recording limits are rejected. The panel renders recent rows in batches at most 10 times per second, with no live log DOM work while closed, hidden, or on another tab. Intermediate display rows may be coalesced; the page buffer remains available via events.list/export.

The bridge has a 200-event pending queue, drains up to 200 events in batches of 20 per 50 ms tick, and pauses event sends when the socket has 512 KiB pending. Saturated queues keep the newest events; drop counts appear in the panel, bridge.status, mirror events/clients and live tail. The initial/reconnect replay is the latest 200 events, not the full page history; use events.list (the page command) or export for more. The server mirror also has a 4 MiB payload budget. Slow CLI live tails disconnect above 512 KiB of queued output and report an error instead of accumulating output or ending silently; reconnect and query recent history, noting sequence gaps. SSE diagnostics retain at most 64 KiB of an incomplete frame; app response bytes pass through unchanged.

The bridge drop counter reports pending-queue evictions and omitted replay entries, not unique end-to-end losses: reconnect replay can include previously delivered events, and disconnects can discard unsent socket data. Use event sequence gaps to identify missing history.

The **Record** tab separates recordings from the rolling live log. Start recording,
reproduce the issue, optionally add marker notes, then stop and download that
recording's JSON. While active, **Download snapshot** exports that recording so
far without stopping it. **Download live log** is a separate, unfiltered export
of the rolling buffer. Capture pause affects both the live log and the active
recording; **Resume capture** does not start a new recording. Automatic stops
show whether the event or size limit was reached. Recordings stay in page memory
only (latest five); download before reloading. All actions use the same
`record.*`, `note`, `events.resume` and `export recording=<id>` commands as agents.

Human Status/bridge status controls and CLI status/bridge.status expose the same limits, counters and recording stop reasons. Capturing every event is inherently work; these bounds prevent retained history and rendering queues from growing with session duration, not zero overhead.

Feature flags and event filters persist per browser origin by default. Saved choices override initial `features`; use `initPulse({ storageKey: false })` for deterministic harnesses, or a custom key to isolate configurations. All switches persist, including `captureBodies`: turn it off when finished capturing payloads. Only preferences are saved, never events, request bodies or recordings. Invalid/denied storage falls back safely. Ports are separate browser origins.

The panel also remembers its open/closed state and selected tab. An explicit `open` option overrides the saved visibility; `mountPanel({ storageKey: false })` disables panel persistence independently of runtime preferences.

### Panel placement

The single Devtools launcher opens a floating, draggable panel. Use the header selector to pin it to any corner; pinned and floating positions survive reloads and remain within the viewport on resize. Choose a default that avoids your app navigation:

```ts
mountPanel(pulse, { position: "top-right", storageKey: "my-app:devtools" });
```

The default is bottom-right. Set `storageKey: false` to disable persistence, or `fab: false` for keyboard/CLI-only access. **Alt+Shift+P**, `panel.open`, `panel.close`, `panel.pin corner=top-left`, and `panel.move x=80 y=60` use the same controller as the UI. `panel.status` reports available tabs and effective placement.

### Optional tools

Tools contribute a tab and commands through one supported registration API; they can attach before or after the panel mounts. Removing a tool removes its view and commands. The panel and bridge command list update when tools change.

```ts
import { registerTool } from "@omniaura/solid-pulse/panel";
const remove = registerTool(pulse, {
  id: "my-tool", title: "My tool",
  commands: [{ spec: { name: "my-tool.status", summary: "Read tool state" }, run: () => ({ ready: true }) }],
  mount(container, pulse) {
    const button = document.createElement("button");
    button.textContent = "Status";
    button.onclick = () => void pulse.run("my-tool.status");
    container.append(button);
    return () => button.remove();
  },
});
// HMR / tool teardown:
remove();
```

The panel automatically discovers the supported Solid Grab runtime, including late initialization, and hosts its source picker inside **Inspect**, hiding its standalone badge and the fallback DOM picker. The `solid-grab` tab id remains an alias for `grab`. Tools may use `slot: "inspect"` to contribute to that view. Query and Scenarios appear when their adapters register commands. Other tools use `registerTool`; installing an arbitrary npm package alone does not provide an integration contract.

### The combined panel (pulse + TanStack Query devtools)

```ts
import { mountPanel } from "@omniaura/solid-pulse/panel";
import { tanstackQueryTab } from "@omniaura/solid-pulse/tanstack";
mountPanel(pulse, { queryDevtools: tanstackQueryTab({
  client: queryClient,
  // Literal imports let the app bundler resolve these optional peers.
  load: async () => {
    const [{ SolidQueryDevtoolsPanel }, { render }] = await Promise.all([
      import("@tanstack/solid-query-devtools"), import("solid-js/web"),
    ]);
    return { Panel: SolidQueryDevtoolsPanel, render };
  },
}) });
```

One drawer, one hotkey, one CLI: Pulse / Query / Inspect / Scenarios / Record. Native `SolidQueryDevtoolsPanel` loads on first opening **Query**, alongside Pulse's query commands. `panel.open tab=query` and the legacy `tab=tanstack` alias open it. The legacy `tabs: [tanstackQueryTab(...)]` API still supports a separate custom tab. TanStack's UI requires Solid's development runtime, including in built simulators; do not enable it in real production builds.

### Overlay

A single `position: fixed; pointer-events: none` container draws flash rectangles (amber = DOM change, green = mount, red = reattach, blue = query, purple = highlight) and a transient badge centred on the component that initiates/observes a query, showing the redacted query key. No layout shift, no focus, capped at 48 live rectangles and 4 badges; respects `prefers-reduced-motion`.

## Human ⇄ agent parity

Every panel control carries `data-command="<name>"` and calls `controller.run(name, args)`; the CLI and HTTP API call the same function. `solid-pulse commands` prints the contract — including where the human control lives — and the test suite asserts the two sets match.

```bash
solid-pulse status                          # bridge + connected pages
solid-pulse commands                        # the contract
solid-pulse events kinds=dom,query limit=50 # buffered events through the active filters
solid-pulse tail kinds=dom.reattach,focus.lost   # live (SSE)
solid-pulse features.set name=flash on=false
solid-pulse features.set name=verboseComputations on=true
solid-pulse filters.set kinds=query component=ChatFeed
solid-pulse inspect.components name=Chat
solid-pulse inspect.queries active=true
solid-pulse inspect.element selector='[data-testid=composer]'   # source + component context (solid-grab aware)
solid-pulse dom.highlight selector='.scroll-view' all=true      # show a human what the agent is looking at
solid-pulse record.start id=qa-1 · record.stop · export recording=qa-1 --json > qa-1.json
solid-pulse note text='step 3: switch thread'
solid-pulse panel.open tab=query · panel.close
solid-pulse query.invalidate key='["conversations"]'
solid-pulse scenario.select name=chat-stream-drop               # when @omniaura/scenario-sim is attached
```

Options: `--url http://host:port[/__pulse]` (or `SOLID_PULSE_URL`; auto-discovered from `node_modules/.vite/solid-pulse.json`), `--client <id>` when several tabs are connected, `--json`.

In-page: `window.__SOLID_PULSE__.run("events.list", { kinds: "dom" })` — handy from `agent-browser eval` or Playwright `page.evaluate`.

### Pages started without a bridge

Built/preview bundles have no Vite dev server. Start `bunx solid-pulse bridge --port 4567`, then attach from the page — `window.__SOLID_PULSE__.run("bridge.connect", { url: "ws://127.0.0.1:4567/__pulse/ws" })` (e.g. via `agent-browser eval`) — or pass the URL in `initPulse({ bridge })`. Reconnects back off exponentially to 30 s, so an absent bridge never floods the console.

### HTTP API (what the CLI uses)

```
GET  /__pulse/api/status
GET  /__pulse/api/clients
GET  /__pulse/api/commands?client=
POST /__pulse/api/command   {client?, name, args}
GET  /__pulse/api/command?name=&args=<json>&client=
GET  /__pulse/api/events?client=&since=&kinds=&limit=
GET  /__pulse/api/events/stream?client=&kinds=          (text/event-stream)
```

## Security and overhead

- **Dev only.** The Vite plugin is `apply: "serve"`; the runtime refuses to initialise twice; nothing is imported in production builds (`bun run smoke` proves it against the example app).
- **Loopback only.** The bridge checks both the peer address and the `Host` header; `allowRemote: true` is an explicit opt-in.
- **Redaction.** URLs lose `token|key|secret|auth|session|ticket|password|signature|code` params, JWT and bearer tokens are scrubbed, headers are never captured, bodies only with the `captureBodies` feature (truncated).
- **Bounded.** Ring buffer (2000 events), per-flush aggregation (individual computations only in verbose mode), per-frame flash caps, per-stream message caps (first 200 then every 50th), recordings capped and limited to the last five.
- **Non-interfering.** The overlay and panel are raw DOM (no Solid), so they never appear in their own event stream, never take focus, and never shift layout. Query instrumentation is a cache subscription — no query behaviour changes.
- **Hooks, not guesses.** Solid instrumentation uses `DEV.hooks.afterCreateOwner`/`afterUpdate` from Solid's development build and chains any hook already installed (e.g. `solid-devtools`); in a production Solid build it becomes a no-op and says so.

## Reading a Suspense flip

The bug class this was built for: a tracked `query.data` read under `<Suspense>` flips the boundary to its fallback and back within a couple of milliseconds, detaching the live surface — `scrollTop` resets to 0 and focus drops to `<body>` with no component cleanup. It reads as:

```
dom.detach    <ChatFeed> section[data-testid=chat] scrollers=1 had focus
dom.reattach  <ChatFeed> section[data-testid=chat] gap=2.1ms SCROLL RESET 1834→0 FOCUS LOST (Suspense in chain)
focus.lost    textarea — element removed from document
```

`solid-pulse tail kinds=dom.reattach,focus.lost` while a scroll harness runs turns days of frame-by-frame probing into a one-line alarm.

## solid-grab

With a supported [`solid-grab`](https://github.com/omniaura/solid-grab) runtime initialized, the panel automatically adds a **Solid Grab** tab with Pick/Cancel and selector inspection. Its separate badge is hidden while hosted and restored on panel teardown. `grab.status`, `grab.pick on=true`, and `grab.inspect selector=button` expose the same controls to agents. Existing `inspect.element` and held-key picking remain available. Older Grab runtimes still contribute source context to `inspect.element`, but need an upgrade for the hosted picker.

MIT © omniaura
