## 1. Must-read paths

- `packages/workflows/src/shared/store.ts`  
  Core in-memory workflow state machine: run/stage records, lifecycle transitions, prompt state, session metadata, and snapshot generation. This is the main “graph store” for migration.

- `packages/workflows/src/shared/store-types.ts`  
  Defines the persisted/live graph shape: `RunSnapshot`, `StageSnapshot`, `RunStatus`, `StageStatus`, child-run refs, `sessionId`, `sessionFile`, `rootRunId`, `resumedFromRunId`, etc.

- `packages/workflows/src/shared/expanded-workflow-graph.ts`  
  View-layer graph expansion/flattening for nested workflows. Important if Rust replaces graph rendering/lookup logic.

- `packages/workflows/src/shared/persistence-session-entries.ts`  
  Writes workflow lifecycle entries into session transcripts (`workflow.run.start`, `workflow.stage.start`, `workflow.stage.end`, `workflow.run.end`). This is the persistence contract.

- `packages/workflows/src/shared/persistence-restore.ts`  
  Rehydrates runs/stages from session entries on startup. Critical for crash recovery and “resume in flight” behavior.

- `packages/workflows/src/extension/status-writer.ts`  
  Atomic JSON status file writer for CI polling (`.atomic/workflows/status.json`). Includes file path resolution and deduped write-failure notices.

- `packages/workflows/src/runs/background/status.ts`  
  Status/kill/resume helpers, including graph-based stage counting and terminal run handling. This is the main consumer of store + graph expansion.

## 2. Supporting paths

- `packages/workflows/src/extension/index.ts`  
  Wires persistence/status writer into the extension runtime. Search around `createStatusWriter`, `makePersistencePort`, and `restoreOnSessionStart`.

- `packages/workflows/src/extension/runtime.ts`  
  Runtime setup path where workflow runs are created and metadata is forwarded into store/persistence.

- `packages/workflows/src/runs/foreground/executor.ts`  
  Populates run/stage metadata and appends persistence entries during execution.

- `packages/workflows/src/runs/foreground/stage-runner.ts`  
  Source of `sessionId` / `sessionFile` attachment metadata for stages.

- `packages/workflows/src/runs/foreground/stage-control-registry.ts`  
  Live control handles for paused/resumed stages; relevant for persisted run state.

- `packages/workflows/src/tui/graph-view.ts`  
  UI consumer of the expanded workflow graph.

- `packages/workflows/src/tui/widget.ts`  
  Uses top-level vs nested run visibility and graph-related filtering.

- `packages/workflows/src/tui/status-list.ts` / `status-helpers.ts` / `run-detail.ts`  
  Render status surfaces from store snapshots.

## 3. Entry points / symbols

- `createStore()` in `packages/workflows/src/shared/store.ts`
- `recordRunStart`, `recordRunEnd`, `recordStageStart`, `recordStageEnd`
- `recordStageSession`, `recordStageWorkflowChildRun`
- `snapshot()`, `subscribe()`, `clear()`
- `expandWorkflowGraph(snapshot, rootRunId)` in `packages/workflows/src/shared/expanded-workflow-graph.ts`
- `appendRunStart`, `appendStageStart`, `appendStageEnd`, `appendRunEnd` in `packages/workflows/src/shared/persistence-session-entries.ts`
- `restoreOnSessionStart(...)` in `packages/workflows/src/shared/persistence-restore.ts`
- `resolveStatusFilePath`, `atomicWriteJson`, `createStatusWriter` in `packages/workflows/src/extension/status-writer.ts`
- `statusRuns`, `killRun`, `killAllRuns`, `resumeRun`, `pauseRun`, `interruptRun` in `packages/workflows/src/runs/background/status.ts`

## 4. Gaps or uncertainty

- There is **no dedicated file literally named “graph store”**; the functionality appears split across `store.ts`, `expanded-workflow-graph.ts`, and TUI consumers.
- I could not fully verify all runtime call sites for status persistence in one pass; `extension/index.ts` and `runtime.ts` are the likely integration points.
- The exact session-entry schema is partly inferred from helper functions/tests; if you need Rust parity, confirm against session transcript format docs and any upstream pi session API.