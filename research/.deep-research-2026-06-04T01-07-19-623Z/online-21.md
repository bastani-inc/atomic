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