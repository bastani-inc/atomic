I can’t write the file directly in this environment, but here are the findings to paste into `research/docs/2026-06-26-issue-1517-context-owner-locator.md`.

## File Locations for ExtensionContext ownership + widget rendering

### Implementation Files
- `packages/coding-agent/src/core/extensions/context-types.ts` — `ExtensionContext` / `ExtensionCommandContext` / `ReplacedSessionContext` definitions, including UI ownership surface (`ui`, `hasUI`, `mode`, `cwd`, session methods). **Inspect:** lines ~1-120
- `packages/coding-agent/src/core/extensions/runner-context.ts` — fresh wrapper creation for `ExtensionContext` and `ExtensionCommandContext`, lazy guarded getters, stale-context protection. **Inspect:** lines ~1-170
- `packages/coding-agent/src/modes/interactive/interactive-extension-runtime.ts` — constructs per-call `ExtensionContext` for shortcuts and wires `ui`, `setWidget`, `requestRender`, `setFooter`, etc. **Inspect:** lines ~1-220
- `packages/coding-agent/src/modes/interactive/interactive-extension-context.ts` — interactive UI ownership helpers (`createExtensionUIContext`, `setWidget`-adjacent UI state, focus/render callbacks). **Inspect:** lines ~1-180
- `packages/coding-agent/src/modes/interactive/interactive-extension-widgets.ts` — interactive widget ownership/render plumbing (`setExtensionWidget`, `renderWidgets`, footer/header placement, requestRender after widget swaps). **Inspect:** lines ~1-120
- `packages/coding-agent/src/core/extensions/reactive-widget.ts` — reactive widget helper API (`installReactiveWidget`, `setWidget`, `requestRender`, mount/update/unmount decisions). **Inspect:** lines ~1-260
- `packages/coding-agent/src/index-extensions.ts` — extension API export surface including `ExtensionContext`, `ReactiveWidget*`, `installReactiveWidget`. **Inspect:** lines ~1-120

### Subagent / Widget Display Files
- `packages/subagents/src/extension/index.ts` — subagent extension registration, async-widget lifecycle hookup, `renderWidget` integration, UI cleanup, `setWidget(... belowEditor)` ownership. **Inspect:** lines ~1-260 and ~440-520
- `packages/subagents/src/tui/render-widget.ts` — async subagent widget singleton ownership, mount/update/unmount, requestRender fallback, animation ticker. **Inspect:** lines ~1-320
- `packages/subagents/src/tui/render-widget-graph.ts` — widget line construction/helpers for subagent display. **Inspect:** lines ~1-140
- `packages/subagents/src/runs/background/async-job-tracker.ts` — hydrates active jobs and drives widget mounting/updating from session state. **Inspect:** search within file for `setWidget`, `requestRender`, `hydrateActiveJobs`, `resetJobs` (file not opened here; likely around tracker methods)
- `packages/intercom/reply-tracker.ts` — not widget UI, but relevant ownership/state tracker pattern for reply context. **Inspect:** lines ~1-140

### Tests
- `test/unit/reactive-widget.test.ts` — `installReactiveWidget` mount/update/unmount, render coalescing, fallback requestRender, timer cleanup. **Inspect:** lines ~1-260
- `test/unit/subagents-async-widget-visibility.test.ts` — subagent widget hydration, belowEditor placement, visible update behavior. **Inspect:** lines ~1-260
- `test/unit/subagents-render-stability-running-widget.ts` — subagent widget animation / stable captured-now rendering. **Inspect:** lines ~1-180
- `test/unit/subagents-render-stability-widget-lifecycle.ts` — widget remount/unmount lifecycle and requestRender behavior. **Inspect:** lines ~1-260
- `test/unit/widget-rendering.test.ts` — general widget rendering layout/visibility contract. **Inspect:** lines ~1-260
- `test/unit/mcp-stale-context-init.test.ts` — stale ExtensionContext / cancellation behavior under async init race. **Inspect:** lines ~1-180
- `test/unit/extension.test.ts` — extension factory / session switch behavior around context ownership. **Inspect:** lines ~1-220
- `test/unit/changelog.test.ts` — changelog parser coverage (if you need changelog-related test surface). **Inspect:** lines ~1-120

### Documentation
- `packages/coding-agent/docs/extensions.md` — ExtensionContext / UI / custom widget docs, including `setWidget`, `requestRender`, `custom`, `setFooter`, `setHeader`. **Inspect:** lines ~1-260 and the `ExtensionContext` / `Custom UI` sections later in the file
- `packages/coding-agent/docs/subagents.md` — bundled subagent behavior, fresh/fork context notes, async/background widget behavior. **Inspect:** lines ~1-220
- `research/docs/2026-06-26-issue-1517-subagent-ui-lifecycle-analysis.md` — related research note. **Inspect:** entire file
- `research/docs/2026-06-26-issue-1517-subagent-ui-locator.md` — prior locator doc for the same issue family. **Inspect:** entire file
- `specs/2026-06-26-implement-github-issue-https-github-com-bastani-inc-atomic-issues-1274-in-this-r.md` — likely adjacent spec surface. **Inspect:** entire file if you need issue-linked context

### Changelog / Release Notes
- `packages/workflows/CHANGELOG.md` — package changelog surface (likely relevant if widget/context behavior shipped there). **Inspect:** top release sections
- `packages/intercom/CHANGELOG.md` — related runtime/state behavior release notes. **Inspect:** top release sections
- `packages/mcp/CHANGELOG.md` — relevant if stale-context/init changes touched MCP startup. **Inspect:** top release sections

### Related Directories
- `packages/coding-agent/src/modes/interactive/` — interactive UI/context/widget cluster
- `packages/coding-agent/src/core/extensions/` — extension context/runtime/helper cluster
- `packages/subagents/src/tui/` — async widget rendering cluster
- `packages/subagents/src/runs/background/` — async job tracking / widget hydration cluster
- `test/unit/` — widget/context regression tests cluster
- `packages/coding-agent/docs/` — extension/subagent documentation cluster
- `research/docs/` and `specs/` — issue-adjacent design/research notes