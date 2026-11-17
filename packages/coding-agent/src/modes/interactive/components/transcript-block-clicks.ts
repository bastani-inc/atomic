import {
	type Component,
	stripTerminalSequences,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "@bastani/atomic-tui";
import { keyText } from "./keybinding-hints.js";
import type { ToolGroupRole } from "./tool-block.ts";

/** A transcript block, such as a tool call or a finished-agent card, that a click on its header expands and collapses. */
export interface ClickExpandableBlock extends Component {
	readonly expandsOnClick: true;
	isExpanded(): boolean;
	setExpanded(expanded: boolean): void;
	/** The block's place in a group of finished calls; blocks that never group omit it. */
	getGroupRole?(): ToolGroupRole;
}

export function isClickExpandableBlock(component: Component | undefined): component is ClickExpandableBlock {
	return component !== undefined && (component as Partial<ClickExpandableBlock>).expandsOnClick === true;
}

function roleOf(block: ClickExpandableBlock): ToolGroupRole["kind"] {
	return block.getGroupRole?.().kind ?? "standalone";
}

/**
 * The blocks a click on `siblings[index]` acts on: a group's summary block with the calls folded into it, or the
 * block alone. Folded calls follow their summary block; rows between them that are not blocks, such as an empty
 * assistant turn, are skipped.
 */
function clickUnit(siblings: readonly Component[], index: number): readonly ClickExpandableBlock[] | undefined {
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

/** `… +12 earlier lines` and `... 12 more lines`, the rows that stand in for a collapsed block's hidden output. */
const HIDDEN_LINES_ROW = /^\s*(?:⎿\s*)?(?:…|\.\.\.)\s*\+?\d+ (?:earlier |more )?lines?\b/u;

/**
 * Whether `row` is part of a block's header: its first row, which carries the state glyph and title, or a row that
 * offers to expand or collapse the block.
 */
function isHeaderRow(lines: readonly string[], row: number): boolean {
	const text = stripTerminalSequences(lines[row] ?? "");
	if (text.trim().length === 0) return false;
	if (lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0) === row) return true;
	if (HIDDEN_LINES_ROW.test(text)) return true;
	const expandKey = keyText("app.tools.expand");
	return expandKey.length > 0 && text.includes(`${expandKey} `);
}

/**
 * Expand or collapse the block whose header row a single left click landed on, among `siblings` stacked in order.
 * Clicks in a block's body are left to text selection, so selecting body text works as everywhere else.
 * `owner` is the container the siblings belong to; it is reported as the click's handler.
 */
export function handleTranscriptBlockClick(
	owner: Component,
	siblings: readonly Component[],
	locate: (width: number, row: number) => { readonly component: Component; readonly row: number } | undefined,
	event: TuiMouseEvent,
): TuiMouseDispatchResult | undefined {
	if (event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
	if ((event.clickCount ?? 1) !== 1) return undefined;
	const hit = locate(event.width, event.y);
	if (!hit) return undefined;
	const index = siblings.indexOf(hit.component);
	const unit = index === -1 ? undefined : clickUnit(siblings, index);
	if (!unit || !isHeaderRow(hit.component.render(event.width), hit.row)) return undefined;
	const expand = !unit[0]!.isExpanded();
	for (const block of unit) block.setExpanded(expand);
	return {
		handled: true,
		target: {
			component: owner,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}
