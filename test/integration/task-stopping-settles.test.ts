import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { CancelReceipt, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { type BashToolDetails, createBashTool } from "../../packages/coding-agent/src/core/tools/bash.js";
import { createKillTool } from "../../packages/coding-agent/src/core/tools/kill.js";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { fileExists, readJson, sleep } from "../helpers/runtime.js";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, label);
		await sleep(20);
	}
}

const footer = (store: OwnerTaskStore) =>
	renderTaskFooter(store.backgroundTasks, 200).map((line) => stripVTControlCharacters(line));

// The Tasks widget counted these stops as "stopping" forever: a descendant that left the command's process group kept
// its output open, so cleanup could not be confirmed, and a stop with unconfirmed cleanup never settled.
test.runIf(process.platform !== "win32")(
	"a killed background shell and an aborted foreground shell stop counting as stopping when cleanup is unconfirmed",
	async () => {
		initTheme("dark");
		const directory = await mkdtemp(join(tmpdir(), "task-stopping-"));
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: crypto.randomUUID() },
			authorizeLaunch() {},
		});
		const { supervisor, owner } = host.ownerBinding;
		const store = new OwnerTaskStore(supervisor, owner);
		assert.ok(store.connect().ok);
		const bash = createBashTool(process.cwd(), { taskOwner: host.ownerBinding });
		const kill = createKillTool({ taskOwner: () => host.ownerBinding });
		const processes: Array<{ parent: number; holder: number }> = [];
		const command = (name: string) =>
			`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("test/fixtures/task-escaped-output-holder.mjs"))} ${JSON.stringify(join(directory, name))}`;
		const started = async (name: string) => {
			await until(() => fileExists(join(directory, name)), 10_000, `${name} fixture started`);
			const identities = await readJson<{ parent: number; holder: number }>(join(directory, name));
			processes.push(identities);
			return identities;
		};
		try {
			const launched = await bash.execute("background", {
				command: command("background.json"),
				wait: { kind: "background" },
			});
			const observation = (launched.details as BashToolDetails).observation;
			assert.ok(observation?.kind === "yielded");
			const background = await started("background.json");
			const receipt = await kill.execute("kill", { id: observation.taskId });
			assert.equal((receipt.details as CancelReceipt).execution.kind, "cancelling");

			const controller = new AbortController();
			const foregroundCall = bash
				.execute(
					"foreground",
					{ command: command("foreground.json"), wait: { kind: "foreground", budgetMs: 20_000 } },
					controller.signal,
				)
				.then(
					() => undefined,
					(error: Error) => error,
				);
			const foreground = await started("foreground.json");
			const abortedAt = Date.now();
			controller.abort();

			// Cleanup gives up within its bound; both stops then settle and leave the widget.
			await until(
				() => {
					store.drain();
					return store.tasks.length === 2 && store.tasks.every((task) => task.execution.kind === "settled");
				},
				10_000,
				"stopped tasks settled",
			);
			assert.ok(Date.now() - abortedAt < 10_000);
			assert.deepEqual(footer(store), []);
			for (const task of store.tasks) {
				const result = (task.execution as Extract<TaskRecord["execution"], { kind: "settled" }>).result;
				assert.equal(result.kind, "failed", JSON.stringify(result));
				if (result.kind === "failed") {
					assert.equal(result.code, "CleanupUnconfirmed");
					assert.match(result.message, /^Stop requested \(user\); cleanup unconfirmed: process-group:\d+: /);
				}
				assert.equal(task.cleanup.kind, "failed");
			}
			const error = await foregroundCall;
			assert.ok(error instanceof Error, "the aborted foreground call reports its stop");
			assert.match(error.message, /^CleanupUnconfirmed: Stop requested \(user\); cleanup unconfirmed/);
			// The commands' own process groups are gone; only the escaped holders outlive the stop.
			for (const identities of [background, foreground]) {
				assert.equal(alive(identities.parent), false);
				assert.equal(alive(identities.holder), true);
			}
		} finally {
			for (const { holder } of processes) {
				try {
					process.kill(holder, "SIGKILL");
				} catch {}
			}
			store.dispose();
			await host.close("session-close");
			await rm(directory, { recursive: true, force: true });
		}
	},
);
