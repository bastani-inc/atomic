import { createSessionScopedSingleton } from "./session-scoped-singleton.js";
import { createStoreContext, isTerminalRunStatus } from "./store-internal.js";
import { createPromptStoreMethods } from "./store-prompt-methods.js";
import type { Store } from "./store-public-types.js";
import { createRunStoreMethods } from "./store-run-methods.js";
import { createStageStoreMethods } from "./store-stage-methods.js";
import { createToolNodeStoreMethods } from "./store-tool-node-methods.js";

export function createStore(): Store {
	const context = createStoreContext();
	return {
		...createRunStoreMethods(context),
		...createStageStoreMethods(context),
		...createToolNodeStoreMethods(context),
		...createPromptStoreMethods(context),
	};
}

const SESSION_KEY = "workflows:store:v1";
const singleton = createSessionScopedSingleton(SESSION_KEY, createStore);

export const store: Store = singleton.facade;

export interface WorkflowStoreAdoption {
	readonly store: Store;
	readonly recoveredCurrent: boolean;
}

function reclaimDisplacedLiveStore(current: Store, target: Store): boolean {
	if (!current.runs().some((run) => !isTerminalRunStatus(run.status))) return false;
	if (target.runs().some((run) => !isTerminalRunStatus(run.status))) return false;

	const currentRunIds = new Set(current.runs().map((run) => run.id));
	for (const run of target.runs()) {
		if (!currentRunIds.has(run.id)) current.recordRunStart(structuredClone(run));
	}
	const currentNoticeIds = new Set(current.notices().map((notice) => notice.id));
	for (const notice of target.notices()) {
		if (!currentNoticeIds.has(notice.id)) current.recordNotice(structuredClone(notice));
	}
	return true;
}

/**
 * Reclaim live state displaced by another session only when `/reload` returns
 * to an already-known host scope with no live run of its own. Retained terminal
 * history is merged into the recovered store. A newly seen scope never inherits it.
 */
export function adoptWorkflowHostStore(scope: object): WorkflowStoreAdoption {
	const result = singleton.adoptWithResult(scope, {
		preserveCurrentWhenTargetExists: reclaimDisplacedLiveStore,
	});
	return { store: result.instance, recoveredCurrent: result.preservedCurrent };
}

export function adoptStore(scope: object): Store {
	return singleton.adopt(scope);
}
