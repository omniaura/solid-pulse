// Imported by the solid-pulse Vite plugin right after initPulse (dev only).
import { attachQueryClient } from "@omniaura/solid-pulse/query";
import { attachScenarioCommands } from "@omniaura/scenario-sim/pulse";
import { queryClient } from "./queryClient";

const pulse = window.__SOLID_PULSE__!;
attachQueryClient(pulse, queryClient);
attachScenarioCommands(pulse, { kind: "remote", controlUrl: `${location.origin}/__sim` });
