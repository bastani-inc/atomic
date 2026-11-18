import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	consumeStartupInput,
	osStdinPendingInput,
	startEarlyInputCapture,
	withEarlyInputHeldForStartupDialog,
} from "../../../packages/coding-agent/src/main-early-input.ts";

const [directory, scenario, typedLength] = process.argv.slice(2);
if (!directory || (scenario !== "top-level" && scenario !== "after-read" && scenario !== "terminal")) {
	throw new Error("usage: startup-input-handoff-child <directory> <top-level|after-read|terminal>");
}
const input = process.stdin;
const capture = startEarlyInputCapture(
	scenario === "terminal"
		? { enabled: true }
		: {
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
				pendingInput: osStdinPendingInput,
			},
);
if (scenario === "after-read") await readFile(process.argv[1] ?? "");
writeFileSync(join(directory, "capture-ready"), "ready");
const inputWritten = join(directory, "input-written");
while (!existsSync(inputWritten)) {}
if (scenario === "terminal") {
	const diag = (line: string) => appendFileSync(join(directory, "diag.txt"), `${performance.now().toFixed(1)} ${line}\n`);
	diag(`input-written seen pending=${osStdinPendingInput()}`);
	const deadline = Date.now() + 30_000;
	let next = 0;
	while ((osStdinPendingInput() ?? 0) < Number(typedLength) && Date.now() < deadline) {
		if (performance.now() >= next) {
			diag(`waiting pending=${osStdinPendingInput()}`);
			next = performance.now() + 500;
		}
	}
	diag(`done waiting pending=${osStdinPendingInput()}`);
}
if (scenario === "after-read") {
	setImmediate(() => {
		const end = performance.now() + 1;
		while (performance.now() < end) {}
	});
}
const snapshot = await withEarlyInputHeldForStartupDialog(async () => consumeStartupInput(capture));
writeFileSync(join(directory, "snapshot.json"), JSON.stringify(snapshot));
process.exit(0);
