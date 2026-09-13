import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import solidPulse from "@omniaura/solid-pulse/vite";
import scenarioSim from "@omniaura/scenario-sim/vite";

export default defineConfig({
  plugins: [
    // dev only; the production build below must contain neither.
    solidPulse({ setupModule: "/src/pulse-setup.ts" }),
    scenarioSim({ scenarios: () => import("@omniaura/scenario-sim/examples"), match: (p) => p.startsWith("/api/") }),
    solid(),
  ],
  server: { port: 5199, strictPort: true },
  build: { outDir: "dist" },
});
