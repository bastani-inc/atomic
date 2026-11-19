import {
	type NavKey,
	navEntryKeys,
	renderNavHintLine,
	type SelectorItem,
	SelectorState,
	type SelectorStyle,
	selectorHintEntries,
	sliceHead,
	themeSelectorStyle,
} from "@bastani/atomic";
import {
	getKeybindings,
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import type { PiCustomComponent, PiCustomOverlayFactoryTui, PiCustomOverlayFunction } from "../extension/wiring.js";
import { displayRunStatus } from "../shared/display-run-status.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import { sanitizeToolTitleText } from "../shared/tool-payload-bounds.js";
import { inertDisplayLine, summarizeFailureText } from "./display-text.js";
import { panelItemsFromSnapshot } from "./panel-runs.js";
import { type RunFailureSource, runFailureText } from "./run-display-state.js";
import { runStateIndicator } from "./run-state-indicator.js";

export interface WorkflowsListingInvalidDefinition {
	readonly name: string;
	readonly source?: string;
	readonly code: string;
	readonly reason: string;
	readonly message: string;
}

export type WorkflowsListingTarget =
	| { kind: "run"; runId: string }
	| { kind: "invalid-definition"; definition: WorkflowsListingInvalidDefinition };

const FAILED_TO_LOAD_CODES: ReadonlySet<string> = new Set(["INVALID_DEFINITION", "IMPORT_FAILED", "PATH_NOT_FOUND"]);
const NON_WORKFLOW_NAMED_EXPORT =
	/\bexport "(?!default")[^"]+" rejected: (?:export is not an object|missing or incorrect __piWorkflow sentinel\b|workflow definition is not produced by workflow\b)/;
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
	if (!Number.isFinite(ms)) return "";
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function listingAgo(ms: number): string {
	if (!Number.isFinite(ms)) return "";
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "yesterday" : `${days}d ago`;
}

export function shortFailureReason(run: RunFailureSource & Pick<RunSnapshot, "exitReason">): string | undefined {
	const text = runFailureText(run) ?? run.exitReason;
	if (!text) return undefined;
	const summary = summarizeFailureText(text).reason;
	const clean = summary.replace(/^(Error|[A-Z][A-Za-z]*Error):\s*/, "");
	return clean.length > 60 ? `${sliceHead(clean, 59)}…` : clean || undefined;
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
	return typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0 ? undefined : `$${cost.toFixed(2)}`;
}

function firstNonBlankLine(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	for (const line of value.split(/\r?\n/)) {
		const clean = sanitizeToolTitleText(line).trim();
		if (clean.length > 0) return clean;
	}
	return undefined;
}

export function runRowLabel(run: RunSnapshot): string {
	const name = sanitizeToolTitleText(run.name);
	const label = firstNonBlankLine(run.label);
	if (label !== undefined) return `${name} · ${label}`;
	let rawDetail: string | undefined;
	for (const value of Object.values(run.inputs)) {
		rawDetail = firstNonBlankLine(value);
		if (rawDetail !== undefined) break;
	}
	const fallback = rawDetail ?? sanitizeToolTitleText(run.id.slice(0, 8)).trim();
	const detail = fallback.length > 40 ? `${sliceHead(fallback, 39)}…` : fallback;
	return `${name} · ${detail}`;
}

export function runRowDescription(
	run: RunSnapshot,
	now: number,
	question?: string,
	status: RunSnapshot["status"] = displayRunStatus(run),
): string {
	if (question !== undefined)
		return ["needs input", sanitizeToolTitleText(question), listingDuration(elapsedRunMs(run, now)), runCostText(run)]
			.filter((part): part is string => part !== undefined && part !== "")
			.join(" · ");
	const state = runStateIndicator(run, status);
	const statusText = state?.kind === "quit" ? "quit" : RUN_STATUS_TEXT[status];
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

function startedAtRank(run: RunSnapshot): number {
	return Number.isFinite(run.startedAt) ? run.startedAt : Number.NEGATIVE_INFINITY;
}

export function workflowsListingItems(
	runs: readonly RunSnapshot[],
	now = Date.now(),
	invalidDefinitions: readonly WorkflowsListingInvalidDefinition[] = [],
): SelectorItem<WorkflowsListingTarget>[] {
	// Reuse a marker the panel already read from this particular input, never a row at its former index.
	const markers = new Map<RunSnapshot, Pick<RunSnapshot, "blockedAt">>();
	const waiting = new Map(
		panelItemsFromSnapshot(runs, now, undefined, undefined, markers)
			.filter((item) => item.state === "input")
			.map((item) => [item.id, item.question ?? item.task] as const),
	);
	const runItems = [...topLevelWorkflowRuns(runs)]
		.sort((a, b) => startedAtRank(b) - startedAtRank(a))
		.map((run): SelectorItem<WorkflowsListingTarget> => {
			const status = displayRunStatus(run, markers.get(run) ?? run);
			const state = runStateIndicator(run, status);
			const statusText = state?.kind === "quit" ? "quit" : RUN_STATUS_TEXT[status];
			const question = waiting.get(`run:${run.id}`);
			const label = inertDisplayLine(runRowLabel(run));
			const tag =
				question !== undefined
					? "◆"
					: state?.kind === "quit"
						? state.glyph
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
				searchText: `${label} ${sanitizeToolTitleText(run.id)} ${statusText}`,
			};
		});
	const seenInvalidIds = new Map<string, number>();
	const definitionItems = invalidDefinitions
		.map(
			(definition): SelectorItem<WorkflowsListingTarget> => ({
				id: invalidDefinitionId(definition, seenInvalidIds),
				value: { kind: "invalid-definition", definition },
				label: definition.name,
				description: `failed to load · ${definition.reason}`,
				tag: "✗",
				tagTone: "error",
				searchText: `${definition.name} ${definition.source ?? ""} failed ${definition.reason}`,
			}),
		)
		.sort((a, b) => a.label.localeCompare(b.label));
	return [...runItems, ...definitionItems];
}

export interface WorkflowsListingUi {
	custom?: PiCustomOverlayFunction;
}

const LISTING_CLOCK_TICK_MS = 1_000;
const LISTING_CHROME_ROWS = 3;
const RUN_PREVIEW_ROWS = 5;
const MIN_ROWS_FOR_PREVIEW = LISTING_CHROME_ROWS + 2 + RUN_PREVIEW_ROWS;
const TRANSCRIPT_MIN_ROWS = 1;
const USAGE_METER_ROWS = 1;
const FOOTER_CHROME_ROWS = 2;
const BELOW_SHEET_ROWS = TRANSCRIPT_MIN_ROWS + USAGE_METER_ROWS + FOOTER_CHROME_ROWS;
const LISTING_HINT_DROP_ORDER = ["to search", "preview", "close preview", "select"];

function listingAvailableRows(tui: PiCustomOverlayFactoryTui): number {
	const reportedRows = tui.terminal?.rows;
	const terminalRows =
		typeof reportedRows === "number" && Number.isFinite(reportedRows) && reportedRows > 0
			? Math.floor(reportedRows)
			: 24;
	return Math.max(3, terminalRows - BELOW_SHEET_ROWS);
}

function fitListingHints(
	entries: readonly NavKey[],
	width: number,
	style: SelectorStyle,
	keybindings: ReturnType<typeof getKeybindings>,
): string {
	const kept = [...entries];
	const plainStyle: SelectorStyle = {
		dim: (t) => t,
		text: (t) => t,
		muted: (t) => t,
		border: (t) => t,
		bold: (t) => t,
		accent: (t) => t,
		tone: (_tone, t) => t,
	};
	while (kept.length > 1) {
		const rendered = renderNavHintLine(kept, 10_000, plainStyle, keybindings);
		if (visibleWidth(rendered) <= width) break;
		const drop = LISTING_HINT_DROP_ORDER.map((label) => kept.findIndex((entry) => entry.label === label)).find(
			(index) => index >= 0,
		);
		if (drop === undefined) break;
		kept.splice(drop, 1);
	}
	return renderNavHintLine(kept, width, style, keybindings);
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

function renderRunPreview(
	item: SelectorItem<WorkflowsListingTarget>,
	run: RunSnapshot | undefined,
	style: SelectorStyle,
	width: number,
): string[] {
	const inner = Math.max(1, width - 6);
	const border = style.border;
	const heading = ` ${truncateToWidth(item.label, Math.max(1, inner - 2))} `;
	const top = `  ${border("╭─")}${style.bold(style.text(heading))}${border(`${"─".repeat(Math.max(0, inner - visibleWidth(heading) + 1))}╮`)}`;
	const frame = (line: string): string => {
		const clipped = truncateToWidth(line, inner);
		return `  ${border("│ ")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${border(" │")}`;
	};
	const body: string[] = [];
	if (item.description) body.push(style.muted(item.description));
	if (run) {
		const stages = run.stages
			.map((stage) => `${sanitizeToolTitleText(stage.name).trim()} (${sanitizeToolTitleText(stage.status)})`)
			.filter(Boolean)
			.join(" · ");
		if (stages) body.push(style.dim(stages));
		for (const line of wrapTextWithAnsi(`id ${sanitizeToolTitleText(run.id)}`, inner)) body.push(style.dim(line));
	}
	const bottom = `  ${border(`╰${"─".repeat(Math.max(0, inner + 2))}╯`)}`;
	return [top, ...body.map(frame), bottom].map((line) => truncateToWidth(line, width));
}

function renderCompactListing(
	state: SelectorState<WorkflowsListingTarget>,
	runs: readonly RunSnapshot[],
	search: Input,
	style: SelectorStyle,
	width: number,
	previewOpen: boolean,
	previewAvailable: boolean,
): string[] {
	const visible = state.getVisible();
	const top = state.getTop();
	const end = Math.min(visible.length, top + state.maxVisible);
	const page = visible.slice(top, end);
	const title = `  ${style.bold(style.text("Workflows"))}  `;
	const range = visible.length > 0 ? style.dim(`  ${top + 1}-${end}/${visible.length}`) : "";
	const searchWidth = Math.max(1, width - visibleWidth(title) - visibleWidth(range));
	const hasSearch = state.items.length > 0 || state.getQuery().length > 0;
	const lines = [
		style.accent("▔".repeat(Math.max(0, Math.floor(width)))),
		hasSearch ? title + renderListingSearch(search, style, searchWidth) + range : title.trimEnd(),
	];
	if (page.length === 0) {
		const empty = state.getQuery()
			? `No matches for "${sanitizeToolTitleText(state.getQuery())}"`
			: "No workflows in this session.";
		lines.push(`  ${style.dim(truncateToWidth(empty, Math.max(1, width - 2)))}`);
	}
	for (let index = 0; index < page.length; index++) {
		const item = page[index]!;
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
		if (selected && previewOpen && !state.getQuery()) {
			const target = item.value;
			const selectedRun = target.kind === "run" ? runs.find((run) => run.id === target.runId) : undefined;
			lines.push(...renderRunPreview(item, selectedRun, style, width));
		}
	}
	const keybindings = getKeybindings();
	if (state.items.length === 0 && !state.getQuery()) {
		const closeKey = navEntryKeys(
			{ matches: () => false, getKeys: (action) => keybindings.getKeys(action as "tui.select.cancel").slice(0, 1) },
			{ action: "tui.select.cancel", label: "" },
		);
		if (closeKey) lines.push(renderNavHintLine([{ keys: closeKey, label: "to close" }], width, style, keybindings));
	} else {
		const hints = selectorHintEntries(state, {
			search: true,
			confirmLabel: "open",
			cancelLabel: "close",
			onPreview: !state.getQuery() && previewAvailable ? () => {} : undefined,
			previewLabel: previewOpen ? "close preview" : "preview",
			keybindings,
		});
		lines.push(fitListingHints(hints, width, style, keybindings));
	}
	return lines.map((line) => truncateToWidth(line, width));
}

/** The theme's live styles: they follow the cached color level, so an open list repaints when it changes. */
function listingStyle(): SelectorStyle {
	return themeSelectorStyle();
}

export function openWorkflowsListing(
	ui: WorkflowsListingUi,
	source: {
		readonly runs: () => readonly RunSnapshot[];
		readonly invalidDefinitions?: () => readonly WorkflowsListingInvalidDefinition[];
		readonly subscribe?: (listener: () => void) => () => void;
		readonly initialId?: string;
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
			let cachedInvalidDefinitions = source.invalidDefinitions?.() ?? [];
			let currentNow = Date.now();
			let items = workflowsListingItems(cachedRuns, currentNow, cachedInvalidDefinitions);
			const style = listingStyle();
			const search = new Input({ prompt: "⌕ ", placeholder: "Search…", placeholderStyle: style.dim });
			const initialId = source.selectRunId !== undefined ? `run:${source.selectRunId}` : source.initialId;
			const selector = new SelectorState<WorkflowsListingTarget>({
				items,
				initialId,
				maxVisible: Math.max(1, Math.floor((listingAvailableRows(tui) - LISTING_CHROME_ROWS) / 2)),
			});
			let baseTop = selector.getTop();
			let previewOpen = false;
			const canShowPreview = (): boolean =>
				!selector.getQuery() &&
				selector.getSelected() !== undefined &&
				listingAvailableRows(tui) >= MIN_ROWS_FOR_PREVIEW;
			const handleSelectionInput = (data: string): boolean => {
				const keys = getKeybindings();
				if (selector.items.length === 0 && !selector.getQuery()) {
					if (keys.matches(data, "tui.select.cancel")) finish(undefined);
					return false;
				}
				if (keys.matches(data, "tui.select.up")) selector.move(-1);
				else if (keys.matches(data, "tui.select.down")) selector.move(1);
				else if (keys.matches(data, "tui.select.pageUp")) selector.page(-1);
				else if (keys.matches(data, "tui.select.pageDown")) selector.page(1);
				else if (data === " " && !selector.getQuery()) {
					if (canShowPreview()) previewOpen = !previewOpen;
					return false;
				} else if (keys.matches(data, "tui.select.cancel")) {
					if (previewOpen && !matchesKey(data, "ctrl+c")) {
						previewOpen = false;
						return false;
					}
					if (selector.getQuery() && !matchesKey(data, "ctrl+c")) {
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
					if (selector.getQuery()) previewOpen = false;
				}
				if (!selector.getSelected()) previewOpen = false;
				baseTop = selector.getTop();
				return true;
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
				const next = workflowsListingItems(cachedRuns, currentNow, cachedInvalidDefinitions);
				if (sameDescriptions(items, next)) return false;
				items = next;
				const before = selector.getVisible();
				const beforePage = visiblePage();
				selector.setItems(items);
				baseTop = selector.getTop();
				refreshedSincePaint = true;
				return !sameIds(before, selector.getVisible()) || !sameDescriptions(beforePage, visiblePage());
			};
			const refreshItems = (): void => {
				if (itemsStale) {
					itemsStale = false;
					cachedRuns = source.runs();
					cachedInvalidDefinitions = source.invalidDefinitions?.() ?? [];
					currentNow = Date.now();
					items = workflowsListingItems(cachedRuns, currentNow, cachedInvalidDefinitions);
					selector.setItems(items);
					if (!selector.getSelected()) previewOpen = false;
					baseTop = selector.getTop();
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
					const previewAvailable = canShowPreview();
					if (!previewAvailable) previewOpen = false;
					let maxVisible = Math.max(1, Math.floor((availableRows - LISTING_CHROME_ROWS) / 2));
					Reflect.set(selector, "top", baseTop);
					Reflect.set(selector, "_maxVisible", 0);
					selector.setMaxVisible(maxVisible);
					baseTop = selector.getTop();
					let lines = renderCompactListing(
						selector,
						cachedRuns,
						search,
						style,
						width,
						previewOpen,
						previewAvailable,
					);
					while (lines.length > availableRows && maxVisible > 1) {
						selector.setMaxVisible(--maxVisible);
						lines = renderCompactListing(
							selector,
							cachedRuns,
							search,
							style,
							width,
							previewOpen,
							previewAvailable,
						);
					}
					if (previewOpen && lines.length > availableRows) {
						lines = renderCompactListing(selector, cachedRuns, search, style, width, false, previewAvailable);
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
						if (handleSelectionInput(data)) movedSincePaint = true;
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
