import { type Component, Container, truncateToWidth } from "@bastani/atomic-tui";
import { codemodeNestedCallBlock } from "../../../extensions/codemode/renderer.js";
import { type CodemodeNestedCall, isCodemodeToolCall } from "../../../extensions/codemode/tool.js";
import { theme } from "../theme/theme.js";
import { keyHintIfBound } from "./keybinding-hints.js";
import { disposeRenderer } from "./renderer-disposal.js";
import type { ToolGroupRole } from "./tool-block.ts";
import { type RowRange, rowsFrom } from "./transcript-block-clicks.ts";

/** Nested calls a script shows as blocks; earlier ones fold into one line until expanded. */
export const CODEMODE_NESTED_CALLS_SHOWN = 8;

const STANDALONE: ToolGroupRole = { kind: "standalone" };
const HIDDEN: ToolGroupRole = { kind: "hidden" };

/** A nested call's block in the chat: the component its own tool draws, or a generic row. */
export interface CodemodeNestedCallComponent extends Component {
	isExpanded(): boolean;
	setExpanded(expanded: boolean): void;
	setGroupRole(role: ToolGroupRole): void;
	setOutputPad?(outputPad: number): void;
}

/** The nested tool calls in a codemode result's details, in the order the script started them. */
export function codemodeNestedToolCalls(details: unknown): CodemodeNestedCall[] {
	const calls = (details as { calls?: unknown } | null | undefined)?.calls;
	if (!Array.isArray(calls)) return [];
	return calls.filter(
		(call): call is CodemodeNestedCall =>
			typeof call === "object" &&
			call !== null &&
			typeof (call as CodemodeNestedCall).id === "string" &&
			typeof (call as CodemodeNestedCall).name === "string" &&
			isCodemodeToolCall(call as CodemodeNestedCall),
	);
}

/**
 * `result` for the codemode block of a chat that draws its nested tool calls as blocks of their own: without those
 * calls, so the block keeps only the script, its model calls and its output.
 */
export function withoutCodemodeToolCalls<T extends { details?: unknown }>(result: T): T {
	const details = result.details as { calls?: unknown } | null | undefined;
	if (typeof details !== "object" || details === null || !Array.isArray(details.calls)) return result;
	const calls = details.calls.filter(
		(call) =>
			typeof call === "object" &&
			call !== null &&
			typeof (call as CodemodeNestedCall).name === "string" &&
			!isCodemodeToolCall(call as CodemodeNestedCall),
	);
	return calls.length === details.calls.length ? result : { ...result, details: { ...details, calls } };
}

/** The order a script started a nested call in: the number its id ends with, `<codemode call id>/<n>`. */
function startOrder(id: string): number {
	const match = /\/(\d+)$/.exec(id);
	return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/**
 * `… +N earlier calls`: the line the folded calls of a script stand behind. It heads them as a group does its calls,
 * so a click on it, or on any of them once shown, shows or folds them all.
 */
class EarlierCallsFold implements Component {
	readonly expandsOnClick = true;
	private expanded = false;
	private outputPad: number;
	private readonly folded: () => number;
	constructor(folded: () => number, outputPad: number) {
		this.folded = folded;
		this.outputPad = outputPad;
	}
	isExpanded(): boolean {
		return this.expanded;
	}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
	}
	getGroupRole(): ToolGroupRole {
		return { kind: "head", clauses: [] };
	}
	clickArea(width: number): RowRange | undefined {
		return rowsFrom(1, this.render(width).length);
	}
	invalidate(): void {}
	render(width: number): string[] {
		const count = this.folded();
		if (this.expanded || count === 0 || width < 1) return [];
		const pad = " ".repeat(Math.max(0, Math.min(this.outputPad, width - 1)));
		const hint = keyHintIfBound("app.tools.expand", "to expand");
		const label = `… +${count} earlier ${count === 1 ? "call" : "calls"}${hint ? ` (${hint})` : ""}`;
		return ["", truncateToWidth(`${pad}${theme.fg("dim", label)}`, width, "…")];
	}
}

/**
 * A nested call drawn as a generic row: a call of a session saved before nested calls kept their blocks, or one whose
 * block was over the limits.
 */
export class CodemodeGenericCallComponent implements CodemodeNestedCallComponent {
	readonly expandsOnClick = true;
	private readonly call: CodemodeNestedCall;
	private readonly cwd: string;
	private outputPad: number;
	private expanded = false;
	private role: ToolGroupRole = STANDALONE;
	constructor(call: CodemodeNestedCall, cwd: string, outputPad: number) {
		this.call = call;
		this.cwd = cwd;
		this.outputPad = outputPad;
	}
	isExpanded(): boolean {
		return this.expanded;
	}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	getGroupRole(): ToolGroupRole {
		return this.role;
	}
	setGroupRole(role: ToolGroupRole): void {
		this.role = role;
	}
	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
	}
	clickArea(width: number): RowRange | undefined {
		return rowsFrom(1, this.render(width).length);
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1 || (!this.expanded && this.role.kind === "hidden")) return [];
		return ["", ...codemodeNestedCallBlock(this.call, theme, this.expanded, this.cwd, this.outputPad).render(width)];
	}
}

interface NestedCallSlot {
	readonly id: string;
	readonly order: number;
	readonly component: CodemodeNestedCallComponent;
	hidden: boolean;
}

/**
 * The tool calls one codemode script made, each drawn as a block of its own, after the script's block and in the order
 * the script started them. Past {@link CODEMODE_NESTED_CALLS_SHOWN} calls the earlier ones fold into a line; expanding
 * shows them all. Its rows are its children, so a click reaches the block it lands on.
 */
export class CodemodeNestedCalls extends Container {
	private readonly fold: EarlierCallsFold;
	private readonly slots: NestedCallSlot[] = [];
	private readonly running = new Set<string>();
	private disposed = false;

	constructor(outputPad: number, expanded: boolean) {
		super();
		this.fold = new EarlierCallsFold(() => this.foldedCount(), outputPad);
		this.fold.setExpanded(expanded);
		this.children = [this.fold];
	}

	get size(): number {
		return this.slots.length;
	}

	/**
	 * A saved transcript page may draw these blocks again only when it can draw each of them again: a block whose
	 * renderer keeps state of its own must say it can; a block without such state can.
	 */
	get historyReplayable(): boolean {
		return this.slots.every((slot) => {
			const block = slot.component as {
				readonly historyReplayable?: boolean;
				readonly selectionTextMayChangeOnReplay?: boolean;
			};
			return block.selectionTextMayChangeOnReplay !== true || block.historyReplayable === true;
		});
	}

	/** Whether a block drawn again may read differently, as one whose renderer keeps state of its own can. */
	get selectionTextMayChangeOnReplay(): boolean {
		return this.slots.some(
			(slot) =>
				(slot.component as { readonly selectionTextMayChangeOnReplay?: boolean }).selectionTextMayChangeOnReplay ===
				true,
		);
	}

	has(id: string): boolean {
		return this.slots.some((slot) => slot.id === id);
	}

	get(id: string): CodemodeNestedCallComponent | undefined {
		return this.slots.find((slot) => slot.id === id)?.component;
	}

	/** Adds the block of call `id` in start order. A `running` call is one whose end is still to come. */
	add(id: string, component: CodemodeNestedCallComponent, running = false): void {
		if (this.disposed || this.has(id)) return;
		const order = startOrder(id);
		const slot: NestedCallSlot = { id, order, component, hidden: false };
		const at = this.slots.findIndex((existing) => existing.order > order);
		if (at < 0) this.slots.push(slot);
		else this.slots.splice(at, 0, slot);
		if (running) this.running.add(id);
		this.children = [this.fold, ...this.slots.map((entry) => entry.component)];
		this.arrange();
	}

	/** Call `id` ended. */
	settle(id: string): void {
		this.running.delete(id);
	}

	/** Calls whose end has not come, in start order. */
	runningCalls(): CodemodeNestedCallComponent[] {
		return this.slots.filter((slot) => this.running.has(slot.id)).map((slot) => slot.component);
	}

	setOutputPad(outputPad: number): void {
		this.fold.setOutputPad(outputPad);
		for (const slot of this.slots) slot.component.setOutputPad?.(outputPad);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const slot of this.slots) disposeRenderer(slot.component);
		this.slots.length = 0;
		this.running.clear();
		this.children = [];
	}

	private foldedCount(): number {
		return Math.max(0, this.slots.length - CODEMODE_NESTED_CALLS_SHOWN);
	}

	/** The earlier calls fold behind the line; one that just folded takes the line's expansion. */
	private arrange(): void {
		const folded = this.foldedCount();
		this.slots.forEach((slot, index) => {
			const hidden = index < folded;
			if (hidden === slot.hidden) return;
			slot.hidden = hidden;
			if (hidden) slot.component.setExpanded(this.fold.isExpanded());
			slot.component.setGroupRole(hidden ? HIDDEN : STANDALONE);
		});
	}
}
