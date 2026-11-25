import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { AgentTaskHost } from "../src/core/tasks/agent-adapter.js";
import type { CommandIntent, TaskId } from "../src/core/tasks/contracts.js";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import { createKillToolDefinition } from "../src/core/tools/kill.js";

/** The execution timeout every command without one used to get. */
const OLD_DEFAULT_TIMEOUT_MS = 300_000;

test.runIf(process.platform !== "win32")(
	"a background command without a timeout keeps running past the old 300 second default until kill stops it",
	async () => {
		const owner = new AgentTaskHost({
			scope: { kind: "session", sessionId: crypto.randomUUID() },
			tasks: { wait: { kind: "automatic", commandBudgetMs: 0 } },
			authorizeLaunch() {},
		});
		const { supervisor, owner: lease } = owner.ownerBinding;
		const intents: CommandIntent[] = [];
		const start = supervisor.startCommandTask.bind(supervisor);
		vi.spyOn(supervisor, "startCommandTask").mockImplementation((ownerLease, intent, ...rest) => {
			intents.push(intent);
			return start(ownerLease, intent, ...rest);
		});
		const bash = createBashToolDefinition(process.cwd(), { taskOwner: owner.ownerBinding });
		const kill = createKillToolDefinition({ taskOwner: () => owner.ownerBinding });
		const execution = (id: TaskId) =>
			supervisor.taskRecords(lease, new Set([id])).find((task) => task.ref.taskId === id)?.execution;
		try {
			// A dev server: it never exits by itself.
			const launched = await bash.execute("dev-server", { command: "read value", wait: { kind: "background" } });
			const id = launched.details?.observation?.taskId;
			assert.ok(id);
			// The command asks the supervisor for no deadline at all, so nothing stops it on a timer.
			assert.equal(intents.length, 1);
			assert.equal(intents[0]?.executionTimeoutMs, undefined);

			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			await vi.advanceTimersByTimeAsync(OLD_DEFAULT_TIMEOUT_MS + 60_000);
			vi.useRealTimers();
			assert.equal(execution(id)?.kind, "running");

			const stopped = await kill.execute("kill", { id }, undefined, undefined, {} as never);
			assert.equal(stopped.details?.decision, "cancellation-requested");
			const waited = await bash.execute("wait", { action: "wait", id, budgetMs: 10_000 });
			const observation = waited.details?.observation;
			assert.equal(observation?.kind, "settled");
			const result = observation?.kind === "settled" ? observation.result : undefined;
			assert.equal(result?.kind, "cancelled");
			assert.equal(result?.kind === "cancelled" ? result.cause : undefined, "user");
		} finally {
			vi.useRealTimers();
			await owner.close("session-close");
		}
	},
);
