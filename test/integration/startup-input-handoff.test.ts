import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
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
