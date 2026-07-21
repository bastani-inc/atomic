import {
	Loader,
	visibleWidth,
	type Component,
	type LoaderIndicatorOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const G1_BODY = [
	"###            ###  ",
	" ###          ###   ",
	"  ###        ###    ",
	"   ############     ",
	"    ###    ###      ",
	"     ###  ###       ",
	"      ####          ",
] as const;
const G1_PHASES = [
	"000            000  ",
	" 111          111   ",
	"  222        222    ",
	"   333333333333     ",
	"    444    444      ",
	"     555  555       ",
	"      6666          ",
] as const;
const BRAILLE_BITS = [[1, 8], [2, 16], [4, 32], [64, 128]] as const;

function packedG1(step: number): string[] {
	const rows = ["", ""];
	for (let blockRow = 0; blockRow < 2; blockRow++) {
		for (let blockColumn = 0; blockColumn < 10; blockColumn++) {
			let bits = 0;
			for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
				const row = blockRow * 4 + y;
				const column = blockColumn * 2 + x;
				if (row < G1_BODY.length && G1_BODY[row]![column] !== " " && Number(G1_PHASES[row]![column]) <= Math.min(step, 6)) {
					bits |= BRAILLE_BITS[y]![x];
				}
			}
			rows[blockRow] += bits === 0 ? " " : String.fromCodePoint(0x2800 + bits);
		}
	}
	const suffix = step < 7 ? "" : step === 7 ? "-" : step === 8 ? "--" : "--*";
	return [`${rows[0]}${suffix.padEnd(3)}`, `${rows[1]}   `];
}

export const ATOMIC_WORKING_MARK_FRAMES: readonly (readonly string[])[] =
	Array.from({ length: 12 }, (_, step) => packedG1(Math.min(step, 9)));
export const ATOMIC_WORKING_FRAME_MS = 240;


export interface AtomicWorkingStatusOptions {
	frame?: number;
	message?: string;
	spinnerColor?: (text: string) => string;
	messageColor?: (text: string) => string;
}

function styleMark(line: string, color: (text: string) => string): string {
	return [...line].map((character) => character === "*" ? color(character) : character === " " ? " " : theme.fg("dim", character)).join("");
}

export class AtomicWorkingStatusComponent implements Component {
	private readonly options: AtomicWorkingStatusOptions;

	constructor(options: AtomicWorkingStatusOptions = {}) {
		this.options = options;
	}

	render(width: number): string[] {
		const frame = ATOMIC_WORKING_MARK_FRAMES[(this.options.frame ?? 0) % ATOMIC_WORKING_MARK_FRAMES.length]!;
		const color = this.options.spinnerColor ?? ((text: string) => theme.bold(theme.fg("accent", text)));
		const messageColor = this.options.messageColor ?? ((text: string) => theme.fg("muted", text));
		const message = this.options.message ?? "Working...";
		const second = ` ${styleMark(frame[1]!, color)}  ${messageColor(message)}`;
		if (visibleWidth(second) > width) return [];
		return [` ${styleMark(frame[0]!, color)}`, second];
	}

	invalidate(): void {}
}

/** Loader-compatible ordinary working surface. Explicit extension indicators delegate to pi-tui unchanged. */
export class AtomicWorkingLoader implements Component {
	private readonly ui: TUI;
	private readonly spinnerColor: (text: string) => string;
	private readonly messageColor: (text: string) => string;
	private message: string;
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private delegate: Loader | undefined;

	constructor(
		ui: TUI,
		spinnerColor: (text: string) => string,
		messageColor: (text: string) => string,
		message = "Working...",
		indicator?: LoaderIndicatorOptions,
	) {
		this.ui = ui;
		this.spinnerColor = spinnerColor;
		this.messageColor = messageColor;
		this.message = message;
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		return this.delegate?.render(width) ?? new AtomicWorkingStatusComponent({ frame: this.frame, message: this.message, spinnerColor: this.spinnerColor, messageColor: this.messageColor }).render(width);
	}

	start(): void {
		if (this.delegate) return this.delegate.start();
		this.stop();
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % ATOMIC_WORKING_MARK_FRAMES.length;
			this.ui.requestRender();
		}, ATOMIC_WORKING_FRAME_MS);
		this.timer.unref?.();
	}

	stop(): void {
		this.delegate?.stop();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	setMessage(message: string): void {
		this.message = message;
		this.delegate?.setMessage(message);
		this.ui.requestRender();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.stop();
		this.delegate = indicator ? new Loader(this.ui, this.spinnerColor, this.messageColor, this.message, indicator) : undefined;
		this.frame = process.env.ATOMIC_REDUCED_MOTION === "1" ? 9 : 0;
		if (!this.delegate && process.env.ATOMIC_REDUCED_MOTION !== "1") this.start();
	}

	invalidate(): void {}
}

export function atomicWorkingFrame(now = Date.now()): number {
	if (process.env.ATOMIC_REDUCED_MOTION === "1") return 9;
	return Math.floor(now / ATOMIC_WORKING_FRAME_MS) % ATOMIC_WORKING_MARK_FRAMES.length;
}
