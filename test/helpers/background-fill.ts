import assert from "node:assert/strict";
import { visibleWidth } from "@bastani/atomic-tui";
import { Terminal } from "@xterm/headless";

/** Assert actual terminal cells, not just the presence of a background escape. */
export async function assertBackgroundFill(
	lines: readonly string[],
	width: number,
	background: string,
	inset = 0,
): Promise<void> {
	const terminal = new Terminal({ cols: width, rows: lines.length + 1, allowProposedApi: true });
	try {
		await new Promise<void>((resolve) => terminal.write(`${background} \x1b[0m\r\n${lines.join("\r\n")}`, resolve));
		const expected = terminal.buffer.active.getLine(0)!.getCell(0)!;
		for (let row = 0; row < lines.length; row++) {
			assert.equal(visibleWidth(lines[row]!), width, `row ${row} fills the width`);
			for (let column = inset; column < width - inset; column++) {
				const actual = terminal.buffer.active.getLine(row + 1)!.getCell(column)!;
				assert.deepEqual(
					[actual.getBgColorMode(), actual.getBgColor()],
					[expected.getBgColorMode(), expected.getBgColor()],
					`row ${row}, column ${column}, width ${width}`,
				);
			}
		}
	} finally {
		terminal.dispose();
	}
}
