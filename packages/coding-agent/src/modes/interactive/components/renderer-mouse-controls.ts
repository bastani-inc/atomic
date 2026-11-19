import {
	type Component,
	createMouseControl,
	readHintSpans,
	stripMouseControlMarkers,
	type TuiMouseEvent,
} from "@bastani/atomic-tui";
import type { ChatControlOptions } from "../../../core/extensions/ui-types.js";
import { registerBlockControlSlot } from "./transcript-block-clicks.ts";

type Bind = NonNullable<ChatControlOptions["bindMouseControl"]>;
type Handler = Parameters<Bind>[0];

/** A renderer slot owns the actions it explicitly binds. Only opaque IDs travel through the painted rows. */
export class RendererMouseControls {
	readonly comparableLine = stripMouseControlMarkers;
	private readonly block: Component;
	private readonly firstRow: number;
	constructor(block: Component, firstRow: number) {
		this.block = block;
		this.firstRow = firstRow;
	}
	private actions?: Map<string, Handler>;
	private owner?: Component;

	render<T extends Component | null | undefined>(factory: (bind: Bind) => T): T {
		let next: Map<string, Handler> | undefined;
		let binding = true;
		try {
			const component = factory((handle) => {
				if (!binding) throw new Error("Bind the mouse control in the renderer, before returning its component");
				const control = createMouseControl();
				next ??= new Map();
				next.set(control.token, handle);
				return control.label;
			});
			// A tool may reuse lastComponent with its original labels instead of binding a new set of actions.
			if (next || component !== this.owner) {
				this.actions = component ? next : undefined;
				this.owner = this.actions ? (component ?? undefined) : undefined;
			}
			if (next && component) registerBlockControlSlot(this.block, this);
			return component;
		} catch (error) {
			this.clear();
			throw error;
		} finally {
			binding = false;
			next = undefined;
		}
	}

	clear(): void {
		this.actions = undefined;
		this.owner = undefined;
	}

	handle(event: TuiMouseEvent, row: number): boolean {
		if (row < this.firstRow) return false;
		const span = event.paintedControl;
		const handle = span && this.actions?.get(span.token);
		if (!span || !handle) return false;
		// A measurement may veto the painted occurrence (removed/moved while held), never grant a new one.
		const line = this.block.render(event.width)[row];
		const live = line && readHintSpans(line).controls?.find((s) => s.start <= event.x && event.x < s.end);
		if (!live || live.token !== span.token || this.actions?.get(span.token) !== handle) return false;
		return (
			handle({ ...event, x: event.screenX - span.start, y: 0, width: span.end - span.start, height: 1 })?.handled ===
			true
		);
	}
}
