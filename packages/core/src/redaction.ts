// SPDX-License-Identifier: MIT
import type {ClearActJsonObject} from './types.ts';

const REDACTED = '[REDACTED]';
const object = (value: unknown): value is ClearActJsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

type ReferenceResolver = (schema: ClearActJsonObject, reference: string) => unknown[];
const UNRESOLVED_REFERENCE = {writeOnly: true};

/** Index only this action's schema document. References outside it fail closed. */
function referenceResolver(root: ClearActJsonObject): ReferenceResolver {
  const initialBase = "https://clearact.invalid/schema";
  const bases = new WeakMap<object, Set<string>>();
  const targets = new Map<string, unknown[]>();
  const documents = new Map<string, unknown[]>();
  const uri = (reference: string, base: string): string | undefined => {
    try {return new URL(reference, base).href;} catch {return undefined;}
  };
  const add = (index: Map<string, unknown[]>, key: string, value: unknown) => {
    const values = index.get(key) ?? [];
    if (!values.includes(value)) values.push(value);
    index.set(key, values);
  };
  const index = (value: unknown, inheritedBase: string): void => {
    if (Array.isArray(value)) {value.forEach(child => index(child, inheritedBase)); return;}
    if (!object(value)) return;
    const base = typeof value.$id === 'string' ? uri(value.$id, inheritedBase) ?? inheritedBase : inheritedBase;
    const known = bases.get(value) ?? new Set<string>();
    if (known.has(base)) return;
    known.add(base); bases.set(value, known);
    if (typeof value.$id === 'string') {
      add(targets, base, value);
      if (!new URL(base).hash) add(documents, base.split('#')[0]!, value);
    }
    if (typeof value.$anchor === 'string') {
      const anchor = uri('#' + value.$anchor, base);
      if (anchor) add(targets, anchor, value);
    }
    // Include all schema positions conservatively; duplicate identifiers never
    // overwrite an earlier annotation, including annotations in alternatives.
    Object.values(value).forEach(child => index(child, base));
  };
  add(documents, initialBase, root);
  index(root, initialBase);
  return (schema, reference) => {
    const result = new Set<unknown>();
    for (const base of bases.get(schema) ?? [initialBase]) {
      const resolved = uri(reference, base);
      const found = new Set<unknown>(resolved ? targets.get(resolved) : []);
      if (resolved) {
        const url = new URL(resolved);
        try {
          const fragment = decodeURIComponent(url.hash.slice(1));
          for (const document of documents.get(resolved.split('#')[0]!) ?? []) {
            let value = document;
            if (fragment && !fragment.startsWith('/')) continue;
            for (const part of fragment ? fragment.slice(1).split('/') : []) {
              const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
              value = object(value) || Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
            }
            if (value !== undefined) found.add(value);
          }
        } catch { /* An invalid fragment is concealed rather than silently exposed. */ }
      }
      if (!found.size) found.add(UNRESOLVED_REFERENCE);
      found.forEach(value => result.add(value));
    }
    return [...result];
  };
}

function schemas(schema: unknown, resolve: ReferenceResolver, seen = new Set<unknown>()): ClearActJsonObject[] {
  if (!object(schema) || seen.has(schema)) return [];
  seen.add(schema);
  const result = [schema];
  if (typeof schema.$ref === 'string')
    for (const referenced of resolve(schema, schema.$ref)) result.push(...schemas(referenced, resolve, seen));
  // A secret annotation in any alternative is enough: validation chooses the
  // branch; observation conservatively conceals all potentially secret fields.
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(schema[keyword]))
    for (const branch of schema[keyword]) result.push(...schemas(branch, resolve, seen));
  for (const keyword of ['if', 'then', 'else']) result.push(...schemas(schema[keyword], resolve, seen));
  for (const keyword of ['dependencies', 'dependentSchemas']) if (object(schema[keyword]))
    for (const dependency of Object.values(schema[keyword])) result.push(...schemas(dependency, resolve, seen));
  return result;
}

/** Internal shared policy: implementations receive input, observers receive its
 * writeOnly projection. Only nonempty string secrets are used to scrub echoes. */
export function privateArguments(input: ClearActJsonObject, schema: ClearActJsonObject): {arguments: ClearActJsonObject; secrets: string[]} {
  const secrets = new Set<string>();
  const resolve = referenceResolver(schema);
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value) secrets.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (object(value)) Object.values(value).forEach(collect);
  };
  const visit = (value: unknown, candidates: unknown[]): unknown => {
    const applicable = candidates.flatMap(candidate => schemas(candidate, resolve));
    if (applicable.some(candidate => candidate.writeOnly === true)) {collect(value); return REDACTED;}
    if (Array.isArray(value)) return value.map((item, index) => {
      const children: unknown[] = [];
      for (const candidate of applicable) {
        if (Array.isArray(candidate.items)) children.push(candidate.items[index] ?? candidate.additionalItems);
        else if (Array.isArray(candidate.prefixItems)) children.push(candidate.prefixItems[index] ?? candidate.items);
        else children.push(candidate.items);
        children.push(candidate.contains);
      }
      return visit(item, children);
    });
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const children: unknown[] = [];
      for (const candidate of applicable) {
        let covered = false;
        if (object(candidate.properties) && Object.hasOwn(candidate.properties, key)) {children.push(candidate.properties[key]); covered = true;}
        if (object(candidate.patternProperties)) for (const [pattern, child] of Object.entries(candidate.patternProperties))
          if (new RegExp(pattern).test(key)) {children.push(child); covered = true;}
        if (!covered) children.push(candidate.additionalProperties);
      }
      return [key, visit(item, children)];
    }));
    return value;
  };
  const projected = visit(input, [schema]);
  const privateStrings = [...secrets].sort((a, b) => b.length - a.length);
  return {arguments: scrubSecretEcho(object(projected) ? projected : {$redacted: REDACTED}, privateStrings, true), secrets: privateStrings};
}

export function scrubSecretEcho<T>(value: T, secrets: readonly string[], preserveKeys = false): T {
  if (!secrets.length) return value;
  // Match the transport's JSON semantics once before filtering. In particular,
  // toJSON results must not retain functions that could run again after scrubbing.
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return undefined as T;
  const normalized: unknown = JSON.parse(serialized);
  const alternatives = [...new Set([REDACTED, ...secrets])].filter(Boolean).sort((a, b) => b.length - a.length)
    .map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(alternatives.join('|'), 'g');
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') {
      // Generated markers must survive repeated broker/runtime projections,
      // and a later short secret must not rewrite an earlier replacement.
      return item.replace(pattern, REDACTED);
    }
    if (Array.isArray(item)) return item.map(child => visit(child));
    if (object(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [preserveKeys ? key : visit(key), visit(child)]));
    return item;
  };
  return visit(normalized) as T;
}
