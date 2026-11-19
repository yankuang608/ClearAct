# Changesets

Use `pnpm changeset` for user-facing changes; see [release guide](../docs/RELEASING.md).
React and Vue are independent. There are no fixed/linked package groups. Let Changesets propagate real incompatible internal dependency updates, then review every generated range/version.
Initial unpublished review baseline is exactly `0.0.1-beta`; later supported beta pre-mode may generate numbered prereleases. Never publish with Changesets directly: only the disabled-by-default, reviewed beta artifact workflow may publish after separate registry setup.
