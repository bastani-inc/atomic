import { existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	consumeStartupInput,
	startEarlyInputCapture,
	withEarlyInputHeldForStartupDialog,
} from "../../../packages/coding-agent/src/main-early-input.ts";

const [directory, scenario] = process.argv.slice(2);
if (!directory || (scenario !== "top-level" && scenario !== "after-read")) {
	throw new Error("usage: startup-input-handoff-child <directory> <top-level|after-read>");
}
const input = process.stdin;
const capture = startEarlyInputCapture({
	enabled: true,
	stdin: {
		isTTY: true,
		isRaw: false,
		setRawMode() {},
		setEncoding: (encoding) => input.setEncoding(encoding),
		resume: () => input.resume(),
		pause: () => input.pause(),
		read: (size) => input.read(size),
		on: (event, listener) => input.on(event, listener),
		off: (event, listener) => input.off(event, listener),
		removeListener: (event, listener) => input.removeListener(event, listener),
	},
});
if (scenario === "after-read") await readFile(process.argv[1] ?? "");
writeFileSync(join(directory, "capture-ready"), "ready");
const inputWritten = join(directory, "input-written");
while (!existsSync(inputWritten)) {}
if (scenario === "after-read") {
	setImmediate(() => {
		const end = performance.now() + 1;
		while (performance.now() < end) {}
	});
}
const snapshot = await withEarlyInputHeldForStartupDialog(async () => consumeStartupInput(capture));
writeFileSync(join(directory, "snapshot.json"), JSON.stringify(snapshot));
process.exit(0);
