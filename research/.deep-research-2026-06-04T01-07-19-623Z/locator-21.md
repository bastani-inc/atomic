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