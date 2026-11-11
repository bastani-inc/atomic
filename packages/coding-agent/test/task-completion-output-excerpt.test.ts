import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { AgentTaskHost } from "../src/core/tasks/agent-adapter.js";
import { COMMAND_DETAIL_TAIL_BYTES } from "../src/core/tasks/command-output.js";
import { COMMAND_OUTPUT_UNAVAILABLE, commandOutputExcerpt } from "../src/core/tasks/completion-message.js";
import type { OperationId, TaskRecord } from "../src/core/tasks/contracts.js";
import type { TaskLease } from "../src/core/tasks/supervisor.js";

const hosts: AgentTaskHost[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const host of hosts.splice(0)) await host.close("session-close");
});

function host(): AgentTaskHost {
	const created = new AgentTaskHost({
		scope: { kind: "session", sessionId: crypto.randomUUID() },
		tasks: { wait: { kind: "automatic", commandBudgetMs: 0 } },
		authorizeLaunch() {},
	});
	hosts.push(created);
	return created;
}

/** Runs `command` to completion and returns its lease and settled record. */
async function settledCommand(owner: AgentTaskHost, command: string): Promise<{ lease: TaskLease; task: TaskRecord }> {
	const { supervisor, owner: lease } = owner.ownerBinding;
	const started = await supervisor.startCommandTask(
		lease,
		{ kind: "command", command, terminal: { kind: "pipe" } },
		crypto.randomUUID() as OperationId,
	);
	assert.ok(started.ok);
	const settled = await supervisor.waitForTask(started.value, 10_000);
	assert.ok(settled.ok && settled.value.kind === "settled");
	const watched = owner.watchOwnerTasks();
	assert.ok(watched.ok);
	watched.value.dispose();
	const task = watched.value.snapshot.tasks.find(
		(item) => item.ref.taskId === supervisor.taskReference(started.value).taskId,
	);
	assert.ok(task);
	return { lease: started.value, task };
}

test.runIf(process.platform !== "win32")("a short command's excerpt is its whole output", async () => {
	const owner = host();
	const { lease, task } = await settledCommand(owner, "printf 'short output'");
	assert.equal(await commandOutputExcerpt(owner, lease, task), "short output");
});

test.runIf(process.platform !== "win32")(
	"a long command's excerpt is the tail of its output, marked as cut",
	async () => {
		const owner = host();
		const { lease, task } = await settledCommand(owner, "printf 'head%.0s' $(seq 1 3000); printf 'tail-end'");
		const excerpt = await commandOutputExcerpt(owner, lease, task);
		assert.ok(excerpt.startsWith("[Earlier output omitted]\n"), excerpt.slice(0, 40));
		assert.ok(excerpt.endsWith("tail-end"));
		assert.equal(excerpt.length, "[Earlier output omitted]\n".length + COMMAND_DETAIL_TAIL_BYTES);
	},
);

test.runIf(process.platform !== "win32")(
	"an excerpt whose output cannot be read says so instead of dropping the notice",
	async () => {
		const owner = host();
		const { lease, task } = await settledCommand(owner, "printf 'kept'");
		const { supervisor } = owner.ownerBinding;
		vi.spyOn(supervisor, "readTaskOutput").mockResolvedValueOnce({
			ok: false,
			error: { code: "OutputUnavailable", message: "gone" },
		});
		assert.equal(await commandOutputExcerpt(owner, lease, task), COMMAND_OUTPUT_UNAVAILABLE);
		vi.spyOn(supervisor, "readTaskOutput").mockRejectedValueOnce(new Error("read failed"));
		assert.equal(await commandOutputExcerpt(owner, lease, task), "Output unavailable");
	},
);
