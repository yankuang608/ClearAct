// SPDX-License-Identifier: MIT
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import type { ClearActAction, ClearActRuntime, PageViewRegistration, PageActionBindingRegistration } from "@clearact/core";
const useCommittedEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;
const Context = createContext<ClearActRuntime | null>(null);
export function ClearActProvider({
  runtime,
  children,
}: {
  runtime: ClearActRuntime;
  children: ReactNode;
}) {
  useEffect(() => {
    runtime.connect();
    return () => runtime.disconnect();
  }, [runtime]);
  return createElement(Context.Provider, { value: runtime }, children);
}
export function useClearActRuntime(): ClearActRuntime {
  const runtime = useContext(Context);
  if (!runtime) throw new Error("ClearActProvider is required");
  return runtime;
}
/** Keep the handler fresh without disrupting registration on unrelated renders. */
export function useClearActAction(action: ClearActAction): void {
  const runtime = useClearActRuntime();
  const latest = useRef(action);
  useCommittedEffect(() => {latest.current = action;});
  const { execute, ...metadata } = action;
  const signature = JSON.stringify(metadata);
  useCommittedEffect(
    () =>
      runtime.registerAction({
        ...JSON.parse(signature),
        execute: (input, context) => latest.current.execute(input, context),
      }),
    [runtime, signature],
  );
}

/** Registers only committed UI. The returned key can own portals and action bindings. */
export function useClearActView(view: PageViewRegistration): string {
  const runtime = useClearActRuntime();
  const instance = useId();
  const key = `${instance}:${view.key}`;
  const committed = useRef(view);
  useCommittedEffect(() => {committed.current = view;});
  useCommittedEffect(() => runtime.registerView({
    key, kind: view.kind, ownerKey: view.ownerKey,
    root: () => committed.current.root(),
    read: reader => committed.current.read ? committed.current.read(reader) : reader.native(undefined, committed.current.kind),
  }), [runtime, key, view.kind, view.ownerKey]);
  return key;
}

export function useClearActActionBinding(binding: PageActionBindingRegistration): void {
  const runtime = useClearActRuntime();
  const instance = useId();
  const committed = useRef(binding);
  const signature = JSON.stringify({key:binding.key,viewKey:binding.viewKey,action:binding.action,guard:binding.guard});
  useCommittedEffect(() => {committed.current = binding;});
  useCommittedEffect(() => runtime.registerActionBinding({
    ...JSON.parse(signature), key:`${instance}:${binding.key}`,
    target: () => committed.current.target(), trigger: () => committed.current.trigger(),
    objectKey: () => committed.current.objectKey(),
    argumentBindings: () => committed.current.argumentBindings?.() ?? {},
  }), [runtime, instance, signature]);
}
