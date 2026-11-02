import { outsideWorkflowExecutions } from "../../durable/execution-context-boundary.js";
import { registerPendingStageIntercomBridge } from "../../extension/pending-stage-intercom.js";
import { workflowInvocationIntercomGroup } from "../../shared/intercom-group.js";
import { hasWorkflowPendingStageRouteOwner } from "../../shared/pending-stage-route-readiness.js";
import type { Store } from "../../shared/store.js";
import type { RunSnapshot } from "../../shared/store-types.js";
import { reciprocalWorkflowRootRunId } from "../../shared/workflow-run-ownership.js";

type RouteOwner = ReturnType<typeof import("../../../../intercom/workflow-route-owner.js").createWorkflowRouteOwner>;
interface StandaloneOwner {
	readonly roots: Map<string, number>;
	readonly ready: Promise<{
		readonly routes: RouteOwner;
		readonly bridge: ReturnType<typeof registerPendingStageIntercomBridge>;
		readonly unwatch: () => void;
	}>;
}

/** Each run's durable root, and the roots with a stage that can take pending deliveries, for one store version. */
interface RootIndex {
	readonly rootOf: ReadonlyMap<string, string | undefined>;
	readonly deliverable: ReadonlySet<string>;
}

function indexRoots(runs: readonly RunSnapshot[]): RootIndex {
	const runById = new Map(runs.map((run) => [run.id, run]));
	const rootOf = new Map<string, string | undefined>();
	const deliverable = new Set<string>();
	for (const run of runs) {
		const root = reciprocalWorkflowRootRunId(runById, run.id);
		rootOf.set(run.id, root);
		if (root !== undefined && run.stages.some((stage) => stage.pendingStageDeliveryAvailable === true))
			deliverable.add(root);
	}
	return { rootOf, deliverable };
}

/**
 * Which runs a standalone host's route bridge announces: runs under a root this host is running, once any run under
 * that root has a stage that can take pending deliveries. The bridge asks about every run on every announcement, so
 * the answer comes from an index built once per store version, not from a pass over the store per question (#4174).
 */
export function createStandaloneRouteOwnership(
	store: Store,
	roots: ReadonlyMap<string, number>,
): { readonly owns: (runId: string) => boolean; readonly dispose: () => void } {
	const activated = new Set<string>();
	let index: RootIndex | undefined;
	const dispose = store.subscribeInvalidation(() => {
		index = undefined;
	});
	return {
		owns: (runId) => {
			index ??= indexRoots(store.runs());
			const root = index.rootOf.get(runId) ?? runId;
			if (!roots.has(root)) return false;
			if (!activated.has(root) && index.deliverable.has(root)) activated.add(root);
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
