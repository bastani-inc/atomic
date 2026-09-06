/**
 * Live tool-node control registry — runtime-only handle table keyed by
 * `runId + nodeId`.
 *
 * `ctx.tool` executions live inside `run()`, while `/workflow quit|interrupt`
 * runs elsewhere in the process. Store snapshots are JSON-cloneable and cannot
 * carry an `AbortController`, so the abort surface for an in-flight tool node
 * lives here, exactly as live stage chat handles live in the stage-control
 * registry.
 *
 * Tool handles are abort-only: they are never attachable chat targets.
 *
 * cross-ref: issue #2078; src/runs/foreground/stage-control-registry.ts
 */

import { createSessionScopedSingleton } from "../shared/session-scoped-singleton.js";
import type { WorkflowToolNodeIdentity } from "../shared/types.js";
import type { ToolAdmissionBoundary } from "./run-tool-admission-boundary.js";
import { WorkflowToolAbortError, type WorkflowToolAbortScope } from "./workflow-tool-abort.js";

/**
 * Bounded wait for aborted tool callbacks to settle before quit abandons them
 * and records the durable paused transition. A callback that ignores its signal
 * must never pin quit, mirroring the failure path's abandonment policy.
 */
export const TOOL_QUIT_SETTLEMENT_TIMEOUT_MS = 500;

export interface ToolControlRegistration {
	readonly runId: string;
	readonly nodeId: string;
	readonly name: string;
	readonly controller: AbortController;
	/** Resolves when the logical tool execution settles, however it settles. */
	readonly settled: Promise<void>;
}

export interface ToolControlHandle {
	readonly runId: string;
	readonly nodeId: string;
	readonly name: string;
	readonly settled: Promise<void>;
	readonly aborted: boolean;
	abort(scope: WorkflowToolAbortScope): WorkflowToolAbortError;
}

/** Executor control for initialization and between-node awaits; never a graph node. */
export interface WorkflowRunControlHandle {
	readonly paused: boolean;
	pause(): Promise<void>;
	resume(): Promise<void>;
	quit(): Promise<void>;
}

export interface ToolControlRegistry {
	/** Register an in-flight node; the returned disposer unregisters it. */
	register(registration: ToolControlRegistration): () => void;
	/** Resolve one in-flight node by owning run id and local node id. */
	get(runId: string, nodeId: string): ToolControlHandle | undefined;
	/** Every in-flight node for one run, in registration order. */
	active(runId: string): readonly ToolControlHandle[];
	/**
	 * Publish the root-shared admission boundary under one run id. Nested runs
	 * register the same instance, so quit can close the whole boundary from any
	 * run id below it.
	 */
	registerAdmissionBoundary(runId: string, boundary: ToolAdmissionBoundary): () => void;
	admissionBoundary(runId: string): ToolAdmissionBoundary | undefined;
	registerRun(runId: string, handle: WorkflowRunControlHandle): () => void;
	runControl(runId: string): WorkflowRunControlHandle | undefined;
	/** Drop every registration. Used on session/store teardown and by tests. */
	clear(): void;
}

export function createToolControlRegistry(): ToolControlRegistry {
	const byRun = new Map<string, Map<string, ToolControlHandle>>();
	const admissionByRun = new Map<string, ToolAdmissionBoundary>();
	const runControls = new Map<string, WorkflowRunControlHandle>();

	const makeHandle = (registration: ToolControlRegistration): ToolControlHandle => ({
		runId: registration.runId,
		nodeId: registration.nodeId,
		name: registration.name,
		settled: registration.settled,
		get aborted(): boolean {
			return registration.controller.signal.aborted;
		},
		abort(scope: WorkflowToolAbortScope): WorkflowToolAbortError {
			const existing = registration.controller.signal.reason;
			if (registration.controller.signal.aborted && existing instanceof WorkflowToolAbortError) return existing;
			const reason = new WorkflowToolAbortError({
				runId: registration.runId,
				nodeId: registration.nodeId,
				toolName: registration.name,
				scope,
			});
			registration.controller.abort(reason);
			return reason;
		},
	});

	return {
		register(registration: ToolControlRegistration): () => void {
			let runMap = byRun.get(registration.runId);
			if (runMap === undefined) {
				runMap = new Map();
				byRun.set(registration.runId, runMap);
			}
			const handle = makeHandle(registration);
			runMap.set(registration.nodeId, handle);
			return () => {
				const existing = byRun.get(registration.runId);
				if (existing === undefined) return;
				if (existing.get(registration.nodeId) === handle) existing.delete(registration.nodeId);
				if (existing.size === 0) byRun.delete(registration.runId);
			};
		},
		get(runId: string, nodeId: string): ToolControlHandle | undefined {
			return byRun.get(runId)?.get(nodeId);
		},
		active(runId: string): readonly ToolControlHandle[] {
			const runMap = byRun.get(runId);
			return runMap === undefined ? [] : [...runMap.values()];
		},
		registerAdmissionBoundary(runId: string, boundary: ToolAdmissionBoundary): () => void {
			admissionByRun.set(runId, boundary);
			return () => {
				if (admissionByRun.get(runId) === boundary) admissionByRun.delete(runId);
			};
		},
		admissionBoundary(runId: string): ToolAdmissionBoundary | undefined {
			return admissionByRun.get(runId);
		},
		registerRun(runId, handle) {
			runControls.set(runId, handle);
			return () => {
				if (runControls.get(runId) === handle) runControls.delete(runId);
			};
		},
		runControl: (runId) => runControls.get(runId),
		clear(): void {
			byRun.clear();
			admissionByRun.clear();
			runControls.clear();
		},
	};
}

/**
 * Process-wide registry. Tests and embedders SHOULD prefer an explicit instance
 * through `RunOpts.toolControlRegistry`; the singleton is the default consumer
 * surface used by the extension factory.
 */
const SESSION_KEY = "workflows:tool-control:v1";
const singleton = createSessionScopedSingleton(SESSION_KEY, createToolControlRegistry);

export const toolControlRegistry: ToolControlRegistry = singleton.facade;

export function adoptToolControlRegistry(scope: object, preserveCurrentWhenTargetExists = false): ToolControlRegistry {
	return singleton.adopt(scope, {
		preserveCurrentWhenTargetExists: preserveCurrentWhenTargetExists ? () => true : undefined,
	});
}

/**
 * Await settlement of aborted tool handles up to `timeoutMs` and report the
 * identities that were still unsettled when the bound expired.
 *
 * Identity stays structured: nested child runs legitimately share a local
 * `tool:<argsHash>` id because the hash is local to each run, so only
 * `{runId, nodeId}` distinguishes them.
 */
export async function settleAbortedToolNodes(
	handles: readonly ToolControlHandle[],
	timeoutMs: number,
): Promise<readonly WorkflowToolNodeIdentity[]> {
	if (handles.length === 0) return [];
	let expire: (() => void) | undefined;
	const deadline = new Promise<void>((resolve) => {
		expire = resolve;
	});
	const timer = setTimeout(() => expire?.(), timeoutMs);
	// Node's timer keeps the loop alive otherwise; quit must not extend process
	// lifetime just because it is waiting on a callback that may never answer.
	(timer as { unref?: () => void }).unref?.();
	try {
		const settled = await Promise.all(
			handles.map((handle) =>
				Promise.race([
					handle.settled.then(
						() => true,
						() => true,
					),
					deadline.then(() => false),
				]),
			),
		);
		return handles.flatMap((handle, index) =>
			settled[index] === true ? [] : [{ runId: handle.runId, nodeId: handle.nodeId }],
		);
	} finally {
		clearTimeout(timer);
	}
}

/** True when both identities name the same tool node in the same run. */
export function sameToolNodeIdentity(left: WorkflowToolNodeIdentity, right: WorkflowToolNodeIdentity): boolean {
	return left.runId === right.runId && left.nodeId === right.nodeId;
}
