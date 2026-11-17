import {
	renderNavHintLine,
	type SelectorItem,
	SelectorState,
	type SelectorStyle,
	selectorHintEntries,
	themeSelectorStyle,
} from "@bastani/atomic";
import { getKeybindings, Input, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { PiCustomComponent, PiCustomOverlayFactoryTui, PiCustomOverlayFunction } from "../extension/wiring.js";
import { actionableReturnedStatusText, effectiveRunStatus } from "../shared/returned-run-status.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import { schemaIsRequired } from "../shared/schema-introspection.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import { sanitizeToolTitleText } from "../shared/tool-payload-bounds.js";
import type { WorkflowInputSchemaMap } from "../shared/types.js";
import { inertDisplayLine } from "./display-text.js";
import { panelItemsFromSnapshot } from "./panel-runs.js";
import { summarizeFailureText } from "./run-outcome.js";

export interface WorkflowsListingInvalidDefinition {
	readonly name: string;
	readonly source?: string;
	readonly code: string;
	readonly reason: string;
	readonly message: string;
}

export type WorkflowsListingTarget =
	| { kind: "run"; runId: string }
	| { kind: "definition"; name: string }
	| { kind: "invalid-definition"; definition: WorkflowsListingInvalidDefinition };

const FAILED_TO_LOAD_CODES: ReadonlySet<string> = new Set(["INVALID_DEFINITION", "IMPORT_FAILED", "PATH_NOT_FOUND"]);
const NON_WORKFLOW_NAMED_EXPORT =
	/\bexport "(?!default")[^"]+" rejected: (?:export is not an object|missing or incorrect __piWorkflow sentinel\b|workflow definition is not produced by workflow\b)/;
const NAMED_EXPORT_REJECTION = /\bexport "(?!default").+?" rejected:/;
const RAW_SOURCE = Symbol("workflow.invalidDefinition.rawSource");

type InvalidDefinitionWithRawSource = WorkflowsListingInvalidDefinition & {
	readonly [RAW_SOURCE]?: string;
};

function definitionNameFromSource(source: string | undefined, code: string): string {
	if (source === undefined || source.trim() === "") return code.toLowerCase();
	const base = source.split(/[\\/]/).pop() ?? source;
	return base.replace(/\.(?:[cm]?[jt]s|tsx)$/, "") || source;
}

function withoutSourcePrefix(reason: string, source: string | undefined): string {
	if (source === undefined) return reason;
	const prefix = `Failed to import "${source}": `;
	return reason.startsWith(prefix) && reason.length > prefix.length ? reason.slice(prefix.length) : reason;
}

function invalidDefinitionDiscriminator(definition: WorkflowsListingInvalidDefinition): string {
	const exported = /\bexport\s+(?:"(.+?)"\s+rejected:|"([^"]+)"|([^\s:]+)\s*:)/.exec(definition.message);
	const exportKey = exported?.[1] ?? exported?.[2] ?? exported?.[3];
	if (exportKey !== undefined) return exportKey;
	if (definition.code === "INVALID_DEFINITION" || definition.source === undefined) return definition.reason;
	return "";
}

function rawDefinitionSource(definition: WorkflowsListingInvalidDefinition): string {
	return (definition as InvalidDefinitionWithRawSource)[RAW_SOURCE] ?? definition.source ?? definition.name;
}

function invalidDefinitionKey(definition: WorkflowsListingInvalidDefinition): string {
	const encoded = JSON.stringify([
		definition.code,
		rawDefinitionSource(definition),
		invalidDefinitionDiscriminator(definition),
	]).replace(
		/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	return `invalid-definition:${encoded}`;
}

function invalidDefinitionId(definition: WorkflowsListingInvalidDefinition, seen: Map<string, number>): string {
	const key = invalidDefinitionKey(definition);
	const count = seen.get(key) ?? 0;
	seen.set(key, count + 1);
	return count === 0 ? key : `${key}#${count}`;
}

export function invalidDefinitionsFromDiagnostics(
	diagnostics: readonly {
		readonly level: string;
		readonly code: string;
		readonly message: string;
		readonly source?: string;
	}[],
): WorkflowsListingInvalidDefinition[] {
	const entries: WorkflowsListingInvalidDefinition[] = [];
	const indexByKey = new Map<string, number>();
	for (const diagnostic of diagnostics) {
		if (
			diagnostic.level !== "error" ||
			!FAILED_TO_LOAD_CODES.has(diagnostic.code) ||
			(diagnostic.code === "INVALID_DEFINITION" && NON_WORKFLOW_NAMED_EXPORT.test(diagnostic.message))
		) {
			continue;
		}
		const source = diagnostic.source === undefined ? undefined : inertDisplayLine(diagnostic.source);
		const rawMessage = withoutSourcePrefix(diagnostic.message, diagnostic.source);
		const entry: WorkflowsListingInvalidDefinition = {
			name: inertDisplayLine(definitionNameFromSource(diagnostic.source, diagnostic.code)),
			...(source === undefined ? {} : { source }),
			code: diagnostic.code,
			reason: withoutSourcePrefix(summarizeFailureText(rawMessage).reason, source),
			message: diagnostic.message,
		};
		if (diagnostic.source !== undefined) {
			Object.defineProperty(entry, RAW_SOURCE, { value: diagnostic.source });
		}
		const key = invalidDefinitionKey(entry);
		const existing = indexByKey.get(key);
		if (existing !== undefined) {
			entries[existing] = entry;
		} else {
			indexByKey.set(key, entries.length);
			entries.push(entry);
		}
	}
	return entries;
}

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

function normalizeRunsForPanel(runs: readonly RunSnapshot[]): readonly RunSnapshot[] {
	if (
		runs.every(
			(run) =>
				Array.isArray(run.toolNodes) &&
				Array.isArray(run.stages) &&
				run.stages.every((stage) => Array.isArray(stage.parentIds)),
		)
	) {
		return runs;
	}
	return runs.map((run) => ({
		...run,
		toolNodes: Array.isArray(run.toolNodes) ? run.toolNodes : [],
		stages: Array.isArray(run.stages)
			? run.stages.map((stage) => (Array.isArray(stage.parentIds) ? stage : { ...stage, parentIds: [] }))
			: [],
	}));
}

export function workflowsListingItems(
	runs: readonly RunSnapshot[],
	definitions: readonly WorkflowsListingDefinition[],
	now = Date.now(),
	invalidDefinitions: readonly WorkflowsListingInvalidDefinition[] = [],
): SelectorItem<WorkflowsListingTarget>[] {
	const waiting = new Map(
		panelItemsFromSnapshot(normalizeRunsForPanel(runs), now)
			.filter((item) => item.state === "input")
			.map((item) => [item.id, item.question ?? item.task] as const),
	);
	const runItems = [...topLevelWorkflowRuns(runs)]
		.sort((a, b) => b.startedAt - a.startedAt)
		.map((run): SelectorItem<WorkflowsListingTarget> => {
			const status = effectiveRunStatus(run);
			const question = waiting.get(`run:${run.id}`);
			const label = inertDisplayLine(runRowLabel(run));
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
				description: inertDisplayLine(runRowDescription(run, now, question, status)),
				tag,
				tagTone: question !== undefined ? "warning" : RUN_TONE[status],
				group: "Runs",
				searchText: `${label} ${sanitizeToolTitleText(run.id)} ${RUN_STATUS_TEXT[status]}`,
			};
		});
	const seenInvalidIds = new Map<string, number>();
	const loadedNames = new Set(definitions.map((definition) => definition.normalizedName));
	const visibleInvalidDefinitions = invalidDefinitions.filter(
		(definition) =>
			!(
				definition.code === "INVALID_DEFINITION" &&
				loadedNames.has(definition.name) &&
				NAMED_EXPORT_REJECTION.test(definition.message)
			),
	);
	const definitionItems = [
		...definitions.map((definition): SelectorItem<WorkflowsListingTarget> => {
			const label = inertDisplayLine(sanitizeToolTitleText(definition.normalizedName));
			const summary = inertDisplayLine(sanitizeToolTitleText(definition.description.split(/\r?\n/)[0] ?? "")).trim();
			return {
				id: `definition:${definition.normalizedName}`,
				value: { kind: "definition", name: definition.normalizedName },
				label,
				description: [summary, inputsSummary(definition.inputs)].filter(Boolean).join(" · "),
				group: "Definitions",
				searchText: `${label} ${sanitizeToolTitleText(definition.description)}`,
			};
		}),
		...visibleInvalidDefinitions.map(
			(definition): SelectorItem<WorkflowsListingTarget> => ({
				id: invalidDefinitionId(definition, seenInvalidIds),
				value: { kind: "invalid-definition", definition },
				label: definition.name,
				description: `failed to load · ${definition.reason}`,
				tag: "✗",
				tagTone: "error",
				group: "Definitions",
				searchText: `${definition.name} ${definition.source ?? ""} failed ${definition.reason}`,
			}),
		),
	].sort((a, b) => a.label.localeCompare(b.label));
	return [...runItems, ...definitionItems];
}

export interface WorkflowsListingUi {
	custom?: PiCustomOverlayFunction;
}

const LISTING_CLOCK_TICK_MS = 1_000;
const TRANSCRIPT_MIN_ROWS = 1;
const USAGE_METER_ROWS = 1;
const FOOTER_CHROME_ROWS = 2;
const WIDGET_SPACER_ROWS = 1;
const IDLE_AGENT_PANEL_ROWS = 4;
const IDLE_AGENT_PANEL_OVERFLOW_ROWS = 1;
const BELOW_SHEET_ROWS =
	TRANSCRIPT_MIN_ROWS +
	USAGE_METER_ROWS +
	FOOTER_CHROME_ROWS +
	WIDGET_SPACER_ROWS +
	IDLE_AGENT_PANEL_ROWS +
	IDLE_AGENT_PANEL_OVERFLOW_ROWS;
const LISTING_HINT_OPTIONS = { search: true, confirmLabel: "open", cancelLabel: "close" };

function listingAvailableRows(tui: PiCustomOverlayFactoryTui): number {
	const reportedRows = tui.terminal?.rows;
	const terminalRows =
		typeof reportedRows === "number" && Number.isFinite(reportedRows) && reportedRows > 0
			? Math.floor(reportedRows)
			: 24;
	return Math.max(3, terminalRows - BELOW_SHEET_ROWS);
}

function renderListingSearch(search: Input, style: SelectorStyle, width: number): string {
	const raw = search.getValue();
	const safe = sanitizeToolTitleText(raw);
	if (raw === safe) return search.render(width)[0] ?? "";
	const display = new Input({ prompt: "⌕ ", placeholder: "Search…", placeholderStyle: style.dim });
	display.setValue(safe);
	Reflect.set(display, "cursor", sanitizeToolTitleText(raw.slice(0, search.getCursor())).length);
	display.focused = search.focused;
	return display.render(width)[0] ?? "";
}

function renderCompactListing(
	state: SelectorState<WorkflowsListingTarget>,
	search: Input,
	style: SelectorStyle,
	width: number,
): string[] {
	const visible = state.getVisible();
	const top = state.getTop();
	const end = Math.min(visible.length, top + state.maxVisible);
	const page = visible.slice(top, end);
	const groups = new Set(page.map((item) => item.group).filter((group) => group !== undefined));
	const singleGroup = !state.getQuery() && groups.size === 1 ? page[0]?.group : undefined;
	const title = `  ${style.bold(style.text("Workflows"))}${singleGroup ? style.muted(` · ${singleGroup}`) : ""}  `;
	const range = visible.length > 0 ? style.dim(`  ${top + 1}-${end}/${visible.length}`) : "";
	const searchWidth = Math.max(1, width - visibleWidth(title) - visibleWidth(range));
	const lines = [title + renderListingSearch(search, style, searchWidth) + range];
	if (page.length === 0) {
		const empty = state.getQuery()
			? `No matches for "${sanitizeToolTitleText(state.getQuery())}"`
			: "No workflows in this session.";
		lines.push(`  ${style.dim(truncateToWidth(empty, Math.max(1, width - 2)))}`);
	}
	let lastGroup: string | undefined;
	for (let index = 0; index < page.length; index++) {
		const item = page[index]!;
		if (groups.size > 1 && !state.getQuery() && item.group !== lastGroup && item.group !== undefined)
			lines.push(`  ${style.bold(style.muted(truncateToWidth(item.group, Math.max(1, width - 2))))}`);
		lastGroup = item.group;
		const selected = top + index === state.getSelectedIndex();
		const lead = selected ? ` ${style.accent(style.bold("❯ "))}` : "   ";
		const tagWidth = item.tag ? visibleWidth(item.tag) + 2 : 0;
		const label = truncateToWidth(item.label, Math.max(1, width - 3 - tagWidth));
		let line = lead + (selected ? style.accent(style.bold(label)) : style.text(label));
		if (item.tag)
			line +=
				" ".repeat(Math.max(2, width - 3 - visibleWidth(label) - visibleWidth(item.tag))) +
				style.tone(item.tagTone ?? "muted", item.tag);
		lines.push(line);
		lines.push(`   ${style.muted(truncateToWidth(item.description ?? "", Math.max(1, width - 3)))}`);
	}
	const hints = selectorHintEntries(state, LISTING_HINT_OPTIONS).filter((entry) => entry.label !== "to search");
	lines.push(renderNavHintLine(hints, width, style, getKeybindings()));
	return lines.map((line) => truncateToWidth(line, width));
}

export function openWorkflowsListing(
	ui: WorkflowsListingUi,
	source: {
		readonly runs: () => readonly RunSnapshot[];
		readonly definitions: () => readonly WorkflowsListingDefinition[];
		readonly invalidDefinitions?: () => readonly WorkflowsListingInvalidDefinition[];
		readonly subscribe?: (listener: () => void) => () => void;
		readonly selectRunId?: string;
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
			let cachedInvalidDefinitions = source.invalidDefinitions?.() ?? [];
			let currentNow = Date.now();
			let items = workflowsListingItems(cachedRuns, cachedDefinitions, currentNow, cachedInvalidDefinitions);
			const style = themeSelectorStyle();
			const search = new Input({ prompt: "⌕ ", placeholder: "Search…", placeholderStyle: style.dim });
			const selector = new SelectorState<WorkflowsListingTarget>({
				items,
				initialId: source.selectRunId === undefined ? undefined : `run:${source.selectRunId}`,
				maxVisible: Math.max(1, Math.floor((listingAvailableRows(tui) - 2) / 2)),
			});
			const handleSelectionInput = (data: string): void => {
				const keys = getKeybindings();
				if (keys.matches(data, "tui.select.up")) selector.move(-1);
				else if (keys.matches(data, "tui.select.down")) selector.move(1);
				else if (keys.matches(data, "tui.select.pageUp")) selector.page(-1);
				else if (keys.matches(data, "tui.select.pageDown")) selector.page(1);
				else if (keys.matches(data, "tui.select.cancel")) {
					if (selector.getQuery() && data !== "\x03") {
						search.setValue("");
						selector.setQuery("");
					} else finish(undefined);
				} else if (
					keys.matches(data, "tui.select.confirm") ||
					(keys.matches(data, "app.list.open") && !selector.getQuery())
				) {
					const selected = selector.getSelected();
					if (selected) finish(selected.value);
				} else {
					search.handleInput(data);
					selector.setQuery(search.getValue());
				}
			};
			let paintedSelectionId: string | undefined;
			let refreshedSincePaint = true;
			let movedSincePaint = false;
			let itemsStale = false;
			const sameIds = (
				before: readonly SelectorItem<WorkflowsListingTarget>[],
				after: readonly SelectorItem<WorkflowsListingTarget>[],
			): boolean => before.length === after.length && before.every((item, index) => item.id === after[index]?.id);
			const sameDescriptions = (
				before: readonly SelectorItem<WorkflowsListingTarget>[],
				after: readonly SelectorItem<WorkflowsListingTarget>[],
			): boolean =>
				sameIds(before, after) && before.every((item, index) => item.description === after[index]?.description);
			const visiblePage = (): SelectorItem<WorkflowsListingTarget>[] => {
				const visible = selector.getVisible();
				const top = selector.getTop();
				return visible.slice(top, top + selector.maxVisible);
			};
			const refreshClock = (fromTick = false): boolean => {
				const now = Date.now();
				if ((!fromTick && Math.abs(now - currentNow) < LISTING_CLOCK_TICK_MS) || cachedRuns.length === 0)
					return false;
				currentNow = now;
				const next = workflowsListingItems(cachedRuns, cachedDefinitions, currentNow, cachedInvalidDefinitions);
				if (sameDescriptions(items, next)) return false;
				items = next;
				const before = selector.getVisible();
				const beforePage = visiblePage();
				selector.setItems(items);
				if (!sameIds(before, selector.getVisible())) {
					refreshedSincePaint = true;
					return true;
				}
				return !sameDescriptions(beforePage, visiblePage());
			};
			const refreshItems = (): void => {
				if (itemsStale) {
					itemsStale = false;
					cachedRuns = source.runs();
					cachedDefinitions = source.definitions();
					cachedInvalidDefinitions = source.invalidDefinitions?.() ?? [];
					currentNow = Date.now();
					items = workflowsListingItems(cachedRuns, cachedDefinitions, currentNow, cachedInvalidDefinitions);
					selector.setItems(items);
					refreshedSincePaint = true;
					return;
				}
				refreshClock();
			};
			const tick = setInterval(() => {
				if (refreshClock(true)) tui.requestRender?.();
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
			const component: PiCustomComponent & { focused: boolean } = {
				render: (width: number) => {
					refreshItems();
					const availableRows = listingAvailableRows(tui);
					let maxVisible = Math.max(1, Math.floor((availableRows - 2) / 2));
					selector.setMaxVisible(maxVisible);
					let lines = renderCompactListing(selector, search, style, width);
					while (lines.length > availableRows && maxVisible > 1) {
						selector.setMaxVisible(--maxVisible);
						lines = renderCompactListing(selector, search, style, width);
					}
					paintedSelectionId = selector.getSelected()?.id;
					refreshedSincePaint = false;
					movedSincePaint = false;
					return lines;
				},
				handleInput: (data: string) => {
					refreshItems();
					const keys = getKeybindings();
					const confirms =
						keys.matches(data, "tui.select.confirm") ||
						(keys.matches(data, "app.list.open") && !selector.getQuery());
					if (!confirms) {
						handleSelectionInput(data);
						movedSincePaint = true;
					} else if (
						!refreshedSincePaint ||
						(!movedSincePaint && selector.getSelected()?.id === paintedSelectionId)
					) {
						handleSelectionInput(data);
					}
					tui.requestRender?.();
					return true;
				},
				invalidate: () => search.invalidate(),
				dispose: () => finish(undefined),
				get focused() {
					return search.focused;
				},
				set focused(value: boolean) {
					search.focused = value;
				},
			};
			return component;
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
