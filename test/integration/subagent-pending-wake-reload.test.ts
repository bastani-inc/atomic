import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
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
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** A real stage session loads the editable subagents extension twice. */
const STAGE_RELOAD_TIMEOUT_MS = 120_000;

test.each(["commit", "rollback", "preparing"] as const)(
	"a wake admitted after workflow stage reload %s saves the live task once (#5609)",
	async (reload) => {
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
			`import subagents from ${JSON.stringify(extension)};\nimport { agentWakeDispatcher } from "@bastani/atomic";\nexport default pi => { ${reload === "preparing" ? "" : "subagents(pi);"} pi.events.on("test:dispatcher", request => { request.value = agentWakeDispatcher(); request.privateWriter = Reflect.has(pi, Symbol.for("atomic.subagents/acquire-child-record-writer@1")); }); };\n`,
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
			additionalExtensionPaths: reload === "preparing" ? [extension, entry] : [entry],
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
				subagents: reload === "preparing",
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
		const tasks: string[] = [];
		const start = host.startAgentTask.bind(host);
		vi.spyOn(host, "startAgentTask").mockImplementation(async (intent, operation, _runner, schedule) => {
			tasks.push(intent.task);
			const admit = () =>
				start(
					intent,
					operation,
					() => ({
						result: finish.promise.then(() => ({ kind: "cancelled", cause: "user" })),
						cleanup: finish.promise.then(() => ({ kind: "reaped" })),
					}),
					schedule,
				);
			const admitted = reload === "preparing" ? await admit() : undefined;
			reached.resolve();
			await gate.promise;
			return admitted ?? admit();
		});
		const wakeKey = `subagents/${manager.getSessionId()}:${id}`;
		let wake: Promise<void> | undefined;
		try {
			const request: { value?: AgentWakeDispatcher; privateWriter?: boolean } = {};
			bus.emit("test:dispatcher", request);
			assert.ok(
				session.extensionRunner.getToolDefinition("subagent"),
				JSON.stringify(loader.getExtensions().errors),
			);
			assert.ok(request.value);
			assert.equal(request.privateWriter, false, "a third-party extension has no private record writer");
			wake = request.value.deliver(wakeKey, {
				id: "result",
				kind: "tool-result",
				toolResult: {
					toolCallId: "call",
					toolName: "bash",
					result: { content: [{ type: "text", text: "checks finished" }], details: undefined },
					isError: false,
				},
			});
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
			assert.equal(runner === previous, reload === "rollback");
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
			await Promise.race([
				releasedChildWakeDecided(wakeKey),
				wake.then(() => assert.fail("wake did not wait for its live task")),
			]);
			const answer = await resume;
			const records = async () =>
				(await manager.getSessionStore().load(manager.getSessionId())).entries
					.filter(isSubagentChildRecord)
					.flatMap((entry) => (entry.data?.childId === id && entry.data.state === "running" ? [entry.data] : []));
			const running = await records();
			assert.equal(running.length, 1);
			assert.ok(answer.isError, JSON.stringify(answer.content));
			assert.match(JSON.stringify(answer.content), new RegExp(`already running as task ${running[0]?.taskId}`));
			assert.equal(tasks.length, 1);
			assert.match(tasks[0]!, /checks finished/);
			finish.resolve();
			await wake;
			assert.equal((await records()).length, 1);
		} finally {
			gate.resolve();
			finish.resolve();
			await wake?.catch(() => undefined);
			await session.dispose();
			vi.unstubAllEnvs();
			removeTempDirectory(cwd);
		}
	},
	STAGE_RELOAD_TIMEOUT_MS,
);
