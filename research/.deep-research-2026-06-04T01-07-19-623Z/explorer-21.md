## Partition 21: HTML export, sharing, changelog, and update/version-check utilities

### Locator
## 1. Must-read paths

- `packages/coding-agent/src/core/export-html/index.ts`  
  Main HTML export pipeline: `exportSessionToHtml()` and `exportFromFile()`. This is the core “session → shareable HTML” contract.
- `packages/coding-agent/src/core/export-html/template.html`  
  HTML shell injected with session data, CSS, JS, marked/highlight assets.
- `packages/coding-agent/src/core/export-html/template.js`  
  Client-side share viewer logic; important for what the exported artifact can do.
- `packages/coding-agent/src/utils/changelog.ts`  
  `parseChangelog()`, `getNewEntries()`, `getEntriesForVersion()`. This defines how release notes are parsed and filtered.
- `packages/coding-agent/src/utils/version-check.ts`  
  `comparePackageVersions()`, `isNewerPackageVersion()`, `getLatestPiRelease()`, `checkForNewPiVersion()`. This is the startup update-check logic.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`  
  Owns `/share`, `/changelog`, startup changelog display, and update notifications.
- `packages/coding-agent/src/config.ts`  
  `getShareViewerUrl()` and changelog URL/config constants; also env gating for update checks.
- `packages/coding-agent/CHANGELOG.md`  
  The release-note source parsed at runtime.
- `scripts/bump-version.ts`  
  Repo-wide version sync tool; critical if Rust migration changes release/versioning flow.
- `docs/ci.md`  
  Shows how changelog/versioning feeds CI and release publishing.

## 2. Supporting paths

- `packages/coding-agent/src/core/agent-session.ts`  
  `exportToHtml()` delegates to `exportSessionToHtml()`; useful for the session API boundary.
- `packages/coding-agent/src/core/atomic-guide-command.ts`  
  Uses changelog parsing to generate “what’s new” help content.
- `packages/coding-agent/src/core/settings-manager.ts`  
  Stores `lastChangelogVersion` and telemetry/update-related preferences.
- `packages/coding-agent/docs/settings.md`  
  Documents `collapseChangelog`, `enableInstallTelemetry`, and update-check env behavior.
- `packages/coding-agent/test/version-check.test.ts`  
  Verifies version comparison and npm-registry lookup behavior.
- `packages/coding-agent/test/export-html-xss.test.ts`  
  Guards export HTML sanitization/security.
- `packages/coding-agent/test/export-html-skill-block.test.ts`  
  Covers skill-block rendering in exported HTML.
- `packages/coding-agent/test/export-html-whitespace.test.ts`  
  Covers HTML output formatting/whitespace behavior.
- `packages/coding-agent/docs/session-format.md`  
  Helps interpret exported session data and tree structure.
- `packages/coding-agent/src/core/slash-commands.ts`  
  Registers `/share` and `/changelog` command availability.

## 3. Entry points / symbols

- `exportSessionToHtml(sm, state?, options?)` — `packages/coding-agent/src/core/export-html/index.ts`
- `exportFromFile(inputPath, options?)` — `packages/coding-agent/src/core/export-html/index.ts`
- `generateHtml(sessionData, themeName?)` — same file, internal HTML assembly
- `preRenderCustomTools(...)` — same file, custom tool rendering path
- `parseChangelog(changelogPath)` — `packages/coding-agent/src/utils/changelog.ts`
- `getNewEntries(entries, lastVersion, currentVersion?)` — same file
- `comparePackageVersions(left, right)` — `packages/coding-agent/src/utils/version-check.ts`
- `checkForNewPiVersion(currentVersion)` — same file
- `getLatestPiRelease()` / `getLatestPiVersion()` — same file
- `InteractiveMode.handleShareCommand()` — `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `InteractiveMode.handleChangelogCommand()` — same file
- `InteractiveMode.getChangelogForDisplay()` — same file
- `InteractiveMode.showNewVersionNotification(newVersion)` — same file
- `getShareViewerUrl(gistId)` — `packages/coding-agent/src/config.ts`
- `scripts/bump-version.ts` targets: package.json version fields + README badges

## 4. Gaps or uncertainty

- I did not verify the full contents of `packages/coding-agent/src/core/export-html/template.js` beyond test assertions, so exact client behavior is only partially evidenced.
- I did not inspect whether there is a dedicated changelog parser test file; changelog logic appears covered indirectly via UI/help paths, but that’s unverified.
- Rust-migration impact is clear for export/share/update flow, but the exact replacement strategy for the HTML template assets (`template.html/css/js`, marked/highlight vendor files) is still open.

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition covers three related user-facing behaviors:

- **HTML export/share**: session data is serialized into a standalone HTML artifact (`exportSessionToHtml`, `exportFromFile`) and also uploaded via `/share` through `gh gist create`.
- **Changelog display**: changelog markdown is parsed from `packages/coding-agent/CHANGELOG.md` and shown either on startup or via `/changelog`.
- **Update/version check**: startup asynchronously checks npm for a newer package version and shows a notification if one exists.

The coupling point is the interactive TUI: it decides when to show startup changelog content, update notices, and the `/share` command flow.

---

## 2. Key flows and invariants

### HTML export
- `exportSessionToHtml(sm, state?, options?)`:
  - requires a file-backed session (`sm.getSessionFile()` must exist)
  - refuses in-memory sessions
  - reads current session entries
  - optionally pre-renders custom tools via `toolRenderer`
  - injects session JSON, theme variables, and vendor JS into `template.html`
  - writes a `.html` file and returns its path

- `exportFromFile(inputPath, options?)`:
  - resolves and validates a session JSONL file
  - opens it with `SessionManager.open(...)`
  - exports with no live `AgentState`
  - same HTML generation path as above

**Invariant:** export output is a fully self-contained HTML snapshot; it embeds session data rather than referencing live runtime state.

### Share flow
- `/share` in interactive mode:
  - checks `gh auth status`
  - exports current session to a temp HTML file
  - runs `gh gist create --public=false <tmpFile>`
  - parses gist ID from stdout
  - constructs a preview URL with `getShareViewerUrl(gistId)`

**Invariant:** sharing depends on GitHub CLI availability and auth; it is not an internal upload mechanism.

### Changelog flow
- `parseChangelog()` reads `CHANGELOG.md` and extracts versioned `##` sections.
- `getNewEntries(entries, lastVersion, currentVersion?)` filters entries:
  - with `currentVersion`, it uses changelog order to avoid treating old upstream sections as “new”
  - without `currentVersion`, it compares semver-like versions directly
- `InteractiveMode.getChangelogForDisplay()`:
  - skips resumed sessions
  - on first run, records current version and reports telemetry, but does not show changelog
  - on subsequent runs, shows only the current-version section if it’s newer than `lastChangelogVersion`
- `/changelog` shows the full parsed changelog, newest-first.

**Invariant:** startup changelog is a “what’s new since last seen version” flow, while `/changelog` is the full local release notes viewer.

### Update/version check
- `checkForNewPiVersion(currentVersion)` fetches latest npm version unless offline/skip flags are set.
- `InteractiveMode.run()` launches it asynchronously and shows a warning if newer.
- Version comparison is tolerant of prerelease strings but falls back to string inequality if parsing fails.

**Invariant:** update checks are non-blocking and failure-tolerant; they never stop the session.

---

## 3. Tests / validation

Good coverage exists, but it’s uneven:

- **Version check**
  - `packages/coding-agent/test/version-check.test.ts`
  - covers semver comparison, npm lookup, skip flag, and latest-version extraction

- **HTML export security/formatting**
  - `export-html-xss.test.ts`
  - `export-html-whitespace.test.ts`
  - `export-html-skill-block.test.ts`
  - these validate sanitization, whitespace behavior, and skill-block rendering assumptions by inspecting template JS/CSS

What’s not clearly covered here:
- end-to-end `/share` behavior
- changelog startup filtering logic
- `getNewEntries(..., currentVersion)` edge cases
- actual HTML output generation from live session data

---

## 4. Risks, unknowns, and verification steps

### Risks
- **Rust migration boundary is sharp here**: HTML export depends on rich session structure, theme data, and pre-rendered tool output.
- **`/share` is shell/CLI coupled** to `gh`; replacing it in Rust may require a different gist/publish strategy.
- **Changelog logic is semver + changelog-order hybrid**, which is easy to regress if reimplemented naively.
- **Startup telemetry/update behavior is side-effectful but non-fatal**; Rust should preserve that “best effort only” behavior.

### Unknowns
- Exact client-side behavior inside `template.js` beyond what tests assert.
- Whether changelog parsing is intended to preserve all formatting nuances of `CHANGELOG.md`.
- Whether any hidden CI coverage exists for startup changelog display or `/share`.

### Verify
- Run or port tests for:
  - version comparison / latest lookup
  - changelog filtering (`lastVersion`, `currentVersion`, prerelease cases)
  - export HTML snapshot/sanitization
- Manually validate:
  - export from a real session
  - share flow with `gh`
  - startup behavior on first run vs update run vs resumed session

### Online Researcher
## 1. Relevant external facts

- **npm registry update check**: `GET https://registry.npmjs.org/<package>/latest` returns package metadata JSON including `name` and `version`. This matches your `getLatestPiRelease()` flow and is the source of truth for update notifications.
- **Timeout API**: the current code uses `AbortSignal.timeout(...)`, which is a JavaScript runtime API, not a Rust primitive. A Rust port needs an equivalent request timeout.
- **Markdown/code highlighting in HTML export**: your export shell inlines browser assets (`marked.min.js`, `highlight.min.js`) and injects session data into an HTML template. That means the export is not just data serialization; it is a full client-side viewer bundle.
- **Changelog version parsing**: the repo’s changelog format is custom but semver-shaped (`## 1.2.3`, `## [1.2.3]`, prereleases like `-alpha.1` and legacy `-N`). Any Rust migration must preserve this parser behavior or release-note display will change.

## 2. Local implications

- **HTML export/share**
  - `exportSessionToHtml()` / `exportFromFile()` currently assemble a standalone HTML file from:
    - session JSONL via `SessionManager`
    - template HTML/CSS/JS
    - vendor JS assets
    - base64-encoded session payload
  - In Rust, this likely becomes:
    - a filesystem/session reader
    - a template renderer
    - embedded static assets
    - careful escaping/sanitization parity for XSS safety

- **Sharing**
  - The exported HTML is meant to be shareable, so the Rust version must preserve:
    - identical output structure
    - tool-call rendering hooks
    - theme variable injection
    - file naming conventions (`APP_NAME-session-*.html`)

- **Changelog**
  - `parseChangelog()` and `getNewEntries()` are tightly coupled to startup UI/help text.
  - A Rust rewrite should keep:
    - header matching rules
    - prerelease comparison order
    - “currentVersion bounds historical entries” behavior

- **Version checks**
  - `checkForNewPiVersion()` is small but behaviorally important:
    - skip when offline or disabled
    - tolerate network failures
    - compare versions robustly
  - Rust will need the same “best effort, never block startup” design.

## 3. Version/API assumptions

- I’m assuming your Rust migration will keep the same **user-visible contract**:
  - exported HTML files remain standalone
  - update checks still query npm
  - changelog display still uses the repo’s `CHANGELOG.md`
- I’m also assuming you’ll replace JS-specific APIs (`fetch`, `AbortSignal.timeout`, base64/templating helpers) with Rust equivalents, not change the product behavior.

## 4. Unverified or unnecessary research

- I could not verify external docs live here because search tooling hit a rate limit.
- I did **not** need deeper external research to understand this partition; the local code already defines the important migration surface.
- If you want, I can next map this partition into a **Rust migration checklist** (files to rewrite, retained contracts, and test coverage).