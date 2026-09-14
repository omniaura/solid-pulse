/**
 * Bridge protocol (JSON over WebSocket) between a page runtime and the bridge
 * server, and the HTTP shape the server exposes to CLIs and agents.
 *
 * Page → server
 *   hello      first frame; identifies the tab
 *   commands   replaces the tab's command contract after late register/unregister
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
  dropped?: number;
}

export interface CommandsFrame {
  type: "commands";
  commands: CommandSpec[];
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

export type PageFrame = HelloFrame | CommandsFrame | EventsFrame | ResultFrame;
export type ServerFrame = CommandFrame | WelcomeFrame;

export interface ClientSummary {
  dropped?: number;
  clientId: string;
  url: string;
  title: string;
  userAgent: string;
  connectedWall: number;
  lastSeenWall: number;
  events: number;
  commands: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCommandSpec(value: unknown): value is CommandSpec {
  if (!isRecord(value)) return false;
  if (typeof value.name !== "string" || value.name.length === 0) return false;
  if (typeof value.summary !== "string") return false;
  if (value.ui !== undefined && typeof value.ui !== "string") return false;
  if (value.args !== undefined) {
    if (!isRecord(value.args)) return false;
    for (const v of Object.values(value.args)) if (typeof v !== "string") return false;
  }
  return true;
}

function isCommandSpecs(value: unknown): value is CommandSpec[] {
  return Array.isArray(value) && value.every(isCommandSpec);
}

export function isPageFrame(value: unknown): value is PageFrame {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "hello":
      return (
        typeof value.protocol === "number" &&
        typeof value.clientId === "string" &&
        typeof value.url === "string" &&
        typeof value.title === "string" &&
        typeof value.userAgent === "string" &&
        typeof value.startedWall === "number" &&
        isCommandSpecs(value.commands)
      );
    case "commands":
      return isCommandSpecs(value.commands);
    case "events":
      return Array.isArray(value.events);
    case "result":
      return typeof value.id === "string" && isRecord(value.result);
    default:
      return false;
  }
}

export function isServerFrame(value: unknown): value is ServerFrame {
  if (!value || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  return t === "command" || t === "welcome";
}
