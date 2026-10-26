// Imported by the solid-pulse Vite plugin (dev only) before the app entry runs.
import type { Pulse } from "@omniaura/solid-pulse";
import { mountPanel } from "@omniaura/solid-pulse/panel";
import { tanstackQueryTab } from "@omniaura/solid-pulse/tanstack";
import { attachQueryClient } from "@omniaura/solid-pulse/query";
import { attachScenarioCommands } from "@omniaura/scenario-sim/pulse";
import { queryClient } from "./queryClient";

export default function setup(pulse: Pulse) {
  attachQueryClient(pulse, queryClient);
  mountPanel(pulse, { queryDevtools: tanstackQueryTab({
    client: queryClient,
    load: async () => {
      const [{ SolidQueryDevtoolsPanel }, { render }] = await Promise.all([
        import("@tanstack/solid-query-devtools"), import("@solidjs/web"),
      ]);
      return { Panel: () => SolidQueryDevtoolsPanel({ client: queryClient }), render };
    },
  }) });
  attachScenarioCommands(pulse, { kind: "remote", controlUrl: `${location.origin}/__sim` });
}
