import type { SubagentToolResult } from "../../shared/types.ts";
import { findSubagentControl, listSubagentControls } from "./control-registry.ts";

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
			details: { mode: "management", results: [] },
		};
	}
	const lines = listSubagentControls().flatMap((control) => [
		`Parent: ${control.parent.path}`,
		...childLines(control),
	]);
	if (lines.length === 0) return undefined;
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { mode: "management", results: [] },
	};
}

export async function interruptInProcessChild(id: string): Promise<SubagentToolResult | undefined> {
	const control = findSubagentControl(id);
	if (!control) return undefined;
	const identities = control.listChildren();
	const candidates = id === control.parent.path ? identities : identities.filter((child) => child.path === id);
	for (const child of candidates) {
		if (await control.interruptChild(child.path)) {
			return {
				content: [{ type: "text", text: `Interrupt requested for in-process child ${child.path}.` }],
				details: { mode: "management", results: [] },
			};
		}
	}
	return {
		content: [{ type: "text", text: `No running in-process child found for '${id}'.` }],
		isError: true,
		details: { mode: "management", results: [] },
	};
}
