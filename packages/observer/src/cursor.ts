// SPDX-License-Identifier: MIT
import type {ClearActOperation} from "@clearact/core";
import {cursorDuration, cursorPoint, type CursorPoint} from "./cursor-motion.ts";

export const cursorStyles = `
 .cursor,.target-glow,.action-frame{position:fixed;pointer-events:none}
 .cursor{left:0;top:0;width:24px;height:32px;z-index:3;filter:drop-shadow(0 2px 2px #070e1c38);will-change:transform,opacity;opacity:1}
 .cursor.fading{opacity:0;transition:opacity 300ms ease-out}
 .cursor svg{display:block;overflow:visible;transform:translate(-2px,-1.5px)}.cursor[hidden],.target-glow[hidden],.action-frame[hidden]{display:none}
 .target-glow{left:0;top:0;width:42px;height:42px;border:2px solid #3b82f6;border-radius:50%;box-shadow:0 0 0 5px #60a5fa22,0 0 18px #60a5fa55;z-index:2}
 .action-frame{inset:0;border:3px solid #3b82f6;box-shadow:inset 0 0 20px #3b82f633;z-index:1}
`;

/** A single visual owner; overlapping operations keep their independent business timing. */
export class ClearActCursor {
  private readonly element: HTMLDivElement;
  private readonly glow: HTMLDivElement;
  private owner?: string;
  private frame?: number;
  private generation = 0;
  private position: CursorPoint = {x:72,y:72};
  private releaseWaiting?: () => void;
  private disposed = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private fadeTimer?: ReturnType<typeof setTimeout>;
  private reduced?: MediaQueryList;
  private readonly visibility = () => {if (document.hidden) this.clear();};
  private readonly motion = () => {if (this.reduced?.matches) this.clear();};
  constructor(shadow: ShadowRoot, private readonly resolveTarget: (operation: ClearActOperation) => HTMLElement | null) {
    this.element = document.createElement("div");
    this.element.className = "cursor";
    this.element.dataset.clearactCursor = "true";
    this.element.setAttribute("aria-hidden", "true");
    this.element.hidden = true;
    // Offset the artwork so the arrow tip stays exactly at the tracked target coordinate.
    this.element.innerHTML = `<svg width="24" height="32" viewBox="0 0 24 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 1.5V25.3L8.6 19.2L14.2 30L19.1 27.4L13.5 17.3L22.1 16.1L2 1.5Z" fill="#fff" stroke="#202631" stroke-width="1.25" stroke-linejoin="round"/></svg>`;
    this.glow = document.createElement("div");
    this.glow.className = "target-glow";
    this.glow.setAttribute("aria-hidden", "true");
    this.glow.hidden = true;
    shadow.append(this.glow, this.element);
    // These listeners also cover the retained idle/fading pointer, after preparation ends.
    document.addEventListener("visibilitychange", this.visibility);
    try {
      this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
      this.reduced.addEventListener("change", this.motion);
    } catch { /* An unavailable visual environment simply skips the pointer. */ }
  }
  private targetPoint(operation: ClearActOperation): CursorPoint | null {
    const target = this.resolveTarget(operation);
    if (!target?.isConnected) return null;
    const rect = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    if (!rect.width || !rect.height || !target.getClientRects().length || style.visibility !== "visible" || style.display === "none" || style.opacity === "0") return null;
    if (target.checkVisibility && !target.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
    const point = {x:rect.left + rect.width / 2,y:rect.top + rect.height / 2};
    return Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= innerWidth && point.y >= 0 && point.y <= innerHeight ? point : null;
  }
  private move(point: CursorPoint): void {
    this.position = point;
    this.element.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
  }
  prepare(operation: ClearActOperation, signal: AbortSignal): void | Promise<void> {
    if (this.disposed || this.owner || signal.aborted || document.hidden) return;
    const reduced = this.reduced;
    let target: CursorPoint | null;
    try {
      if (!reduced || reduced.matches || !(target = this.targetPoint(operation))) return;
    } catch { return; }
    this.cancelIdle();
    const from = {...this.position};
    const duration = cursorDuration(from, target);
    const started = performance.now();
    const generation = ++this.generation;
    this.owner = operation.id;
    this.element.dataset.operationId = operation.id;
    this.element.dataset.phase = "preparing";
    this.element.hidden = false;
    this.move(from);
    return new Promise<void>(resolve => {
      let done = false;
      let arrived = false;
      const release = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (this.releaseWaiting === release) this.releaseWaiting = undefined;
        resolve();
      };
      const abort = () => this.clear();
      // rAF can stop advancing in a background tab or a damaged visual environment.
      const timeout = setTimeout(() => {if (generation === this.generation) this.clear();}, 900);
      this.releaseWaiting = release;
      signal.addEventListener("abort", abort, {once:true});
      const tick = (now: number) => {
        if (this.disposed || generation !== this.generation) return;
        try {
          if (signal.aborted || document.hidden || reduced.matches) {this.clear();return;}
          const destination = this.targetPoint(operation);
          if (!destination) {this.clear();return;}
          const progress = Math.min(1, Math.max(0, (now - started) / duration));
          this.move(arrived ? destination : cursorPoint(from, destination, progress));
          if (progress === 1) {
            arrived = true;
            this.glow.style.transform = `translate3d(${destination.x - 21}px, ${destination.y - 21}px, 0)`;
            this.glow.hidden = false;
            release();
          }
          this.frame = requestAnimationFrame(tick);
        } catch {this.clear();}
      };
      try {this.frame = requestAnimationFrame(tick);} catch {this.clear();}
    });
  }
  executing(operation: ClearActOperation): void {
    if (this.owner === operation.id) this.element.dataset.phase = "executing";
  }
  settled(operation: ClearActOperation): void {
    if (this.owner !== operation.id) return;
    this.releaseMotion();
    this.glow.hidden = true;
    this.element.dataset.phase = "idle";
    const generation = this.generation;
    // A completed action releases visual ownership without erasing the last position.
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.disposed || this.owner || generation !== this.generation) return;
      this.element.dataset.phase = "fading";
      this.element.classList.add("fading");
      this.fadeTimer = setTimeout(() => {
        if (generation === this.generation) this.clear();
      }, 300);
    }, 10_000);
  }
  private cancelIdle(): void {
    clearTimeout(this.idleTimer);
    clearTimeout(this.fadeTimer);
    this.idleTimer = undefined;
    this.fadeTimer = undefined;
    // Removing the fade class restores opacity immediately without moving the pointer.
    this.element.classList.remove("fading");
  }
  private releaseMotion(): void {
    ++this.generation;
    if (this.frame !== undefined) {
      try {cancelAnimationFrame(this.frame);} catch { /* Visual cleanup must still release business preparation. */ }
    }
    this.frame = undefined;
    this.owner = undefined;
    this.releaseWaiting?.();
  }
  clear(): void {
    this.cancelIdle();
    this.releaseMotion();
    this.element.hidden = true;
    this.glow.hidden = true;
    delete this.element.dataset.phase;
    delete this.element.dataset.operationId;
  }
  dispose(): void {
    this.disposed = true;
    this.clear();
    document.removeEventListener("visibilitychange", this.visibility);
    this.reduced?.removeEventListener("change", this.motion);
    this.element.remove();
    this.glow.remove();
  }
}
