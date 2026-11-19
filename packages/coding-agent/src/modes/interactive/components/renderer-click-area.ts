import { isProxy } from "node:util/types";
import {
	Box,
	type Component,
	Container,
	Editor,
	Input,
	MouseRegion,
	SelectList,
	SettingsList,
	type TuiMouseEvent,
} from "@bastani/atomic-tui";
import { isOnLabelCell, labelSourceBudget } from "@bastani/atomic-tui/dist/utils.js";
import {
	type ClickExpandableBlock,
	type ContainerMouseResult,
	type RowRange,
	rowsFrom,
} from "./transcript-block-clicks.ts";

type Handler = NonNullable<Component["handleMouse"]>;
interface Control {
	component: Component;
	handle: Handler;
	id: symbol;
}
interface Pending {
	action: () => void;
	cancel?: () => void;
}
interface Mount {
	host: Container;
	top: number;
	title?: number;
	controls: Control[];
	pending?: Map<object, Pending>;
}
const mounts = new WeakMap<Component, Mount>();

/** Recognize a direct declaration, never an inherited layout dispatcher (including a bound or bundled copy). */
function directHandler(component: Component): Handler | undefined {
	try {
		if (isProxy(component)) return undefined;
		const proto: object | null = Object.getPrototypeOf(component);
		if (proto && isProxy(proto)) return undefined;
		const declaration =
			Object.getOwnPropertyDescriptor(component, "handleMouse") ??
			(proto && Object.getOwnPropertyDescriptor(proto, "handleMouse"));
		const handle: Handler | undefined = declaration?.value;
		if (
			typeof handle !== "function" ||
			Object.hasOwn(component, "children") ||
			(Object.hasOwn(component, "child") && Object.hasOwn(component, "onMouse"))
		)
			return undefined;
		if (
			handle === Container.prototype.handleMouse ||
			handle === Box.prototype.handleMouse ||
			handle === MouseRegion.prototype.handleMouse ||
			handle === Input.prototype.handleMouse ||
			handle === Editor.prototype.handleMouse ||
			handle === SelectList.prototype.handleMouse ||
			handle === SettingsList.prototype.handleMouse
		)
			return undefined;
		return handle;
	} catch {
		// Opaque renderers may decline inspection. A click on their card still toggles it normally.
		return undefined;
	}
}

export function unmountRendererControls(block: Component): void {
	mounts.get(block)?.pending?.clear();
	mounts.delete(block);
}

export function mountRendererControls(
	block: Component,
	host: Container,
	components: readonly (Component | undefined)[],
	top = 0,
	title?: number,
): void {
	const controls: Control[] = [];
	for (const component of components) {
		if (!component || components.indexOf(component) !== components.lastIndexOf(component)) continue;
		const handle = directHandler(component);
		if (handle) controls.push({ component, handle, id: Symbol() });
	}
	if (controls.length) mounts.set(block, { host, top, title, controls });
}

// An accessor or opaque prototype cannot certify an occurrence. In particular, do not invoke a getter at paint.
function rowKeyReader(component: Component): Component["paintedRowKey"] | null {
	let owner: object | null = component;
	for (let depth = 0; owner && depth < 16; depth++) {
		if (isProxy(owner)) return null;
		const field = Object.getOwnPropertyDescriptor(owner, "paintedRowKey");
		if (field)
			return "value" in field && (field.value === undefined || typeof field.value === "function")
				? field.value
				: null;
		owner = Object.getPrototypeOf(owner);
	}
	return owner ? null : undefined;
}

function occurrence(mount: Mount, width: number, row: number) {
	if (row === mount.title || row < mount.top || mount.host.children.length > 2) return undefined;
	const hit = mount.host.childAtRow(width, row - mount.top);
	const control = hit && mount.controls.find(({ component }) => component === hit.component);
	if (!hit || !control) return undefined;
	let key: string | undefined;
	try {
		const read = rowKeyReader(control.component);
		if (read === null) return undefined;
		key = read && Reflect.apply(read, control.component, [hit.row]);
	} catch {
		return undefined;
	}
	if (key !== undefined && (typeof key !== "string" || key.length > 256)) return undefined;
	return { control, local: hit.row, height: hit.height, key };
}

/** Enough input for a normal styled terminal row, without a substring pinning an arbitrarily large backing string. */
function rowPrefix(line: string, width: number): string {
	const limit = labelSourceBudget(width);
	return line.length <= limit ? line : Buffer.from(line.slice(0, limit), "utf16le").toString("utf16le");
}

/** Only small values travel from the paint to the press; none of them own the renderer or its document. */
export interface PaintedRendererRow {
	readonly id: symbol;
	readonly row: number;
	readonly local: number;
	readonly key?: string;
	readonly text: string;
	readonly complete: boolean;
	readonly width: number;
}

export function sameRendererCell(a: PaintedRendererRow, b: PaintedRendererRow, x: number): boolean {
	return (
		a.id === b.id &&
		a.row === b.row &&
		a.local === b.local &&
		a.key === b.key &&
		a.width === b.width &&
		sameCellPrefix(a.text, b.text, x) &&
		isOnLabelCell(b.text, x, b.complete)
	);
}

interface DrawnControl {
	start: number;
	end: number;
	id: symbol;
	keys?: Map<number, string | undefined>;
}

/** Snapshot the direct slots before another widget's render can measure this block again. */
export function captureRendererRow(block: Component, width: number, height: number, first: number, end: number) {
	const mount = mounts.get(block);
	if (!mount || mount.host.children.length > 2 || height <= (mount.title ?? -1) + 1) return undefined;
	const drawn: DrawnControl[] = [];
	for (let start = mount.top, slot = 0; start < height && slot < 2; slot++) {
		const hit = mount.host.childAtRow(width, start - mount.top);
		if (!hit || hit.height <= 0) break;
		const control = mount.controls.find(({ component }) => component === hit.component);
		const stop = start + hit.height;
		if (control && !(start === mount.title && stop === start + 1)) {
			const span: DrawnControl = { start, end: stop, id: control.id };
			try {
				const getKey = rowKeyReader(control.component);
				if (getKey === null) {
					start = stop;
					continue;
				}
				if (getKey) {
					// Keys belong to this draw. Don't ask about the other rows in a long list, even for an overscan pass.
					span.keys = new Map();
					for (let row = Math.max(start, first); row < Math.min(stop, end); row++) {
						if (row === mount.title) continue;
						const key = Reflect.apply(getKey, control.component, [row - start]);
						if (key === undefined || (typeof key === "string" && key.length <= 256)) span.keys.set(row, key);
					}
				}
				drawn.push(span);
			} catch {
				/* An opaque row cannot grant a new click route. */
			}
		}
		start = stop;
	}
	if (!drawn.length || mounts.get(block) !== mount) return undefined;
	const title = mount.title;
	return (row: number, line: string): PaintedRendererRow | undefined => {
		if (row === title) return undefined;
		const span = drawn.find(({ start, end }) => row >= start && row < end);
		if (!span || (span.keys && !span.keys.has(row))) return undefined;
		const text = rowPrefix(line, width);
		return {
			id: span.id,
			row,
			local: row - span.start,
			key: span.keys?.get(row),
			text,
			complete: text.length === line.length,
			width,
		};
	};
}

function settleAction(
	ref: WeakRef<Mount>,
	token: object,
	attached: (settling?: boolean) => boolean,
	cancel: boolean,
): () => void {
	return () => {
		const pending = ref.deref()?.pending;
		const action = pending?.get(token);
		pending?.delete(token);
		if (action && attached(true)) (cancel ? action.cancel : action.action)?.();
	};
}
function deferAction(mount: Mount, action: () => void, cancel: (() => void) | undefined, attached: () => boolean) {
	const token = {};
	mount.pending ??= new Map();
	mount.pending.set(token, { action, cancel });
	const ref = new WeakRef(mount);
	return {
		whenSingleClick: settleAction(ref, token, attached, false),
		onSingleClickCancel: settleAction(ref, token, attached, true),
	};
}

function sameCellPrefix(a: string, b: string, x: number): boolean {
	const end = labelSourceBudget(x + 1);
	return a.slice(0, end) === b.slice(0, end);
}

// A synchronous clickArea draw may also report the one row being validated. The public range remains inert.
interface ReadRow {
	block: Component;
	row: number;
	line?: string;
}
let reading: ReadRow | undefined;
export function rendererRows(block: Component, start: number, rows: readonly string[]): RowRange | undefined {
	if (reading?.block === block) reading.line = rows[reading.row];
	return rowsFrom(start, rows.length);
}
function measureRow(block: ClickExpandableBlock, width: number, row: number) {
	const previous = reading;
	const read: ReadRow = { block, row };
	reading = read;
	try {
		return { area: block.clickArea(width), line: read.line };
	} finally {
		reading = previous;
	}
}

/** A measurement may veto the displayed occurrence, never nominate a new one. Use the block's one normal draw. */
export function measureRendererClick(
	block: ClickExpandableBlock,
	painted: PaintedRendererRow,
	event: TuiMouseEvent,
	attached: () => boolean,
): { area?: RowRange; handled?: ContainerMouseResult } | undefined {
	const mount = mounts.get(block);
	if (!mount || painted.row !== event.y || !mount.controls.some(({ id }) => id === painted.id)) return undefined;
	const { area, line } = measureRow(block, event.width, event.y);
	if (!area || line === undefined || event.y < area.start || event.y >= area.end || mounts.get(block) !== mount)
		return { area };
	const hit = occurrence(mount, event.width, event.y);
	if (
		!hit ||
		hit.control.id !== painted.id ||
		hit.local !== painted.local ||
		hit.key !== painted.key ||
		!sameCellPrefix(painted.text, line, event.x) ||
		directHandler(hit.control.component) !== hit.control.handle ||
		mount.host.children.length > 2 ||
		!mount.host.children.includes(hit.control.component) ||
		mounts.get(block) !== mount ||
		!attached()
	)
		return { area };
	const result = Reflect.apply(hit.control.handle, hit.control.component, [
		{ ...event, y: hit.local, height: hit.height },
	]);
	if (!result || (!result.handled && !result.capture && !result.focus)) return { area };
	// The physical button is already up. This offer is for a click action, not a new mouse capture or keyboard focus.
	return {
		area,
		handled: {
			handled: true,
			render: result.render,
			...(result.whenSingleClick &&
				mounts.get(block) === mount &&
				deferAction(mount, result.whenSingleClick, result.onSingleClickCancel, attached)),
			target: {
				component: block,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		},
	};
}
