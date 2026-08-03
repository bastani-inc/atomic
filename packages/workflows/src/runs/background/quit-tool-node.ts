/**
 * Targeted abort for a single in-flight `ctx.tool` graph node.
 *
 * This is the tool-node counterpart to interrupting one rogue stage: the node's
 * own controller is aborted, sibling stages and sibling tool nodes keep running,
 * and the run is not paused. The aborted call writes no replayable checkpoint,
 * so a later resume re-executes exactly that callback at the same ordinal.
 *
 * cross-ref: issue #2078.
 */

import {
	toolControlRegistry as defaultToolControlRegistry,
	settleAbortedToolNodes,
	TOOL_QUIT_SETTLEMENT_TIMEOUT_MS,
	type ToolControlRegistry,
} from "../../engine/run-tool-control-registry.js";
import { store as defaultStore } from "../../shared/store.js";
import type { Store } from "../../shared/store-public-types.js";
import type { ToolNodeSnapshot } from "../../shared/store-types.js";

export type ToolNodeAbortResult =
	| {
			readonly ok: true;
			readonly runId: string;
			readonly nodeId: string;
			readonly name: string;
			/** The cancelled node once it settled, when the store still retains it. */
			readonly cancelled?: ToolNodeSnapshot;
			/** True when the callback ignored its signal within the bounded wait. */
			readonly abandoned: boolean;
	  }
	| { readonly ok: false; readonly runId: string; readonly nodeId: string; readonly reason: "not_running" };

/**
 * Abort one in-flight tool node and wait a bounded interval for its callback.
 *
 * `action` only picks the wording of the abort reason; both `quit` and
 * `interrupt` on a tool node mean the same thing — stop this call now.
 */
export async function abortToolNode(
	runId: string,
	nodeId: string,
	opts?: { store?: Store; toolControlRegistry?: ToolControlRegistry },
): Promise<ToolNodeAbortResult> {
	const activeStore = opts?.store ?? defaultStore;
	const toolControls = opts?.toolControlRegistry ?? defaultToolControlRegistry;
	const handle = toolControls.get(runId, nodeId);
	if (handle === undefined) return { ok: false, runId, nodeId, reason: "not_running" };
	handle.abort("node");
	const abandoned = (await settleAbortedToolNodes([handle], TOOL_QUIT_SETTLEMENT_TIMEOUT_MS)).length > 0;
	if (abandoned) {
		activeStore.recordToolNodeEnd(runId, nodeId, {
			status: "cancelled",
			endedAt: Date.now(),
			error: `atomic-workflows: ctx.tool ${handle.name} abandoned after abort; the callback ignored its abort signal`,
		});
	}
	const cancelled = activeStore
		.runs()
		.find((candidate) => candidate.id === runId)
		?.toolNodes?.find((candidate) => candidate.id === nodeId);
	return {
		ok: true,
		runId,
		nodeId,
		name: handle.name,
		...(cancelled === undefined ? {} : { cancelled: structuredClone(cancelled) }),
		abandoned,
	};
}
