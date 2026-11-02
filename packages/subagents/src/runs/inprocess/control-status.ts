import type { SubagentStatusGroup, SubagentToolResult } from "../../shared/types.js";
import { resultRanOnLine } from "../shared/model-fallback.js";
import { findSubagentControl, listSubagentControls, subagentChildPath } from "./control-registry.js";

type Control = NonNullable<ReturnType<typeof findSubagentControl>>;
/** Whether the session asking launched this run, so it may see and control its children. */
export type OwnsSubagentRun = (runId: string) => boolean;

function canonicalChildren(control: Control) {
	return [...control.listChildren()].sort((left, right) => left.path.localeCompare(right.path));
}

/** Why a settled child failed or stopped, as its delivered result says, on one line. */
function settledCause(control: Control, path: string, status: string): string | undefined {
	if (status !== "error" && status !== "interrupted") return undefined;
	const cause = control.getDeliveredResult(path)?.cause?.replace(/\s+/g, " ").trim();
	return cause || undefined;
}

/** The model a child runs or ran on and the one its launch asked for, live or as its delivered result says. */
function childModels(control: Control, path: string) {
	return control.getChildMetadata(path) ?? control.getDeliveredResult(path);
}

function childLines(control: Control, id?: string): string[] {
	if (id) {
		const path = subagentChildPath(control, id);
		const child = control.findChild(path);
		if (!child) return [];
		const delivered = control.getDeliveredResult(path);
		const childId = control.childIdOf(path);
		const cause = settledCause(control, path, child.status);
		// A child on another model than its launch asked for says so (#4188).
		const ranOn = resultRanOnLine(childModels(control, path) ?? {});
		return [
			...(childId ? [`Id: ${childId}`] : []),
			`Child: ${child.path}`,
			`Parent: ${child.parentPath}`,
			`Task: ${child.taskName}`,
			`Depth: ${child.depth}`,
			`Status: ${child.status}`,
			...(cause ? [`Cause: ${cause}`] : []),
			...(ranOn ? [ranOn] : []),
			`Residency: ${child.loaded ? "loaded" : "cold"}`,
			...(delivered?.sessionFile ? [`Session: ${delivered.sessionFile}`] : []),
		];
	}
	return control.listChildren().map((child) => {
		const childId = control.childIdOf(child.path);
		const cause = settledCause(control, child.path, child.status);
		const ranOn = resultRanOnLine(childModels(control, child.path) ?? {});
		// `pause`, `resume` and `quit` take the child id, and the path too.
		return `${child.path} — ${child.status} (${child.loaded ? "loaded" : "cold"})${childId ? ` · id ${childId}` : ""}${cause ? ` · ${cause}` : ""}${ranOn ? ` · ${ranOn.slice("Model: ".length, -1)}` : ""}`;
	});
}

function statusGroup(control: Control, id?: string): SubagentStatusGroup {
	const path = id === undefined ? undefined : subagentChildPath(control, id);
	return {
		parentPath: control.parent.path,
		children: canonicalChildren(control)
			.filter((child) => !path || path === control.parent.path || child.path === path)
			.map((child) => {
				const delivered = control.getDeliveredResult(child.path);
				const metadata = childModels(control, child.path);
				const childId = control.childIdOf(child.path);
				const failure = settledCause(control, child.path, child.status);
				return {
					...child,
					...(childId === undefined ? {} : { childId }),
					...(failure === undefined ? {} : { failure }),
					sessionFile: delivered?.sessionFile,
					...(metadata?.model === undefined ? {} : { model: metadata.model }),
					...(metadata?.thinking === undefined ? {} : { thinking: metadata.thinking }),
					...(metadata?.requestedModel === undefined ? {} : { requestedModel: metadata.requestedModel }),
				};
			}),
	};
}

/**
 * The in-process children `id` names (a run id, a child path, or a child id), or every child, of the runs `ownsRun`
 * accepts: a session sees only the runs it launched, which are the only ones its run control can reach.
 */
export function inspectInProcessChildStatus(id?: string, ownsRun?: OwnsSubagentRun): SubagentToolResult | undefined {
	const owned = (control: Control) => ownsRun?.(control.parent.path) ?? true;
	if (id) {
		const control = findSubagentControl(id);
		if (!control || !owned(control)) return undefined;
		const text =
			id === control.parent.path
				? [`Parent: ${control.parent.path}`, ...childLines(control)].join("\n")
				: childLines(control, id).join("\n");
		if (!text) return undefined;
		return {
			content: [{ type: "text", text }],
			details: { mode: "management", results: [], statusGroups: [statusGroup(control, id)] },
		};
	}
	const controls = listSubagentControls().filter(owned);
	const lines = controls.flatMap((control) => [`Parent: ${control.parent.path}`, ...childLines(control)]);
	if (lines.length === 0) return undefined;
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { mode: "management", results: [], statusGroups: controls.map((control) => statusGroup(control)) },
	};
}
