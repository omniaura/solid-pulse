/**
 * Fault layer: latency (+ seeded jitter), fail modes and per-endpoint
 * overrides. Overrides are checked before routing, so a test can force any
 * endpoint — even one the scenario never defined — to answer with a given
 * status/body, once (`times`) or until cleared — the classic in-bundle mock
 * "endpoint override" contract, generalised.
 */

import type { Rng } from "./rng.js";
import { json, malformed, type MalformedKind, problem } from "./router.js";

export type FailMode = "off" | "data" | "all";

export interface OverrideInput {
  /** Substring of the path, or `{ regex, flags }`. */
  matcher: string | { regex: string; flags?: string };
  method?: string;
  status?: number;
  body?: unknown;
  /** Auto-expire after N matches. */
  times?: number;
  delayMs?: number;
  malformed?: MalformedKind;
  name?: string;
}

export interface Override extends OverrideInput {
  id: string;
  remaining: number;
  hits: number;
}

export interface FaultSnapshot {
  latencyMs: number;
  jitterMs: number;
  failMode: FailMode;
  shellPaths: string[];
  overrides: Override[];
}

export class FaultLayer {
  latencyMs = 0;
  jitterMs = 0;
  failMode: FailMode = "off";
  /** Paths the `data` fail mode leaves alone so the app shell still boots. */
  shellPaths = new Set<string>();
  private overrides: Override[] = [];
  private nextId = 1;

  constructor(private rng: Rng) {}

  configure(patch: Partial<{ latencyMs: number; jitterMs: number; failMode: FailMode; shellPaths: string[] }>) {
    if (patch.latencyMs !== undefined) this.latencyMs = Math.max(0, patch.latencyMs);
    if (patch.jitterMs !== undefined) this.jitterMs = Math.max(0, patch.jitterMs);
    if (patch.failMode !== undefined) this.failMode = patch.failMode;
    if (patch.shellPaths !== undefined) this.shellPaths = new Set(patch.shellPaths);
  }

  /** Effective delay for one request (seeded jitter keeps it reproducible). */
  delayFor(extra = 0): number {
    const jitter = this.jitterMs > 0 ? this.rng.int(0, this.jitterMs) : 0;
    return this.latencyMs + jitter + extra;
  }

  setOverride(input: OverrideInput): Override {
    const key = matcherKey(input.matcher, input.method);
    this.overrides = this.overrides.filter((o) => matcherKey(o.matcher, o.method) !== key);
    const o: Override = { ...input, id: `ov_${this.nextId++}`, remaining: input.times ?? Infinity, hits: 0 };
    this.overrides.unshift(o);
    return o;
  }

  clearOverride(target: string | OverrideInput["matcher"], method?: string): boolean {
    const before = this.overrides.length;
    this.overrides = this.overrides.filter((o) => o.id !== target && matcherKey(o.matcher, o.method) !== matcherKey(target as OverrideInput["matcher"], method));
    return this.overrides.length !== before;
  }

  clearOverrides() {
    this.overrides = [];
  }

  listOverrides(): Override[] {
    return this.overrides.map((o) => ({ ...o }));
  }

  /** Find (and consume) the first matching override. */
  matchOverride(path: string, method: string): Override | null {
    for (const o of this.overrides) {
      if (o.method && o.method.toUpperCase() !== method.toUpperCase()) continue;
      const hit = typeof o.matcher === "string" ? path.includes(o.matcher) : new RegExp(o.matcher.regex, o.matcher.flags).test(path);
      if (!hit) continue;
      o.hits++;
      o.remaining--;
      if (o.remaining <= 0) this.overrides = this.overrides.filter((x) => x !== o);
      return o;
    }
    return null;
  }

  /** Build the response an override dictates. */
  overrideResponse(o: Override): Response {
    if (o.malformed) return malformed(o.malformed, o.body);
    const status = o.status ?? 500;
    if (status === 204 || (o.body === undefined && status >= 200 && status < 300)) return new Response(null, { status });
    if (o.body === undefined) return problem(status, `forced by override ${o.id}`);
    return json(o.body, { status });
  }

  /** Fail-mode response, or null when the request should proceed. */
  failResponse(path: string): Response | null {
    if (this.failMode === "off") return null;
    if (this.failMode === "data" && this.shellPaths.has(path)) return null;
    return problem(503, `scenario fail mode "${this.failMode}"`);
  }

  snapshot(): FaultSnapshot {
    return { latencyMs: this.latencyMs, jitterMs: this.jitterMs, failMode: this.failMode, shellPaths: [...this.shellPaths], overrides: this.listOverrides() };
  }
}

function matcherKey(matcher: OverrideInput["matcher"], method?: string) {
  const m = typeof matcher === "string" ? `str:${matcher}` : `re:${matcher.regex}:${matcher.flags ?? ""}`;
  return `${(method ?? "*").toUpperCase()} ${m}`;
}
