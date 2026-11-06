import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { FINISHED_TASK_RETENTION } from "../../packages/coding-agent/src/core/tasks/eviction-error.js";
import { taskHostStateSizesForTesting } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { fileExists, readJson, sleep } from "../helpers/runtime.js";

/** Long enough for the drain window that quarantines a stopped command and for its later confirmation. */
const QUARANTINE_TIMEOUT_MS = 20_000;
/** A real stopped command, its quarantine and confirmation, then a retention's worth of agents. */
const QUARANTINE_TEST_TIMEOUT_MS = 60_000;

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + QUARANTINE_TIMEOUT_MS;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, label);
		await sleep(20);
	}
}

test.runIf(process.platform !== "win32")(
	"a shell whose quarantined cleanup was confirmed leaves no host state once it is evicted (#4385)",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "task-quarantine-retention-"));
		const identities = join(directory, "holder.json");
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: crypto.randomUUID() },
			authorizeLaunch() {},
		});
		const { supervisor, owner } = host.ownerBinding;
		let holder: number | undefined;
		const cleanup = () => {
			const watched = host.watchOwnerTasks();
			assert.ok(watched.ok);
			const kinds = watched.value.snapshot.tasks.map((task) => task.cleanup.kind);
			watched.value.dispose();
			return kinds;
		};
		try {
			const started = await supervisor.startCommandTask(
				owner,
				{
					kind: "command",
					command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("test/fixtures/task-escaped-output-holder.mjs"))} ${JSON.stringify(identities)}`,
					terminal: { kind: "pipe" },
				},
				"held-output" as OperationId,
			);
			assert.ok(started.ok);
			assert.ok((await supervisor.initialObservation(started.value, { kind: "background" })).ok);
			await until(() => fileExists(identities), "the holder started");
			holder = (await readJson<{ holder: number }>(identities)).holder;
			assert.ok((await supervisor.cancelTask(started.value, "user")).ok);
			await until(() => taskHostStateSizesForTesting(owner).quarantinedTasks === 1, "the stop quarantined");
			process.kill(holder, "SIGKILL");
			holder = undefined;
			await until(() => cleanup()[0] === "reaped", "the quarantined cleanup was confirmed");
			for (let index = 0; index < FINISHED_TASK_RETENTION; index++) {
				const agent = await host.startAgentTask(
					{ kind: "agent", agent: "worker", task: `task ${index}` },
					`agent-${index}` as OperationId,
					() => ({
						result: Promise.resolve<TaskResult>({ kind: "failed", code: "Done", message: "done" }),
						cleanup: Promise.resolve({ kind: "reaped" }),
					}),
				);
				assert.ok(agent.ok);
				assert.ok((await host.waitForTask(agent.value.taskId)).ok);
			}
			await until(
				() => taskHostStateSizesForTesting(owner).quarantinedTasks === 0,
				"the evicted shell's quarantine is forgotten",
			);
			assert.equal(cleanup().length, FINISHED_TASK_RETENTION);
		} finally {
			if (holder !== undefined) process.kill(holder, "SIGKILL");
			await host.close("session-close");
			await rm(directory, { recursive: true, force: true });
		}
	},
	QUARANTINE_TEST_TIMEOUT_MS,
);
