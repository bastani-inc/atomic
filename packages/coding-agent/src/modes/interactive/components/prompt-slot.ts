import {
	type Component,
	Container,
	isKeyRelease,
	stripHintMarkers,
	type TUI,
	type TuiMouseEvent,
} from "@bastani/atomic-tui";

/**
 * The longest the prompt's slot keeps showing what it showed while a view is on its way: as long as a key in a view
 * another process draws waits for that process to answer.
 */
export const PROMPT_SLOT_HOLD_MS = 250;

/** Atomic's own views that can mount with nothing to draw yet, and how each tells. */
const firstContent = new WeakMap<Component, () => boolean>();

/**
 * `view` has nothing to draw while `awaiting` answers true, as a panel the engine draws before its first frame: the
 * prompt's slot keeps its rows meanwhile. Only views registered here are asked; any other component draws at once.
 */
export function awaitFirstContent(view: Component, awaiting: () => boolean): void {
	firstContent.set(view, awaiting);
}

function awaitsFirstContent(component: Component): boolean {
	return firstContent.get(component)?.() === true;
}

/** A command that opens a view holds the prompt's slot; `settle` says the command is done. */
export interface PromptSlotHold {
	settle(): void;
}

const SETTLED: PromptSlotHold = { settle: () => {} };

/** Keep `slot` as it is on screen until the view the running command opens is up, when it is the prompt's slot. */
export function holdPromptSlot(slot: Container): PromptSlotHold {
	return slot instanceof PromptSlot ? slot.hold() : SETTLED;
}

/** A key the user pressed: not the release of one, nor a mouse or focus report. */
function isKeyPress(data: string): boolean {
	return !isKeyRelease(data) && !data.startsWith("\x1b[<") && data !== "\x1b[I" && data !== "\x1b[O";
}

type PromptSlotState =
	| { readonly kind: "live" }
	| {
			readonly kind: "held";
			/** The rows the slot drew last, at `width`, with their key hints made plain text: they run nothing. */
			readonly rows: readonly string[];
			readonly width: number;
			/** The slot's children as they were when the hold began, counted by `generation`. */
			readonly generation: number;
			readonly end: () => void;
	  };

/**
 * Where the prompt is drawn, or the selector or panel that takes its place. A slash command that opens a view clears
 * the prompt at once, but its view can mount only after an await, or draw only after another process answers. Until
 * then the slot keeps the rows it drew before, so the screen goes from the prompt straight to the view and the rows
 * around it stay put. Only these rows wait: everything else on the screen keeps drawing.
 *
 * The rows come back live when the view is up and has something to draw, when the command ends without one, on the
 * user's next key, at another width, or after `PROMPT_SLOT_HOLD_MS`.
 */
export class PromptSlot extends Container {
	private state: PromptSlotState = { kind: "live" };
	/** Counts changes of `children`. */
	private generation = 0;
	private drawn: { readonly width: number; readonly rows: readonly string[]; readonly generation: number } | undefined;
	private showingHeldRows = false;
	private readonly ui: Pick<TUI, "requestRender">;

	constructor(ui: Pick<TUI, "requestRender">) {
		super();
		this.ui = ui;
	}

	override addChild(component: Component): void {
		this.generation++;
		super.addChild(component);
	}

	override removeChild(component: Component): void {
		this.generation++;
		super.removeChild(component);
	}

	override clear(): void {
		this.generation++;
		super.clear();
	}

	/** Keep showing what the slot drew last until the view a command opens is up or the command settles. */
	hold(): PromptSlotHold {
		const drawn = this.drawn;
		if (!drawn) return SETTLED;
		const generation = this.generation;
		this.beginHold(drawn.rows, drawn.width, generation);
		const state = this.state;
		return {
			// A command that ends with nothing mounted shows the slot as it is; a mounted view decides for itself.
			settle: () => {
				if (this.state === state && this.state.kind === "held" && this.generation === generation) {
					this.state.end();
					this.ui.requestRender();
				}
			},
		};
	}

	override render(width: number): string[] {
		const live = super.render(width);
		let rows: readonly string[] = live;
		const state = this.state;
		if (state.kind === "held") {
			if (this.showsHeldRows(state, width)) rows = state.rows;
			else state.end();
		} else if (
			this.drawn !== undefined &&
			this.drawn.width === width &&
			this.drawn.generation !== this.generation &&
			this.children.some(awaitsFirstContent)
		) {
			// A view mounted with nothing to draw yet, as an engine panel before its first frame: the rows stay.
			rows = this.beginHold(this.drawn.rows, width, this.drawn.generation);
		}
		this.showingHeldRows = rows !== live;
		this.drawn = { width, rows, generation: this.generation };
		return rows === live ? live : [...rows];
	}

	/** Input on its way to the focused component: the user's next key sees the slot as it is. */
	noteInput(data: string): void {
		if (this.state.kind === "held" && isKeyPress(data)) this.state.end();
	}

	/** Held rows are a picture of what was there: a click on them reaches nothing. */
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		return this.showingHeldRows ? undefined : super.handleMouse(event);
	}

	private showsHeldRows(state: Extract<PromptSlotState, { kind: "held" }>, width: number): boolean {
		if (width !== state.width) return false;
		return this.generation === state.generation || this.children.some(awaitsFirstContent);
	}

	/** Answers the rows it holds. */
	private beginHold(rows: readonly string[], width: number, generation: number): readonly string[] {
		if (this.state.kind === "held") this.state.end();
		let ended = false;
		const end = () => {
			if (ended) return;
			ended = true;
			clearTimeout(timer);
			if (this.state === held) this.state = { kind: "live" };
		};
		const timer = setTimeout(() => {
			if (ended) return;
			end();
			this.ui.requestRender();
		}, PROMPT_SLOT_HOLD_MS);
		timer.unref?.();
		const held = {
			kind: "held",
			rows: rows.map(stripHintMarkers),
			width,
			generation,
			end,
		} as const;
		this.state = held;
		return held.rows;
	}
}
