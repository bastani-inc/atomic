import type { RunSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";

export type ToolResumeFrontier =
	| { readonly ok: true; readonly toolNodeId: string }
	| { readonly ok: false; readonly message: string };

/** Fail closed before dispatch: a tool frontier must not turn missing completed work into live callbacks. */
export function resolveToolResumeFrontier(source: RunSnapshot, backend: DurableWorkflowBackend): ToolResumeFrontier {
	const fail = (detail: string): ToolResumeFrontier => ({
		ok: false,
		message: `insufficient_state: ${detail} in run ${source.id}`,
	});
	const tools = source.toolNodes ?? [];
	const candidates = tools.filter((node) =>
		source.failedToolNodeId === undefined
			? (node.status === "cancelled" || node.status === "failed") &&
				node.error === source.error &&
				source.error === `atomic-workflows: ctx.tool ${node.name} aborted by node abort`
			: node.id === source.failedToolNodeId,
	);
	if (candidates.length !== 1) return fail("missing or ambiguous failed tool frontier");
	const frontier = candidates[0]!;
	if (
		(frontier.status !== "cancelled" && frontier.status !== "failed") ||
		backend.getToolCheckpoint(source.id, frontier.argsHash) !== undefined
	)
		return fail("tool frontier is already finished");
	if (
		frontier.id !== `tool:${frontier.argsHash}` ||
		!Number.isInteger(frontier.ordinal) ||
		frontier.ordinal < 1 ||
		frontier.topologyState === "unavailable"
	)
		return fail("invalid tool frontier identity");
	const nodes = [...source.stages, ...tools];
	const byId = new Map(nodes.map((node) => [node.id, node]));
	if (byId.size !== nodes.length) return fail("duplicate graph node identity");
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const valid = (id: string): boolean => {
		if (visiting.has(id)) return false;
		if (visited.has(id)) return true;
		const node = byId.get(id);
		if (node === undefined) return false;
		visiting.add(id);
		if (!node.parentIds.every(valid)) return false;
		visiting.delete(id);
		visited.add(id);
		return true;
	};
	if (!nodes.every((node) => valid(node.id))) return fail("missing parent or cyclic tool frontier topology");
	const checkpoints = backend.listCheckpoints(source.id);
	if (
		source.failedToolNodeId === undefined &&
		!checkpoints.some(
			(checkpoint) =>
				checkpoint.kind === "tool" &&
				checkpoint.throwingFailureError === source.error &&
				checkpoint.argsHash === frontier.argsHash &&
				checkpoint.topology?.nodeId === frontier.id &&
				checkpoint.topology.ordinal === frontier.ordinal,
		)
	)
		return fail("missing typed tool failure checkpoint for legacy frontier");
	for (const stage of source.stages) {
		if (
			stage.status !== "completed" ||
			!checkpoints.some(
				(checkpoint) =>
					checkpoint.kind === "stage" &&
					checkpoint.replayKey === stage.replayKey &&
					checkpoint.output !== undefined,
			)
		)
			return fail(`unfinished or missing completed stage checkpoint ${stage.id}`);
	}
	for (const tool of tools) {
		if (tool.id === frontier.id) continue;
		const checkpoint = backend.getToolCheckpoint(source.id, tool.argsHash);
		if (checkpoint === undefined || checkpoint.topology?.nodeId !== tool.id)
			return fail(`unfinished or missing completed tool checkpoint ${tool.id}`);
	}
	return { ok: true, toolNodeId: frontier.id };
}
