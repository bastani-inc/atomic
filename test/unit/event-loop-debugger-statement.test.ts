import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	removeTempDirectory,
	spawnProcess,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/event-loop-debugger-statement.ts");
/** A real diagnostic process must load its runtime, initialize its sampler, continue and dispose. */
const MONITOR_CHILD_TIMEOUT_MS = 20_000;

for (const runtime of [
	{ name: "Node", command: () => [process.execPath, "--import", "jiti/register"] },
	{ name: "Bun", command: () => [bunExecutable()] },
]) {
	test(`the diagnostic on ${runtime.name} continues past an application debugger statement (#5544)`, async () => {
		const root = makeTempDirectory("event-loop-debugger-statement-");
		const child = spawnProcess([...runtime.command(), FIXTURE], {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: join(root, "agent"),
				ATOMIC_EVENT_LOOP_BLOCK_MS: "200",
				ATOMIC_EVENT_LOOP_BLOCK_LOG: join(root, "blocks.jsonl"),
				ATOMIC_EVENT_LOOP_BLOCK_STACKS: undefined,
			},
		});
		const stdout = readStreamText(child.stdout);
		const stderr = readStreamText(child.stderr);
		const timer = setTimeout(() => child.kill("SIGKILL"), MONITOR_CHILD_TIMEOUT_MS);
		try {
			const code = await child.exited;
			const output = await stdout;
			assert.match(output, /before debugger statement/);
			assert.equal(code, 0, `the diagnostic child stopped at a debugger statement:\n${output}\n${await stderr}`);
			assert.match(output, /after debugger statement/);
		} finally {
			clearTimeout(timer);
			child.kill("SIGKILL");
			await Promise.all([child.exited, stdout, stderr]);
			removeTempDirectory(root);
		}
	});
}
