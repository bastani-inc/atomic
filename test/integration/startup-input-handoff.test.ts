import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { startPty } from "../../scripts/perf/startup/pty.ts";
import { useBundledNodeFixture } from "../helpers/bundled-node-fixture.js";
import {
	bunExecutable,
	fileExists,
	makeTempDirectory,
	moduleDir,
	readTextSync,
	removeTempDirectory,
	sleep,
	spawnProcess,
	writeTextSync,
} from "../helpers/runtime.js";

const STDIN_HANDOFF_TIMEOUT_MS = 60_000;
const FIXTURE = join(moduleDir(import.meta.url), "fixtures/startup-input-handoff-child.ts");
const bundledNodeFixture = useBundledNodeFixture(FIXTURE);

const cases = (["bun", "node"] as const).flatMap((runtime) =>
	(["top-level", "after-read"] as const).flatMap((scenario) =>
		(["hello", "hello\r"] as const).map((input) => ({ runtime, scenario, input })),
	),
);

test.each(cases)(
	"keeps unread OS input $input before a startup dialog takes stdin under $runtime ($scenario) (#5241)",
	async ({ runtime, scenario, input }) => {
		const dir = makeTempDirectory("atomic-startup-handoff-");
		const command = runtime === "node" ? [process.execPath, await bundledNodeFixture()] : [bunExecutable(), FIXTURE];
		const child = spawnProcess([...command, dir, scenario], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: STDIN_HANDOFF_TIMEOUT_MS / 2,
		});
		const stderr = new Response(child.stderr).text();
		void new Response(child.stdout).text();
		try {
			const deadline = Date.now() + STDIN_HANDOFF_TIMEOUT_MS / 2;
			while (!(await fileExists(join(dir, "capture-ready")))) {
				if (child.exitCode !== null) assert.fail(`the child exited before capturing input: ${await stderr}`);
				assert.ok(Date.now() < deadline, "the child never started capturing input");
				await sleep(10);
			}
			await new Promise<void>((resolve, reject) => {
				child.stdin!.write(input, (error?: Error | null) => (error ? reject(error) : resolve()));
			});
			writeTextSync(join(dir, "input-written"), "ready");
			assert.equal(await child.exited, 0, await stderr);
			assert.deepEqual(JSON.parse(readTextSync(join(dir, "snapshot.json"), "utf8")), {
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
	STDIN_HANDOFF_TIMEOUT_MS,
);

/** The PTY passes its command to the shell as one argument, whose quoting `cmd` does not undo: no part may need any. */
function unquotedCommandLine(parts: readonly string[]): string {
	for (const part of parts) assert.doesNotMatch(part, /["\s%^&|<>]/, `an argument that needs quoting: ${part}`);
	return parts.join(" ");
}

const terminalCases = (["bun", "node"] as const).flatMap((runtime) =>
	(["hello", "hello\r"] as const).map((input) => ({ runtime, input })),
);

test.each(terminalCases)(
	"keeps input $input the terminal already holds before a startup dialog takes stdin under $runtime (#5241)",
	async ({ runtime, input }) => {
		const dir = makeTempDirectory("atomic-startup-handoff-");
		const command = runtime === "node" ? [process.execPath, await bundledNodeFixture()] : [bunExecutable(), FIXTURE];
		let screen = "";
		const child = startPty({
			command: unquotedCommandLine([...command, dir, "terminal", String(input.length)]),
			cwd: dir,
			env: { ...process.env } as Record<string, string>,
			timeoutMs: STDIN_HANDOFF_TIMEOUT_MS,
			cols: 80,
			rows: 24,
			onChunk: (chunk) => {
				screen += chunk;
			},
		});
		try {
			const deadline = Date.now() + STDIN_HANDOFF_TIMEOUT_MS / 2;
			while (!(await fileExists(join(dir, "capture-ready")))) {
				assert.ok(Date.now() < deadline, `the child never started capturing input: ${JSON.stringify(screen)}`);
				await sleep(10);
			}
			child.write(input);
			writeTextSync(join(dir, "input-written"), "ready");
			assert.equal((await child.exited).exitCode, 0, screen);
			assert.deepEqual(JSON.parse(readTextSync(join(dir, "snapshot.json"), "utf8")), {
				text: "hello",
				submissions: [],
				heldForStartupDecision: true,
			});
		} finally {
			if ((await Promise.race([child.exited.then(() => true), sleep(0).then(() => false)])) === false) child.kill();
			await child.exited.catch(() => undefined);
			removeTempDirectory(dir);
		}
	},
	STDIN_HANDOFF_TIMEOUT_MS,
);
