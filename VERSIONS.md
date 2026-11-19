# Snapshot versions

All eight distributable packages use exact `0.0.1-beta`. This is a new no-history source snapshot candidate, not a published npm release. The private workspace root is not distributed.

React and Vue are independently versioned by Changesets. No fixed or linked group is configured; real core dependency changes may legitimately propagate downstream. Future supported prerelease mode can generate numbered beta versions. Review all dependency ranges and tarballs before any release.

No old repository commits, prior release records, PRs, credentials, or image locks are included. The original project source is MIT-licensed. Public repository creation and registry publication remain separate decisions. See docs/RELEASING.md.
