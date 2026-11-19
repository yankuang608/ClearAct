import assert from 'node:assert/strict';
export const registry = 'https://registry.npmjs.org/';
export function validatePlan(plan) {
  assert.equal(plan.schema, 1);
  assert.equal(plan.tag, 'beta', 'Only the explicit beta dist-tag is supported');
  assert.equal(plan.registry, registry);
  assert.equal(plan.access, 'restricted');
  assert.ok(Array.isArray(plan.packages) && plan.packages.length > 0);
  const names = new Set();
  for (const pkg of plan.packages) {
    assert.match(pkg.name, /^@clearact\/[a-z][a-z-]*$/);
    assert.ok(!names.has(pkg.name), 'Duplicate package'); names.add(pkg.name);
    assert.match(pkg.version, /^\d+\.\d+\.\d+-beta(?:\.\d+)?$/, 'Release must be beta, never stable/latest');
  }
  return plan;
}
export function publicationGate(env) {
  assert.equal(env.CLEARACT_NPM_PUBLISH_ENABLED, 'true', 'Publishing is disabled');
  assert.equal(env.CLEARACT_NPM_REGISTRY, registry, 'Registry must be explicitly allowed');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Automatic publishing is CI-only');
  assert.equal(env.CLEARACT_APPROVED_RELEASE_SHA, env.GITHUB_SHA, 'Exact approved merge SHA required');
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/);
}
