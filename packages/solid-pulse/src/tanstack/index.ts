/**
 * @omniaura/solid-pulse/tanstack — the combined devtools panel: solid-pulse's
 * tabs (Pulse, Query, Grab, Scenarios, Record) plus TanStack's own Solid Query
 * devtools rendered as a tab of the same drawer. One panel, one hotkey, one
 * CLI (`solid-pulse panel.open tab=tanstack`).
 *
 *   import { mountPanel } from "@omniaura/solid-pulse/panel";
 *   import { tanstackQueryTab } from "@omniaura/solid-pulse/tanstack";
 *   mountPanel(pulse, { tabs: [tanstackQueryTab({ client: queryClient })] });
 *
 * `@tanstack/solid-query-devtools` and `solid-js/web` are optional peers; they
 * are loaded lazily on first open so apps that never open the tab pay nothing.
 * Pass `load` to supply them yourself (or a test double).
 */

import type { PanelTab } from "../panel/index.js";
import type { Pulse } from "../index.js";

export interface TanstackTabDeps {
  /** `SolidQueryDevtoolsPanel` from @tanstack/solid-query-devtools (or a compatible component). */
  Panel: (props: { client: unknown } & Record<string, unknown>) => unknown;
  /** `render` from solid-js/web. */
  render: (code: () => unknown, el: Element) => () => void;
}

export interface TanstackQueryTabOptions {
  /** The app's QueryClient (@tanstack/solid-query or query-core). */
  client: unknown;
  id?: string;
  title?: string;
  /** Minimum height for the embedded devtools (default 260px). */
  minHeight?: string;
  /** Extra props forwarded to SolidQueryDevtoolsPanel. */
  panelProps?: Record<string, unknown>;
  /** Supply the peer modules explicitly (tests, or bundlers that dislike dynamic imports). */
  load?: () => Promise<TanstackTabDeps>;
}

async function defaultLoad(): Promise<TanstackTabDeps> {
  // Peer modules are resolved by the consumer's bundler; the strings are kept
  // opaque so this package builds without them installed.
  const devtoolsId = "@tanstack/solid-query-devtools";
  const webId = "solid-js/web";
  const [devtools, web] = await Promise.all([import(/* @vite-ignore */ devtoolsId), import(/* @vite-ignore */ webId)]);
  const Panel = (devtools as { SolidQueryDevtoolsPanel?: TanstackTabDeps["Panel"] }).SolidQueryDevtoolsPanel;
  const render = (web as { render?: TanstackTabDeps["render"] }).render;
  if (!Panel || !render) throw new Error("@tanstack/solid-query-devtools and solid-js/web are required for the TanStack tab");
  return { Panel, render };
}

export function tanstackQueryTab(options: TanstackQueryTabOptions): PanelTab {
  const { client, id = "tanstack", title = "TanStack", minHeight = "260px", panelProps = {}, load = defaultLoad } = options;
  return {
    id,
    title,
    mount(el: HTMLElement, _pulse: Pulse) {
      el.style.minHeight = minHeight;
      const status = document.createElement("div");
      status.setAttribute("data-tanstack-status", "loading");
      status.textContent = "Loading TanStack Query devtools…";
      el.append(status);
      let dispose: (() => void) | null = null;
      let cancelled = false;
      void load()
        .then(({ Panel, render }) => {
          if (cancelled) return;
          status.remove();
          dispose = render(() => Panel({ client, ...panelProps }), el);
        })
        .catch((err: unknown) => {
          status.setAttribute("data-tanstack-status", "error");
          status.textContent = `TanStack devtools unavailable: ${err instanceof Error ? err.message : String(err)}`;
        });
      return () => {
        cancelled = true;
        dispose?.();
      };
    },
  };
}
