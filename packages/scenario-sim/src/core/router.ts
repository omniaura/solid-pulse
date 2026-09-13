/**
 * HTTP routing on Web `Request`/`Response`, so the same scenario runs on a
 * Bun/Node server, inside Vite's dev server, or entirely in the browser.
 */

import type { Rng } from "./rng.js";
import type { VirtualClock } from "./clock.js";
import type { Store } from "./store.js";
import type { StreamHub } from "./streams.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "*";

export interface RouteContext {
  request: Request;
  url: URL;
  method: string;
  /** `:name` captures. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body (or `{}` when absent/invalid). */
  body<T = Record<string, unknown>>(): Promise<T>;
  state: Store;
  rng: Rng;
  clock: VirtualClock;
  streams: StreamHub;
  /** Run id and scenario name, for logging or per-run behaviour. */
  run: { id: string; scenario: string; seed: string };
  /** Per-route call counter (1-based) — handy for "fail on the 3rd call". */
  calls: number;
  log(message: string, data?: unknown): void;
}

export type Handler = (ctx: RouteContext) => Response | Promise<Response>;

export interface Route {
  method: Method;
  path: string;
  handler: Handler;
  /** Optional label for logs and the control plane. */
  name?: string;
}

export interface CompiledRoute extends Route {
  match: (pathname: string) => Record<string, string> | null;
  calls: number;
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

export function json(body: unknown, init: ResponseInit & { status?: number } = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { ...init, status: init.status ?? 200, headers: { ...JSON_HEADERS, ...(init.headers as Record<string, string> | undefined) } });
}

export function text(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { ...init, headers: { "content-type": "text/plain; charset=utf-8", ...(init.headers as Record<string, string> | undefined) } });
}

export function empty(status = 204, init: ResponseInit = {}): Response {
  return new Response(null, { ...init, status });
}

/** RFC 9457 problem details, the shape most APIs use for errors. */
export function problem(status: number, detail: string, extra: Record<string, unknown> = {}): Response {
  return json({ type: "about:blank", title: statusText(status), status, detail, ...extra }, { status, headers: { "content-type": "application/problem+json" } });
}

export type MalformedKind = "invalid-json" | "wrong-content-type" | "truncated" | "empty-200" | "html-500" | "schema-drift";

/** Deliberately broken responses for exercising client validation paths. */
export function malformed(kind: MalformedKind, extra?: unknown): Response {
  switch (kind) {
    case "invalid-json":
      return new Response('{"items": [1, 2,', { status: 200, headers: JSON_HEADERS });
    case "wrong-content-type":
      return new Response(JSON.stringify(extra ?? { ok: true }), { status: 200, headers: { "content-type": "text/html" } });
    case "truncated":
      return new Response(JSON.stringify(extra ?? { items: [{ id: "a" }] }).slice(0, -6), { status: 200, headers: JSON_HEADERS });
    case "empty-200":
      return new Response("", { status: 200, headers: JSON_HEADERS });
    case "html-500":
      return new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status: 502, headers: { "content-type": "text/html" } });
    case "schema-drift":
      return json(extra ?? { data: { items: "not-an-array" }, meta: null });
  }
}

/**
 * Cycle through responses call by call: `sequence([ok, fail, ok])` answers
 * ok, fail, ok, then repeats the last unless `loop` is set. Each entry may be a
 * Response factory or a handler.
 */
export function sequence(steps: Array<Handler | Response>, opts: { loop?: boolean } = {}): Handler {
  let i = 0;
  return async (ctx) => {
    const idx = opts.loop ? i % steps.length : Math.min(i, steps.length - 1);
    i++;
    const step = steps[idx]!;
    if (step instanceof Response) return step.clone();
    return step(ctx);
  };
}

/** Wrap a handler so it answers after `ms` virtual milliseconds. */
export function delayed(ms: number | ((ctx: RouteContext) => number), handler: Handler): Handler {
  return async (ctx) => {
    await ctx.clock.sleep(typeof ms === "function" ? ms(ctx) : ms, `delay ${ctx.method} ${ctx.url.pathname}`);
    return handler(ctx);
  };
}

export function compileRoute(route: Route): CompiledRoute {
  const keys: string[] = [];
  const pattern = route.path
    .split("/")
    .map((seg) => {
      if (seg === "*") return "(?:.*)";
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  const re = new RegExp(`^${pattern}/?$`);
  return {
    ...route,
    calls: 0,
    match(pathname) {
      const m = re.exec(pathname);
      if (!m) return null;
      const params: Record<string, string> = {};
      keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
      return params;
    },
  };
}

export function statusText(status: number): string {
  return (
    {
      400: "Bad Request",
      401: "Unauthorized",
      402: "Payment Required",
      403: "Forbidden",
      404: "Not Found",
      409: "Conflict",
      422: "Unprocessable Content",
      429: "Too Many Requests",
      500: "Internal Server Error",
      502: "Bad Gateway",
      503: "Service Unavailable",
      504: "Gateway Timeout",
    }[status] ?? "Error"
  );
}

/** Route helpers so scenario files read like a table. */
export const route = {
  get: (path: string, handler: Handler, name?: string): Route => ({ method: "GET", path, handler, name }),
  post: (path: string, handler: Handler, name?: string): Route => ({ method: "POST", path, handler, name }),
  put: (path: string, handler: Handler, name?: string): Route => ({ method: "PUT", path, handler, name }),
  patch: (path: string, handler: Handler, name?: string): Route => ({ method: "PATCH", path, handler, name }),
  delete: (path: string, handler: Handler, name?: string): Route => ({ method: "DELETE", path, handler, name }),
  any: (path: string, handler: Handler, name?: string): Route => ({ method: "*", path, handler, name }),
};

/**
 * A full CRUD resource in one line:
 *   crud("/api/notes", "notes", { create: (body, ctx) => ({ id: ctx.rng.id("note"), ...body }) })
 * Emits store events on every mutation, which stream routes can forward.
 */
export function crud<T extends Record<string, unknown> & { id: string }>(
  path: string,
  collection: string,
  opts: {
    create: (body: Record<string, unknown>, ctx: RouteContext) => T;
    update?: (current: T, body: Record<string, unknown>, ctx: RouteContext) => T;
    list?: (items: T[], ctx: RouteContext) => unknown;
    sort?: (a: T, b: T) => number;
    validate?: (body: Record<string, unknown>, ctx: RouteContext) => string | null;
  },
): Route[] {
  const wrap = opts.list ?? ((items: T[]) => ({ items }));
  return [
    route.get(path, (ctx) => json(wrap(ctx.state.list<T>(collection, { sort: opts.sort }), ctx)), `${collection}.list`),
    route.post(path, async (ctx) => {
      const body = await ctx.body();
      const invalid = opts.validate?.(body, ctx);
      if (invalid) return problem(422, invalid);
      const record = opts.create(body, ctx);
      ctx.state.insert(collection, record);
      return json(record, { status: 201 });
    }, `${collection}.create`),
    route.get(`${path}/:id`, (ctx) => {
      const rec = ctx.state.get<T>(collection, ctx.params.id!);
      return rec ? json(rec) : problem(404, `${collection} ${ctx.params.id} not found`);
    }, `${collection}.read`),
    route.patch(`${path}/:id`, async (ctx) => {
      const body = await ctx.body();
      const invalid = opts.validate?.(body, ctx);
      if (invalid) return problem(422, invalid);
      const next = ctx.state.update<T>(collection, ctx.params.id!, (cur) => (opts.update ? opts.update(cur, body, ctx) : ({ ...cur, ...body, id: cur.id } as T)));
      return next ? json(next) : problem(404, `${collection} ${ctx.params.id} not found`);
    }, `${collection}.update`),
    route.put(`${path}/:id`, async (ctx) => {
      const body = await ctx.body();
      const invalid = opts.validate?.(body, ctx);
      if (invalid) return problem(422, invalid);
      const next = ctx.state.update<T>(collection, ctx.params.id!, (cur) => (opts.update ? opts.update(cur, body, ctx) : ({ ...cur, ...body, id: cur.id } as T)));
      return next ? json(next) : problem(404, `${collection} ${ctx.params.id} not found`);
    }, `${collection}.replace`),
    route.delete(`${path}/:id`, (ctx) => {
      const removed = ctx.state.remove(collection, ctx.params.id!);
      return removed ? empty(204) : problem(404, `${collection} ${ctx.params.id} not found`);
    }, `${collection}.delete`),
  ];
}
