import { type Component, Container, stripHintMarkers, type TUI, type TuiMouseEvent } from "@bastani/atomic-tui";
import { ScreenHold } from "../screen-hold.ts";

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

/**
 * Whether what `slot` last drew is live and still current: not held rows, no view still waiting for its first frame,
 * drawn onto the screen, and nothing mounted and no run's working status changed since.
 */
export function promptSlotDrewLive(slot: Container): boolean {
	return !(slot instanceof PromptSlot) || slot.drewLive;
}

/** The opening and closing sequences of an OSC 8 hyperlink; the text between them is kept. */
const HYPERLINK = /\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** `row` as it looks, with nothing on it that a click could run: no key hints and no links. */
function inertRow(row: string): string {
	return stripHintMarkers(row).replace(HYPERLINK, "");
}

/** What a render of the slot drew. */
interface Drawn {
	readonly width: number;
	readonly rows: readonly string[];
	/** The children it drew, counted by `generation`. */
	readonly generation: number;
	/** Live content drawn onto the screen: not held rows, not a view yet to draw, not under a held dock. */
	readonly live: boolean;
	/** It drew a run's working status in the prompt. */
	readonly runStatus: boolean;
	/** The working status changes counted when it drew (`ScreenHold.statusEpoch`). */
	readonly statusEpoch: number;
}

type PromptSlotState =
	| { readonly kind: "live" }
	| {
			readonly kind: "held";
			/** Which hold this is. */
			readonly token: object;
			/** The rows the slot drew last, at `width`, with their key hints and links made plain text: they run nothing. */
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
 * user's next key, at another width, or after `PROMPT_SLOT_HOLD_MS`. The slot holds only through the screen's hold
 * (`ScreenHold`): never while another part of the screen is held, and only rows it drew from live content.
 *
 * A prompt that draws a run's working status in its own rows is never held: the hold would stop that status moving, and
 * could keep showing it after the run ended.
 */
export class PromptSlot extends Container {
	private state: PromptSlotState = { kind: "live" };
	/** Counts changes of `children`. */
	private generation = 0;
	/** What the last render drew. */
	private drawn: Drawn | undefined;
	private showingHeldRows = false;
	private readonly ui: Pick<TUI, "requestRender">;
	private readonly showsRunStatus: () => boolean;
	private readonly screen: ScreenHold;

	/**
	 * `showsRunStatus` answers whether the prompt draws a run's working status in its rows now; `screen` is the hold of
	 * the screen the slot is on.
	 */
	constructor(
		ui: Pick<TUI, "requestRender">,
		showsRunStatus: () => boolean = () => false,
		screen: ScreenHold = new ScreenHold(),
	) {
		super();
		this.ui = ui;
		this.showsRunStatus = showsRunStatus;
		this.screen = screen;
	}

	/**
	 * Whether the last render drew live content that is still current (`promptSlotDrewLive`): what a held dock, which
	 * has the status area in it too, may keep.
	 */
	get drewLive(): boolean {
		const drawn = this.drawn;
		return (
			drawn?.live === true && drawn.generation === this.generation && drawn.statusEpoch === this.screen.statusEpoch
		);
	}

	/**
	 * Whether a hold may keep what the last render drew: live content of the children the slot has now, with no run's
	 * working status in it. A status drawn elsewhere on the screen is not in these rows.
	 */
	private mayHold(): boolean {
		const drawn = this.drawn;
		return drawn?.live === true && drawn.generation === this.generation && !drawn.runStatus && !this.showsRunStatus();
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
		const generation = this.generation;
		let token: object | undefined;
		this.screen.begin("prompt", (ended) => {
			const drawn = this.drawn;
			if (drawn === undefined || !this.mayHold()) return undefined;
			const held = this.beginHold(drawn, drawn.width, generation, ended);
			token = held.token;
			return held.end;
		});
		if (token === undefined) return SETTLED;
		const own = token;
		return {
			// A command that ends with nothing mounted shows the slot as it is; a mounted view decides for itself. The
			// handle keeps only the hold's token, not its rows: a command can keep it until its view closes.
			settle: () => {
				const state = this.state;
				if (state.kind === "held" && state.token === own && this.generation === generation) {
					state.end();
					this.ui.requestRender();
				}
			},
		};
	}

	override render(width: number): string[] {
		const live = super.render(width);
		let rows: readonly string[] = live;
		const state = this.state;
		const previous = this.drawn;
		if (state.kind === "held") {
			if (this.showsHeldRows(state, width)) rows = state.rows;
			else state.end();
		} else if (
			previous?.live === true &&
			!previous.runStatus &&
			previous.width === width &&
			previous.generation !== this.generation &&
			this.children.some(awaitsFirstContent) &&
			!this.showsRunStatus()
		) {
			// A view mounted with nothing to draw yet, as an engine panel before its first frame: the rows stay.
			this.screen.begin("prompt", (ended) => {
				const held = this.beginHold(previous, width, previous.generation, ended);
				rows = held.rows;
				return held.end;
			});
		}
		this.showingHeldRows = rows !== live;
		this.drawn = {
			width,
			rows,
			generation: this.generation,
			// Under a held dock the slot is drawn unseen: what it draws then never reached the screen.
			live: rows === live && !this.children.some(awaitsFirstContent) && this.screen.region !== "dock",
			runStatus: this.showsRunStatus(),
			statusEpoch: this.screen.statusEpoch,
		};
		return rows === live ? live : [...rows];
	}

	/** Held rows are a picture of what was there: a click on them reaches nothing. */
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		return this.showingHeldRows ? undefined : super.handleMouse(event);
	}

	private showsHeldRows(state: Extract<PromptSlotState, { kind: "held" }>, width: number): boolean {
		if (width !== state.width || this.showsRunStatus()) return false;
		return this.generation === state.generation || this.children.some(awaitsFirstContent);
	}

	/** Hold the rows `seed` drew, the slot's last render. */
	private beginHold(
		seed: Drawn,
		width: number,
		generation: number,
		ended: () => void,
	): Extract<PromptSlotState, { kind: "held" }> {
		let over = false;
		const end = () => {
			if (over) return;
			over = true;
			clearTimeout(timer);
			if (this.state === held) this.state = { kind: "live" };
			// Nothing drawn since the hold began: its rows were kept once, and no later hold keeps them again.
			if (this.drawn === seed) this.drawn = { ...seed, live: false };
			ended();
		};
		const timer = setTimeout(() => {
			if (over) return;
			end();
			this.ui.requestRender();
		}, PROMPT_SLOT_HOLD_MS);
		timer.unref?.();
		const held = {
			kind: "held",
			token: {},
			rows: seed.rows.map(inertRow),
			width,
			generation,
			end,
		} as const;
		this.state = held;
		return held;
	}
}
