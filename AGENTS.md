# ClearAct contributor guide

This repository owns the reusable framework, SDK, protocol, self-contained fixtures and regression tests. WebWorkBench owns real application setup, app-specific adapters, business verifiers, datasets and experiment evidence. Do not import another checkout's source or require WebWorkBench in SDK CI.

Read package scripts and docs/PACKAGES.md before editing. Use the pinned pnpm version. Validate relevant regressions, then `pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm check:packages`. Distinguish failed tests from environment-blocked browser/socket checks.

User-visible SDK changes need a Changeset. Release versioning and registry publication are separate; follow docs/RELEASING.md. Never infer permission to publish, merge, change registry visibility or select a license from a code-edit request.

Do not modify historical experiment claims. Link to immutable evidence in WebWorkBench. Ignore generated artifacts; never discard unique source, trajectories or local-only data. Check `.agents/skills/` if present and read only relevant Skills.
