// SPDX-License-Identifier: MIT
import {
  inject,
  onMounted,
  onUnmounted,
  onUpdated,
  type App,
  type InjectionKey,
} from "vue";
import type { ClearActAction, ClearActRuntime, PageViewRegistration, PageActionBindingRegistration } from "@clearact/core";
const RuntimeKey: InjectionKey<ClearActRuntime> = Symbol("clearact-runtime");
export function createClearActPlugin(runtime: ClearActRuntime) {
  return {
    install(app: App) {
      app.provide(RuntimeKey, runtime);
      runtime.connect();
    },
  };
}
export function useClearActRuntime(): ClearActRuntime {
  const runtime = inject(RuntimeKey);
  if (!runtime) throw new Error("ClearAct agent plugin is required");
  return runtime;
}
export function useClearActAction(action: ClearActAction): void {
  const runtime = useClearActRuntime();
  let unregister: (() => void) | undefined;
  onMounted(() => {
    unregister = runtime.registerAction(action);
  });
  onUnmounted(() => unregister?.());
}

let nextViewInstance = 0;
type ViewSource<T> = T | (() => T);
const current = <T>(source: ViewSource<T>): T => typeof source === 'function' ? (source as () => T)() : source;

/** Runs after Vue commits; no form model or pending render is exposed. */
export function useClearActView(source: ViewSource<PageViewRegistration>): string {
  const runtime = useClearActRuntime();
  let committed = current(source);
  const key = `vue-${++nextViewInstance}:${committed.key}`;
  let unregister: (() => void) | undefined;
  let signature = '';
  const update = () => {
    committed = current(source);
    const next = JSON.stringify({kind:committed.kind,ownerKey:committed.ownerKey});
    if (unregister && next === signature) return;
    unregister?.(); signature = next;
    unregister = runtime.registerView({
      key, kind:committed.kind, ownerKey:committed.ownerKey,
      root: () => committed.root(),
      read: reader => committed.read ? committed.read(reader) : reader.native(undefined, committed.kind),
    });
  };
  onMounted(update); onUpdated(update); onUnmounted(() => unregister?.());
  return key;
}

export function useClearActActionBinding(source: ViewSource<PageActionBindingRegistration>): void {
  const runtime = useClearActRuntime();
  let committed = current(source);
  const instance = `vue-binding-${++nextViewInstance}`;
  let unregister: (() => void) | undefined;
  let signature = '';
  const update = () => {
    committed = current(source);
    const next = JSON.stringify({key:committed.key,viewKey:committed.viewKey,action:committed.action,guard:committed.guard});
    if (unregister && next === signature) return;
    unregister?.(); signature = next;
    unregister = runtime.registerActionBinding({
      ...committed,key:`${instance}:${committed.key}`,
      target: () => committed.target(), trigger: () => committed.trigger(), objectKey: () => committed.objectKey(),
      argumentBindings: () => committed.argumentBindings?.() ?? {},
    });
  };
  onMounted(update); onUpdated(update); onUnmounted(() => unregister?.());
}
