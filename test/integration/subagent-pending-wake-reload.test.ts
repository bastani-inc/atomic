import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import {
	type AgentWakeDispatcher,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { releasedChildWakeDecided } from "../../packages/subagents/src/runs/foreground/released-child-resume.js";
import { isSubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import { collectGarbage } from "../helpers/collect-garbage.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** A real stage session loads the editable subagents extension twice. */
const STAGE_RELOAD_TIMEOUT_MS = 120_000;

type Receipt = "whenIdle" | "deliver";
type Reload =
	| "commit"
	| "rollback"
	| "preparing"
	| "refused"
	| "refused-rollback"
	| `peer-${Receipt}`
	| `hook-${Receipt}`;

describe("workflow stage reload", () => {
	test.each(["commit", "rollback", "preparing"] as const)(
		"an admitted wake saves the live task once across %s (#5609)",
		runReload,
		STAGE_RELOAD_TIMEOUT_MS,
	);
	test.each(["refused", "refused-rollback"] as const)(
		"%s reports the refusal and keeps its result for resume (#5629)",
		runReload,
		STAGE_RELOAD_TIMEOUT_MS,
	);
	test.each(["whenIdle", "deliver"] as const)(
		"an admitted extension callback awaiting %s does not block reload (#5629)",
		(receipt) => runReload(`peer-${receipt}`),
		STAGE_RELOAD_TIMEOUT_MS,
	);
	test.each(["whenIdle", "deliver"] as const)(
		"beforeSessionStart can await %s after the native refusal (#5629)",
		(receipt) => runReload(`hook-${receipt}`),
		STAGE_RELOAD_TIMEOUT_MS,
	);

	async function runReload(reload: Reload): Promise<void> {
		const observer = reload.startsWith("peer-") || reload.startsWith("hook-");
		const fenced = reload === "refused" || reload === "refused-rollback";
		const builtin = reload === "preparing" || fenced || observer;
		const cwd = makeTempDirectory("atomic-stage-wake-");
		const agentDir = join(cwd, "profile");
		const entry = join(cwd, "subagents.ts");
		const extension = fileURLToPath(new URL("../../packages/subagents/src/extension/index.ts", import.meta.url));
		const manager = SessionManager.inMemory(cwd);
		const child = await SessionManager.create(manager.getSessionStore(), cwd);
		const id = "reload-worker:0";
		const orchestration = {
			kind: "workflow-stage",
			workflowRunId: "wake-run",
			workflowStageId: "stage",
			workflowStageName: "stage",
		} as const;
		const bus = createEventBus();
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "wake-worker.md"),
			"---\nname: wake-worker\ndescription: Receives a result\n---\nContinue from the result.\n",
		);
		await writeFile(
			entry,
			`import subagents from ${JSON.stringify(extension)};\nimport { agentWakeDispatcher } from "@bastani/atomic";\nexport default pi => { ${builtin ? "" : "subagents(pi);"} pi.events.on("test:observe-wake", observe => observe(agentWakeDispatcher())); pi.events.on("test:dispatcher", request => { request.value = agentWakeDispatcher(); request.privateWriter = Reflect.has(pi, Symbol.for("atomic.subagents/acquire-child-record-writer@1")); }); };\n`,
		);
		await child.appendMessage({ role: "user", content: "original task", timestamp: Date.now() });
		await manager.appendCustomEntry("subagent-child", {
			version: 1,
			childId: id,
			runId: "reload-worker",
			index: 0,
			agent: "wake-worker",
			cwd,
			state: "terminal",
			terminalStatus: "ok",
			childSessionId: child.getSessionId(),
			owner: { ...orchestration, sessionId: manager.getSessionId() },
		});
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		const settingsManager = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			eventBus: bus,
			builtinPackagePaths: [],
			additionalExtensionPaths: builtin ? [extension, entry] : [entry],
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: manager,
			settingsManager,
			resourceLoader: loader,
			orchestrationContext: { ...orchestration, constraints: { disableWorkflowTool: true } },
			builtins: {
				subagents: builtin,
				workflows: false,
				intercom: false,
				mcp: false,
				"web-access": false,
			},
		});
		const host = session.getAgentTaskHost();
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const refused = Promise.withResolvers<string>();
		let attemptedRunner: WeakRef<object> | undefined;
		const tasks: string[] = [];
		const start = host.startAgentTask.bind(host);
		vi.spyOn(host, "startAgentTask").mockImplementation(async (intent, operation, _runner, schedule) => {
			tasks.push(intent.task);
			const admit = () => {
				const runner: Parameters<typeof start>[2] = () => ({
					result: finish.promise.then(() => ({ kind: "cancelled", cause: "user" })),
					cleanup: finish.promise.then(() => ({ kind: "reaped" })),
				});
				attemptedRunner = new WeakRef(runner);
				return start(intent, operation, runner, schedule);
			};
			const admitted = reload === "preparing" ? await admit() : undefined;
			reached.resolve();
			await gate.promise;
			return (
				admitted ??
				admit().catch((error: unknown) => {
					refused.resolve(String(error));
					throw error;
				})
			);
		});
		const wakeKey = `subagents/${manager.getSessionId()}:${id}`;
		let wake: Promise<void> | undefined;
		const releaseObserver = Promise.withResolvers<void>();
		let observedReload: Promise<void> | undefined;
		try {
			const request: { value?: AgentWakeDispatcher; privateWriter?: boolean } = {};
			bus.emit("test:dispatcher", request);
			assert.ok(
				session.extensionRunner.getToolDefinition("subagent"),
				JSON.stringify(loader.getExtensions().errors),
			);
			assert.ok(request.value);
			assert.equal(request.privateWriter, false, "a third-party extension has no private record writer");
			const deliver = (dispatcher: AgentWakeDispatcher) =>
				dispatcher.deliver(wakeKey, {
					id: "result",
					kind: "tool-result",
					toolResult: {
						toolCallId: "call",
						toolName: "bash",
						result: { content: [{ type: "text", text: "checks finished" }], details: undefined },
						isError: false,
					},
				});
			if (observer) {
				const dispatcher = request.value;
				const returned = Promise.withResolvers<void>();
				let callbackError: unknown;
				const observe = async (sdk: AgentWakeDispatcher) => {
					wake ??= deliver(sdk);
					const receipt = reload.endsWith("whenIdle") ? sdk.whenIdle() : wake;
					try {
						await Promise.race([receipt, releaseObserver.promise]);
					} catch (error) {
						callbackError = error;
					} finally {
						returned.resolve();
					}
				};
				if (reload !== "peer-deliver") wake = deliver(dispatcher);
				else bus.emit("test:observe-wake", observe);
				assert.ok(wake);
				void wake.catch(() => {});
				await reached.promise;
				if (reload === "peer-whenIdle") bus.emit("test:observe-wake", observe);
				const previous = session.extensionRunner;
				observedReload = session.reload({
					beforeSessionStart: async () => {
						if (!reload.startsWith("hook-")) return;
						gate.resolve();
						await refused.promise;
						await observe(dispatcher);
					},
				});
				finish.resolve();
				if (reload.startsWith("peer-")) gate.resolve();
				assert.match(await refused.promise, /Task owner is closed/);
				// Rescue only the callback if it is stuck. Neither the reload nor the wake waits on the test.
				let rescued = false;
				const watchdog = setTimeout(() => {
					rescued = true;
					releaseObserver.resolve();
				}, 10_000);
				await returned.promise.finally(() => clearTimeout(watchdog));
				assert.equal(rescued, false, "the callback must return without being released by the test");
				await observedReload;
				assert.notEqual(session.extensionRunner, previous);
				await assert.rejects(wake, (error: Error) => {
					assert.ok("code" in error && error.code === "wake-failed");
					assert.match(String(error.cause), /Task owner is closed/);
					assert.equal(callbackError, reload.endsWith("whenIdle") ? undefined : error);
					return true;
				});
				assert.equal(tasks.length, 1, "a refused wake must not be retried behind its own observer");
				return;
			}
			wake = deliver(request.value);
			void wake.catch(() => {});
			await Promise.race([reached.promise, wake.then(() => assert.fail("wake ended before admission"))]);
			await appendFile(entry, "\n// Reload this extension while the owner is admitting the wake.\n");
			const previous = session.extensionRunner;
			if (reload === "rollback") {
				const prepare = DefaultResourceLoader.prototype.prepareReload;
				vi.spyOn(DefaultResourceLoader.prototype, "prepareReload").mockImplementationOnce(async function (
					this: DefaultResourceLoader,
					...args
				) {
					return {
						...(await prepare.apply(this, args)),
						prepareCommit() {
							throw new Error("reject candidate after session_start");
						},
					};
				});
				await assert.rejects(
					session.reload({ failOnExtensionErrors: true }),
					/reject candidate after session_start/,
				);
			} else if (fenced) {
				const reloading = session.reload({
					failOnExtensionErrors: true,
					beforeSessionStart: async () => {
						gate.resolve();
						assert.match(await refused.promise, /Task owner is closed/);
						assert.ok(attemptedRunner);
						await collectGarbage(5);
						assert.equal(attemptedRunner.deref(), undefined, "the reload does not retain the refused runner");
						if (reload === "refused-rollback") throw new Error("reject candidate before session_start");
					},
				});
				if (reload === "refused-rollback") await assert.rejects(reloading, /reject candidate before session_start/);
				else await reloading;
			} else if (reload === "preparing") {
				await session.reload({
					failOnExtensionErrors: true,
					beforeSessionStart: async () => {
						gate.resolve();
						await releasedChildWakeDecided(wakeKey);
					},
				});
			} else await session.reload({ failOnExtensionErrors: true });
			assert.equal(session.getAgentTaskHost(), host, "the workflow stage keeps its task host");
			const runner = session.extensionRunner;
			assert.equal(runner === previous, reload === "rollback" || reload === "refused-rollback");
			const tool = runner.getToolDefinition("subagent");
			assert.ok(tool);
			const resume = tool.execute(
				"competing-resume",
				{ action: "resume", id, message: "do not start again" },
				new AbortController().signal,
				undefined,
				runner.createToolContext("competing-resume", undefined),
			);
			gate.resolve();
			if (!fenced) {
				await Promise.race([
					releasedChildWakeDecided(wakeKey),
					wake.then(() => assert.fail("wake did not wait for its live task")),
				]);
			}
			const answer = await resume;
			const records = async () =>
				(await manager.getSessionStore().load(manager.getSessionId())).entries
					.filter(isSubagentChildRecord)
					.flatMap((entry) => (entry.data?.childId === id && entry.data.state === "running" ? [entry.data] : []));
			const running = await records();
			assert.equal(running.length, 1);
			if (fenced) {
				assert.match(JSON.stringify(answer.content), /Resumed wake-worker/);
				await assert.rejects(wake, { code: "wake-failed" });
			} else {
				assert.ok(answer.isError, JSON.stringify(answer.content));
				assert.match(JSON.stringify(answer.content), new RegExp(`already running as task ${running[0]?.taskId}`));
			}
			assert.equal(tasks.length, fenced ? 2 : 1);
			assert.equal(tasks.at(-1)?.match(/checks finished/g)?.length, 1);
			finish.resolve();
			if (!fenced) await wake;
			assert.equal((await records()).length, 1);
		} finally {
			releaseObserver.resolve();
			gate.resolve();
			finish.resolve();
			await observedReload?.catch(() => undefined);
			await wake?.catch(() => undefined);
			await session.dispose();
			vi.unstubAllEnvs();
			removeTempDirectory(cwd);
		}
	}
});
