import type { Component, Container, TuiMouseEvent, TuiMouseEventResult } from "@bastani/atomic-tui";
import { isSingleLeftClick } from "./single-click.ts";
import type { ToolGroupRole } from "./tool-block.ts";

/** What a container's mouse handler returns: the component that handled the event, and where it is drawn. */
export type ContainerMouseResult = ReturnType<Container["handleMouse"]>;

/** Rows `start` up to, not including, `end` of what a component rendered. */
export interface RowRange {
	readonly start: number;
	readonly end: number;
}

/**
 * A transcript block that Ctrl+O expands and collapses, such as a tool call, a finished-agent card or a message card. A
 * single click anywhere on it expands or collapses it too.
 */
export interface ClickExpandableBlock extends Component {
	/** Whether a click on the block expands it; a wrapper is a block only while it wraps one. */
	readonly expandsOnClick: boolean;
	isExpanded(): boolean;
	setExpanded(expanded: boolean): void;
	/**
	 * The rows of `render(width)` a click toggles the block from: everything the block draws, without the blank rows
	 * that only separate it from the block above. Undefined while it draws nothing.
	 */
	clickArea(width: number): RowRange | undefined;
	/** The block's place in a group of finished calls; blocks that never group omit it. */
	getGroupRole?(): ToolGroupRole;
	/**
	 * Sets the expansion a click asked for on a block whose rows are drawn elsewhere and arrive later, such as one the
	 * isolated engine renders. It calls `changed` once the new rows differ from the old ones, and otherwise goes back
	 * to the expansion it had. Blocks drawn in place omit it: they are drawn in both states at once instead.
	 */
	expandByClick?(expanded: boolean, changed: () => void, width: number, signal?: AbortSignal): void;
}

export function isClickExpandableBlock(component: Component | undefined): component is ClickExpandableBlock {
	return component !== undefined && (component as Partial<ClickExpandableBlock>).expandsOnClick === true;
}

/** Every row of a block that renders `rendered` rows from row `start` on, or undefined when it draws none there. */
export function rowsFrom(start: number, rendered: number): RowRange | undefined {
	return rendered > start ? { start, end: rendered } : undefined;
}

function roleOf(block: ClickExpandableBlock): ToolGroupRole["kind"] {
	return block.getGroupRole?.().kind ?? "standalone";
}

/**
 * The blocks a click on `siblings[index]` acts on: a group's summary block with the calls folded into it, or the
 * block alone. Folded calls follow their summary block; rows between them that are not blocks, such as an empty
 * assistant turn, are skipped.
 */
export function clickUnit(siblings: readonly Component[], index: number): readonly ClickExpandableBlock[] | undefined {
	const clicked = siblings[index];
	if (!isClickExpandableBlock(clicked)) return undefined;
	let headIndex = index;
	if (roleOf(clicked) === "hidden") {
		headIndex = -1;
		for (let at = index - 1; at >= 0; at -= 1) {
			const sibling = siblings[at];
			if (!isClickExpandableBlock(sibling)) continue;
			const role = roleOf(sibling);
			if (role === "hidden") continue;
			if (role === "head") headIndex = at;
			break;
		}
		if (headIndex === -1) return [clicked];
	}
	const head = siblings[headIndex] as ClickExpandableBlock;
	const blocks: ClickExpandableBlock[] = [head];
	if (roleOf(head) !== "head") return blocks;
	for (let at = headIndex + 1; at < siblings.length; at += 1) {
		const sibling = siblings[at];
		if (!isClickExpandableBlock(sibling)) continue;
		if (roleOf(sibling) !== "hidden") break;
		blocks.push(sibling);
	}
	return blocks;
}

/**
 * The blocks a click on row `row` of `siblings[index]` drawn at `width` expands or collapses: the block and, for a
 * group summary or one of its calls, the whole group. Undefined unless the row is one the clicked block draws.
 */
export function clickedBlocks(
	siblings: readonly Component[],
	index: number,
	width: number,
	row: number,
): readonly ClickExpandableBlock[] | undefined {
	const clicked = siblings[index];
	if (!isClickExpandableBlock(clicked)) return undefined;
	const area = clicked.clickArea(width);
	if (area === undefined || row < area.start || row >= area.end) return undefined;
	return clickUnit(siblings, index);
}

/** Whether a click on `unit` folds or shows a group's calls, which always changes what it draws. */
export function isClickedGroup(unit: readonly ClickExpandableBlock[]): boolean {
	const [head] = unit;
	return unit.length > 1 || (head !== undefined && roleOf(head) === "head");
}

let comparisonTime: number | undefined;

/** A tool's elapsed label must read the same clock in both synchronous draws of a click comparison. */
export function blockRenderTime(): number {
	return comparisonTime ?? Date.now();
}

export function withBlockRenderTime<T>(draw: () => T): T {
	const previous = comparisonTime;
	comparisonTime = blockRenderTime();
	try {
		return draw();
	} finally {
		comparisonTime = previous;
	}
}

export function sameRows(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

/**
 * Sets `block` expanded or collapsed and keeps that only when it changes the rows the block draws at `width`. Whether
 * it did: a block with nothing to expand or collapse goes back to how it was.
 */
export function expandIfItChangesRows(block: ClickExpandableBlock, width: number, expanded: boolean): boolean {
	return withBlockRenderTime(() => {
		const before = block.render(width);
		block.setExpanded(expanded);
		if (!sameRows(before, block.render(width))) return true;
		block.setExpanded(!expanded);
		return false;
	});
}

/**
 * Toggles `unit`, the blocks a click landed on, from the expansion they have now, and calls `changed` with the new
 * expansion once that changes what they draw. A group always does, since its summary folds or shows the calls; a lone
 * block with nothing to expand stays as it is.
 */
export function toggleClickedBlocks(
	unit: readonly ClickExpandableBlock[],
	width: number,
	changed: (expanded: boolean) => void,
	signal?: AbortSignal,
): void {
	const [head] = unit;
	if (head === undefined) return;
	// Read when the click settles, not when it landed: another click on the block may have settled in between.
	const expanded = !head.isExpanded();
	if (isClickedGroup(unit)) {
		for (const block of unit) block.setExpanded(expanded);
		changed(expanded);
		return;
	}
	if (head.expandByClick) {
		head.expandByClick(expanded, () => changed(expanded), width, signal);
		return;
	}
	if (expandIfItChangesRows(head, width, expanded)) changed(expanded);
}

/**
 * The blocks a click on row `row` of `container`, drawn at `width`, expands or collapses: among its children or, for a
 * child that is a plain container of blocks, among that child's children.
 */
function clickUnitAt(
	container: Container,
	width: number,
	row: number,
): (() => readonly ClickExpandableBlock[] | undefined) | undefined {
	const hit = container.childAtRow(width, row);
	if (!hit || !container.children.includes(hit.component)) return undefined;
	if (isClickExpandableBlock(hit.component)) {
		const area = hit.component.clickArea(width);
		if (!area || hit.row < area.start || hit.row >= area.end) return undefined;
		return () => clickUnit(container.children, container.children.indexOf(hit.component));
	}
	const nested = hit.component as Container;
	if (!nested.children || !nested.childAtRow) return undefined;
	const unit = clickUnitAt(nested, width, hit.row);
	return unit && (() => (container.children.includes(nested) ? unit() : undefined));
}

// A global expansion supersedes only transcript toggles, not other controls' single-click actions.
const clickScopes = new WeakMap<Container, AbortController>();
const pressedScopes = new WeakMap<Container, AbortSignal>();

export function supersedeBlockClicks(container: Container): void {
	clickScopes.get(container)?.abort();
	clickScopes.delete(container);
}

/** A click names the block it landed on. It toggles that block in its current group at the current width. */
export function handleTranscriptBlockClick(
	owner: Component,
	container: Container,
	event: TuiMouseEvent,
	currentWidth: () => number | undefined,
	onToggled?: (expanded: boolean) => void,
): ContainerMouseResult {
	if (event.type !== "press" && !isSingleLeftClick(event)) return undefined;
	let scope = clickScopes.get(container);
	if (!scope) {
		scope = new AbortController();
		clickScopes.set(container, scope);
	}
	if (event.type === "press") {
		pressedScopes.set(container, scope.signal);
		return undefined;
	}
	const signal = pressedScopes.get(container) ?? scope.signal;
	pressedScopes.delete(container);
	if (signal.aborted) return undefined;
	// The click names its blocks where it lands; it toggles them once it settles, so each single click toggles once.
	const unit = clickUnitAt(container, event.width, event.y);
	if (!unit) return undefined;
	return {
		handled: true,
		whenSingleClick: () => {
			if (signal.aborted) return;
			const blocks = unit();
			const width = currentWidth();
			if (blocks && width !== undefined)
				toggleClickedBlocks(blocks, width, (expanded) => onToggled?.(expanded), signal);
		},
		target: {
			component: owner,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}

/** `result`, with `repaint` run once its single-click action has run, for a view that draws what the action changed. */
export function repaintAfterSingleClick(
	result: TuiMouseEventResult | undefined,
	repaint: () => void,
): TuiMouseEventResult | undefined {
	const action = result?.whenSingleClick;
	if (result === undefined || action === undefined) return result;
	return {
		...result,
		whenSingleClick: () => {
			action();
			repaint();
		},
	};
}

/**
 * `container` drawn outside the transcript, such as the pending area below it, while `hidden` is false. Its blocks
 * take clicks as the transcript's do.
 */
export function clickableBlocksView(container: Container, hidden: () => boolean): Component {
	let paintedWidth: number | undefined;
	const view: Component & Pick<Container, "childAtRow"> = {
		childAtRow: (width, row) => (paintedWidth === width ? container.childAtRow(width, row) : undefined),
		render: (width) => {
			paintedWidth = hidden() ? undefined : width;
			return paintedWidth === undefined ? [] : container.render(width);
		},
		invalidate: () => container.invalidate(),
		handleMouse: (event) => handleTranscriptBlockClick(view, container, event, () => paintedWidth),
	};
	return view;
}
