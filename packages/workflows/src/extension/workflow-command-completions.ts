import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import { schemaChoices, schemaDescription, schemaFieldKind } from "../shared/schema-introspection.js";
import { type Store, store } from "../shared/store.js";
import type { PiArgumentCompletion, PiArgumentCompletionResult } from "./public-types.js";
import type { ExtensionRuntime } from "./runtime.js";

export function completeToken(argumentText: string, candidates: PiArgumentCompletion[]): PiArgumentCompletionResult {
	const tokenStart = /\s$/.test(argumentText)
		? argumentText.length
		: Math.max(argumentText.lastIndexOf(" "), argumentText.lastIndexOf("\t")) + 1;
	const head = argumentText.slice(0, tokenStart);
	const token = argumentText.slice(tokenStart);
	const normalizedToken = token.trimEnd();
	const filtered = candidates
		.filter((candidate) => candidate.value.startsWith(token) && candidate.value.trimEnd() !== normalizedToken)
		.map((candidate) => ({ ...candidate, value: `${head}${candidate.value}` }));
	return filtered.length > 0 ? filtered : null;
}

function adminCompletions(): PiArgumentCompletion[] {
	return [
		{ value: "list ", label: "list", description: "List registered workflows" },
		{ value: "status ", label: "status", description: "List current-session active and retained terminal runs" },
		{ value: "pause ", label: "pause", description: "Pause a run" },
		{ value: "quit ", label: "quit", description: "Quit a run and keep it resumable" },
		{ value: "resume ", label: "resume", description: "Re-open overlay for a run" },
		{ value: "fork ", label: "fork", description: "Fork a run into a new run, optionally --from a stage" },
		{ value: "inputs ", label: "inputs", description: "Show a workflow's input schema" },
		{ value: "reload ", label: "reload", description: "Reload workflow resources" },
	];
}

function workflowNameItems(runtime: ExtensionRuntime): PiArgumentCompletion[] {
	return runtime.registry.names().map((name) => ({
		value: `${name} `,
		label: name,
		description: `Run workflow: ${name}`,
	}));
}

export function runIdItems(activeStore: Store): PiArgumentCompletion[] {
	return topLevelWorkflowRuns(activeStore.runs()).map((run) => ({
		value: `${run.id} `,
		label: run.id,
		description: `${run.name} — ${run.status}`,
	}));
}

export function workflowArgumentCompletionsNeedWorkflowResources(partial: string): boolean {
	const parts = partial.trim().split(/\s+/).filter(Boolean);
	const subcommand = parts[0] ?? "";
	if (!partial.includes(" ")) return true;
	if (!subcommand || subcommand === "inputs") return true;
	if (["status", "resume", "pause", "quit", "reload", "fork"].includes(subcommand)) {
		return false;
	}
	return true;
}

function hasPositionalRunArgument(argumentText: string): boolean {
	return argumentText
		.trimStart()
		.split(/\s+/)
		.slice(1, -1)
		.some((token) => !token.startsWith("-"));
}

export function workflowArgumentCompletions(
	partial: string,
	runtime: ExtensionRuntime,
	activeStore: Store = store,
): PiArgumentCompletionResult {
	const parts = partial.trim().split(/\s+/).filter(Boolean);
	const subcommand = parts[0] ?? "";
	const workflows = () => workflowNameItems(runtime);
	if (!partial.includes(" ")) {
		return completeToken(partial, [...adminCompletions(), ...workflows()]);
	}
	if (subcommand === "inputs") return completeToken(partial, workflows());
	if (subcommand === "status" || subcommand === "resume") {
		if (subcommand === "resume" && hasPositionalRunArgument(partial)) return null;
		return completeToken(partial, runIdItems(activeStore));
	}
	if (subcommand === "pause") {
		if (hasPositionalRunArgument(partial)) return null;
		return completeToken(partial, [
			{ value: "--all ", label: "--all", description: "Pause all in-flight runs" },
			{ value: "--yes ", label: "--yes", description: "Skip confirmation" },
			{ value: "-y ", label: "-y", description: "Skip confirmation" },
			...runIdItems(activeStore),
		]);
	}
	if (subcommand === "fork") {
		if (parts.slice(1).some((token) => token === "--from" || token.startsWith("--from="))) return null;
		return completeToken(partial, [
			{ value: "--from ", label: "--from", description: "Dot path of the stage the fork re-runs from" },
			...(hasPositionalRunArgument(partial) ? [] : runIdItems(activeStore)),
		]);
	}
	if (subcommand === "quit") {
		return completeToken(partial, [
			{ value: "--all ", label: "--all", description: "Quit and keep all in-flight runs resumable" },
			...runIdItems(activeStore),
		]);
	}
	if (!subcommand) return completeToken(partial, [...adminCompletions(), ...workflows()]);

	const workflow = runtime.registry.get(subcommand);
	if (!workflow) return null;
	const tokenStart = /\s$/.test(partial)
		? partial.length
		: Math.max(partial.lastIndexOf(" "), partial.lastIndexOf("\t")) + 1;
	const token = partial.slice(tokenStart);
	const equalsIndex = token.indexOf("=");
	if (equalsIndex > 0) {
		const inputName = token.slice(0, equalsIndex);
		const schema = workflow.inputs[inputName];
		const schemaChoiceValues = schema === undefined ? undefined : schemaChoices(schema);
		const schemaKind = schema === undefined ? undefined : schemaFieldKind(schema);
		if (schemaChoiceValues !== undefined) {
			return completeToken(
				partial,
				schemaChoiceValues.map((choice) => ({
					value: `${inputName}=${choice} `,
					label: choice,
					description: inputName,
				})),
			);
		}
		if (schemaKind === "boolean") {
			return completeToken(partial, [
				{ value: `${inputName}=true `, label: "true", description: inputName },
				{ value: `${inputName}=false `, label: "false", description: inputName },
			]);
		}
		return null;
	}
	const inputCompletions: PiArgumentCompletion[] = Object.entries(workflow.inputs).map(([name, schema]) => ({
		value: `${name}=`,
		label: name,
		description: schemaDescription(schema),
	}));
	return completeToken(partial, [
		{ value: "--no-picker ", label: "--no-picker", description: "Skip interactive input picker" },
		{ value: "--help ", label: "--help", description: "Show this workflow's input schema" },
		...inputCompletions,
	]);
}
