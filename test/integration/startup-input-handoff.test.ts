import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import {
	bunExecutable,
	makeTempDirectory,
	removeTempDirectory,
	spawnProcess,
	writeTextSync,
} from "../helpers/runtime.js";

const BUN_STDIN_HANDOFF_TIMEOUT_MS = 60_000;

for (const input of ["hello", "hello\r"]) {
	test(
		`keeps unread OS input ${JSON.stringify(input)} before a startup dialog takes stdin (#5241)`,
		async () => {
			const dir = makeTempDirectory("atomic-startup-handoff-");
			const readyFile = join(dir, "input-written");
			const childFile = join(dir, "capture.ts");
			const source = new URL("../../packages/coding-agent/src/main-early-input.ts", import.meta.url).href;
			writeTextSync(
				childFile,
				`
import { existsSync } from "node:fs";
import { consumeStartupInput, startEarlyInputCapture, withEarlyInputHeldForStartupDialog } from ${JSON.stringify(source)};
const input = process.stdin;
const capture = startEarlyInputCapture({
	enabled: true,
	stdin: {
		isTTY: true,
		isRaw: false,
		setRawMode() {},
		setEncoding: (encoding) => input.setEncoding(encoding),
		resume: () => input.resume(),
		on: (event, listener) => input.on(event, listener),
		off: (event, listener) => input.off(event, listener),
		removeListener: (event, listener) => input.removeListener(event, listener),
	},
});
process.stdout.write("CAPTURE-READY\\n");
while (!existsSync(process.argv[2])) {}
const snapshot = await withEarlyInputHeldForStartupDialog(async () => consumeStartupInput(capture));
process.stdout.write("SNAPSHOT:" + JSON.stringify(snapshot) + "\\n");
process.exit(0);
`,
			);
			const child = spawnProcess([bunExecutable(), childFile, readyFile], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: BUN_STDIN_HANDOFF_TIMEOUT_MS / 2,
			});
			const stderr = new Response(child.stderr).text();
			const reader = child.stdout!.getReader();
			const decoder = new TextDecoder();
			let output = "";
			try {
				while (!output.includes("CAPTURE-READY\n")) {
					const chunk = await reader.read();
					assert.equal(chunk.done, false, output);
					output += decoder.decode(chunk.value, { stream: true });
				}
				await new Promise<void>((resolve, reject) => {
					child.stdin!.write(input, (error?: Error | null) => (error ? reject(error) : resolve()));
				});
				writeTextSync(readyFile, "ready");
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					output += decoder.decode(chunk.value, { stream: true });
				}
				assert.equal(await child.exited, 0, await stderr);
				const snapshot = /^SNAPSHOT:(.*)$/m.exec(output)?.[1];
				assert.ok(snapshot, output);
				assert.deepEqual(JSON.parse(snapshot), {
					text: "hello",
					submissions: [],
					heldForStartupDecision: true,
				});
			} finally {
				child.kill();
				await child.exited;
				removeTempDirectory(dir);
			}
		},
		BUN_STDIN_HANDOFF_TIMEOUT_MS,
	);
}
