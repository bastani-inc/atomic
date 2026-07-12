import type { WorkflowExecutionPolicy } from "../shared/types.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import type { RunOpts } from "../runs/foreground/executor.js";
import type { Store } from "../shared/store.js";
import type { WorkflowRegistry } from "../workflows/registry.js";
import {
  isBackendTerminal,
  prepareRuntimeDurableResumable,
  resumeDurableWorkflow as resumeDurableWorkflowAdapter,
  type ResumeDurableDeps,
  type ResumeDurableResult,
} from "../durable/resume-runtime.js";
import { getDurableBackend } from "../durable/factory.js";
import { scanResumableWorkflows } from "../durable/resume-catalog.js";
import { listOpenableCompletedWorkflows } from "../durable/completed-catalog.js";
import {
  openCompletedDurableWorkflow as openCompletedSnapshot,
  type OpenCompletedDurableResult,
} from "../durable/completed-inspection.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";

export interface DurableResumeRuntime {
  resumeDurableWorkflow(
    workflowIdOrPrefix: string,
    options?: { readonly policy?: WorkflowExecutionPolicy },
  ): ResumeDurableResult;
  listDurableResumable(sessionDir?: string): readonly ResumableWorkflowEntry[];
  prepareDurableResumable(
    workflowIdOrPrefix?: string,
    sessionDir?: string,
  ): Promise<readonly ResumableWorkflowEntry[]>;
  prepareCompletedDurable?(): Promise<readonly ResumableWorkflowEntry[]>;
  openCompletedDurableWorkflow?(
    workflowIdOrPrefix: string,
    catalog?: readonly ResumableWorkflowEntry[],
  ): OpenCompletedDurableResult;
}

export interface DurableResumeRuntimeDeps {
  readonly registry: WorkflowRegistry;
  readonly store: Store;
  readonly adapters?: StageAdapters;
  readonly runtimeCwd: string;
  readonly ensureReady: () => Promise<void>;
  readonly resolveDefaultStageSessionDir?: () => string | undefined;
  readonly baseRunOpts: (policy?: WorkflowExecutionPolicy) => RunOpts;
}

export function createDurableResumeRuntime(
  deps: DurableResumeRuntimeDeps,
): DurableResumeRuntime {
  let preparedCatalog: readonly ResumableWorkflowEntry[] = [];
  return {
    resumeDurableWorkflow(workflowIdOrPrefix, options): ResumeDurableResult {
      const adapterDeps: ResumeDurableDeps = {
        registry: deps.registry,
        baseRunOpts: deps.baseRunOpts(options?.policy),
        durableBackend: getDurableBackend(),
      };
      return resumeDurableWorkflowAdapter(workflowIdOrPrefix, adapterDeps, preparedCatalog);
    },
    listDurableResumable(sessionDir): readonly ResumableWorkflowEntry[] {
      const backend = getDurableBackend();
      const live = backend.listResumableWorkflows();
      const dir = sessionDir ?? deps.resolveDefaultStageSessionDir?.();
      if (dir === undefined) return live;
      const scanned = scanResumableWorkflows(dir);
      const liveIds = new Set(live.map((entry) => entry.workflowId));
      const compatible = scanned.filter((entry) =>
        !liveIds.has(entry.workflowId) &&
        backend.getWorkflow(entry.workflowId) !== undefined &&
        !isBackendTerminal(backend, entry.workflowId)
      );
      return [...live, ...compatible];
    },
    async prepareDurableResumable(workflowIdOrPrefix, sessionDir) {
      await deps.ensureReady();
      preparedCatalog = await prepareRuntimeDurableResumable(
        getDurableBackend,
        () => deps.resolveDefaultStageSessionDir?.(),
        workflowIdOrPrefix,
        sessionDir,
      );
      return preparedCatalog;
    },
    async prepareCompletedDurable() {
      await deps.ensureReady();
      const backend = getDurableBackend();
      await backend.hydrateResumableWorkflows?.();
      return listOpenableCompletedWorkflows(backend);
    },
    openCompletedDurableWorkflow(workflowIdOrPrefix, catalog) {
      const backend = getDurableBackend();
      const entry = resolveCatalogEntry(workflowIdOrPrefix, catalog ?? []);
      const handle = backend.getWorkflow(entry?.workflowId ?? workflowIdOrPrefix);
      return openCompletedSnapshot(workflowIdOrPrefix, {
        durableBackend: backend,
        store: deps.store,
        adapters: deps.adapters,
        cwd: handle?.workflowCwd ?? handle?.invocationCwd ?? deps.runtimeCwd,
        defaultSessionDir: deps.resolveDefaultStageSessionDir?.(),
      }, catalog);
    },
  };
}

function resolveCatalogEntry(
  workflowIdOrPrefix: string,
  catalog: readonly ResumableWorkflowEntry[],
): ResumableWorkflowEntry | undefined {
  const exact = catalog.find((entry) => entry.workflowId === workflowIdOrPrefix);
  if (exact !== undefined) return exact;
  const matches = catalog.filter((entry) => entry.workflowId.startsWith(workflowIdOrPrefix));
  return matches.length === 1 ? matches[0] : undefined;
}
