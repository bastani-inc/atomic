import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import type { Store } from "../shared/store.js";

/** A live view of one pooled stage, held until `release`; the last release closes its watch. */
export interface PooledStageLease {
	readonly handle: StageControlHandle;
	release(): void;
	/**
	 * Observes the view reconnecting to a replacement attempt after its worker died or its
	 * attempt was fenced, with the number of messages it redelivered.
	 */
	onReconnected?(listener: (redelivered: number) => void): () => void;
}

/** Something that can open live views of stages running on its local workers: a pool. */
export interface PooledStageSource {
	acquire(runId: string, stageId: string): Promise<PooledStageLease | undefined>;
}

const sources = new WeakMap<Store, Set<PooledStageSource>>();

/**
 * Makes a pool's running stages attachable from views of `store` (#3996). Kept free of
 * imports so the attach pane can resolve pooled stages without loading pool code.
 */
export function registerPooledStageSource(store: Store, source: PooledStageSource): () => void {
	let registered = sources.get(store);
	if (registered === undefined) {
		registered = new Set();
		sources.set(store, registered);
	}
	registered.add(source);
	return () => {
		registered.delete(source);
	};
}

/** Opens a live view of a stage running on a local worker of a pool publishing into `store`. */
export async function acquirePooledStage(
	store: Store,
	runId: string,
	stageId: string,
): Promise<PooledStageLease | undefined> {
	for (const source of [...(sources.get(store) ?? [])]) {
		const lease = await source.acquire(runId, stageId);
		if (lease !== undefined) return lease;
	}
	return undefined;
}
