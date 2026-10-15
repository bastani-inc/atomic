export type TerminalMouseProtocol = "sgr";
export type TerminalMouseAction = "press" | "release";
export type TerminalMouseWheelDirection = "up" | "down" | "left" | "right";

export interface TerminalMouseEvent {
	readonly protocol: TerminalMouseProtocol;
	readonly action: TerminalMouseAction;
	readonly buttonCode: number;
	/** Zero-based terminal column. */
	readonly col: number;
	/** Zero-based terminal row. */
	readonly row: number;
}

/** Parse one complete SGR terminal mouse sequence. */
export function parseTerminalMouseInput(data: string): TerminalMouseEvent | null {
	const sgr = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (sgr) {
		const oneBasedCol = Number.parseInt(sgr[2]!, 10);
		const oneBasedRow = Number.parseInt(sgr[3]!, 10);
		if (oneBasedCol < 1 || oneBasedRow < 1) return null;
		return {
			protocol: "sgr",
			action: sgr[4] === "M" ? "press" : "release",
			buttonCode: Number.parseInt(sgr[1]!, 10),
			col: oneBasedCol - 1,
			row: oneBasedRow - 1,
		};
	}

	return null;
}

export function terminalMouseWheelDirection(event: TerminalMouseEvent): TerminalMouseWheelDirection | null {
	if (event.action !== "press" || (event.buttonCode & 64) === 0) return null;
	const direction = event.buttonCode & 3;
	if (direction === 0) return "up";
	if (direction === 1) return "down";
	if (direction === 2) return "left";
	return "right";
}

export function isTerminalLeftMousePress(event: TerminalMouseEvent): boolean {
	return (
		event.action === "press" &&
		(event.buttonCode & 64) === 0 &&
		(event.buttonCode & 32) === 0 &&
		(event.buttonCode & 3) === 0
	);
}
