interface ParsedMouseSequence {
	readonly data: string;
	readonly button: number;
	readonly x: number;
	readonly y: number;
	readonly isRelease: boolean;
}

const SGR_MOUSE_SEQUENCE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const LEFT_MOUSE_MODIFIER_MASK = 4 | 8 | 16;

export function parseMouseSequences(data: string): ParsedMouseSequence[] | undefined {
	if (data.length === 0) return undefined;
	const sequences: ParsedMouseSequence[] = [];
	let offset = 0;
	while (offset < data.length) {
		const remaining = data.slice(offset);
		const sgr = SGR_MOUSE_SEQUENCE.exec(remaining);
		if (sgr) {
			const sequence = sgr[0]!;
			sequences.push({
				data: sequence,
				button: Number.parseInt(sgr[1]!, 10),
				x: Number.parseInt(sgr[2]!, 10) - 1,
				y: Number.parseInt(sgr[3]!, 10) - 1,
				isRelease: sgr[4] === "m",
			});
			offset += sequence.length;
			continue;
		}
		if (remaining.startsWith("\x1b[M") && remaining.length >= 6) {
			const sequence = remaining.slice(0, 6);
			sequences.push({
				data: sequence,
				button: sequence.charCodeAt(3) - 32,
				x: sequence.charCodeAt(4) - 33,
				y: sequence.charCodeAt(5) - 33,
				isRelease: false,
			});
			offset += 6;
			continue;
		}
		return undefined;
	}
	return sequences;
}

export function isLeftMouseButton(sequence: ParsedMouseSequence): boolean {
	const { button } = sequence;
	if ((button & 64) !== 0) return false;
	const held = button & 3;
	// Generic SGR releases carry code 3 rather than the pressed button. Even a modified release
	// must close the selection; modified presses and motion remain application-bypass gestures.
	if (sequence.isRelease) return held === 0 || held === 3;
	return held === 0 && (button & LEFT_MOUSE_MODIFIER_MASK) === 0;
}

/** Whether a mouse chunk contains a left-button selection gesture. */
export function isLeftMouseSequence(data: string): boolean {
	return parseMouseSequences(data)?.some((sequence) => isLeftMouseButton(sequence)) ?? false;
}
