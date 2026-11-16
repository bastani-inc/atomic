import { Selector, type SelectorItem } from "@bastani/atomic";
import { getKeybindings } from "@bastani/atomic-tui";
import type { PiCustomComponent, PiCustomOverlayFactoryTui, PiCustomOverlayFunction } from "../extension/wiring.js";
import { actionableReturnedStatusText, effectiveRunStatus } from "../shared/returned-run-status.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import { schemaIsRequired } from "../shared/schema-introspection.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import { sanitizeToolTitleText } from "../shared/tool-payload-bounds.js";
import type { WorkflowInputSchemaMap } from "../shared/types.js";
import { panelItemsFromSnapshot } from "./panel-runs.js";

export type WorkflowsListingTarget = { kind: "run"; runId: string } | { kind: "definition"; name: string };

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

export function listingDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function listingAgo(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "yesterday" : `${days}d ago`;
}

export function shortFailureReason(
	run: Pick<RunSnapshot, "error" | "exitReason" | "failureMessage" | "result">,
): string | undefined {
	const text = run.error ?? run.exitReason ?? run.failureMessage ?? actionableReturnedStatusText(run.result);
	if (!text) return undefined;
	const first =
		text
			.split(/\r?\n/)
			.map((line) => sanitizeToolTitleText(line).trim())
			.find((line) => line.length > 0 && !/^at\s/.test(line)) ?? "";
	const clean = first.replace(/^(Error|[A-Z][A-Za-z]*Error):\s*/, "");
	return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean || undefined;
}

export function runStageText(run: RunSnapshot): string | undefined {
	const total = run.stages.length;
	if (total === 0) return undefined;
	const failed = run.failedStageId ? run.stages.find((stage) => stage.id === run.failedStageId) : undefined;
	const current = failed ?? run.stages.find((stage) => stage.status === "running") ?? undefined;
	const settled = run.stages.filter((stage) => stage.status !== "pending" && stage.status !== "running").length;
	const index = current ? run.stages.indexOf(current) + 1 : Math.min(total, settled);
	const stageName = current ? sanitizeToolTitleText(current.name).trim() : "";
	return `stage ${index}/${total}${stageName ? ` ${stageName}` : ""}`;
}

export function runCostText(run: RunSnapshot): string | undefined {
	const cost = run.budgetState?.accounting?.cost;
	return cost === undefined || cost <= 0 ? undefined : `$${cost.toFixed(2)}`;
}

export function runRowLabel(run: RunSnapshot): string {
	const name = sanitizeToolTitleText(run.name);
	if (run.label) return `${name} · ${sanitizeToolTitleText(run.label)}`;
	const input = Object.values(run.inputs).find((value) => typeof value === "string" && value.trim() !== "");
	const rawDetail =
		typeof input === "string"
			? sanitizeToolTitleText(input.split(/\r?\n/)[0] ?? "").trim()
			: sanitizeToolTitleText(run.id.slice(0, 8));
	const detail = rawDetail.length > 40 ? `${rawDetail.slice(0, 39)}…` : rawDetail;
	return `${name} · ${detail}`;
}

export function runRowDescription(
	run: RunSnapshot,
	now: number,
	question?: string,
	status: RunSnapshot["status"] = effectiveRunStatus(run),
): string {
	if (question !== undefined)
		return ["needs input", sanitizeToolTitleText(question), listingDuration(elapsedRunMs(run, now)), runCostText(run)]
			.filter((part): part is string => part !== undefined && part !== "")
			.join(" · ");
	const statusText = RUN_STATUS_TEXT[status];
	const live = status === "running" || status === "pending" || status === "paused";
	const reason = status === "failed" || status === "blocked" ? shortFailureReason(run) : undefined;
	const parts = [
		statusText,
		runStageText(run),
		live || run.endedAt === undefined ? undefined : listingAgo(now - run.endedAt),
		listingDuration(elapsedRunMs(run, now)),
		runCostText(run),
		reason ? `✗ ${reason}` : undefined,
	];
	return parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");
}

export function inputsSummary(inputs: WorkflowInputSchemaMap): string {
	const entries = Object.values(inputs);
	if (entries.length === 0) return "no inputs";
	const required = entries.filter((schema) => schemaIsRequired(schema)).length;
	const noun = entries.length === 1 ? "input" : "inputs";
	return required ? `${entries.length} ${noun} (${required} required)` : `${entries.length} ${noun}`;
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

export function workflowsListingItems(
	runs: readonly RunSnapshot[],
	definitions: readonly WorkflowsListingDefinition[],
	now = Date.now(),
): SelectorItem<WorkflowsListingTarget>[] {
	const waiting = new Map(
		panelItemsFromSnapshot(runs, now)
			.filter((item) => item.state === "input")
			.map((item) => [item.id, item.question ?? item.task] as const),
	);
	const runItems = [...topLevelWorkflowRuns(runs)]
		.sort((a, b) => b.startedAt - a.startedAt)
		.map((run): SelectorItem<WorkflowsListingTarget> => {
			const status = effectiveRunStatus(run);
			const question = waiting.get(`run:${run.id}`);
			const label = runRowLabel(run);
			const tag =
				question !== undefined
					? "◆"
					: status === "failed"
						? "✗"
						: status === "cancelled" || status === "killed"
							? "◼"
							: undefined;
			return {
				id: `run:${run.id}`,
				value: { kind: "run", runId: run.id },
				label,
				description: runRowDescription(run, now, question, status),
				tag,
				tagTone: question !== undefined ? "warning" : RUN_TONE[status],
				group: "Runs",
				searchText: `${label} ${sanitizeToolTitleText(run.id)} ${RUN_STATUS_TEXT[status]}`,
			};
		});
	const definitionItems = [...definitions]
		.sort((a, b) => a.normalizedName.localeCompare(b.normalizedName))
		.map((definition): SelectorItem<WorkflowsListingTarget> => {
			const label = sanitizeToolTitleText(definition.normalizedName);
			const summary = sanitizeToolTitleText(definition.description.split(/\r?\n/)[0] ?? "").trim();
			return {
				id: `definition:${definition.normalizedName}`,
				value: { kind: "definition", name: definition.normalizedName },
				label,
				description: [summary, inputsSummary(definition.inputs)].filter(Boolean).join(" · "),
				group: "Definitions",
				searchText: `${label} ${sanitizeToolTitleText(definition.description)}`,
			};
		});
	return [...runItems, ...definitionItems];
}

export interface WorkflowsListingUi {
	custom?: PiCustomOverlayFunction;
}

const LISTING_CLOCK_TICK_MS = 1_000;
const SELECTOR_CHROME_ROWS = 12;
const FOOTER_CHROME_ROWS = 2;
const IDLE_AGENT_PANEL_ROWS = 4;
const IDLE_AGENT_PANEL_OVERFLOW_ROWS = 1;
const LISTING_CHROME_ROWS =
	SELECTOR_CHROME_ROWS + FOOTER_CHROME_ROWS + IDLE_AGENT_PANEL_ROWS + IDLE_AGENT_PANEL_OVERFLOW_ROWS;

function listingMaxVisible(tui: PiCustomOverlayFactoryTui): number {
	const reportedRows = tui.terminal?.rows;
	const terminalRows =
		typeof reportedRows === "number" && Number.isFinite(reportedRows) && reportedRows > 0
			? Math.floor(reportedRows)
			: 24;
	return Math.max(1, Math.floor((terminalRows - LISTING_CHROME_ROWS) / 2));
}

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
		const settle = (target: WorkflowsListingTarget | undefined): boolean => {
			if (settled) return false;
			settled = true;
			release?.();
			resolve(target);
			return true;
		};
		const factory = (
			tui: PiCustomOverlayFactoryTui,
			_theme: unknown,
			_keys: unknown,
			done: (r: undefined) => void,
		): PiCustomComponent => {
			const finish = (target: WorkflowsListingTarget | undefined): void => {
				if (settle(target)) done(undefined);
			};
			let cachedRuns = source.runs();
			let cachedDefinitions = source.definitions();
			let currentNow = Date.now();
			const selector = new Selector<WorkflowsListingTarget>({
				title: "Workflows",
				items: workflowsListingItems(cachedRuns, cachedDefinitions, currentNow),
				layout: "two-line",
				maxVisible: listingMaxVisible(tui),
				search: true,
				searchPlaceholder: "Search…",
				emptyText: "No workflows in this session.",
				confirmLabel: "open",
				cancelLabel: "close",
				onSelect: (item) => finish(item.value),
				onCancel: () => finish(undefined),
			});
			let paintedSelectionId: string | undefined;
			let refreshedSincePaint = true;
			let movedSincePaint = false;
			let itemsStale = false;
			const refreshItems = (): void => {
				if (itemsStale) {
					itemsStale = false;
					cachedRuns = source.runs();
					cachedDefinitions = source.definitions();
					currentNow = Date.now();
					selector.setItems(workflowsListingItems(cachedRuns, cachedDefinitions, currentNow));
					refreshedSincePaint = true;
					return;
				}
				const now = Date.now();
				if (now === currentNow || cachedRuns.length === 0) return;
				currentNow = now;
				const beforeId = selector.getSelected()?.id;
				selector.setItems(workflowsListingItems(cachedRuns, cachedDefinitions, currentNow));
				if (selector.getSelected()?.id !== beforeId) refreshedSincePaint = true;
			};
			const tick = setInterval(() => {
				if (cachedRuns.length > 0) tui.requestRender?.();
			}, LISTING_CLOCK_TICK_MS);
			tick.unref?.();
			let unsubscribe: (() => void) | undefined;
			release = () => {
				clearInterval(tick);
				unsubscribe?.();
			};
			unsubscribe = source.subscribe?.(() => {
				itemsStale = true;
				tui.requestRender?.();
			});
			if (settled) release();
			return {
				render: (width: number) => {
					selector.setMaxVisible(listingMaxVisible(tui));
					refreshItems();
					const lines = selector.render(width);
					paintedSelectionId = selector.getSelected()?.id;
					refreshedSincePaint = false;
					movedSincePaint = false;
					return lines;
				},
				handleInput: (data: string) => {
					selector.setMaxVisible(listingMaxVisible(tui));
					refreshItems();
					const keys = getKeybindings();
					const confirms =
						keys.matches(data, "tui.select.confirm") ||
						(keys.matches(data, "app.list.open") && !selector.state.getQuery());
					if (!confirms) {
						selector.handleInput(data);
						movedSincePaint = true;
					} else if (
						!refreshedSincePaint ||
						(!movedSincePaint && selector.getSelected()?.id === paintedSelectionId)
					) {
						selector.handleInput(data);
					}
					tui.requestRender?.();
					return true;
				},
				invalidate: () => selector.invalidate(),
				dispose: () => finish(undefined),
			};
		};
		try {
			void Promise.resolve(
				custom(factory as Parameters<PiCustomOverlayFunction>[0], { overlay: false, purpose: "navigation" }),
			).then(
				() => settle(undefined),
				() => settle(undefined),
			);
		} catch {
			settle(undefined);
		}
	});
}
