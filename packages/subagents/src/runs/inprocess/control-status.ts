import type { SubagentStatusGroup, SubagentToolResult } from "../../shared/types.js";
import { findSubagentControl, listSubagentControls } from "./control-registry.js";

function canonicalChildren(control: NonNullable<ReturnType<typeof findSubagentControl>>) {
	return [...control.listChildren()].sort((left, right) => left.path.localeCompare(right.path));
}

function childLines(control: ReturnType<typeof findSubagentControl>, id?: string): string[] {
	if (!control) return [];
	if (id) {
		const child = control.findChild(id);
		if (!child) return [];
		const delivered = control.getDeliveredResult(id);
		return [
			`Child: ${child.path}`,
			`Parent: ${child.parentPath}`,
			`Task: ${child.taskName}`,
			`Depth: ${child.depth}`,
			`Status: ${child.status}`,
			`Residency: ${child.loaded ? "loaded" : "cold"}`,
			...(delivered?.sessionFile ? [`Session: ${delivered.sessionFile}`] : []),
		];
	}
	return control
		.listChildren()
		.map((child) => `${child.path} — ${child.status} (${child.loaded ? "loaded" : "cold"})`);
}

function statusGroup(control: NonNullable<ReturnType<typeof findSubagentControl>>, id?: string): SubagentStatusGroup {
	return {
		parentPath: control.parent.path,
		children: canonicalChildren(control)
			.filter((child) => !id || id === control.parent.path || child.path === id)
			.map((child) => {
				const delivered = control.getDeliveredResult(child.path);
				const metadata = control.getChildMetadata(child.path) ?? delivered;
				return {
					...child,
					sessionFile: delivered?.sessionFile,
					...(metadata?.model === undefined ? {} : { model: metadata.model }),
					...(metadata?.thinking === undefined ? {} : { thinking: metadata.thinking }),
				};
			}),
	};
}

export function inspectInProcessChildStatus(id?: string): SubagentToolResult | undefined {
	if (id) {
		const control = findSubagentControl(id);
		if (!control) return undefined;
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
	const controls = listSubagentControls();
	const lines = controls.flatMap((control) => [`Parent: ${control.parent.path}`, ...childLines(control)]);
	if (lines.length === 0) return undefined;
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { mode: "management", results: [], statusGroups: controls.map((control) => statusGroup(control)) },
	};
}
