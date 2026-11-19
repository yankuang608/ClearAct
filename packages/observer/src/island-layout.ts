// SPDX-License-Identifier: MIT
export interface IslandLayoutElements {
  panel: HTMLElement;
  surface: HTMLElement;
  handle: HTMLButtonElement;
  dock: HTMLButtonElement;
  onCollapsedChange?: (collapsed: boolean) => void;
  onLayout?: () => void;
}

type Position = { left: number; top: number };
type Box = Position & { width: number; height: number };
type Drag = Position & { id: number; x: number; y: number; moved: boolean };
type Motion = {
  ghost: HTMLElement;
  path: SVGPathElement;
  content: HTMLElement;
  logo: HTMLElement;
  animations: Animation[];
  focus: boolean;
};
type Snapshot = { box: Box; path: string; textOpacity: number; logoOpacity: number };

const svgNamespace = 'http://www.w3.org/2000/svg';
// Both paths use the same commands so the SVG outline can interpolate continuously.
const openPath = 'M3 0H97 C100 0 100 8 100 20 C100 33 100 47 100 60 C100 84 98 100 95 100 C65 100 35 100 5 100 C2 100 0 84 0 60 C0 40 0 0 3 0Z';
const arcPath = 'M0 0H100 C88.9 0 84.7 7.7 80.6 23.1 C77.1 36.5 72.6 53.8 66.7 69.2 C61.1 84.6 55.6 92.3 50 92.3 C44.4 92.3 38.9 84.6 33.3 69.2 C27.4 53.8 22.9 36.5 19.4 23.1 C15.3 7.7 11.1 0 0 0Z';
const interactive = 'button,input,select,textarea,option,a,label,details,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="slider"],[role="textbox"],[draggable="true"],[data-no-drag]';
let instanceId = 0;

/** Owns presentation and geometry only; Agent state remains in the Observer. */
export class IslandLayout {
  private readonly win: Window & typeof globalThis;
  private readonly doc: Document;
  private readonly prefix = `clearact-lens-${++instanceId}`;
  private readonly outline: SVGSVGElement;
  private readonly removers: Array<() => void> = [];
  private resizeObserver?: ResizeObserver;
  private position?: Position;
  private size = { width: 600, height: 64 };
  private drag?: Drag;
  private motion?: Motion;
  private epoch = 0;
  private isCollapsed = false;
  private disposed = false;

  constructor(private readonly elements: IslandLayoutElements) {
    this.doc = elements.panel.ownerDocument;
    this.win = (this.doc.defaultView ?? window) as Window & typeof globalThis;
    elements.panel.style.position = 'fixed';
    elements.panel.style.translate = 'none';
    elements.dock.classList.add('island-dock');
    elements.dock.type = 'button';
    elements.dock.style.position = 'fixed';
    elements.dock.style.width = '76px';
    elements.dock.style.height = '28px';
    elements.dock.style.top = '0px';
    elements.dock.style.translate = 'none';
    if (!elements.dock.hasAttribute('aria-label')) elements.dock.setAttribute('aria-label', '展开 ClearAct 顶岛');
    this.outline = this.createOutline(`${this.prefix}-dock`, arcPath, 'dock-outline');
    elements.dock.prepend(this.outline);
    this.listen(elements.dock, 'click', () => this.setCollapsed(false, { focus: true }));
    this.listen(elements.surface, 'pointerdown', event => this.pointerDown(event as PointerEvent));
    this.listen(this.win, 'pointermove', event => this.pointerMove(event as PointerEvent));
    this.listen(this.win, 'pointerup', event => this.pointerEnd(event as PointerEvent));
    this.listen(this.win, 'pointercancel', event => this.pointerEnd(event as PointerEvent));
    this.listen(elements.surface, 'lostpointercapture', event => this.pointerEnd(event as PointerEvent));
    this.listen(elements.handle, 'keydown', event => this.keyDown(event as KeyboardEvent));
    this.listen(this.win, 'resize', () => this.viewportResize());
    if (this.win.visualViewport) this.listen(this.win.visualViewport, 'resize', () => this.viewportResize());
    if (typeof this.win.ResizeObserver === 'function') {
      this.resizeObserver = new this.win.ResizeObserver(() => {
        if (!this.disposed && !this.isCollapsed && !this.motion) this.refresh();
      });
      this.resizeObserver.observe(elements.surface);
    }
    this.placeExpanded();
    this.applyView(false);
  }

  get collapsed(): boolean { return this.isCollapsed; }

  setCollapsed(next: boolean, options: { animate?: boolean; focus?: boolean } = {}): void {
    if (this.disposed) return;
    if (next === this.isCollapsed && !this.motion) {
      if (options.focus) this.focusVisible();
      return;
    }
    const snapshot = this.snapshot();
    this.endDrag();
    this.cancelMotion();
    this.measure();
    this.placeExpanded();
    if (next !== this.isCollapsed) {
      this.isCollapsed = next;
      this.elements.onCollapsedChange?.(next);
    }
    this.updateDock();
    const reduced = typeof this.win.matchMedia === 'function'
      && this.win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (options.animate === false || reduced || typeof this.elements.surface.animate !== 'function') {
      this.applyView(!!options.focus);
      return;
    }
    this.startMotion(next, snapshot, !!options.focus);
  }

  /** Reconcile content dimensions without interrupting an in-flight transition. */
  refresh(): void {
    if (this.disposed) return;
    this.measure();
    this.placeExpanded();
    this.updateDock();
    this.elements.onLayout?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endDrag();
    this.cancelMotion();
    this.resizeObserver?.disconnect();
    for (const remove of this.removers) remove();
    this.removers.length = 0;
    this.outline.remove();
  }

  private listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.removers.push(() => target.removeEventListener(type, listener));
  }

  private viewport(): { width: number; height: number } {
    return {
      width: this.win.innerWidth || this.doc.documentElement.clientWidth || 600,
      height: this.win.innerHeight || this.doc.documentElement.clientHeight || 800,
    };
  }

  private measure(): void {
    // A collapsed panel still needs its current responsive width and approval height.
    const panel = this.elements.panel, hidden = panel.hidden, visibility = panel.style.visibility;
    if (hidden) { panel.style.visibility = 'hidden'; panel.hidden = false; }
    const rect = panel.getBoundingClientRect();
    if (rect.width > 0) this.size.width = rect.width;
    if (rect.height > 0) this.size.height = rect.height;
    if (hidden) { panel.hidden = true; panel.style.visibility = visibility; }
  }

  private placeExpanded(position = this.position): void {
    const viewport = this.viewport();
    const width = Math.min(this.size.width, Math.max(0, viewport.width - 28));
    const desired = position ?? { left: (viewport.width - width) / 2, top: 40 };
    this.position = {
      left: Math.max(14, Math.min(desired.left, Math.max(14, viewport.width - width - 14))),
      top: Math.max(16, Math.min(desired.top, Math.max(16, viewport.height - this.size.height - 16))),
    };
    this.elements.panel.style.left = `${this.position.left}px`;
    this.elements.panel.style.top = `${this.position.top}px`;
  }

  private dockBox(): Box {
    return { left: (this.viewport().width - 76) / 2, top: 0, width: 76, height: 28 };
  }

  private updateDock(): void {
    this.elements.dock.style.left = `${this.dockBox().left}px`;
  }

  private applyView(focus: boolean): void {
    const { panel, dock, handle } = this.elements;
    panel.hidden = this.isCollapsed;
    panel.inert = this.isCollapsed;
    panel.dataset.collapsed = String(this.isCollapsed);
    panel.dataset.moving = 'false';
    dock.hidden = !this.isCollapsed;
    dock.inert = !this.isCollapsed;
    dock.setAttribute('aria-expanded', String(!this.isCollapsed));
    handle.setAttribute('aria-expanded', String(!this.isCollapsed));
    this.updateDock();
    this.elements.onLayout?.();
    if (focus) this.focusVisible();
  }

  private focusVisible(): void {
    const target = this.isCollapsed ? this.elements.dock : this.elements.handle;
    try { target.focus({ preventScroll: true }); } catch { target.focus(); }
  }

  private pointerDown(event: PointerEvent): void {
    if (this.disposed || this.isCollapsed || this.motion || event.button !== 0 || event.isPrimary === false) return;
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    if (!this.elements.handle.contains(target) && target.closest(interactive)) return;
    this.measure();
    this.placeExpanded();
    this.drag = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      left: this.position!.left, top: this.position!.top, moved: false,
    };
    try { this.elements.surface.setPointerCapture?.(event.pointerId); } catch { /* The window listeners also cover synthetic events. */ }
  }

  private pointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id || this.disposed) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    this.elements.panel.dataset.dragging = 'true';
    if (event.cancelable) event.preventDefault();
    this.placeExpanded({ left: drag.left + dx, top: drag.top + dy });
    this.elements.onLayout?.();
  }

  private pointerEnd(event: PointerEvent): void {
    if (this.drag?.id === event.pointerId) this.endDrag();
  }

  private endDrag(): void {
    const pointerId = this.drag?.id;
    this.drag = undefined;
    this.elements.panel.dataset.dragging = 'false';
    if (pointerId === undefined) return;
    try {
      if (this.elements.surface.hasPointerCapture?.(pointerId)) this.elements.surface.releasePointerCapture(pointerId);
    } catch { /* Capture may already have been released by the browser. */ }
  }

  private keyDown(event: KeyboardEvent): void {
    if (this.disposed || this.isCollapsed || this.motion || event.altKey || event.ctrlKey || event.metaKey) return;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const distance = event.shiftKey ? 50 : 20;
    this.placeExpanded({ left: this.position!.left + direction[0] * distance, top: this.position!.top + direction[1] * distance });
    this.elements.onLayout?.();
  }

  private viewportResize(): void {
    if (this.disposed) return;
    const focus = this.motion?.focus ?? false;
    this.endDrag();
    this.cancelMotion();
    this.refresh();
    this.applyView(focus);
  }

  private createOutline(prefix: string, path: string, className: string): SVGSVGElement {
    const svg = this.doc.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<defs>
      <linearGradient id="${prefix}-fill" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="var(--lens-tint)" stop-opacity="var(--lens-o1)"/>
        <stop offset=".41" stop-color="var(--lens-tint)" stop-opacity="var(--lens-o2)"/>
        <stop offset=".72" stop-color="var(--lens-edge-dark)" stop-opacity="var(--lens-o3)"/>
        <stop offset="1" stop-color="var(--lens-tint)" stop-opacity="var(--lens-o4)"/>
      </linearGradient>
      <linearGradient id="${prefix}-edge" x1="0" y1="0" x2=".4" y2="1">
        <stop stop-color="var(--lens-edge-light)" stop-opacity="var(--lens-edge-o1)"/>
        <stop offset=".4" stop-color="var(--lens-edge-light)" stop-opacity="var(--lens-edge-o2)"/>
        <stop offset=".7" stop-color="var(--lens-edge-dark)" stop-opacity="var(--lens-edge-o3)"/>
        <stop offset="1" stop-color="var(--lens-edge-light)" stop-opacity="var(--lens-edge-o3)"/>
      </linearGradient>
    </defs><path d="${path}" fill="url(#${prefix}-fill)" stroke="url(#${prefix}-edge)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    return svg;
  }

  private snapshot(): Snapshot | undefined {
    if (!this.motion) return;
    const { ghost, path, content, logo } = this.motion;
    const rect = ghost.getBoundingClientRect();
    const d = this.win.getComputedStyle(path).getPropertyValue('d');
    return {
      box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      path: d && d !== 'none' ? d : `path('${path.getAttribute('d')}')`,
      textOpacity: Number(this.win.getComputedStyle(content).opacity),
      logoOpacity: Number(this.win.getComputedStyle(logo).opacity),
    };
  }

  private cancelMotion(): void {
    this.epoch++;
    const motion = this.motion;
    this.motion = undefined;
    if (!motion) return;
    for (const animation of motion.animations) animation.cancel();
    motion.ghost.remove();
  }

  private startMotion(next: boolean, snapshot: Snapshot | undefined, focus: boolean): void {
    const { panel, surface, dock } = this.elements;
    const open: Box = { ...this.position!, ...this.size };
    const closed = this.dockBox();
    const ghost = this.doc.createElement('div');
    ghost.className = 'island-morph';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    Object.assign(ghost.style, { position: 'fixed', pointerEvents: 'none', overflow: 'hidden' });
    const svg = this.createOutline(`${this.prefix}-morph`, next ? openPath : arcPath, 'morph-outline');
    const path = svg.querySelector('path')!;
    const content = surface.cloneNode(true) as HTMLElement;
    content.className = 'morph-content';
    content.inert = true;
    content.style.width = `${open.width}px`;
    for (const element of [content, ...Array.from(content.querySelectorAll<HTMLElement>('*'))]) {
      element.removeAttribute('id');
      element.removeAttribute('autofocus');
      element.removeAttribute('name');
      if (element.hasAttribute('aria-live')) element.setAttribute('aria-live', 'off');
      if (element.hasAttribute('tabindex')) element.tabIndex = -1;
    }
    content.querySelectorAll('script,iframe,object,embed').forEach(element => element.remove());
    const logo = this.doc.createElement('span');
    logo.className = 'morph-logo';
    const icon = dock.querySelector('.orbit-icon');
    if (icon) logo.append(icon.cloneNode(true));
    ghost.append(svg, content, logo);
    panel.getRootNode().appendChild(ghost);
    panel.hidden = true;
    panel.inert = true;
    panel.dataset.collapsed = String(next);
    panel.dataset.moving = 'true';
    dock.hidden = true;
    dock.inert = true;
    const epoch = ++this.epoch;
    const frame = (box: Box, offset: number): Keyframe => ({
      left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, offset,
    });
    const center = this.viewport().width / 2;
    let frames = [
      frame(open, 0),
      frame({ left: center - 126, top: Math.max(8, open.top * .18), width: 252, height: 36 }, .5),
      frame({ left: center - 40, top: 0, width: 80, height: 25 }, .85),
      frame(closed, 1),
    ];
    if (!next) frames = frames.map(item => ({ ...item, offset: 1 - Number(item.offset) })).reverse();
    if (snapshot) frames = [frame(snapshot.box, 0), frame(next ? closed : open, 1)];
    const duration = snapshot ? 480 : 900;
    const options: KeyframeAnimationOptions = { duration, easing: 'cubic-bezier(.22,.7,.22,1)', fill: 'forwards' };
    const animations: Animation[] = [];
    const track = (animation: Animation): Animation => {
      animations.push(animation);
      // Register immediately: a later animate() call can throw and cancel this one.
      void animation.finished.catch(() => undefined);
      return animation;
    };
    this.motion = { ghost, path, content, logo, animations, focus };
    try {
      const box = track(ghost.animate(frames, options));
      track(path.animate([
        { d: snapshot?.path ?? `path('${next ? openPath : arcPath}')` },
        { d: `path('${next ? arcPath : openPath}')` },
      ] as Keyframe[], options));
      track(content.animate(next ? [
        { opacity: snapshot?.textOpacity ?? 1, offset: 0 }, { opacity: 0, offset: .2 }, { opacity: 0, offset: 1 },
      ] : [
        { opacity: snapshot?.textOpacity ?? 0, offset: 0 }, { opacity: snapshot?.textOpacity ?? 0, offset: .68 }, { opacity: 1, offset: 1 },
      ], options));
      track(logo.animate(next ? [
        { opacity: snapshot?.logoOpacity ?? 0, offset: 0 }, { opacity: 0, offset: .75 }, { opacity: 1, offset: 1 },
      ] : [
        { opacity: snapshot?.logoOpacity ?? 1, offset: 0 }, { opacity: 0, offset: .25 }, { opacity: 0, offset: 1 },
      ], options));
      void box.finished.then(() => {
        if (this.disposed || epoch !== this.epoch) return;
        this.cancelMotion();
        this.applyView(focus);
      }, () => undefined);
    } catch {
      this.cancelMotion();
      this.applyView(focus);
    }
  }
}
