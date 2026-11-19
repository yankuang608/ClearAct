// SPDX-License-Identifier: MIT
import { PageError, type PageNodeKind, type RenderedFact, type RenderedNode, type RenderedReader } from '@clearact/core';

export class DOMPageError extends PageError {
  constructor(code: string) {
    super(code === 'PAGE_NOT_VISIBLE' ? code : code === 'PAGE_DOM_UNAVAILABLE' ? 'PAGE_NOT_READY' : 'ADAPTER_CONTRACT_VIOLATION');
    this.name = 'DOMPageError';
  }
}

export interface FactEvidence {
  element: Element;
  value: string | boolean | string[];
  source: 'rendered' | 'accessible';
  truncation?: { reason: string };
  private?: boolean;
  requiredIndicator?: true;
  controlValue?: true;
}

const ignoredTags = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'OPTION', 'OPTGROUP']);
const textTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SUMMARY', 'LEGEND', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'SMALL', 'DT', 'DD', 'LI', 'LABEL', 'TIME', 'PRE', 'CODE', 'BLOCKQUOTE']);
const significantSelector = 'table,form,input,textarea,select,button,a[href],dialog,[role="dialog"],[role="alertdialog"],[contenteditable="true"],span[tabindex],[role="button"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],canvas,iframe,object,embed,svg';
const supportedKinds = new Set<PageNodeKind>(['page', 'region', 'text', 'table', 'row', 'cell', 'form', 'field', 'dialog', 'control', 'unsupported']);
const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/gu, ' ').trim();

export function isElement(value: unknown, document: Document): value is Element {
  return !!value && typeof value === 'object' && (value as Node).nodeType === 1 && (value as Node).ownerDocument === document;
}

/** Presentation is deliberately independent from viewport intersection and inertness. */
export function isPresented(element: Element, document: Document): boolean {
  if (!element.isConnected || element.ownerDocument !== document || ignoredTags.has(element.tagName)) return false;
  if (element.closest('[data-clearact-observer]')) return false;
  if (element.matches('input[type="hidden"]')) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden')) return false;
    if (current.tagName === 'DIALOG' && !current.hasAttribute('open')) return false;
    const style = document.defaultView!.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || style.opacity === '0') return false;
    if (current.tagName === 'DETAILS' && !current.hasAttribute('open') && current !== element) {
      const summary = Array.from(current.children).find(child => child.tagName === 'SUMMARY');
      if (!summary || (element !== summary && !summary.contains(element))) return false;
    }
  }
  return element.getClientRects().length > 0 || document.defaultView!.getComputedStyle(element).display === 'contents';
}

export function isPrivateControl(element: Element): boolean {
  return element.matches('input[type="password"],[data-clearact-private]') || /^(?:current-password|new-password|cc-number|cc-csc)$/u.test(element.getAttribute('autocomplete') ?? '');
}

export function controlType(element: Element): string {
  if (element.tagName === 'INPUT') return (element as HTMLInputElement).type;
  if (element.tagName === 'TEXTAREA') return 'textarea';
  if (element.tagName === 'SELECT') return (element as HTMLSelectElement).multiple ? 'select-multiple' : 'select';
  if (element.tagName === 'BUTTON') return (element as HTMLButtonElement).type;
  if (element.matches('a[href]')) return 'link';
  if (element.getAttribute('contenteditable') === 'true') return 'contenteditable';
  return element.getAttribute('role') ?? element.tagName.toLowerCase();
}

export function currentControlValue(element: Element): string | boolean | string[] {
  if (element.tagName === 'INPUT') {
    const input = element as HTMLInputElement;
    return input.type === 'checkbox' || input.type === 'radio' ? input.checked : input.value;
  }
  if (element.tagName === 'TEXTAREA') return (element as HTMLTextAreaElement).value;
  if (element.tagName === 'SELECT') {
    const select = element as HTMLSelectElement;
    const chosen = Array.from(select.selectedOptions).map(option => normalize(option.label || option.textContent));
    return select.multiple ? chosen : chosen[0] ?? '';
  }
  if (element.getAttribute('contenteditable') === 'true') return (element as HTMLElement).innerText;
  if (element.getAttribute('role') === 'checkbox' || element.getAttribute('role') === 'switch' || element.getAttribute('role') === 'radio') return element.getAttribute('aria-checked') === 'true';
  throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
}

function hasClippedText(element: Element, document: Document): boolean {
  for (let current: Element | null = element; current && current !== document.body; current = current.parentElement) {
    const style = document.defaultView!.getComputedStyle(current);
    const clippedX = /hidden|clip/u.test(style.overflowX) && current.scrollWidth > current.clientWidth + 1;
    const clippedY = /hidden|clip/u.test(style.overflowY) && current.scrollHeight > current.clientHeight + 1;
    if (clippedX || clippedY) return true;
  }
  return false;
}

/** Accessible label text is not a serialization of embedded controls or their options. */
export function labelText(root: Element, document: Document, referenced = false): string {
  const pieces: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === 3) { pieces.push(node.textContent ?? ''); return; }
    if (!isElement(node, document) || ignoredTags.has(node.tagName)) return;
    if (node.matches('input,textarea,select,canvas,iframe,object,embed,svg') || node.tagName.includes('-')) return;
    if (!referenced && (!isPresented(node, document) || node.getAttribute('aria-hidden') === 'true')) return;
    if (node.tagName === 'BR') { pieces.push(' '); return; }
    if (node.tagName === 'IMG') { pieces.push(node.getAttribute('alt') ?? ''); return; }
    for (const child of Array.from(node.childNodes)) visit(child);
    pieces.push(' ');
  };
  visit(root);
  return normalize(pieces.join(''));
}

/** Only explicit accessibility associations may traverse hidden label content. */
export function explicitName(element: Element, document: Document): string | undefined {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = normalize(labelledBy.split(/\s+/u).map(id => { const label = document.getElementById(id); return label ? labelText(label, document, true) : ''; }).join(' '));
    if (text) return text;
  }
  const label = normalize(element.getAttribute('aria-label'));
  if (label) return label;
  const labels = (element as HTMLInputElement).labels;
  if (labels?.length) {
    const text = normalize(Array.from(labels).map(item => labelText(item, document)).join(' '));
    if (text) return text;
  }
  const title = normalize(element.getAttribute('title'));
  if (title) return title;
  if (element.tagName === 'IMG') return normalize(element.getAttribute('alt')) || undefined;
  return undefined;
}

export class DOMRenderedReader implements RenderedReader {
  constructor(
    readonly document: Document,
    readonly root: Element,
    private readonly excludedRoots: Set<Element>,
    readonly facts: WeakMap<object, FactEvidence>,
  ) {}

  allows(element: Element): boolean {
    if (element !== this.root && !this.root.contains(element)) return false;
    for (const excluded of this.excludedRoots) {
      if (excluded !== this.root && !excluded.contains(this.root) && (excluded === element || excluded.contains(element))) return false;
    }
    return isPresented(element, this.document);
  }

  private element(value: object | undefined): Element {
    const element = value ?? this.root;
    if (!isElement(element, this.document) || !this.allows(element)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
    return element;
  }

  private fact<T extends string | boolean | string[]>(element: Element, value: T, source: FactEvidence['source'], options: Pick<FactEvidence, 'truncation' | 'private' | 'requiredIndicator' | 'controlValue'> = {}): RenderedFact<T> {
    const token = Object.freeze({});
    this.facts.set(token, { element, value, source, ...options });
    return token as RenderedFact<T>;
  }

  private renderedText(element: Element): string {
    const pieces: string[] = [];
    const visit = (node: Node): void => {
      if (node.nodeType === 3) { pieces.push(node.textContent ?? ''); return; }
      if (!isElement(node, this.document) || !this.allows(node)) return;
      if (node.matches('input,textarea,select,canvas,iframe,object,embed,svg') || node.tagName.includes('-')) return;
      if (node.tagName === 'BR') { pieces.push(' '); return; }
      for (const child of Array.from(node.childNodes)) visit(child);
      pieces.push(' ');
    };
    visit(element);
    return normalize(pieces.join(''));
  }

  text(value: object): RenderedFact<string> {
    const element = this.element(value);
    if (hasClippedText(element, this.document)) {
      const name = explicitName(element, this.document);
      return this.fact(element, name ?? '', name ? 'accessible' : 'rendered', name ? {} : { truncation: { reason: 'clipped_text' } });
    }
    return this.fact(element, this.renderedText(element), 'rendered');
  }

  name(value: object): RenderedFact<string> {
    const element = this.element(value);
    const explicit = explicitName(element, this.document);
    if (explicit) return this.fact(element, explicit, 'accessible');
    let candidate: Element | undefined;
    if (element.tagName === 'TABLE') candidate = Array.from(element.children).find(item => item.tagName === 'CAPTION');
    else if (element.tagName === 'FIELDSET') candidate = Array.from(element.children).find(item => item.tagName === 'LEGEND');
    else if (element.matches('dialog,[role="dialog"],[role="alertdialog"]')) candidate = Array.from(element.querySelectorAll('h1,h2,h3,[role="heading"]')).find(item => this.allows(item));
    else if (element.matches('button,a[href],summary,[role="button"],[role="option"],[role="tab"],[role="menuitem"]')) candidate = element;
    if (candidate && this.allows(candidate)) {
      const fact = this.text(candidate);
      const evidence = this.facts.get(fact)!;
      return this.fact(element, evidence.value as string, evidence.source, { truncation: evidence.truncation });
    }
    if (element.matches('input[type="submit"],input[type="button"],input[type="reset"]')) return this.fact(element, (element as HTMLInputElement).value, 'rendered');
    return this.fact(element, '', 'rendered');
  }

  controlValue(value: object): RenderedFact<string | boolean | string[]> {
    const element = this.element(value);
    if (isPrivateControl(element)) return this.fact(element, '', 'rendered', { private: true, controlValue:true });
    return this.fact(element, currentControlValue(element), 'rendered', {controlValue:true});
  }

  requiredIndicator(value: object, pseudo: '::before' | '::after' = '::before'): RenderedFact<boolean> {
    const element = this.element(value);
    if (pseudo !== '::before' && pseudo !== '::after') throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
    const style = this.document.defaultView!.getComputedStyle(element, pseudo);
    const star = /^(["'])\*\1$/u.test(style.content.trim());
    const transparent = style.color === 'transparent' || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/u.test(style.color);
    const shown = star && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0' && style.fontSize !== '0px' && !transparent && !hasClippedText(element, this.document);
    return this.fact(element, shown, 'rendered', {requiredIndicator:true});
  }

  elements(selector: string, value?: object): object[] {
    const root = this.element(value);
    try { return Array.from(root.querySelectorAll(selector)).filter(item => this.allows(item)); }
    catch { throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION'); }
  }

  table(value?: object, selectors: { headers?: string; rows?: string; cells?: string } = {}): RenderedNode {
    const root = this.element(value);
    const headers = this.elements(selectors.headers ?? 'thead th', root) as Element[];
    if (!headers.length && !selectors.headers) headers.push(...(this.elements('tr:first-child > th', root) as Element[]));
    const columns = headers.map((header, index) => ({ key: `column-${index + 1}`, label: this.text(header) }));
    const candidates = this.elements(selectors.rows ?? 'tbody > tr,table > tr', root) as Element[];
    const rows = candidates.filter(row => selectors.rows || row.closest('table') === root).filter(row => this.elements(selectors.cells ?? ':scope > td', row).length > 0);
    const children = rows.map(row => {
      const cells = (this.elements(selectors.cells ?? ':scope > td,:scope > th', row) as Element[]).filter(cell => selectors.cells || cell.closest('tr') === row);
      return { element: row, kind: 'row' as const, children: cells.map((cell, index) => ({
        element: cell, kind: 'cell' as const, columnKey: columns[index]?.key ?? `column-${index + 1}`, text: this.text(cell),
        children: this.controlChildren(cell),
      })) };
    });
    return { element: root, kind: 'table', name: this.name(root), columns, children };
  }

  form(value?: object): RenderedNode {
    const root = this.element(value);
    return { element: root, kind: 'form', name: this.name(root), children: this.children(root) };
  }

  dialog(value?: object): RenderedNode {
    const root = this.element(value);
    return { element: root, kind: 'dialog', name: this.name(root), children: this.children(root) };
  }

  native(value?: object, requestedKind?: PageNodeKind): RenderedNode {
    const root = this.element(value);
    if (requestedKind && !supportedKinds.has(requestedKind)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
    const kind = requestedKind ?? this.detectKind(root);
    if (kind === 'table') return this.table(root);
    if (kind === 'form') return this.form(root);
    if (kind === 'dialog') return this.dialog(root);
    if (kind === 'field') {
      const messages: RenderedFact<string>[] = [];
      for (const id of (root.getAttribute('aria-errormessage') ?? '').split(/\s+/u).filter(Boolean)) {
        const error = this.document.getElementById(id);
        if (error && this.allows(error)) messages.push(this.text(error));
      }
      return { element: root, kind, name: this.name(root), value: this.controlValue(root), messages };
    }
    if (kind === 'control') {
      const value = root.matches('[role="checkbox"],[role="radio"],[role="switch"]') || root.getAttribute('contenteditable') === 'true' ? this.controlValue(root) : undefined;
      return { element: root, kind, name: this.name(root), ...(value ? { value } : {}) };
    }
    if (kind === 'unsupported') return { element: root, kind, name: this.name(root), unsupported: { reason: root.tagName.includes('-') ? 'unadapted_custom_control' : `unadapted_${root.tagName.toLowerCase()}` } };
    if (kind === 'text') return { element: root, kind, text: this.text(root) };
    if (kind === 'cell') return { element: root, kind, columnKey: 'column-1', text: this.text(root), children: this.controlChildren(root) };
    return { element: root, kind, name: this.name(root), children: this.children(root) };
  }

  private detectKind(element: Element): PageNodeKind {
    if (element.tagName === 'TABLE') return 'table';
    if (element.tagName === 'TR') return 'row';
    if (element.tagName === 'TD' || element.tagName === 'TH') return 'cell';
    if (element.tagName === 'FORM') return 'form';
    if (element.matches('dialog,[role="dialog"],[role="alertdialog"]')) return 'dialog';
    if (element.matches('input:not([type="button"]):not([type="submit"]):not([type="reset"]),textarea,select')) return 'field';
    if (element.matches('button,a[href],input[type="button"],input[type="submit"],input[type="reset"],[role="button"],[role="option"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[contenteditable="true"],span[tabindex]')) return 'control';
    if (element.matches('canvas,iframe,object,embed,svg') || element.tagName.includes('-')) return 'unsupported';
    if (textTags.has(element.tagName) && !Array.from(element.querySelectorAll('*')).some(child => this.isSignificant(child) && this.allows(child))) return 'text';
    return 'region';
  }

  private isSignificant(element: Element): boolean {
    return element.matches(significantSelector) || element.tagName.includes('-');
  }

  private controlChildren(root: Element): RenderedNode[] {
    return (this.elements('*', root) as Element[]).filter(element => this.isSignificant(element)).filter(element => {
      for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) if (this.isSignificant(parent)) return false;
      return true;
    }).map(element => this.native(element));
  }

  children(root: Element): RenderedNode[] {
    const children: RenderedNode[] = [];
    const ownText = normalize(Array.from(root.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent ?? '').join(' '));
    if (ownText) {
      const clipped = hasClippedText(root, this.document);
      const explicit = clipped ? explicitName(root, this.document) : undefined;
      children.push({ element: root, kind: 'text', text: this.fact(root, clipped ? explicit ?? '' : ownText, explicit ? 'accessible' : 'rendered', clipped && !explicit ? { truncation: { reason: 'clipped_text' } } : {}) });
    }
    for (const element of Array.from(root.children)) if (this.allows(element)) children.push(this.native(element));
    return children;
  }
}

/** Detectable contract violations are rejected synchronously; this is not a host-code sandbox. */
export function readOnlySample<T>(document: Document, read: () => T): T {
  const window = document.defaultView!;
  const observer = new window.MutationObserver(() => {});
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const controls = Array.from(document.querySelectorAll('input,textarea,select,[contenteditable="true"]'));
  const values = controls.map(element => JSON.stringify(currentControlValue(element)));
  const restores: Array<() => void> = [];
  let attemptedNetwork = false;
  const block = (): never => { attemptedNetwork = true; throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION'); };
  const replace = (object: object, key: string): void => {
    const record = object as Record<string, unknown>;
    const original = record[key];
    try { record[key] = block; restores.push(() => { record[key] = original; }); } catch { /* Some browser properties are not writable. */ }
  };
  replace(window, 'fetch');
  replace(window, 'WebSocket');
  replace(window, 'EventSource');
  replace(window.XMLHttpRequest.prototype, 'open');
  replace(window.XMLHttpRequest.prototype, 'send');
  replace(window.navigator, 'sendBeacon');
  try {
    const result = read();
    if (result && typeof (result as { then?: unknown }).then === 'function') { Promise.resolve(result).catch(() => {}); throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION'); }
    if (attemptedNetwork || observer.takeRecords().length || controls.some((element, index) => JSON.stringify(currentControlValue(element)) !== values[index])) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
    return result;
  } catch (error) {
    if (error instanceof DOMPageError) throw error;
    throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
  } finally {
    observer.disconnect();
    for (const restore of restores.reverse()) restore();
  }
}
