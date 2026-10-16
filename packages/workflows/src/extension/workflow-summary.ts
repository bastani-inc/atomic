import { availableStoreDurableBackend } from "../durable/store-backend.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import { subscribeStoreInvalidation } from "../shared/store-observation.js";
import type { Store } from "../shared/store-public-types.js";
import type { RunSnapshot } from "../shared/store-types.js";

export interface WorkflowSummaryContext {
	generateWorkflowSummary?(
		text: string,
		signal: AbortSignal,
		options?: { terminal?: boolean },
	): Promise<string | undefined>;
	isSessionSummaryEnabled?(): boolean;
}

const services = new WeakMap<
	Store,
	{ context: WorkflowSummaryContext; service: ReturnType<typeof createWorkflowSummaryService> }
>();

export function ensureWorkflowSummaryService(store: Store, context: WorkflowSummaryContext): void {
	const existing = services.get(store);
	if (existing) {
		existing.context = context;
		return;
	}
	const entry = {
		context,
		service: createWorkflowSummaryService({
			store,
			resolveContext: () => services.get(store)?.context ?? context,
			persist: async (runId, summary, summarizedThrough) => {
				await availableStoreDurableBackend(store)?.persistSummary?.(runId, summary, summarizedThrough);
				store.recordRunSummary?.(runId, summary, summarizedThrough);
			},
		}),
	};
	services.set(store, entry);
}

export function disposeWorkflowSummaryService(store: Store): void {
	services.get(store)?.service.dispose();
	services.delete(store);
}

export function requestWorkflowSummary(store: Store, runId: string): void {
	services.get(store)?.service.request(runId);
}

export function createWorkflowSummaryService(options: {
	store: Store;
	resolveContext: () => WorkflowSummaryContext | undefined;
	persist: (runId: string, summary: string, summarizedThrough: number) => Promise<void>;
}) {
	const contexts = new Map<string, WorkflowSummaryContext>();
	const pending = new Map<string, AbortController>();
	const finalized = new Map<string, ReturnType<typeof effectiveRunStatus>>();
	let disposed = false;
	const request = (runId: string): void => {
		const run = options.store.runs().find((entry) => entry.id === runId);
		const context = contexts.get(runId) ?? options.resolveContext();
		if (
			disposed ||
			!run ||
			!context?.generateWorkflowSummary ||
			context.isSessionSummaryEnabled?.() === false ||
			pending.has(runId)
		)
			return;
		contexts.set(runId, context);
		const controller = new AbortController();
		pending.set(runId, controller);
		const through = Date.now();
		const text = workflowSummaryInput(run);
		void (async () => {
			const summary = await context.generateWorkflowSummary!(text, controller.signal, { terminal: terminal(run) });
			if (summary && !controller.signal.aborted && !disposed && context.isSessionSummaryEnabled?.() !== false) {
				await options.persist(runId, summary, through);
			}
		})()
			.catch(() => {})
			.finally(() => {
				if (pending.get(runId) === controller) pending.delete(runId);
			});
	};
	const refresh = (): void => {
		for (const run of options.store.runs()) {
			if (run.parentRunId) continue;
			if (!contexts.has(run.id)) {
				const context = options.resolveContext();
				if (context) contexts.set(run.id, context);
			}
			const status = effectiveRunStatus(run);
			if (!terminal(run)) finalized.delete(run.id);
			else if (finalized.get(run.id) !== status) {
				finalized.set(run.id, status);
				pending.get(run.id)?.abort();
				pending.delete(run.id);
				request(run.id);
			}
		}
	};
	const unsubscribe = subscribeStoreInvalidation(options.store, refresh);
	refresh();
	return {
		request,
		dispose: () => {
			disposed = true;
			unsubscribe();
			for (const controller of pending.values()) controller.abort();
			pending.clear();
			contexts.clear();
		},
	};
}

function terminal(run: RunSnapshot): boolean {
	const status = effectiveRunStatus(run);
	return status === "blocked" || isTerminalRunStatus(status);
}

export function workflowSummaryInput(run: RunSnapshot): string {
	const preferred = ["objective", "prompt", "task", "request", "input"];
	const keys = [...new Set([...preferred.filter((key) => key in run.inputs), ...Object.keys(run.inputs)])].slice(
		0,
		20,
	);
	const objective = keys
		.map((key) => {
			const value = run.inputs[key];
			const text =
				typeof value === "string"
					? value.slice(0, 2000)
					: typeof value === "object" && value !== null
						? "[structured input]"
						: String(value);
			return `${key.slice(0, 100)}: ${text}`;
		})
		.join("\n")
		.slice(0, 4000);
	const stages = run.stages
		.slice(-40)
		.map(
			(stage) => `${stage.name.slice(0, 100)}: ${stage.status}\n${(stage.result ?? stage.error ?? "").slice(-1500)}`,
		)
		.join("\n")
		.slice(-11000);
	return `Workflow: ${run.name.slice(0, 200)}\nRun: ${run.id}\nStatus: ${effectiveRunStatus(run)}\nObjective/inputs:\n${objective}\nLatest stages and outputs:\n${stages}`.slice(
		0,
		16000,
	);
}
