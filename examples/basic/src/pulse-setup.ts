// Imported by the solid-pulse Vite plugin (dev only) before the app entry runs.
import type { Pulse } from "@omniaura/solid-pulse";
import { attachQueryClient } from "@omniaura/solid-pulse/query";
import { attachScenarioCommands } from "@omniaura/scenario-sim/pulse";
import { queryClient } from "./queryClient";

export default function setup(pulse: Pulse) {
  attachQueryClient(pulse, queryClient);
  attachScenarioCommands(pulse, { kind: "remote", controlUrl: `${location.origin}/__sim` });
}
