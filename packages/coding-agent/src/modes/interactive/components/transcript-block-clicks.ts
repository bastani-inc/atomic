import type { Component, Container, TuiMouseEvent } from "@bastani/atomic-tui";
import { isSingleLeftClick } from "./single-click.ts";
import type { ToolGroupRole } from "./tool-block.ts";

/** What a container's mouse handler returns: the component that handled the event, and where it is drawn. */
export type ContainerMouseResult = ReturnType<Container["handleMouse"]>;

/** A transcript block, such as a tool call or a finished-agent card, that a click on its header expands and collapses. */
export interface ClickExpandableBlock extends Component {
	readonly expandsOnClick: true;
	isExpanded(): boolean;
	setExpanded(expanded: boolean): void;
	/**
	 * The rows of `render(width)` that are the block's header: the row with its state glyph and title. The block's
	 * renderer reports them; a click on any other row, such as output that happens to read like a hint, is not one.
	 */
	headerRows(width: number): readonly number[];
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

/**
 * The blocks a click on row `row` of `siblings[index]` drawn at `width` expands or collapses: the block and, for a
 * group summary or one of its calls, the whole group. Undefined unless the row is the clicked block's header.
 */
export function clickedBlocks(
	siblings: readonly Component[],
	index: number,
	width: number,
	row: number,
): readonly ClickExpandableBlock[] | undefined {
	const clicked = siblings[index];
	if (!isClickExpandableBlock(clicked) || !clicked.headerRows(width).includes(row)) return undefined;
	return clickUnit(siblings, index);
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
	onToggled?: (expanded: boolean) => void,
): ContainerMouseResult {
	if (!isSingleLeftClick(event)) return undefined;
	const hit = locate(event.width, event.y);
	if (!hit) return undefined;
	const index = siblings.indexOf(hit.component);
	const unit = index === -1 ? undefined : clickedBlocks(siblings, index, event.width, hit.row);
	if (!unit) return undefined;
	const expand = !unit[0]!.isExpanded();
	for (const block of unit) block.setExpanded(expand);
	onToggled?.(expand);
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
