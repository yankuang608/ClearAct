// SPDX-License-Identifier: MIT
import type {
  PageActionBindingRegistration, PageAdapter, PageBindingCapture, PageCapture, PageCoverage,
  PageNode, PageNodeKind, PageNodeState, PageReferences, PageViewRegistration, RenderedNode,
} from '@clearact/core';
import {
  DOMPageError, DOMRenderedReader, controlType, explicitName, isElement, isPresented,
  isPrivateControl, currentControlValue, labelText, readOnlySample, type FactEvidence,
} from './reader.js';

export { DOMPageError } from './reader.js';
export interface DOMPageAdapterOptions {
  /** Defaults to the current browser document when the adapter is created. */
  document?: Document;
  /** Read native HTML outside explicitly registered views. Defaults to true. */
  fallback?: boolean;
}
export interface DOMPageRuntime { setPageAdapter(adapter: PageAdapter): void }

const kinds = new Set<PageNodeKind>(['page', 'region', 'text', 'table', 'row', 'cell', 'form', 'field', 'dialog', 'control', 'unsupported']);
const renderedKeys = new Set(['element', 'kind', 'name', 'text', 'value', 'children', 'columnKey', 'columns', 'messages', 'table', 'unsupported', 'required']);
const childKinds = new Set<PageNodeKind>(['page', 'region', 'table', 'row', 'cell', 'form', 'dialog']);
const preferredTargetKinds: PageNodeKind[] = ['row', 'field', 'form', 'table', 'control', 'cell', 'dialog', 'region', 'text', 'unsupported', 'page'];

function modal(element: Element): boolean {
  try { if (element.matches(':modal')) return true; } catch { /* Older engines still expose aria-modal. */ }
  return element.getAttribute('aria-modal') === 'true';
}
function stateFor(element: Element): PageNodeState {
  const state: PageNodeState = {};
  const attributes: Array<[string, keyof PageNodeState]> = [['aria-busy', 'busy'], ['aria-selected', 'selected'], ['aria-expanded', 'expanded'], ['aria-disabled', 'disabled'], ['aria-readonly', 'readOnly'], ['aria-invalid', 'invalid']];
  for (const [attribute, key] of attributes) {
    const value = element.getAttribute(attribute);
    if (value === 'true' || value === 'false') (state as Record<string, unknown>)[key] = value === 'true';
    else if (attribute === 'aria-invalid' && value && value !== 'false') state.invalid = true;
  }
  if (element.matches(':disabled')) state.disabled = true;
  if ((element as HTMLInputElement).readOnly === true) state.readOnly = true;
  if (element.tagName === 'DETAILS') state.expanded = element.hasAttribute('open');
  if (element.tagName === 'TR' && state.selected === undefined) {
    const checkbox = element.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (checkbox && isPresented(checkbox, element.ownerDocument)) state.selected = checkbox.checked;
  }
  return state;
}

/** No DOM is read until creation/capture; importing this optional package is safe in Node. */
export function createDOMPageAdapter(options: DOMPageAdapterOptions = {}): PageAdapter {
  const document = options.document ?? (typeof globalThis.document === 'undefined' ? undefined : globalThis.document);
  if (!document?.defaultView) throw new DOMPageError('PAGE_DOM_UNAVAILABLE');
  const boundDocument = document;
  let previousDialogs = new Set<Element>();
  let dialogEpochs = new WeakMap<Element, number>();
  let epoch = 0;
  type TriggerEvidence = {target:Element;trigger:Element;objectKey:string};
  let currentTriggers = new WeakMap<PageActionBindingRegistration,TriggerEvidence>();
  // Values stay in this browser-local WeakMap. Only a random identity reaches private evidence.
  let privateGuards = new WeakMap<PageActionBindingRegistration,{values:string;identity:object}>();

  const adapter: PageAdapter = {
    capture(views, registrations, refs, actionIdentity) {
      if (boundDocument.visibilityState !== 'visible') throw new DOMPageError('PAGE_NOT_VISIBLE');
      if (!boundDocument.body) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
      const sample = readOnlySample(boundDocument, () => capture(views, registrations, refs, actionIdentity));
      currentTriggers = sample.triggers;
      return sample.capture;
    },
    resolveTrigger(registration) {
      return readOnlySample(boundDocument, () => {
        const expected = currentTriggers.get(registration);
        const target = registration.target();
        const trigger = registration.trigger();
        if (!expected || target !== expected.target || trigger !== expected.trigger || registration.objectKey() !== expected.objectKey || !isElement(target, boundDocument) || !isElement(trigger, boundDocument)) return null;
        return isPresented(target, boundDocument) && isPresented(trigger, boundDocument) ? trigger : null;
      });
    },
    reset() { privateGuards = new WeakMap(); previousDialogs = new Set(); dialogEpochs = new WeakMap(); currentTriggers = new WeakMap(); epoch = 0; },
  };

  function capture(views: PageViewRegistration[], registrations: PageActionBindingRegistration[], refs: PageReferences, actionIdentity: (name: string) => string | undefined): {capture:PageCapture;triggers:WeakMap<PageActionBindingRegistration,TriggerEvidence>} {
    const triggers = new WeakMap<PageActionBindingRegistration,TriggerEvidence>();
    const facts = new WeakMap<object, FactEvidence>();
    const viewByKey = new Map<string, PageViewRegistration>();
    const roots = new Map<string, Element>();
    const rootOwners = new Map<Element, string>();
    const excludedRoots = new Set<Element>();
    const coverage: PageCoverage = { status: 'complete', issues: [], truncated: false, nextCursor: null };
    const nodes: PageNode[] = [];
    const elementNodes = new Map<Element, Map<PageNodeKind, PageNode>>();
    const nodeElements = new Map<string, Element>();
    const parentRefs = new Map<string, string>();
    const byRef = new Map<string, PageNode>();
    const viewRefs = new Map<string, string>();
    const keyedTargets = new Map<Element, string>();
    const resolvedBindings: Array<{registration: PageActionBindingRegistration; target: Element; trigger: Element; objectKey: string; actionIdentity: string}> = [];

    const issue = (ref: string, code: string, message: string): void => { coverage.status = 'partial'; coverage.issues.push({ ref, code, message }); };
    for (const view of views) {
      if (viewByKey.has(view.key)) throw new DOMPageError('PAGE_VIEW_OWNERSHIP_CONFLICT');
      viewByKey.set(view.key, view);
      const root = view.root();
      if (root === null) continue;
      if (!isElement(root, boundDocument)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
      if (!isPresented(root, boundDocument)) continue;
      if (rootOwners.has(root)) throw new DOMPageError('PAGE_VIEW_OWNERSHIP_CONFLICT');
      roots.set(view.key, root); rootOwners.set(root, view.key); excludedRoots.add(root);
    }
    const hasOwner = (key: string, ancestors = new Set<string>()): boolean => {
      const view = viewByKey.get(key);
      if (!view || !roots.has(key)) return false;
      if (!view.ownerKey) return true;
      if (ancestors.has(key) || !viewByKey.has(view.ownerKey)) throw new DOMPageError('PAGE_VIEW_OWNERSHIP_CONFLICT');
      ancestors.add(key);
      return hasOwner(view.ownerKey, ancestors);
    };
    for (const key of roots.keys()) if (!hasOwner(key)) roots.delete(key);

    const currentDialogs = new Set(Array.from(boundDocument.querySelectorAll('dialog,[role="dialog"],[role="alertdialog"]')).filter(element => isPresented(element, boundDocument)));
    for (const element of currentDialogs) if (!previousDialogs.has(element)) dialogEpochs.set(element, ++epoch);
    previousDialogs = currentDialogs;

    for (const registration of registrations) {
      const viewRoot = roots.get(registration.viewKey);
      if (!viewRoot) continue;
      const target = registration.target(); const trigger = registration.trigger(); const objectKey = registration.objectKey();
      if (typeof objectKey !== 'string') throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
      if (!isElement(target, boundDocument) || !isElement(trigger, boundDocument) || !isPresented(target, boundDocument) || !isPresented(trigger, boundDocument)) continue;
      const identity = actionIdentity(registration.action);
      if (!identity) continue;
      if (keyedTargets.has(target) && keyedTargets.get(target) !== objectKey) throw new DOMPageError('PAGE_VIEW_OWNERSHIP_CONFLICT');
      keyedTargets.set(target, objectKey);
      resolvedBindings.push({ registration, target, trigger, objectKey, actionIdentity: identity });
    }

    const identityKey = (element: Element): string => {
      const keys: string[] = [];
      for (let current: Element | null = element; current; current = current.parentElement) {
        if (keyedTargets.has(current)) keys.push(`object:${keyedTargets.get(current)}`);
        if (dialogEpochs.has(current)) keys.push(`dialog:${dialogEpochs.get(current)}`);
      }
      return keys.join('|');
    };
    const nodeRef = (element: Element, kind: string): string => refs.ref(element, kind, identityKey(element));
    const page: PageNode = { ref: nodeRef(boundDocument.body, 'page'), kind: 'page', children: [] };
    nodes.push(page); byRef.set(page.ref, page); nodeElements.set(page.ref, boundDocument.body);

    const evidence = (token: unknown, expected?: 'string', element?: Element): FactEvidence => {
      if (!token || typeof token !== 'object') throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
      const fact = facts.get(token);
      if (!fact || (expected === 'string' && typeof fact.value !== 'string')) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
      if (element && element !== fact.element && !element.contains(fact.element)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
      return fact;
    };

    function flatten(tree: RenderedNode, reader: DOMRenderedReader): PageNode {
      if (!tree || typeof tree !== 'object' || Object.keys(tree).some(key => !renderedKeys.has(key)) || !kinds.has(tree.kind)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
      const element = tree.element;
      if (!isElement(element, boundDocument) || !reader.allows(element)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
      let existing = elementNodes.get(element);
      if (!existing) { existing = new Map(); elementNodes.set(element, existing); }
      if (existing.has(tree.kind)) throw new DOMPageError('PAGE_VIEW_OWNERSHIP_CONFLICT');
      const ref = nodeRef(element, tree.kind);
      if (byRef.has(ref)) throw new DOMPageError('PAGE_VIEW_OWNERSHIP_CONFLICT');
      const state = stateFor(element);
      const common = { ref, kind: tree.kind, ...(Object.keys(state).length ? { state } : {}) };
      const base: Record<string, unknown> = { ...common };
      if (tree.name) {
        const fact = evidence(tree.name, 'string');
        if (!reader.allows(fact.element)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
        if (fact.value) base.name = fact.value;
        base.source = fact.source;
        if (fact.truncation) base.truncation = fact.truncation;
      }
      if (tree.kind === 'text' || tree.kind === 'cell') {
        const fact = evidence(tree.text, 'string', element);
        base.text = fact.value; base.source = fact.source;
        if (fact.truncation) { base.truncation = fact.truncation; issue(ref, fact.truncation.reason, 'Some presented text is visually clipped.'); }
      }
      if (tree.kind === 'cell') {
        if (typeof tree.columnKey !== 'string') throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
        base.columnKey = tree.columnKey;
        const cell = element as HTMLTableCellElement;
        if (typeof cell.rowSpan === 'number' && cell.rowSpan > 1) base.rowSpan = cell.rowSpan;
        if (typeof cell.colSpan === 'number' && cell.colSpan > 1) base.columnSpan = cell.colSpan;
      }
      if (tree.kind === 'table') {
        const table: Record<string, unknown> = { renderedRows: tree.children?.filter(child => child.kind === 'row').length ?? 0 };
        if (tree.columns) table.columns = tree.columns.map(column => {
          if (!column || typeof column.key !== 'string' || Object.keys(column).some(key => key !== 'key' && key !== 'label')) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
          return { key: column.key, label: evidence(column.label, 'string', element).value as string };
        });
        if (tree.table) for (const key of Object.keys(tree.table)) {
          if (!['paginationText', 'filterText', 'sortText'].includes(key)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
          const token = tree.table[key as keyof typeof tree.table];
          if (token !== undefined) table[key] = evidence(token, 'string', element).value;
        }
        base.table = table;
      }
      if (tree.kind === 'field' || tree.kind === 'control') {
        const control: Record<string, unknown> = { controlType: controlType(element) };
        if (isPrivateControl(element)) control.redacted = true;
        else if (tree.value) {
          const fact = evidence(tree.value, undefined, element);
          if (fact.private || !fact.controlValue) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
          control.value = Array.isArray(fact.value) ? [...fact.value] : fact.value;
        }
        if (tree.kind === 'field') {
          if ((element as HTMLInputElement).required || element.getAttribute('aria-required') === 'true') control.required = true;
          if (tree.required) {
            const fact = evidence(tree.required);
            if (!fact.requiredIndicator || typeof fact.value !== 'boolean' || !reader.allows(fact.element)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
            if (fact.value) control.required = true;
          }
          base.field = control;
          if (tree.messages?.length) {
            base.messages = tree.messages.map(token => evidence(token, 'string').value).filter(Boolean);
            if ((base.messages as string[]).length) base.state = { ...state, invalid: true };
          }
        } else {
          delete control.redacted;
          if (element.matches('a[href]')) control.href = (element as HTMLAnchorElement).href;
          base.control = control;
        }
      }
      if (tree.kind === 'dialog') base.dialog = { modal: modal(element), open: true, blocks: [] };
      if (tree.kind === 'unsupported') {
        if (!tree.unsupported || typeof tree.unsupported.reason !== 'string' || !/^[a-z0-9_]{1,100}$/u.test(tree.unsupported.reason)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
        base.unsupported = { reason: tree.unsupported.reason };
        issue(ref, tree.unsupported.reason, 'This presented component has no supported semantic reader.');
      }
      const node = base as unknown as PageNode;
      existing.set(tree.kind, node); nodes.push(node); byRef.set(ref, node); nodeElements.set(ref, element);
      if (tree.children) {
        if (!Array.isArray(tree.children) || !childKinds.has(tree.kind)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
        node.children = tree.children.map(child => {
          const childNode = flatten(child, reader); parentRefs.set(childNode.ref, ref); return childNode.ref;
        });
        if (node.children.length) node.detailAvailable = true;
      }
      return node;
    }

    const attach = (parent: PageNode, child: PageNode): void => {
      parent.children ??= [];
      if (!parent.children.includes(child.ref)) parent.children.push(child.ref);
      parentRefs.set(child.ref, parent.ref); parent.detailAvailable = true;
    };
    if (options.fallback !== false && !excludedRoots.has(boundDocument.body)) {
      const reader = new DOMRenderedReader(boundDocument, boundDocument.body, excludedRoots, facts);
      for (const tree of reader.children(boundDocument.body)) attach(page, flatten(tree, reader));
    }
    for (const view of views) {
      const root = roots.get(view.key);
      if (!root) continue;
      const reader = new DOMRenderedReader(boundDocument, root, excludedRoots, facts);
      const tree = view.read ? view.read(reader) : reader.native(root, view.kind);
      if (tree && typeof (tree as unknown as {then?: unknown}).then === 'function') { Promise.resolve(tree).catch(() => {}); throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION'); }
      if (!tree || tree.element !== root || tree.kind !== view.kind) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
      viewRefs.set(view.key, flatten(tree, reader).ref);
    }
    for (const view of views) {
      const ref = viewRefs.get(view.key); if (!ref) continue;
      const root = roots.get(view.key)!;
      let parent: PageNode = page;
      if (view.ownerKey) {
        const ownerRef = viewRefs.get(view.ownerKey);
        if (!ownerRef) throw new DOMPageError('PAGE_VIEW_OWNERSHIP_CONFLICT');
        parent = byRef.get(ownerRef)!;
      } else {
        for (let element = root.parentElement; element; element = element.parentElement) {
          const candidates = elementNodes.get(element);
          const candidate = candidates && Array.from(candidates.values()).find(node => childKinds.has(node.kind));
          if (candidate) { parent = candidate; break; }
        }
      }
      attach(parent, byRef.get(ref)!);
    }

    const ancestors = (ref: string): PageNode[] => {
      const result: PageNode[] = []; const visited = new Set<string>(); let parent = parentRefs.get(ref);
      while (parent) {
        if (visited.has(parent)) throw new DOMPageError('PAGE_VIEW_OWNERSHIP_CONFLICT');
        visited.add(parent); const node = byRef.get(parent); if (!node) break;
        result.push(node); parent = parentRefs.get(parent);
      }
      return result;
    };
    const descendsFrom = (node: PageNode, ancestorRef: string): boolean => node.ref === ancestorRef || ancestors(node.ref).some(parent => parent.ref === ancestorRef);
    const dialogs = nodes.filter((node): node is Extract<PageNode, {kind: 'dialog'}> => node.kind === 'dialog');
    const nativeModals = dialogs.filter(node => {
      const element=nodeElements.get(node.ref)!;
      try {return element.matches('dialog:modal');} catch {return false;}
    });
    let nativeTop:typeof nativeModals[number]|undefined;
    if(nativeModals.length) {
      const width=boundDocument.documentElement.clientWidth,height=boundDocument.documentElement.clientHeight;
      const points:[[number,number],...[number,number][]]=[[width/2,height/2],[1,1],[Math.max(1,width-2),Math.max(1,height-2)]];
      for(const node of nativeModals) {
        const rect=nodeElements.get(node.ref)!.getBoundingClientRect();
        if(rect.right>0&&rect.bottom>0&&rect.left<width&&rect.top<height) points.push([Math.max(0,Math.min(width-1,(rect.left+rect.right)/2)),Math.max(0,Math.min(height-1,(rect.top+rect.bottom)/2))]);
      }
      // Native modal backdrops participate in hit testing, including outside a panel.
      // Their current top-layer order cannot be recovered from DOM or sampling history.
      for(const [x,y] of points) {
        for(let hit=boundDocument.elementFromPoint(x,y);hit;hit=hit.parentElement) {
          nativeTop=nativeModals.find(node=>nodeElements.get(node.ref)===hit);
          if(nativeTop)break;
        }
        if(nativeTop)break;
      }
      if(!nativeTop&&nativeModals.length===1)nativeTop=nativeModals[0];
      if(!nativeTop)throw new DOMPageError('PAGE_DOM_UNAVAILABLE');
    }
    const modalCandidates = dialogs.filter(node => {
      if(!node.dialog.modal)return false;
      if(!nativeTop)return true;
      const element=nodeElements.get(node.ref)!;
      return (node.ref===nativeTop.ref || !nativeModals.includes(node)) && descendsFrom(node,nativeTop.ref) && nodeElements.get(nativeTop.ref)!.contains(element);
    });
    let activeDialog:typeof dialogs[number]|undefined;
    if(modalCandidates.length) {
      const width=boundDocument.documentElement.clientWidth,height=boundDocument.documentElement.clientHeight;
      const points:Array<[number,number]>=[[width/2,height/2],[1,1],[Math.max(1,width-2),Math.max(1,height-2)]];
      for(const candidate of modalCandidates) {
        const rect=nodeElements.get(candidate.ref)!.getBoundingClientRect();
        const left=Math.max(0,rect.left),right=Math.min(width-1,rect.right),top=Math.max(0,rect.top),bottom=Math.min(height-1,rect.bottom);
        if(right>left&&bottom>top)for(const x of [.1,.5,.9])for(const y of [.1,.5,.9])points.push([left+(right-left)*x,top+(bottom-top)*y]);
      }
      const hitRefs=new Set<string>();
      for(const [x,y] of points)for(let hit=boundDocument.elementFromPoint(x,y);hit;hit=hit.parentElement) {
        const candidate=modalCandidates.find(node=>nodeElements.get(node.ref)===hit);
        if(candidate){hitRefs.add(candidate.ref);break;}
      }
      const hitModals=modalCandidates.filter(node=>hitRefs.has(node.ref));
      // Parent surfaces may still be hit outside a smaller nested modal. A unique
      // logical descendant is its active layer; unrelated visible hits are ambiguous.
      activeDialog=hitModals.find(candidate=>hitModals.every(other=>descendsFrom(candidate,other.ref)));
      if(!activeDialog&&modalCandidates.length===1)activeDialog=modalCandidates[0];
      if(!activeDialog)throw new DOMPageError('PAGE_DOM_UNAVAILABLE');
    }
    const inActiveLayer = (node:PageNode):boolean => {
      if(!activeDialog)return false;
      const lineage=[node,...ancestors(node.ref)];
      const modalOwner=lineage.find(parent=>parent.kind==='dialog'&&parent.dialog.modal);
      if(modalOwner?.ref!==activeDialog.ref)return false;
      if(!nativeTop)return true;
      const nativeOwner=lineage.find(parent=>nativeModals.some(dialog=>dialog.ref===parent.ref));
      return nativeOwner?.ref===nativeTop.ref && nodeElements.get(nativeTop.ref)!.contains(nodeElements.get(node.ref)!);
    };
    if (activeDialog) {
      for (const node of nodes) if (node.kind !== 'page' && !inActiveLayer(node)) node.state = { ...node.state, blockedBy: activeDialog.ref };
      activeDialog.dialog.blocks = nodes.filter(node => (node.kind === 'table' || node.kind === 'form' || (node.kind === 'region' && parentRefs.get(node.ref) === page.ref)) && !inActiveLayer(node)).map(node => node.ref);
    }

    const findNode = (element: Element): PageNode | undefined => {
      const map = elementNodes.get(element);
      return map && preferredTargetKinds.map(kind => map.get(kind)).find(Boolean);
    };
    const closure = (node: PageNode, set: Set<string>, visited = new Set<string>()): void => {
      // Ancestor refs may already be guarded without their descendants being expanded.
      if (visited.has(node.ref)) return; visited.add(node.ref); set.add(node.ref);
      for (const child of node.children ?? []) { const childNode = byRef.get(child); if (childNode) closure(childNode, set, visited); }
    };
    const captures: PageBindingCapture[] = [];
    for (const resolved of resolvedBindings) {
      const { registration, target, trigger, objectKey } = resolved;
      const targetNode = findNode(target); if (!targetNode) continue;
      const triggerNode = findNode(trigger);
      const owningViewRef = viewRefs.get(registration.viewKey);
      if (!owningViewRef || !descendsFrom(targetNode,owningViewRef) || !triggerNode || !descendsFrom(triggerNode,targetNode.ref)) continue;
      const guardRefs = new Set<string>();
      const parents = ancestors(targetNode.ref);
      const row = targetNode.kind === 'row' ? targetNode : parents.find(node => node.kind === 'row');
      const form = targetNode.kind === 'form' ? targetNode : parents.find(node => node.kind === 'form');
      const table = targetNode.kind === 'table' ? targetNode : parents.find(node => node.kind === 'table');
      const submitsForm = (trigger.matches('button,input') && controlType(trigger) === 'submit') || targetNode.kind === 'form';
      if ((registration.guard.scope === 'form' || submitsForm) && form) closure(form, guardRefs);
      else if (registration.guard.scope === 'row' && row) closure(row, guardRefs);
      else closure(targetNode, guardRefs);
      for (const parent of parents) {
        if (parent.kind === 'form') closure(parent, guardRefs);
        else if (parent.kind === 'table' || parent.kind === 'dialog') guardRefs.add(parent.ref);
      }
      if (table) {
        guardRefs.add(table.ref);
        for (const childRef of table.children ?? []) {
          const child = byRef.get(childRef)!;
          if (child.kind !== 'row') closure(child, guardRefs);
          else if (child.state?.selected === true) {
            if (registration.guard.scope === 'selection') closure(child, guardRefs);
            else guardRefs.add(child.ref);
          }
        }
      } else if (registration.guard.scope === 'selection') {
        const viewRef = viewRefs.get(registration.viewKey)!;
        for (const node of nodes) if (node.state?.selected === true && descendsFrom(node, viewRef)) closure(node, guardRefs);
      }
      if (triggerNode) guardRefs.add(triggerNode.ref);
      for (const key of registration.guard.relatedViews ?? []) {
        const relatedRef = viewRefs.get(key); if (!relatedRef) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
        closure(byRef.get(relatedRef)!, guardRefs);
      }
      const blocked = !!activeDialog && (!inActiveLayer(targetNode) || !inActiveLayer(triggerNode));
      const disabled = trigger.matches(':disabled') || !!trigger.closest('[inert],[aria-disabled="true"]') || trigger.getAttribute('aria-disabled') === 'true';
      const labelReader = new DOMRenderedReader(boundDocument, trigger, new Set(), facts);
      const labelFact = evidence(labelReader.name(trigger), 'string');
      const binding: PageBindingCapture['binding'] = {
        ref: refs.ref(registration, 'binding', objectKey), action: registration.action, targetRef: targetNode.ref,
        label: labelFact.value as string, enabled: !disabled && !blocked, callable: !disabled && !blocked,
        argumentBindings: jsonBindings(registration.argumentBindings?.() ?? {}),
      };
      if (disabled) {
        const reason = (trigger.getAttribute('aria-describedby') ?? '').split(/\s+/u).map(id => {const description = boundDocument.getElementById(id);return description ? labelText(description, boundDocument, true) : '';}).filter(Boolean).join(' ');
        if (reason) binding.disabledReason = reason;
      }
      targetNode.actions ??= []; targetNode.actions.push(binding);
      const privateValues = [...guardRefs].filter(ref => byRef.get(ref)?.kind === 'field' && isPrivateControl(nodeElements.get(ref)!)).sort().map(ref => [ref, currentControlValue(nodeElements.get(ref)!)]);
      let privateGuardIdentity: string | undefined;
      if (privateValues.length) {
        const values = JSON.stringify(privateValues);
        let prior = privateGuards.get(registration);
        if (!prior || prior.values !== values) {prior = {values,identity:{}};privateGuards.set(registration,prior);}
        privateGuardIdentity = refs.ref(prior.identity, 'private-guard');
      } else privateGuards.delete(registration);
      captures.push({ binding, ...(privateGuardIdentity ? {privateGuardIdentity} : {}), guardRefs: [...guardRefs], targetIdentity: refs.ref(target, 'target-identity', `${objectKey}|${identityKey(target)}`), actionIdentity: resolved.actionIdentity });
      triggers.set(registration,{target,trigger,objectKey});
    }
    return {capture:{ page: { url: boundDocument.location.href, title: boundDocument.title }, nodes, activeDialogRef: activeDialog?.ref ?? null, coverage, bindings: captures },triggers};
  }
  return adapter;
}

function jsonBindings(value: Record<string, unknown>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION');
  try {
    const serialized = JSON.stringify(value);
    const copy = JSON.parse(serialized) as Record<string, unknown>;
    if (Object.keys(copy).length !== Object.keys(value).length) throw new Error();
    return copy;
  } catch { throw new DOMPageError('PAGE_READ_CONTRACT_VIOLATION'); }
}

export function installDOMPage(runtime: DOMPageRuntime, options: DOMPageAdapterOptions = {}): PageAdapter {
  const adapter = createDOMPageAdapter(options);
  runtime.setPageAdapter(adapter);
  return adapter;
}
