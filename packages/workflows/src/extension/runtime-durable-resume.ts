import type { WorkflowExecutionPolicy } from "../shared/types.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import type { RunOpts } from "../runs/foreground/executor.js";
import type { Store } from "../shared/store.js";
import type { WorkflowRegistry } from "../workflows/registry.js";
import {
  prepareRuntimeDurableResumable,
  prepareTargetedDurableResumable,
  purgeSuppressedWorkflowRuns,
  resumeDurableWorkflow as resumeDurableWorkflowAdapter,
  type ResumeDurableDeps,
  type ResumeDurableResult,
} from "../durable/resume-runtime.js";
import { getDurableBackend } from "../durable/factory.js";
import { scanResumableWorkflows } from "../durable/resume-catalog.js";
import { isDurableWorkflowResumable } from "../durable/resume-eligibility.js";
import { listOpenableCompletedWorkflows } from "../durable/completed-catalog.js";
import {
  openCompletedDurableWorkflow as openCompletedSnapshot,
  type OpenCompletedDurableResult,
} from "../durable/completed-inspection.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import type { DurableWorkflowCatalogEntries } from "../durable/file-catalog.js";

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
  prepareDurableCatalog?(): Promise<DurableWorkflowCatalogEntries>;
  /**
   * Targeted preparation for known workflow ids: reads only those workflows'
   * durable state (O(ids)) instead of enumerating the entire durable
   * directory. Optional so lightweight test doubles remain assignable.
   */
  prepareDurableResumableForIds?(
    workflowIds: readonly string[],
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
  const hydrateStoredWorkflowCandidates = async (backend: ReturnType<typeof getDurableBackend>, target?: string): Promise<void> => {
    if (backend.hydrateWorkflow === undefined) return;
    const ids = deps.store.runs()
      .map((run) => run.id)
      .filter((id) => target === undefined || id === target || id.startsWith(target));
    for (const id of ids) await backend.hydrateWorkflow(id);
  };
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
      const compatible = scanned.filter((entry) => {
        const handle = backend.getWorkflow(entry.workflowId);
        return !liveIds.has(entry.workflowId) && handle !== undefined && isDurableWorkflowResumable(handle);
      });
      return [...live, ...compatible];
    },
    async prepareDurableResumable(workflowIdOrPrefix, sessionDir) {
      await deps.ensureReady();
      const backend = getDurableBackend();
      try {
        await hydrateStoredWorkflowCandidates(backend, workflowIdOrPrefix);
        preparedCatalog = await prepareRuntimeDurableResumable(
          () => backend,
          () => deps.resolveDefaultStageSessionDir?.(),
          workflowIdOrPrefix,
          sessionDir,
        );
        return preparedCatalog;
      } finally {
        purgeSuppressedWorkflowRuns(backend, deps.store);
      }
    },
    async prepareDurableCatalog() {
      await deps.ensureReady();
      const backend = getDurableBackend();
      try {
        await backend.hydrateResumableWorkflows?.();
        await hydrateStoredWorkflowCandidates(backend);
        const indexed = await backend.prepareWorkflowCatalog?.();
        if (indexed !== undefined) {
          preparedCatalog = indexed.resumable;
          return indexed;
        }
        preparedCatalog = await prepareRuntimeDurableResumable(
          () => backend,
          () => deps.resolveDefaultStageSessionDir?.(),
        );
        return {
          resumable: preparedCatalog,
          completed: listOpenableCompletedWorkflows(backend),
        };
      } finally {
        purgeSuppressedWorkflowRuns(backend, deps.store);
      }
    },
    async prepareDurableResumableForIds(workflowIds) {
      await deps.ensureReady();
      const backend = getDurableBackend();
      try {
        preparedCatalog = await prepareTargetedDurableResumable(backend, workflowIds);
        return preparedCatalog;
      } finally {
        purgeSuppressedWorkflowRuns(backend, deps.store);
      }
    },
    async prepareCompletedDurable() {
      await deps.ensureReady();
      const backend = getDurableBackend();
      try {
        await backend.hydrateResumableWorkflows?.();
        await hydrateStoredWorkflowCandidates(backend);
        return listOpenableCompletedWorkflows(backend);
      } finally {
        purgeSuppressedWorkflowRuns(backend, deps.store);
      }
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
