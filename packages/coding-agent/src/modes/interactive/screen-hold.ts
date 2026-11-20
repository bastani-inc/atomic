import { isKeyRelease } from "@bastani/atomic-tui";

/**
 * The part of the screen a hold keeps as painted: the prompt's slot while a slash command's view opens, or everything
 * below the transcript while a subagent opened from `/tasks` is on its way.
 */
export type ScreenHoldRegion = "prompt" | "dock";

/** Ends a hold, or nothing for a request that held nothing. */
export type ScreenHoldRelease = () => void;

const NOTHING_HELD: ScreenHoldRelease = () => {};

/** A key the user pressed: not the release of one, nor a mouse or focus report. */
export function isKeyPress(data: string): boolean {
	return (
		!isKeyRelease(data) &&
		data !== "\x1b[I" &&
		data !== "\x1b[O" &&
		!data.startsWith("\x1b[<") &&
		!data.startsWith("\x1b[M")
	);
}

/** Shows a held part live again; `byKey` when the user's key ends it, which the screen handles right after. */
export type EndScreenHold = (byKey?: boolean) => void;

type ScreenHoldState =
	| { readonly kind: "live" }
	| { readonly kind: "held"; readonly region: ScreenHoldRegion; readonly end: EndScreenHold };

/**
 * Which part of the screen, if any, is kept as painted while what replaces it is on its way. At most one part is held:
 * a request made while another hold is held joins it, keeps nothing more and does not move its bound. A hold keeps
 * only rows painted from live content, never rows another hold kept. The user's next key press shows the screen live.
 */
export class ScreenHold {
	private state: ScreenHoldState = { kind: "live" };
	private statusChanges = 0;

	/** Counts the changes of a run's working status: rows painted before the latest change show one that is gone. */
	get statusEpoch(): number {
		return this.statusChanges;
	}

	/** The part held now, if any. */
	get region(): ScreenHoldRegion | undefined {
		return this.state.kind === "held" ? this.state.region : undefined;
	}

	/**
	 * Hold `region`. `start` keeps it as painted and answers how to show it live again, or undefined when it cannot (what
	 * it painted is not live content); it calls `ended` once its hold ends on its own. Answers what ends this hold.
	 */
	begin(region: ScreenHoldRegion, start: (ended: () => void) => EndScreenHold | undefined): ScreenHoldRelease {
		if (this.state.kind === "held") return NOTHING_HELD;
		let held: ScreenHoldState | undefined;
		const ended = () => {
			if (held !== undefined && this.state === held) this.state = { kind: "live" };
		};
		const end = start(ended);
		if (end === undefined) return NOTHING_HELD;
		held = { kind: "held", region, end };
		this.state = held;
		const self = held;
		return () => {
			if (this.state === self) end();
		};
	}

	/** Show the screen live again, whatever part is held. */
	end(): void {
		if (this.state.kind === "held") this.state.end();
	}

	/** A run's working status started or ended: no part of the screen keeps showing the one it had. */
	statusChanged(): void {
		this.statusChanges++;
		this.end();
	}

	/** Input on its way to the screen, before any handler sees it: a key press shows the screen live. */
	noteInput(data: string): void {
		if (this.state.kind === "held" && isKeyPress(data)) this.state.end(true);
	}
}

const holds = new WeakMap<object, ScreenHold>();

/** The screen hold of the interactive mode `mode`. */
export function screenHoldOf(mode: object): ScreenHold {
	let hold = holds.get(mode);
	if (hold === undefined) {
		hold = new ScreenHold();
		holds.set(mode, hold);
	}
	return hold;
}
