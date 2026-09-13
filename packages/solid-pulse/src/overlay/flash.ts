/**
 * Visual layer. One fixed, pointer-events:none container holds every flash
 * rectangle and badge, so the overlay can never shift layout, take focus or
 * intercept input. Everything is plain DOM (no Solid) so it produces no
 * reactive events of its own and works with any Solid version.
 */

import type { Rect } from "../core/events.js";

export type FlashKind = "dom" | "mount" | "reattach" | "query" | "highlight";

const COLORS: Record<FlashKind, string> = {
  dom: "245,158,11",
  mount: "34,197,94",
  reattach: "239,68,68",
  query: "59,130,246",
  highlight: "168,85,247",
};

export const OWN_ATTR = "data-solid-pulse";

const MAX_LIVE_RECTS = 48;
const MAX_LIVE_BADGES = 4;

export class FlashOverlay {
  /** The fixed host element in the document (carries data-solid-pulse). */
  private host: HTMLDivElement | null = null;
  /** Everything visible lives in the host's shadow root. */
  private root: HTMLDivElement | null = null;
  private live = 0;
  private badges = 0;
  private reduced = false;

  /**
   * The overlay must be inert to the page it observes. Rectangles and badges
   * render inside a shadow root on a fixed, pointer-events:none host and fade
   * with the Web Animations API — so no global stylesheet is inserted, no CSS
   * animation events bubble into the document, and the page's own
   * MutationObservers (or an automation harness's stability checks) never see
   * our nodes come and go. Measured: CSS-keyframe flashes appended to <body>
   * made a Kobalte dropdown item read as "not stable" to Playwright.
   */
  mount() {
    if (this.host || typeof document === "undefined") return;
    const host = document.createElement("div");
    host.setAttribute(OWN_ATTR, "overlay");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483646;contain:strict;overflow:hidden;";
    const shadow = host.attachShadow({ mode: "open" });
    const root = document.createElement("div");
    root.style.cssText =
      "position:absolute;inset:0;pointer-events:none;overflow:hidden;font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;";
    shadow.appendChild(root);
    (document.body ?? document.documentElement).appendChild(host);
    this.host = host;
    this.root = root;
    try {
      this.reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    } catch {
      this.reduced = false;
    }
  }

  unmount() {
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.live = 0;
    this.badges = 0;
  }

  get mounted() {
    return this.host !== null;
  }

  /** Live overlay nodes (for tests/inspection): rects + badges inside the shadow root. */
  get liveNodes(): number {
    return this.root ? this.root.childElementCount : 0;
  }

  private fade(el: HTMLElement, ms: number, keyframes: Keyframe[]) {
    const done = () => {
      el.remove();
    };
    if (typeof el.animate === "function") {
      const anim = el.animate(keyframes, { duration: ms, easing: "ease-out", fill: "forwards" });
      anim.onfinish = done;
      anim.oncancel = done;
      // Belt and braces for hosts whose animations never finish (hidden tabs).
      setTimeout(done, ms + 250);
    } else {
      setTimeout(done, ms);
    }
  }

  /** Flash rectangles in viewport coordinates. Drops extras beyond the live cap. */
  flash(rects: readonly Rect[], kind: FlashKind, opts: { ms?: number; label?: string } = {}) {
    if (!this.root) return 0;
    const ms = this.reduced ? Math.min(opts.ms ?? 600, 250) : (opts.ms ?? 600);
    const color = COLORS[kind];
    let drawn = 0;
    for (const r of rects) {
      if (this.live >= MAX_LIVE_RECTS) break;
      if (r.w <= 0 || r.h <= 0) continue;
      const el = document.createElement("div");
      el.setAttribute(OWN_ATTR, "rect");
      el.style.cssText = `position:absolute;box-sizing:border-box;border-radius:3px;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:rgba(${color},.18);border:2px solid rgba(${color},.9);opacity:.85`;
      if (opts.label && drawn === 0) {
        const tag = document.createElement("span");
        tag.textContent = opts.label;
        tag.style.cssText = `position:absolute;left:-2px;top:-18px;padding:1px 5px;border-radius:3px;color:#fff;background:rgba(${color},.95);font-size:10px;white-space:nowrap`;
        el.appendChild(tag);
      }
      this.root.appendChild(el);
      this.live++;
      drawn++;
      const release = () => {
        this.live--;
      };
      this.fade(el, ms, [{ opacity: 0.85 }, { opacity: 0 }]);
      setTimeout(release, ms + 20);
    }
    return drawn;
  }

  /**
   * Transient badge centred on `at` (or the viewport when null). Used for the
   * Solid Query overlay: "<Component> observing ['todos', 1]".
   */
  badge(html: { title: string; body?: string }, at: Rect | null, opts: { ms?: number; kind?: FlashKind } = {}) {
    if (!this.root) return false;
    if (this.badges >= MAX_LIVE_BADGES) return false;
    const ms = this.reduced ? Math.min(opts.ms ?? 1200, 600) : (opts.ms ?? 1200);
    const color = COLORS[opts.kind ?? "query"];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = at ? Math.min(Math.max(at.x + at.w / 2, 80), vw - 80) : vw / 2;
    const cy = at ? Math.min(Math.max(at.y + at.h / 2, 30), vh - 30) : vh / 2;
    const el = document.createElement("div");
    el.setAttribute(OWN_ATTR, "badge");
    el.style.cssText = `position:absolute;left:${cx}px;top:${cy + this.badges * 34}px;transform:translate(-50%,-50%);max-width:min(60vw,560px);padding:6px 10px;border-radius:8px;color:#fff;background:rgba(17,24,39,.92);box-shadow:0 4px 18px rgba(0,0,0,.35);white-space:pre-wrap;word-break:break-all;border-left:4px solid rgb(${color});opacity:1`;
    const b = document.createElement("b");
    b.style.fontWeight = "600";
    b.textContent = html.title;
    el.appendChild(b);
    if (html.body) {
      el.appendChild(document.createElement("br"));
      el.appendChild(document.createTextNode(html.body));
    }
    this.root.appendChild(el);
    this.badges++;
    this.fade(el, ms, [
      { opacity: 0, transform: "translate(-50%,-50%) scale(.96)", offset: 0 },
      { opacity: 1, transform: "translate(-50%,-50%) scale(1)", offset: 0.12 },
      { opacity: 1, offset: 0.75 },
      { opacity: 0, offset: 1 },
    ]);
    setTimeout(() => {
      this.badges--;
    }, ms + 20);
    return true;
  }
}
