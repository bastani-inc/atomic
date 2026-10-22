import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { run, workflow } from "@bastani/atomic/workflows";

const directory = process.env.ATOMIC_CODING_AGENT_DIR;
assert.ok(directory);
const pidPath = join(directory, "intercom", "broker.pid");
try {
	const definition = workflow({
		name: "standalone-bundled-intercom",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.task("worker", { prompt: "work" });
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{
			cwd: directory,
			journal: { memory: true },
			executionMode: "non_interactive",
			adapters: {
				agentSession: {
					async create() {
						return {
							async prompt() {
								return "done";
							},
							async abort() {},
							dispose() {},
							subscribe() {
								return () => {};
							},
							messages: [],
							getLastAssistantText() {
								return "done";
							},
						};
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.ok(existsSync(pidPath), "the installed SDK started its own Intercom broker");
} finally {
	if (existsSync(pidPath)) {
		const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
		assert.ok(Number.isSafeInteger(pid) && pid > 0);
		const isRunning = () => {
			try {
				return process.kill(pid, 0);
			} catch (error) {
				if (error.code === "ESRCH") return false;
				throw error;
			}
		};
		process.kill(pid, "SIGTERM");
		const deadline = Date.now() + 5_000;
		while (isRunning() && Date.now() < deadline) await delay(25);
		assert.equal(isRunning(), false, "the fixture broker shut down");
	}
}
