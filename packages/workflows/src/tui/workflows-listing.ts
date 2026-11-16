/**
 * The `/workflows` sheet: the session's runs and the registered workflow definitions in one list (#5224).
 *
 * Runs come first, newest first, as two-line rows: the workflow's name and label, then `status · stage n/m <stage> ·
 * elapsed · cost`, with a failed run's short reason in place of its stage. Definitions follow: the name, then its
 * description and an inputs summary. Enter on a run opens its graph; Enter on a definition starts it, which asks for
 * its inputs first. The rows are built by pure functions so the listing can be tested without a terminal.
 */

import { Selector, type SelectorItem } from "@bastani/atomic";
import type { PiCustomComponent, PiCustomOverlayFactoryTui, PiCustomOverlayFunction } from "../extension/wiring.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowInputSchemaMap } from "../shared/types.js";
import { panelItemsFromSnapshot } from "./panel-runs.js";

/** What a chosen row is: a run to open, or a definition to start. */
export type WorkflowsListingTarget = { kind: "run"; runId: string } | { kind: "definition"; name: string };

/** The parts of a registered definition the listing shows. */
export interface WorkflowsListingDefinition {
	readonly normalizedName: string;
	readonly description: string;
	readonly inputs: WorkflowInputSchemaMap;
}

const RUN_STATUS_TEXT: Readonly<Record<RunSnapshot["status"], string>> = {
	pending: "starting",
	running: "running",
	paused: "paused",
	completed: "completed",
	skipped: "skipped",
	cancelled: "stopped",
	killed: "stopped",
	blocked: "blocked",
	failed: "failed",
};

/** `12m`, `2h 5m`, `45s`: how long something took or has run. */
export function listingDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** `2h ago`, `yesterday`: when a finished run ended. */
export function listingAgo(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "yesterday" : `${days}d ago`;
}

/** The first line of a failure, without a stack trace, kept short: what a failed row says went wrong. */
export function shortFailureReason(run: Pick<RunSnapshot, "error" | "exitReason">): string | undefined {
	const text = run.error ?? run.exitReason;
	if (!text) return undefined;
	const first =
		text
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0 && !/^at\s/.test(line)) ?? "";
	const clean = first.replace(/^(Error|[A-Z][A-Za-z]*Error):\s*/, "");
	return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean || undefined;
}

function runElapsedMs(run: RunSnapshot, now: number): number {
	if (run.durationMs !== undefined) return run.durationMs;
	const end = run.endedAt ?? now;
	return (run.accumulatedDurationMs ?? 0) + Math.max(0, end - run.startedAt - (run.pausedDurationMs ?? 0));
}

/** `stage 3/5 implement`: the stage a run is on (or stopped at), counting stages that have settled. */
export function runStageText(run: RunSnapshot): string | undefined {
	const total = run.stages.length;
	if (total === 0) return undefined;
	const failed = run.failedStageId ? run.stages.find((stage) => stage.id === run.failedStageId) : undefined;
	const current = failed ?? run.stages.find((stage) => stage.status === "running") ?? undefined;
	const settled = run.stages.filter((stage) => stage.status !== "pending" && stage.status !== "running").length;
	const index = current ? run.stages.indexOf(current) + 1 : Math.min(total, settled);
	return `stage ${index}/${total}${current ? ` ${current.name}` : ""}`;
}

/** `$1.84`, from the run's budget accounting when it has any. */
export function runCostText(run: RunSnapshot): string | undefined {
	const cost = run.budgetState?.accounting?.cost;
	return cost === undefined || cost <= 0 ? undefined : `$${cost.toFixed(2)}`;
}

/** What tells a run apart from other runs of its workflow: its label, else its first text input, else its short id. */
export function runRowLabel(run: RunSnapshot): string {
	if (run.label) return `${run.name} · ${run.label}`;
	const input = Object.values(run.inputs).find((value) => typeof value === "string" && value.trim() !== "");
	const detail = typeof input === "string" ? (input.split("\n")[0] ?? "").trim() : run.id.slice(0, 8);
	return `${run.name} · ${detail.length > 40 ? `${detail.slice(0, 39)}…` : detail}`;
}

/**
 * A run's second line: `running · stage 3/5 implement · 12m · $1.84`, a failed run's `✗ <reason>`, or
 * `needs input · <question>` while it waits on one.
 */
export function runRowDescription(run: RunSnapshot, now: number, question?: string): string {
	if (question !== undefined)
		return ["needs input", question, listingDuration(runElapsedMs(run, now)), runCostText(run)]
			.filter((part): part is string => part !== undefined && part !== "")
			.join(" · ");
	const status = RUN_STATUS_TEXT[run.status];
	const live = run.status === "running" || run.status === "pending" || run.status === "paused";
	const reason = run.status === "failed" || run.status === "blocked" ? shortFailureReason(run) : undefined;
	const parts = [
		status,
		runStageText(run),
		live || run.endedAt === undefined ? undefined : listingAgo(now - run.endedAt),
		listingDuration(runElapsedMs(run, now)),
		runCostText(run),
		reason ? `✗ ${reason}` : undefined,
	];
	return parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");
}

/** `2 inputs (1 required)`, or `no inputs`. */
export function inputsSummary(inputs: WorkflowInputSchemaMap): string {
	const entries = Object.values(inputs);
	if (entries.length === 0) return "no inputs";
	const required = entries.filter((schema) => schemaRequired(schema)).length;
	const noun = entries.length === 1 ? "input" : "inputs";
	return required ? `${entries.length} ${noun} (${required} required)` : `${entries.length} ${noun}`;
}

function schemaRequired(schema: WorkflowInputSchemaMap[string]): boolean {
	const record = schema as { readonly required?: boolean; readonly default?: unknown };
	return record.required === true && record.default === undefined;
}

const RUN_TONE: Partial<Record<RunSnapshot["status"], "accent" | "success" | "warning" | "error" | "muted">> = {
	running: "accent",
	pending: "accent",
	paused: "muted",
	completed: "success",
	failed: "error",
	blocked: "warning",
	cancelled: "muted",
	killed: "muted",
};

/** The listing's rows: runs (newest first), then definitions (by name). */
export function workflowsListingItems(
	runs: readonly RunSnapshot[],
	definitions: readonly WorkflowsListingDefinition[],
	now = Date.now(),
): SelectorItem<WorkflowsListingTarget>[] {
	// The agent panel's view of each run says whether it waits on a question, and which.
	const waiting = new Map(
		panelItemsFromSnapshot(runs, now)
			.filter((item) => item.state === "input")
			.map((item) => [item.id, item.question ?? item.task] as const),
	);
	const runItems = [...topLevelWorkflowRuns(runs)]
		.sort((a, b) => b.startedAt - a.startedAt)
		.map((run): SelectorItem<WorkflowsListingTarget> => {
			const question = waiting.get(`run:${run.id}`);
			const tag =
				question !== undefined
					? "◆"
					: run.status === "failed"
						? "✗"
						: run.status === "cancelled" || run.status === "killed"
							? "◼"
							: undefined;
			return {
				id: `run:${run.id}`,
				value: { kind: "run", runId: run.id },
				label: runRowLabel(run),
				description: runRowDescription(run, now, question),
				tag,
				tagTone: question !== undefined ? "warning" : RUN_TONE[run.status],
				group: "Runs",
				searchText: `${runRowLabel(run)} ${run.id} ${RUN_STATUS_TEXT[run.status]}`,
			};
		});
	const definitionItems = [...definitions]
		.sort((a, b) => a.normalizedName.localeCompare(b.normalizedName))
		.map(
			(definition): SelectorItem<WorkflowsListingTarget> => ({
				id: `definition:${definition.normalizedName}`,
				value: { kind: "definition", name: definition.normalizedName },
				label: definition.normalizedName,
				description: [definition.description.split("\n")[0]?.trim(), inputsSummary(definition.inputs)]
					.filter(Boolean)
					.join(" · "),
				group: "Definitions",
				searchText: `${definition.normalizedName} ${definition.description}`,
			}),
		);
	return [...runItems, ...definitionItems];
}

export interface WorkflowsListingUi {
	custom?: PiCustomOverlayFunction;
}

/**
 * Mounts the `/workflows` sheet and resolves with the chosen row, or `undefined` on Esc. Resolves `undefined` at once
 * when there is no custom UI.
 */
export function openWorkflowsListing(
	ui: WorkflowsListingUi,
	source: {
		readonly runs: () => readonly RunSnapshot[];
		readonly definitions: () => readonly WorkflowsListingDefinition[];
		readonly subscribe?: (listener: () => void) => () => void;
	},
): Promise<WorkflowsListingTarget | undefined> {
	return new Promise((resolve) => {
		const custom = ui.custom;
		if (typeof custom !== "function") {
			resolve(undefined);
			return;
		}
		let settled = false;
		let release: (() => void) | undefined;
		const factory = (
			tui: PiCustomOverlayFactoryTui,
			_theme: unknown,
			_keys: unknown,
			done: (r: undefined) => void,
		): PiCustomComponent => {
			const finish = (target: WorkflowsListingTarget | undefined): void => {
				if (settled) return;
				settled = true;
				release?.();
				done(undefined);
				resolve(target);
			};
			const items = () => workflowsListingItems(source.runs(), source.definitions());
			const selector = new Selector<WorkflowsListingTarget>({
				title: "Workflows",
				items: items(),
				layout: "two-line",
				search: true,
				searchPlaceholder: "Search…",
				emptyText: "No workflows in this session.",
				confirmLabel: "open",
				cancelLabel: "close",
				onSelect: (item) => finish(item.value),
				onCancel: () => finish(undefined),
			});
			release = source.subscribe?.(() => {
				const updatable = selector as {
					setItems?: (next: readonly SelectorItem<WorkflowsListingTarget>[]) => void;
				};
				updatable.setItems?.(items());
				tui.requestRender?.();
			});
			return {
				render: (width: number) => selector.render(width),
				handleInput: (data: string) => {
					selector.handleInput(data);
					tui.requestRender?.();
					return true;
				},
				invalidate: () => selector.invalidate(),
				dispose: () => finish(undefined),
			};
		};
		void custom(factory as Parameters<PiCustomOverlayFunction>[0], { overlay: false });
	});
}
