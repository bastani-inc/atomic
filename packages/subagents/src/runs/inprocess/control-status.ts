import type { SubagentToolResult } from "../../shared/types.ts";
import { findSubagentControl, listSubagentControls } from "./control-registry.ts";
import type { ModelCandidate } from "./runner.ts";

function canonicalChildren(control: NonNullable<ReturnType<typeof findSubagentControl>>) {
	return [...control.listChildren()].sort((left, right) => left.path.localeCompare(right.path));
}

function resumeTarget(control: NonNullable<ReturnType<typeof findSubagentControl>>, id: string) {
	if (id !== control.parent.path) return control.findChild(id);
	const children = canonicalChildren(control);
	return children.find((child) => child.status === "interrupted") ?? children[0];
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
	const identities = canonicalChildren(control);
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

export async function resumeInProcessChild(
	id: string,
	message: string,
	candidate: ModelCandidate,
): Promise<SubagentToolResult | undefined> {
	const control = findSubagentControl(id);
	if (!control) return undefined;
	const target = resumeTarget(control, id);
	if (!target) {
		return {
			content: [{ type: "text", text: `No in-process child found for '${id}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const outcome = await control.resumeChild(target.path, message, candidate);
	const selection =
		id === control.parent.path && control.listChildren().length > 1
			? `Bare run id resolved to ${target.path}; interrupted children are preferred, then canonical path order.\n\n`
			: "";
	return {
		content: [{ type: "text", text: `${selection}${outcome.envelope}` }],
		isError: outcome.status === "error" || outcome.status === "interrupted" ? true : undefined,
		details: { mode: "management", results: [] },
	};
}
