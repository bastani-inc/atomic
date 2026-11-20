import xterm from "@xterm/headless";

const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";

export interface PresentedScreens {
	/** Every distinct screen the terminal could show, in order, starting with what was on screen before. */
	screens: string[][];
	/** Whether a synchronized update was still open when the output ended. */
	held: boolean;
}

/**
 * Replay terminal output the way a terminal draws it. Outside a synchronized update the terminal may draw after any
 * write, so each write that ends outside one is a screen the user can see, and so is the screen at each update's end.
 * A terminal without synchronized output (`synchronizedOutput: false`) ignores the updates and may draw after any
 * write. `before` is written first, as the shell output that was on screen before the program started.
 */
export async function presentedScreens(
	writes: readonly string[],
	columns: number,
	rows: number,
	before: string,
	options: { synchronizedOutput?: boolean } = {},
): Promise<PresentedScreens> {
	const synchronizedOutput = options.synchronizedOutput ?? true;
	const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
	const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
	const screens: string[][] = [];
	const present = () => {
		const buffer = terminal.buffer.active;
		const screen: string[] = [];
		for (let row = 0; row < rows; row++) {
			screen.push((buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").trimEnd());
		}
		const last = screens.at(-1);
		if (last === undefined || last.join("\n") !== screen.join("\n")) screens.push(screen);
	};
	await write(before);
	present();
	let held = false;
	for (const data of writes) {
		for (const piece of data.split(/(\x1b\[\?2026[hl])/)) {
			if (piece === BEGIN_SYNCHRONIZED_OUTPUT) {
				if (!held) present();
				held = synchronizedOutput;
			} else if (piece === END_SYNCHRONIZED_OUTPUT) {
				held = false;
				present();
			} else if (piece.length > 0) {
				await write(piece);
			}
		}
		if (!held) present();
	}
	terminal.dispose();
	return { screens, held };
}
