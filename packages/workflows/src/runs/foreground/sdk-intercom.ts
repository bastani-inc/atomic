import { outsideWorkflowExecutions } from "../../durable/execution-context-boundary.js";
import { registerPendingStageIntercomBridge } from "../../extension/pending-stage-intercom.js";
import { workflowInvocationIntercomGroup } from "../../shared/intercom-group.js";
import { hasWorkflowPendingStageRouteOwner } from "../../shared/pending-stage-route-readiness.js";
import type { Store } from "../../shared/store.js";
import {
	invocationRunsInSource,
	reciprocalWorkflowRootRunId,
	runsByIdOf,
} from "../../shared/workflow-run-ownership.js";

type RouteOwner = ReturnType<typeof import("../../../../intercom/workflow-route-owner.js").createWorkflowRouteOwner>;
interface StandaloneOwner {
	readonly roots: Map<string, number>;
	readonly ready: Promise<{
		readonly routes: RouteOwner;
		readonly bridge: ReturnType<typeof registerPendingStageIntercomBridge>;
		readonly unwatch: () => void;
	}>;
}

/**
 * Which runs a standalone host's route bridge announces: runs under a root this host is running, once any run under
 * that root has a stage that can take pending deliveries. The bridge asks about every run it announces, so each run's
 * root and each root's deliverability are looked up by id and kept for the store version: a question reads only the
 * run, its parents and, before the root is activated, the root's invocation (#4174, #4190).
 */
export function createStandaloneRouteOwnership(
	store: Store,
	roots: ReadonlyMap<string, number>,
): { readonly owns: (runId: string) => boolean; readonly dispose: () => void } {
	const activated = new Set<string>();
	const runs = runsByIdOf(store);
	const rootOf = new Map<string, string | undefined>();
	const deliverable = new Map<string, boolean>();
	const dispose = store.subscribeInvalidation(() => {
		rootOf.clear();
		deliverable.clear();
	});
	return {
		owns: (runId) => {
			if (!rootOf.has(runId)) rootOf.set(runId, reciprocalWorkflowRootRunId(runs, runId));
			const root = rootOf.get(runId) ?? runId;
			if (!roots.has(root)) return false;
			if (!activated.has(root)) {
				let canDeliver = deliverable.get(root);
				if (canDeliver === undefined) {
					canDeliver = invocationRunsInSource(store, root).some((run) =>
						run.stages.some((stage) => stage.pendingStageDeliveryAvailable === true),
					);
					deliverable.set(root, canDeliver);
				}
				if (canDeliver) activated.add(root);
			}
			return activated.has(root);
		},
		dispose,
	};
}
const owners = new WeakMap<Store, StandaloneOwner>();

function releaseRoot(owner: StandaloneOwner, runId: string): boolean {
	const remaining = (owner.roots.get(runId) ?? 1) - 1;
	if (remaining > 0) {
		owner.roots.set(runId, remaining);
		return false;
	}
	owner.roots.delete(runId);
	return true;
}

export async function acquireStandaloneIntercom(
	store: Store,
	runId: string,
	cwd: string,
): Promise<() => Promise<void>> {
	let owner = owners.get(store);
	if (owner === undefined) {
		if (hasWorkflowPendingStageRouteOwner(store)) return async () => {};
		const roots = new Map<string, number>();
		owner = {
			roots,
			ready: outsideWorkflowExecutions(async () => {
				const { createWorkflowRouteOwner } = await import("../../../../intercom/workflow-route-owner.js");
				const routes = createWorkflowRouteOwner(cwd);
				const ownership = createStandaloneRouteOwnership(store, roots);
				const bridge = registerPendingStageIntercomBridge({ events: routes.events }, store, ownership.owns);
				return { routes, bridge, unwatch: ownership.dispose };
			}),
		};
		owners.set(store, owner);
	}
	owner.roots.set(runId, (owner.roots.get(runId) ?? 0) + 1);
	const retained = owner;
	let initialized: Awaited<StandaloneOwner["ready"]>;
	try {
		initialized = await owner.ready;
	} catch (error) {
		releaseRoot(owner, runId);
		if (owner.roots.size === 0 && owners.get(store) === owner) owners.delete(store);
		throw error;
	}
	return async () => {
		try {
			await initialized.bridge.flush();
		} finally {
			if (releaseRoot(retained, runId)) {
				initialized.bridge.refresh();
				if (retained.roots.size === 0) {
					initialized.bridge();
					initialized.unwatch();
					if (owners.get(store) === retained) owners.delete(store);
				}
				await initialized.routes.closeGroup(workflowInvocationIntercomGroup(runId));
			}
		}
	};
}
