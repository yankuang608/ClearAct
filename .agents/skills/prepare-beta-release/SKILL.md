---
name: prepare-beta-release
description: Prepare a review-only ClearAct beta version PR and local artifacts, without publishing or changing registry settings.
---
Read docs/RELEASING.md and VERSIONS.md. Use pinned pnpm. Keep React/Vue independent; inspect Changesets downstream dependency updates rather than forcing a fixed group. Run release policy and offline publisher tests, typecheck, SDK tests, build and independent package consumers. Record browser/environment blockers separately. Verify the release plan selects only beta versions and the exact tarball manifest. Never infer permission to configure secrets, bootstrap npm names, activate publishing, push/merge, or publish from a preparation request. Preserve historical experiment locks and prior review artifacts.
