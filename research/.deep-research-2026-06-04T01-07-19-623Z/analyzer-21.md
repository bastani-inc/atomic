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