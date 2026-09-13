/**
 * Bridge protocol (JSON over WebSocket) between a page runtime and the bridge
 * server, and the HTTP shape the server exposes to CLIs and agents.
 *
 * Page → server
 *   hello      first frame; identifies the tab
 *   events     batched PulseEvents (≤ 50 ms coalescing)
 *   result     reply to a `command`
 * Server → page
 *   command    run a controller command; page answers with `result`
 *   welcome    ack of hello with the server-assigned client id
 */

import type { PulseEvent } from "./events.js";
import type { CommandResult, CommandSpec } from "./controller.js";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PATH = "/__pulse";

export interface HelloFrame {
  type: "hello";
  protocol: number;
  clientId: string;
  url: string;
  title: string;
  userAgent: string;
  commands: CommandSpec[];
  startedWall: number;
}

export interface EventsFrame {
  type: "events";
  events: PulseEvent[];
}

export interface ResultFrame {
  type: "result";
  id: string;
  result: CommandResult;
}

export interface CommandFrame {
  type: "command";
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface WelcomeFrame {
  type: "welcome";
  clientId: string;
  protocol: number;
}

export type PageFrame = HelloFrame | EventsFrame | ResultFrame;
export type ServerFrame = CommandFrame | WelcomeFrame;

export interface ClientSummary {
  clientId: string;
  url: string;
  title: string;
  userAgent: string;
  connectedWall: number;
  lastSeenWall: number;
  events: number;
  commands: number;
}

export function isPageFrame(value: unknown): value is PageFrame {
  if (!value || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  return t === "hello" || t === "events" || t === "result";
}

export function isServerFrame(value: unknown): value is ServerFrame {
  if (!value || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  return t === "command" || t === "welcome";
}
