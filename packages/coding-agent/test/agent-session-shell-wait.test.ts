import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { createAgentSession } from "../src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk-types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { OperationId, TaskId } from "../src/core/tasks/contracts.js";
import type { BashToolDetails } from "../src/core/tools/bash.js";
import { WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.js";
import { createHarness } from "./suite/harness.js";
import { createTestResourceLoader } from "./utilities.js";

vi.mock("../src/utils/shell.js", async (importOriginal) => {
	const shell = await importOriginal<typeof import("../src/utils/shell.js")>();
	return {
		...shell,
		// Exercise both registry branches even when PowerShell cannot launch on this host.
		isPowerShellAvailable: () => true,
		// Only replace OS executable discovery for portable PowerShell. The session
		// registry, local operations, encoded transport and native supervisor are real.
		getPowerShellConfig: () =>
			process.platform !== "win32" && process.env.ATOMIC_TEST_PWSH
				? { shell: process.env.ATOMIC_TEST_PWSH, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] }
				: shell.getPowerShellConfig(),
	};
});

const launchShell = process.platform === "win32" ? "powershell" : "bash";
const commands = {
	powershell: "$value = [Console]::ReadLine(); Write-Output 'registry completed once'; exit 7",
	bash: "read value; printf 'registry completed once'; exit 7",
};

function tool(session: AgentSession, name: "bash" | "powershell") {
	const registered = session.agent.state.tools.find((item) => item.name === name);
	assert.ok(registered, `${name} must be registered on the session`);
	return registered;
}

async function start(session: AgentSession, name: "bash" | "powershell" = launchShell) {
	const result = await tool(session, name).execute("launch", {
		command: commands[name],
		wait: { kind: "background" },
		timeout: 20,
	});
	const observation = (result.details as BashToolDetails).observation;
	assert.equal(observation?.kind, "yielded");
	assert.ok(observation);
	return observation.taskId;
}

async function release(session: AgentSession, id: TaskId) {
	const host = session.getAgentTaskHost();
	const task = host.resolveTask(id);
	assert.ok(task.ok);
	const { supervisor } = host.ownerBinding;
	const input = supervisor.taskStdin(task.value);
	assert.ok(input.ok);
	const written = await supervisor.writeTaskInput(input.value, crypto.randomUUID() as OperationId, {
		kind: "bytes",
		bytes: Buffer.from("ready\n"),
	});
	assert.ok(written.ok);
}

for (const name of ["bash", "powershell"] as const) {
	// PR #2972: a yielded wait must advance beyond the first retained 8 KiB page.
	test(`registered ${name} progresses retained output across yielded waits`, async () => {
		const harness = await createHarness({
			settings: {},
			initialActiveToolNames: ["bash", "powershell"],
		});
		const { session } = harness;
		session.pauseQueuedMessages();
		try {
			const launched = await tool(session, launchShell).execute("launch", {
				command:
					launchShell === "powershell"
						? "$value = [Console]::ReadLine(); [Console]::Write(('a' * 8192) + 'later-page'); $value = [Console]::ReadLine(); [Console]::Write('terminal'); exit 7"
						: "read value; printf '%8192s' '' | tr ' ' a; printf 'later-page'; read value; printf terminal; exit 7",
				wait: { kind: "background" },
				timeout: 20,
			});
			const id = (launched.details as BashToolDetails).observation!.taskId;
			await release(session, id);
			const host = session.getAgentTaskHost();
			const task = host.resolveTask(id);
			assert.ok(task.ok);
			await vi.waitFor(
				async () => {
					const page = await host.ownerBinding.supervisor.readTaskOutput(task.value, {
						start: "8192",
						maximumBytes: 32,
					});
					assert.ok(page.ok);
					assert.equal(
						Buffer.concat(page.value.chunks.map((chunk) => Buffer.from(chunk.bytes))).toString(),
						"later-page",
					);
				},
				{ timeout: 5000 },
			);
			const first = await tool(session, name).execute("first-page", { action: "wait", id, budgetMs: 0 });
			assert.equal((first.details as BashToolDetails).observation?.kind, "yielded");
			assert.match(first.content[0].type === "text" ? first.content[0].text : "", /^a{8192}\n\[Additional output/);
			const second = await tool(session, name).execute("second-page", { action: "wait", id, budgetMs: 0 });
			assert.equal((second.details as BashToolDetails).observation?.kind, "yielded");
			assert.equal((second.details as BashToolDetails).observation?.taskId, id);
			assert.match(second.content[0].type === "text" ? second.content[0].text : "", /^later-page\n\n/);
			const empty = await tool(session, name).execute("caught-up", { action: "wait", id, budgetMs: 0 });
			assert.match(empty.content[0].type === "text" ? empty.content[0].text : "", /^\(no output\)\n\n/);
			await release(session, id);
			const terminal = await tool(session, name).execute("settle", { action: "wait", id, budgetMs: 10000 });
			assert.equal((terminal.details as BashToolDetails).exitCode, 7);
			assert.match(
				terminal.content[0].type === "text" ? terminal.content[0].text : "",
				/^a{8192}later-pageterminal\n\n/,
			);
		} finally {
			await session.closeSessionTasks();
			harness.cleanup();
		}
	});
	test(`registered ${name} waits on its session's existing command across yields and settlement`, async () => {
		const harness = await createHarness({
			settings: {},
			initialActiveToolNames: ["bash", "powershell"],
		});
		const { session } = harness;
		session.pauseQueuedMessages();
		try {
			const id = await start(session);
			for (const budgetMs of [0, 1]) {
				const result = await tool(session, name).execute("poll", { action: "wait", id, budgetMs });
				const observation = (result.details as BashToolDetails).observation;
				assert.equal(observation?.kind, "yielded");
				assert.equal(observation?.taskId, id);
			}
			await release(session, id);
			const result = await tool(session, name).execute("settle", { action: "wait", id, budgetMs: 10000 });
			const details = result.details as BashToolDetails;
			assert.equal(details.observation?.kind, "settled");
			assert.equal(details.observation?.taskId, id);
			assert.equal(details.exitCode, 7);
			assert.match(
				result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
				/registry completed once/,
			);
			const tasks = session.getAgentTaskHost().watchOwnerTasks();
			assert.ok(tasks.ok);
			assert.equal(tasks.value.snapshot.tasks.length, 1, "wait must not admit another command");
			tasks.value.dispose();
		} finally {
			await session.closeSessionTasks();
			harness.cleanup();
		}
	});
	// #3105: reload cancels session-owned commands rather than reviving their closed native owner.
	test(`registered ${name} receives a fresh owner after reload cancels its old command`, async () => {
		const harness = await createHarness({
			settings: {},
			initialActiveToolNames: ["bash", "powershell"],
		});
		const { session } = harness;
		session.pauseQueuedMessages();
		try {
			const oldId = await start(session);
			const oldOwner = session.getAgentTaskHost();
			await session.reload();
			assert.notEqual(session.getAgentTaskHost(), oldOwner);
			const closed = await oldOwner.close("session-close");
			assert.ok(closed.ok);
			assert.equal(closed.value.state, "closed");
			const execution = closed.value.tasks[0]!.execution;
			assert.equal(execution.kind, "settled");
			if (execution.kind === "settled") assert.equal(execution.result.kind, "cancelled");
			await assert.rejects(tool(session, name).execute("old", { action: "wait", id: oldId }), /UnknownTask/);
			const newId = await start(session);
			await release(session, newId);
			const result = await tool(session, name).execute("new", { action: "wait", id: newId, budgetMs: 10000 });
			assert.equal((result.details as BashToolDetails).exitCode, 7);
		} finally {
			await session.dispose();
			harness.cleanup();
		}
	});
	test(`registered ${name} abort and steering release observation without stopping execution`, async () => {
		const harness = await createHarness({
			settings: {},
			initialActiveToolNames: ["bash", "powershell"],
		});
		const { session } = harness;
		session.pauseQueuedMessages();
		try {
			const id = await start(session);
			const controller = new AbortController();
			const waiting = tool(session, name).execute(
				"abort-wait",
				{ action: "wait", id, budgetMs: 60000 },
				controller.signal,
			);
			const aborted = assert.rejects(waiting, /aborted/);
			controller.abort();
			await aborted;
			const messageWait = tool(session, name).execute("message-wait", { action: "wait", id });
			await session.steer("Keep working on the original task");
			const observation = ((await messageWait).details as BashToolDetails).observation;
			assert.equal(observation?.kind, "yielded");
			assert.equal(observation?.taskId, id);
			if (observation?.kind === "yielded") assert.equal(observation.reason, "input-needed");
			await release(session, id);
			const result = await tool(session, name).execute("settle", { action: "wait", id });
			assert.equal((result.details as BashToolDetails).exitCode, 7);
		} finally {
			await session.closeSessionTasks();
			harness.cleanup();
		}
	});
	test(`registered ${name} releases an aborted observation during session disposal`, async () => {
		const harness = await createHarness({
			settings: {},
			initialActiveToolNames: ["bash", "powershell"],
		});
		const { session } = harness;
		session.pauseQueuedMessages();
		try {
			const id = await start(session);
			const controller = new AbortController();
			const waiting = tool(session, name).execute(
				"disposing-wait",
				{ action: "wait", id, budgetMs: 60000 },
				controller.signal,
			);
			const aborted = assert.rejects(waiting, /aborted/);
			const closing = session.dispose();
			controller.abort();
			await aborted;
			await closing;
		} finally {
			await session.closeSessionTasks();
			harness.cleanup();
		}
	});
}

async function sdkSession(
	root: string,
	options: Pick<CreateAgentSessionOptions, "orchestrationContext" | "subagentPolicy"> = {},
) {
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		tools: ["bash", "powershell"],
		...options,
	});
	session.pauseQueuedMessages();
	return session;
}

for (const name of ["bash", "powershell"] as const) {
	for (const scope of ["session", "workflow-stage"] as const) {
		test(`registered ${name} respects ${scope} ownership across session replacement`, async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-shell-wait-"));
			const boundary = new WorkflowStageAdmissionBoundary();
			const options =
				scope === "workflow-stage"
					? {
							orchestrationContext: {
								kind: "workflow-stage" as const,
								workflowRunId: crypto.randomUUID(),
								workflowStageId: "shell-wait",
								workflowStageName: "Shell wait",
								constraints: { disableWorkflowTool: true as const },
								messageAdmission: {
									boundary,
									extensionState: new Map<string, object>(),
									isOpen: () => boundary.isOpen(),
								},
							},
						}
					: {};
			const sessions: AgentSession[] = [];
			try {
				const original = await sdkSession(root, options);
				sessions.push(original);
				assert.equal(boundary.hasAgentTaskHost(), false, "registration must not create a task owner");
				const id = await start(original);
				const oldTool = tool(original, name);
				original.dispose();
				await original.closeSessionTasks();
				const replacement = await sdkSession(root, options);
				sessions.push(replacement);
				await assert.rejects(oldTool.execute("stale", { action: "wait", id }), /stale|closed/i);
				if (scope === "session") {
					await assert.rejects(
						tool(replacement, name).execute("foreign", { action: "wait", id }),
						/UnknownTask|ScopeMismatch/,
					);
				}
				const currentId = scope === "session" ? await start(replacement) : id;
				const result = await tool(replacement, name).execute("poll", {
					action: "wait",
					id: currentId,
					budgetMs: 0,
				});
				assert.equal((result.details as BashToolDetails).observation?.kind, "yielded");
				assert.equal((result.details as BashToolDetails).observation?.taskId, currentId);
				await release(replacement, currentId);
				const terminal = await tool(replacement, name).execute("settle", {
					action: "wait",
					id: currentId,
					budgetMs: 10000,
				});
				assert.equal((terminal.details as BashToolDetails).exitCode, 7);
				await boundary.close();
				await replacement.closeSessionTasks();
				await assert.rejects(
					tool(replacement, name).execute("closed", { action: "wait", id: currentId }),
					/closed/i,
				);
			} finally {
				await boundary.close();
				for (const session of sessions) {
					await session.closeSessionTasks();
					session.dispose();
				}
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
}

test.runIf(process.platform === "win32" || !!process.env.ATOMIC_TEST_PWSH)(
	"registered PowerShell launches and observes a real PowerShell command without restarting",
	async () => {
		const harness = await createHarness({ initialActiveToolNames: ["powershell"] });
		const { session } = harness;
		session.pauseQueuedMessages();
		try {
			const id = await start(session, "powershell");
			const polled = await tool(session, "powershell").execute("poll", { action: "wait", id, budgetMs: 0 });
			assert.equal((polled.details as BashToolDetails).observation?.taskId, id);
			await release(session, id);
			const result = await tool(session, "powershell").execute("settle", { action: "wait", id, budgetMs: 10000 });
			assert.equal((result.details as BashToolDetails).exitCode, 7);
			assert.match(
				result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
				/registry completed once/,
			);
		} finally {
			await session.closeSessionTasks();
			harness.cleanup();
		}
	},
);

test("registered subagent shells retain unbound waits and legacy foreground execution", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-child-shell-wait-"));
	const session = await sdkSession(root, {
		subagentPolicy: {
			depth: 1,
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
		},
	});
	try {
		for (const name of ["bash", "powershell"] as const) {
			await assert.rejects(
				tool(session, name).execute("unbound", { action: "wait", id: "missing" }),
				/supported task owner/,
			);
			await assert.rejects(
				tool(session, name).execute("background", { command: "must not run", wait: { kind: "background" } }),
				/owner/,
			);
		}
		const result = await tool(session, launchShell).execute("foreground", {
			command: launchShell === "powershell" ? "Write-Output 'legacy foreground'" : "printf 'legacy foreground'",
			wait: { kind: "foreground", budgetMs: 0 },
		});
		assert.equal((result.details as BashToolDetails).observation, undefined);
		assert.match(result.content.map((part) => (part.type === "text" ? part.text : "")).join(""), /legacy foreground/);
	} finally {
		await session.closeSessionTasks();
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
