/**
 * @omniaura/scenario-sim/server — run a Simulator as its own HTTP server
 * (Node or Bun; WebSocket upgrades via `ws`).
 *
 *   import { serveSimulator } from "@omniaura/scenario-sim/server";
 *   const { url } = await serveSimulator(sim, { port: 4100 });
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { isUpgraded, upgradedResponse, type Simulator, type UpgradeHook } from "./core/engine.js";
import type { SocketTransport } from "./core/streams.js";

export function toWebRequest(req: IncomingMessage, base: string): Request {
  const url = new URL(req.url ?? "/", base);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  // Mirror hop-by-hop upgrade headers into names a browser-grade Request keeps.
  if (req.headers.upgrade) headers.set("x-sim-upgrade", String(req.headers.upgrade));
  if (req.headers["sec-websocket-protocol"]) headers.set("x-sim-websocket-protocol", String(req.headers["sec-websocket-protocol"]));
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody
    ? new ReadableStream<Uint8Array>({
        start(ctl) {
          req.on("data", (c: Buffer) => ctl.enqueue(new Uint8Array(c)));
          req.on("end", () => ctl.close());
          req.on("error", (e) => ctl.error(e));
        },
      })
    : null;
  return new Request(url, { method, headers, body, ...(body ? { duplex: "half" } : {}) } as RequestInit);
}

export async function sendWebResponse(res: ServerResponse, response: Response) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => {
    if (k === "set-cookie") headers[k] = [...(Array.isArray(headers[k]) ? (headers[k] as string[]) : []), v];
    else headers[k] = v;
  });
  res.writeHead(response.status, response.statusText, headers);
  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  const pump = async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
      if (typeof (res as unknown as { flush?: () => void }).flush === "function") (res as unknown as { flush: () => void }).flush();
    }
    res.end();
  };
  res.on("close", () => void reader.cancel().catch(() => {}));
  await pump().catch(() => res.end());
}

/**
 * Wire WebSocket upgrades on an http server to the simulator's ws routes.
 * Returns the UpgradeHook to pass into `sim.handle(request, { upgrade })`.
 */
export function attachWebSockets(sim: Simulator, server: HttpServer, opts: { base: () => string; match?: (pathname: string) => boolean } = { base: () => "http://localhost" }) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (pendingProtocol ?? [...protocols][0] ?? false) as string | false });
  let pendingProtocol: string | null = null;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", opts.base());
    if (opts.match && !opts.match(url.pathname)) return;
    const request = toWebRequest(req, opts.base());
    const upgrade: UpgradeHook = (route, ctx, run, protocol) =>
      new Promise<Response>((resolve) => {
        pendingProtocol = protocol;
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          pendingProtocol = null;
          const transport: SocketTransport = {
            send: (data) => ws.readyState === ws.OPEN && ws.send(data),
            close: (code, reason) => ws.close(code, reason),
            drop: () => ws.terminate(),
          };
          const sock = run.streams.openSocket(route, ctx, transport, protocol);
          ws.on("message", (data, isBinary) => run.streams.receive(route, ctx, sock, isBinary ? new Uint8Array(data as Buffer).buffer : data.toString()));
          ws.on("close", (code, reason) => run.streams.clientClosed(route, ctx, sock, code, reason.toString()));
          resolve(upgradedResponse());
        });
      });
    void sim.handle(request, { upgrade }).then((response) => {
      if (!isUpgraded(response)) {
        socket.write(`HTTP/1.1 ${response.status} ${response.statusText || "Error"}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n`);
        void response.text().then((t) => {
          socket.write(t);
          socket.destroy();
        });
      }
    });
  });
  return wss;
}

export interface ServeOptions {
  port?: number;
  host?: string;
  log?: (line: string) => void;
}

export async function serveSimulator(sim: Simulator, options: ServeOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  let base = `http://${host}:${options.port ?? 0}`;
  const server = createServer((req, res) => {
    void sim.handle(toWebRequest(req, base)).then((response) => sendWebResponse(res, response));
  });
  const wss = attachWebSockets(sim, server, { base: () => base });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : (options.port ?? 0));
    });
  });
  base = `http://${host}:${port}`;
  options.log?.(`[scenario-sim] listening at ${base}  control: ${base}${sim.controlPath}/status`);
  return {
    server,
    port,
    url: base,
    controlUrl: `${base}${sim.controlPath}`,
    close: () =>
      new Promise<void>((resolve) => {
        sim.dispose();
        for (const client of wss.clients) client.terminate();
        wss.close();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        server.close(finish);
        // Keep-alive HTTP connections would otherwise hold `close` open until they idle out.
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        setTimeout(finish, 500).unref?.();
      }),
  };
}
