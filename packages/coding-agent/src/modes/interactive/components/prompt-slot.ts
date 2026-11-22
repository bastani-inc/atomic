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

/** Views that navigate (`/tasks`, the focused agent panel): the footer's hints and the widgets give way to them. */
const navigationViews = new WeakSet<Component>();

/**
 * `view` is mounted as a navigation view, until it is unmounted (`navigation` false): while the slot draws it, the
 * footer's hints and the widgets around the prompt hide.
 */
export function markNavigationView(view: Component, navigation: boolean): void {
	if (navigation) navigationViews.add(view);
	else navigationViews.delete(view);
}

export function isNavigationView(component: Component): boolean {
	return navigationViews.has(component);
}

/** A command that opens a view holds the prompt's slot; `settle` says the command is done. */
export interface PromptSlotHold {
	settle(): void;
	/**
	 * Another change on the screen ends the hold before the command did: the slot shows live from the next frame, unless
	 * the command mounts a view with nothing to draw yet before it. Answers whether this ended the hold.
	 */
	endEarly(): boolean;
}

const SETTLED: PromptSlotHold = { settle: () => {}, endEarly: () => false };

export interface PromptSlotHoldOptions {
	/**
	 * The command's view can mount at any time, also after the hold ends (an extension command, which nothing waits
	 * for). A view it mounts with nothing to draw yet, while held or before the first frame after the hold ended,
	 * keeps the rows on screen until it draws, for one more bound from when it is first drawn.
	 */
	readonly lateView?: boolean;
}

/** Keep `slot` as it is on screen until the view the running command opens is up, when it is the prompt's slot. */
export function holdPromptSlot(slot: Container, options?: PromptSlotHoldOptions): PromptSlotHold {
	return slot instanceof PromptSlot ? slot.hold(options) : SETTLED;
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
	/** It drew a navigation view, or a picture of one. */
	readonly navigation: boolean;
}

type HeldSlot = {
	readonly kind: "held";
	/**
	 * What the rows wait for: the view a command opens (`lateView`: an extension command's, which waits for its first
	 * frame once mounted, and can also mount after the hold ends), or the first frame of a view mounted with nothing to
	 * draw yet.
	 */
	readonly awaits: "view" | "lateView" | "firstContent" | "companion";
	/** Which hold this is. */
	readonly token: object;
	/** The rows the slot drew last, at `width`, with their key hints and links made plain text: they run nothing. */
	readonly rows: readonly string[];
	readonly width: number;
	/** The slot's children as they were when the hold began, counted by `generation`. */
	readonly generation: number;
	/** The rows are a picture of a navigation view. */
	readonly navigation: boolean;
	/** For a `companion` hold: what the slot shows once the view is gone; anything else mounted ends the hold. */
	readonly occupant?: Component;
	/** Shows the slot live again. */
	readonly end: () => void;
	/** Ends the hold at its bound, or at another extension's change: a `lateView` hold leaves its rows to the next frame. */
	readonly endEarly: () => boolean;
};

type PromptSlotState =
	| { readonly kind: "live" }
	| HeldSlot
	| {
			/**
			 * A `lateView` hold ended at its bound, or at another extension's change, and no frame was drawn since: the
			 * screen still shows its rows. The slot's next render gives them, once, to a view the command mounted with
			 * nothing to draw yet, and otherwise draws live. The screen is not held meanwhile: another part of it can be.
			 */
			readonly kind: "handoff";
			readonly token: object;
			readonly rows: readonly string[];
			readonly width: number;
			readonly generation: number;
			/** The user's key presses counted when the hold ended (`ScreenHold.keyPresses`): a key since shows it live. */
			readonly keys: number;
			readonly navigation: boolean;
	  };

const LIVE: PromptSlotState = { kind: "live" };

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
	hold(options?: PromptSlotHoldOptions): PromptSlotHold {
		// Rows an earlier command left for its view are not this command's.
		if (this.state.kind === "handoff") this.state = LIVE;
		const generation = this.generation;
		let token: object | undefined;
		this.screen.begin("prompt", (ended) => {
			const drawn = this.drawn;
			if (drawn === undefined || !this.mayHold()) return undefined;
			const awaits = options?.lateView === true ? "lateView" : "view";
			const held = this.beginHold(awaits, drawn.rows.map(inertRow), drawn.width, generation, ended, drawn);
			token = held.token;
			return held.end;
		});
		if (token === undefined) return SETTLED;
		const own = token;
		/** This command's hold, or the rows it left for its view, with nothing mounted since it began. */
		const unchanged = () => {
			const state = this.state;
			return state.kind !== "live" && state.token === own && this.generation === generation ? state : undefined;
		};
		return {
			// A command that ends with nothing mounted shows the slot as it is; a mounted view decides for itself. The
			// handle keeps only the hold's token, not its rows: a command can keep it until its view closes.
			settle: () => {
				const state = unchanged();
				if (state === undefined) return;
				if (state.kind === "held") state.end();
				else this.state = LIVE;
				this.ui.requestRender();
			},
			endEarly: () => {
				const state = unchanged();
				return state?.kind === "held" && state.endEarly();
			},
		};
	}

	/**
	 * Keep showing the navigation view the slot drew last until `ready` settles: the view closes, `occupant` takes its
	 * place, and what the view hid (the agent panel another process draws) is on its way back. The rows show until then,
	 * at most `PROMPT_SLOT_HOLD_MS`; a key, another width, a run's working status in the prompt, or anything but
	 * `occupant` mounted in the view's place show the slot live.
	 */
	holdUntil(ready: Promise<unknown>, occupant: Component): void {
		const drawn = this.drawn;
		if (drawn === undefined || !drawn.navigation || !this.mayHold()) return;
		let held: HeldSlot | undefined;
		this.screen.begin("prompt", (ended) => {
			const rows = drawn.rows.map(inertRow);
			held = this.beginHold("companion", rows, drawn.width, this.generation, ended, drawn, true, occupant);
			return held.end;
		});
		const own = held;
		if (own === undefined) return;
		const show = () => {
			if (this.state !== own) return;
			own.end();
			this.ui.requestRender();
		};
		ready.then(show, show);
	}

	/**
	 * The picture the slot draws now at `width`, if any: of a navigation view, or of the prompt; undefined when it draws
	 * its children live. Asked by what draws around it, in the same frame, before or after the slot draws.
	 */
	heldPicture(width: number): { readonly navigation: boolean } | undefined {
		return this.resolve(width) === undefined ? undefined : { navigation: this.heldNavigation() };
	}

	override render(width: number): string[] {
		const live = super.render(width);
		const held = this.resolve(width);
		this.showingHeldRows = held !== undefined;
		this.drawn = {
			width,
			rows: held ?? live,
			generation: this.generation,
			// Under a held dock the slot is drawn unseen: what it draws then never reached the screen.
			live: held === undefined && !this.children.some(awaitsFirstContent) && this.screen.region !== "dock",
			runStatus: this.showsRunStatus(),
			statusEpoch: this.screen.statusEpoch,
			navigation: held === undefined ? this.children.some(isNavigationView) : this.heldNavigation(),
		};
		return held === undefined ? live : [...held];
	}

	private heldNavigation(): boolean {
		return this.state.kind !== "live" && this.state.navigation;
	}

	/**
	 * Decide what the slot draws at `width` now: the rows it holds, or undefined to draw its children live. A hold whose
	 * view is up ends here, and a view mounted with nothing to draw yet keeps the rows on screen. Asking twice before the
	 * slot draws decides the same.
	 */
	private resolve(width: number): readonly string[] | undefined {
		const state = this.state;
		if (state.kind === "held") {
			if (!this.showsHeldRows(state, width)) {
				state.end();
				return undefined;
			}
			if (
				state.awaits === "lateView" &&
				state.generation !== this.generation &&
				this.children.some(awaitsFirstContent)
			) {
				// The command's view mounted with nothing to draw yet: its first frame, not the command's bound, ends the wait
				// now, for one bound from here.
				state.end();
				return this.holdForFirstContent(state.rows, width, state.generation, state.navigation);
			}
			return state.rows;
		}
		if (state.kind === "handoff") {
			this.state = LIVE;
			if (
				state.keys === this.screen.keyPresses &&
				state.width === width &&
				state.generation !== this.generation &&
				this.children.some(awaitsFirstContent) &&
				!this.showsRunStatus()
			)
				// The command's view mounted after its hold ended, before this frame, with nothing to draw yet: the rows
				// still on screen stay until it draws, for one more bound, and are not kept again after that.
				return this.holdForFirstContent(state.rows, width, state.generation, state.navigation);
			return undefined;
		}
		const previous = this.drawn;
		if (
			previous?.live === true &&
			!previous.runStatus &&
			previous.width === width &&
			previous.generation !== this.generation &&
			this.children.some(awaitsFirstContent) &&
			!this.showsRunStatus()
		)
			// A view mounted with nothing to draw yet, as an engine panel before its first frame: the rows stay.
			return this.holdForFirstContent(
				previous.rows.map(inertRow),
				width,
				previous.generation,
				previous.navigation,
				previous,
			);
		return undefined;
	}

	/** Hold `rows` until the view mounted with nothing to draw yet draws; undefined when the screen holds elsewhere. */
	private holdForFirstContent(
		rows: readonly string[],
		width: number,
		generation: number,
		navigation: boolean,
		seed?: Drawn,
	): readonly string[] | undefined {
		let held: readonly string[] | undefined;
		this.screen.begin("prompt", (ended) => {
			const hold = this.beginHold("firstContent", rows, width, generation, ended, seed, navigation);
			held = hold.rows;
			return hold.end;
		});
		return held;
	}

	/** Held rows are a picture of what was there: a click on them reaches nothing. */
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		return this.showingHeldRows ? undefined : super.handleMouse(event);
	}

	private showsHeldRows(state: HeldSlot, width: number): boolean {
		if (width !== state.width || this.showsRunStatus()) return false;
		// The view's picture waits for what is not in the slot: it stays while the view, or then its occupant, is there.
		if (state.awaits === "companion")
			return (
				this.generation === state.generation || (this.children.length === 1 && this.children[0] === state.occupant)
			);
		return this.generation === state.generation || this.children.some(awaitsFirstContent);
	}

	/**
	 * Hold `rows`: those `seed` drew, the slot's last render, or those a command's hold left for its view. A `lateView`
	 * hold that reaches its bound, or ends at another change, leaves them to the next frame (`handoff`); any other end
	 * shows the slot live.
	 */
	private beginHold(
		awaits: HeldSlot["awaits"],
		rows: readonly string[],
		width: number,
		generation: number,
		ended: () => void,
		seed?: Drawn,
		navigation = seed?.navigation ?? false,
		occupant?: Component,
	): HeldSlot {
		let over = false;
		const finish = (next: PromptSlotState) => {
			over = true;
			clearTimeout(timer);
			if (this.state === held) this.state = next;
			// Nothing drawn since the hold began: its rows were kept once, and no later hold keeps them again.
			if (seed !== undefined && this.drawn === seed) this.drawn = { ...seed, live: false };
			ended();
		};
		const end = () => {
			if (!over) finish(LIVE);
		};
		const endEarly = () => {
			if (over) return false;
			finish(
				awaits === "lateView"
					? {
							kind: "handoff",
							token: held.token,
							rows,
							width,
							generation,
							keys: this.screen.keyPresses,
							navigation,
						}
					: LIVE,
			);
			return true;
		};
		const timer = setTimeout(() => {
			if (endEarly()) this.ui.requestRender();
		}, PROMPT_SLOT_HOLD_MS);
		timer.unref?.();
		const held: HeldSlot = {
			kind: "held",
			awaits,
			token: {},
			rows,
			width,
			generation,
			navigation,
			...(occupant === undefined ? {} : { occupant }),
			end,
			endEarly,
		};
		this.state = held;
		return held;
	}
}
