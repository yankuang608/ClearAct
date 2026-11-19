# Local versioning; publication not activated

Use Node 24 and pinned pnpm 10.30.2. Eight package manifests start at exact `0.0.1-beta`. React and Vue are independent (`fixed: []`, `linked: []`), while core dependency changes can propagate through Changesets. For later prereleases use supported `changeset pre enter beta`, Changesets and `version:packages`; inspect generated numbered beta versions and packed workspace ranges.

Only the read-only validation workflow is active in this snapshot. `docs/templates/beta-release-workflow.yml.example` is an INACTIVE reference, not a workflow and not approval to install it. There is no release-plan.json, trusted publisher identity, publishing secret or enable switch carried over from another repository. `scripts/release-publish.mjs` fails closed without separately authorized CI configuration.

Before activating any publishing: retain and verify MIT and all third-party notices, confirm npm scope/package ownership and access, approve first publication for nonexistent packages, create a new exact artifact release plan, configure per-package trusted publisher against the new repository/workflow, and authorize metadata read credentials separately if restricted package lookup needs them. npm OIDC does not grant npm view access. Do not copy old repository secrets or settings. A qualified review of the version PR is required; one maintainer cannot satisfy an independent reviewer requirement alone.

Use explicit beta tag; do not invoke Changesets publish blindly for first prereleases or assume latest remains untouched. Public source availability does not itself authorize npm publishing or public provenance. Tests, pack, dry run, OIDC and actual upload are separate outcomes. Never publish during local preparation.

Official setup references: https://docs.npmjs.com/trusted-publishers/ ; https://docs.npmjs.com/cli/v11/commands/npm-trust/ ; https://changesets.dev/guide/prereleases/ . Consult their current requirements before setup.
