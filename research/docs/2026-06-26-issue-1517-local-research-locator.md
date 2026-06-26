# Issue #1517 Local Research Locator

## Related Docs

- 🟢 `research/docs/2026-03-25-opentui-react-antipattern-audit.md` — OpenTUI + React anti-pattern audit; good for renderer/focus/state coordination context around TUI flicker.
  - Key sections: summary on OpenTUI/React architecture; anti-pattern hotspots in orchestration hooks and rendering patterns.
- 🟢 `research/docs/2026-03-12-copilot-post-stream-file-warning-rendering-bug.md` — Copilot post-stream rendering bug; relevant for terminal UI repaint / post-stream display issues.
- 🟢 `research/docs/2026-02-28-workflow-tui-rendering-unification-refactor.md` — Workflow TUI rendering unification refactor; relevant to shared rendering paths and flicker-like ordering issues.
- 🟢 `research/docs/2026-02-27-workflow-tui-rendering-unification.md` — Workflow TUI rendering unification; prior architecture for consistent chat/workflow display.
- 🟢 `research/docs/2026-02-16-opentui-rendering-architecture.md` — OpenTUI rendering architecture; foundational reference for dirty tracking, layout, and repaint behavior.
  - Key sections: `BaseRenderable`, Yoga layout, dirty tracking, focus management, z-index ordering.
- 🟢 `research/docs/2026-02-16-ui-inline-streaming-vs-pinned-elements.md` — UI inline streaming vs pinned elements; directly relevant to streamed content appearing out of order relative to sub-agent/task UI.
- 🟢 `research/docs/2026-02-15-subagent-premature-completion-quick-ref.md` — Quick reference for sub-agent premature completion; tracks status finalization bug in `tool.complete`.
  - Key section: `src/ui/index.ts:658` status forced to completed on `tool.complete`.
- 🟢 `research/docs/2026-02-15-sub-agent-tree-status-lifecycle-sdk-parity.md` — Sub-agent tree status lifecycle while background agents run; strongest match for sub-agent display lifecycle bugs.
  - Key sections: status model, live event pipeline, and streaming-time UI update mechanics.
- 🟢 `research/docs/2026-02-15-subagent-event-flow-diagram.md` — Sub-agent event flow diagram; useful for where display updates should happen in the pipeline.
- 🟢 `research/docs/2026-02-15-subagent-premature-completion-investigation.md` — Investigation into premature completion; likely superseded by the quick ref / lifecycle doc above.
- 🟢 `research/docs/2026-02-12-sub-agent-sdk-integration-analysis.md` — Built-in commands and custom sub-agent hookup verification; background on sub-agent wiring and SDK integration.
- 🟢 `research/docs/2026-02-05-subagent-ui-opentui-independent-context.md` — Sub-agent UI with OpenTUI and independent context windows; early target UI / sub-agent rendering research.
- 🟢 `research/docs/2026-02-01-chat-tui-parity-implementation.md` — Chat TUI parity implementation; general chat rendering baseline.
- 🟢 `research/docs/2026-02-01-claude-code-ui-patterns-for-atomic.md` — Claude Code UI patterns for Atomic; useful design reference for terminal UI behavior.

## Related Subagent Notes

- 🟢 `research/subagents/issue-1445-prior-research.md` — Not issue-1517, but useful as a locator-style example and repository-docs pattern reference.

## Closest Overlap / Potentially Superseded

- 🟢 `research/docs/2026-02-15-subagent-premature-completion-quick-ref.md` and `research/docs/2026-02-15-sub-agent-tree-status-lifecycle-sdk-parity.md` likely supersede older sub-agent lifecycle notes:
  - `research/docs/2026-02-15-subagent-premature-completion-investigation.md`
  - `research/docs/2026-02-15-subagent-premature-completion-fix-comparison.md`
- 🟢 `research/docs/2026-02-16-ui-inline-streaming-vs-pinned-elements.md` likely supersedes older ordering-only notes:
  - `research/docs/2026-02-12-tui-layout-streaming-content-ordering.md`

## No Exact Match Found

- No filename matched `1517`, `flicker`, or `Ink` directly in `research/`.
- Best local matches are the sub-agent lifecycle / rendering-order docs above.

**Total:** 14 relevant artifacts found  
**Recent (🟢):** 14