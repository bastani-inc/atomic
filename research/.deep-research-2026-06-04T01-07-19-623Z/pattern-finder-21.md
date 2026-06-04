## 1. Established patterns

- **Utility modules are small, cross-cutting, and CLI-adjacent.**  
  This partition groups “support” features rather than core chat/runtime logic:
  - `packages/coding-agent/src/core/export-html/**`
  - `packages/coding-agent/src/utils/changelog.ts`
  - `packages/coding-agent/src/utils/version-check.ts`

- **Formatting/export features are treated as reusable subsystems, not one-off commands.**  
  The scout groups HTML export with sharing/versioning, which suggests a pattern of generating artifacts for external consumption rather than only internal state.

- **Versioning is centralized.**  
  Version-related behavior is not scattered; it is tied to repo-wide release mechanics:
  - `scripts/bump-version.ts`
  - `packages/*/package.json`
  - changelog files under `packages/*/CHANGELOG.md`

- **Changelog/version checks are part of the release surface.**  
  They align with repo conventions described in `AGENTS.md`: version bumps, changelog updates, and publish flow are standardized, not ad hoc.

- **Documentation contracts matter.**  
  The scout explicitly points to canonical docs for preserving behavior. For this partition, the most relevant “contract” mindset is: if Rust replaces these utilities, preserve the output format and update/version semantics users expect.

## 2. Variations / exceptions

- **HTML export is likely a presentation layer concern; version/check utilities are operational concerns.**  
  These are grouped together in the partition, but they serve different migration goals:
  - export/share = user-facing artifact generation
  - changelog/version-check = repo/process automation

- **“Sharing” may not be a core protocol.**  
  It may be implemented as HTML generation plus optional transport/storage, so it’s more likely to be swappable than session/runtime code.

- **Update/version-check behavior may depend on release conventions outside the utility file itself.**  
  The repo’s release flow is already driven by top-level scripts and changelogs, so these helpers may be thin wrappers around a broader convention rather than independent logic.

## 3. Anti-patterns or risks

- **Hidden coupling to release flow.**  
  If `version-check.ts` assumes Bun/TypeScript package metadata layout, a Rust port can accidentally break release automation or changelog validation.

- **Output-format drift risk for HTML export.**  
  Export/share utilities often look simple but encode a stable HTML/CSS structure. Reimplementing in Rust risks changing the exact output users rely on.

- **Duplication with top-level scripts.**  
  `utils/changelog.ts` and `utils/version-check.ts` may overlap with `scripts/bump-version.ts` and publish docs. That can create split responsibility during migration unless one source of truth is chosen.

- **Potential overfitting to current monorepo layout.**  
  If these utilities read `packages/*/package.json` directly, they may be tightly coupled to the current workspace shape, making Rust extraction harder than it looks.

## 4. Evidence index

- `research/.deep-research-2026-06-04T01-07-19-623Z/00-codebase-scout.md`
  - Section 2: key paths
    - `packages/coding-agent/src/core/export-html/**`
    - `packages/coding-agent/src/utils/changelog.ts`
    - `packages/coding-agent/src/utils/version-check.ts`
  - Section 3: suggested partition 19 — `HTML export/share/version/update`
  - Section 4: risks around backwards compatibility and release tooling
- `AGENTS.md`
  - release/version workflow
  - changelog rules
  - `scripts/bump-version.ts`
  - package version sync conventions