// SPDX-License-Identifier: MIT
/** Public page observations contain presented UI facts and opaque references only. */
export type PageNodeKind = 'page' | 'region' | 'text' | 'table' | 'row' | 'cell' | 'form' | 'field' | 'dialog' | 'control' | 'unsupported';
export interface PageObservationOptions { detail?: 'overview' | 'region'; regionRef?: string; bindingRef?: string; cursor?: string; limit?: number }
export interface ObservationReference { snapshotId: string; bindingRef: string }
export interface PageActionResult {
  outcome: 'completed' | 'validation_failed' | 'in_progress';
  message?: string;
  refreshRefs?: string[];
  observationRequired: boolean;
}
export interface PageActionBinding {
  ref: string;
  action: string;
  targetRef: string;
  label: string;
  enabled: boolean;
  callable: boolean;
  argumentBindings: Record<string, unknown>;
  unavailableReason?: 'observation_incomplete';
  disabledReason?: string;
}
export interface PageNodeState {
  busy?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  blockedBy?: string;
}
export interface PageNodeBase {
  ref: string;
  kind: PageNodeKind;
  name?: string;
  revision?: number;
  children?: string[];
  detailAvailable?: boolean;
  state?: PageNodeState;
  actions?: PageActionBinding[];
  truncation?: { reason: string };
  source?: 'rendered' | 'accessible';
}
export type PageControlValue = string | boolean | string[];
export type PageNode =
  | (PageNodeBase & {kind: 'page' | 'region' | 'row' | 'form'})
  | (PageNodeBase & {kind: 'text'; text: string})
  | (PageNodeBase & {kind: 'table'; table: {columns?: {key: string; label: string}[]; renderedRows?: number; totalRows?: number; paginationText?: string; filterText?: string; sortText?: string}})
  | (PageNodeBase & {kind: 'cell'; columnKey: string; text: string; rowSpan?: number; columnSpan?: number})
  | (PageNodeBase & {kind: 'field'; field: {controlType: string; value?: PageControlValue; required?: boolean; redacted?: boolean}; messages?: string[]})
  | (PageNodeBase & {kind: 'dialog'; dialog: {modal: boolean; open: boolean; blocks: string[]}})
  | (PageNodeBase & {kind: 'control'; control: {controlType: string; value?: PageControlValue; href?: string}})
  | (PageNodeBase & {kind: 'unsupported'; unsupported: {reason: string}});
export interface PageCoverageIssue { ref?: string; code: string; message: string }
export interface PageCoverage {
  status: 'complete' | 'partial';
  issues: PageCoverageIssue[];
  truncated: boolean;
  nextCursor: string | null;
}
export interface PageSnapshot {
  schemaVersion: '1.0';
  sessionId: string;
  documentId: string;
  snapshotId: string;
  capturedAt: string;
  page: {url: string; title: string};
  scope: {ref: string; detail: 'overview' | 'region'};
  activeDialogRef: string | null;
  nodes: PageNode[];
  coverage: PageCoverage;
}
export interface PageBindingEvidence {
  bindingRef: string;
  action: string;
  targetRef: string;
  targetIdentity: string;
  actionIdentity: string;
  /** Opaque browser-local identity for redacted guard values; never contains their values or hashes. */
  privateGuardIdentity?: string;
  canonical: string;
  argumentBindings: Record<string, unknown>;
  guardRefs: string[];
}
export interface PageEvidence { documentId: string; snapshotId: string; bindings: PageBindingEvidence[] }
export interface ExecutionObservation { documentId: string; snapshotId: string; binding: PageBindingEvidence }
export interface PageObservationResult { snapshot: PageSnapshot; evidence: PageEvidence }
export interface PageBindingCapture { binding: PageActionBinding; guardRefs: string[]; targetIdentity: string; actionIdentity: string; privateGuardIdentity?: string }
export interface PageCapture {
  page: {url: string; title: string};
  nodes: PageNode[];
  activeDialogRef: string | null;
  coverage: PageCoverage;
  bindings: PageBindingCapture[];
}
export interface PageReferences { ref(identity: object, kind: string, objectKey?: string): string }

/** Values can only be created and consumed by the DOM reader that owns their provenance. */
declare const renderedFactBrand: unique symbol;
export interface RenderedFact<T> { readonly [renderedFactBrand]: T }
export interface RenderedNode {
  element: object;
  kind: PageNodeKind;
  name?: RenderedFact<string>;
  text?: RenderedFact<string>;
  value?: RenderedFact<PageControlValue>;
  required?: RenderedFact<boolean>;
  children?: RenderedNode[];
  columnKey?: string;
  columns?: Array<{key: string; label: RenderedFact<string>}>;
  messages?: RenderedFact<string>[];
  table?: {paginationText?: RenderedFact<string>; filterText?: RenderedFact<string>; sortText?: RenderedFact<string>};
  unsupported?: {reason: string};
}
export interface RenderedReader {
  text(element: object): RenderedFact<string>;
  name(element: object): RenderedFact<string>;
  controlValue(element: object): RenderedFact<PageControlValue>;
  requiredIndicator(element: object, pseudo?: '::before' | '::after'): RenderedFact<boolean>;
  elements(selector: string, root?: object): object[];
  native(root?: object, kind?: PageNodeKind): RenderedNode;
  table(root?: object, selectors?: {headers?: string; rows?: string; cells?: string}): RenderedNode;
  form(root?: object): RenderedNode;
  dialog(root?: object): RenderedNode;
}
export interface PageViewRegistration {
  key: string;
  kind: PageNodeKind;
  root: () => object | null;
  read?: (reader: RenderedReader) => RenderedNode;
  ownerKey?: string;
}
export interface PageActionBindingRegistration {
  key: string;
  viewKey: string;
  action: string;
  target: () => object | null;
  trigger: () => object | null;
  objectKey: () => string;
  argumentBindings?: () => Record<string, unknown>;
  guard: {scope: 'target' | 'row' | 'form' | 'selection'; relatedViews?: string[]};
}
export interface PageAdapter {
  capture(views: PageViewRegistration[], bindings: PageActionBindingRegistration[], refs: PageReferences, actionIdentity: (name: string) => string | undefined): PageCapture;
  resolveTrigger?(binding: PageActionBindingRegistration): object | null;
  reset?(): void;
}
