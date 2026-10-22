import { outsideWorkflowExecutions } from "../../durable/execution-context-boundary.js";
import { durableRootRunIdForRun } from "../../durable/run-owner-backend.js";
import { registerPendingStageIntercomBridge } from "../../extension/pending-stage-intercom.js";
import { workflowInvocationIntercomGroup } from "../../shared/intercom-group.js";
import { hasWorkflowPendingStageRouteOwner } from "../../shared/pending-stage-route-readiness.js";
import type { Store } from "../../shared/store.js";

type RouteOwner = ReturnType<typeof import("../../../../intercom/workflow-route-owner.js").createWorkflowRouteOwner>;
interface StandaloneOwner {
	readonly roots: Map<string, number>;
	readonly ready: Promise<{
		readonly routes: RouteOwner;
		readonly bridge: ReturnType<typeof registerPendingStageIntercomBridge>;
	}>;
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
		const activated = new Set<string>();
		owner = {
			roots,
			ready: outsideWorkflowExecutions(async () => {
				const { createWorkflowRouteOwner } = await import("../../../../intercom/workflow-route-owner.js");
				const routes = createWorkflowRouteOwner(cwd);
				const bridge = registerPendingStageIntercomBridge({ events: routes.events }, store, (id) => {
					const runs = store.runs();
					const root = durableRootRunIdForRun(runs, id) ?? id;
					if (!roots.has(root)) return false;
					if (
						!activated.has(root) &&
						runs.some(
							(run) =>
								durableRootRunIdForRun(runs, run.id) === root &&
								run.stages.some((stage) => stage.pendingStageDeliveryAvailable === true),
						)
					)
						activated.add(root);
					return activated.has(root);
				});
				return { routes, bridge };
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
					if (owners.get(store) === retained) owners.delete(store);
				}
				await initialized.routes.closeGroup(workflowInvocationIntercomGroup(runId));
			}
		}
	};
}
