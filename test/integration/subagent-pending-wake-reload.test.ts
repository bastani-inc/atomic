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
import { isSubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** A real stage session loads the editable subagents extension twice. */
const STAGE_RELOAD_TIMEOUT_MS = 120_000;

test(
	"a wake admitted after its workflow stage reloads saves the live task once (#5609)",
	async () => {
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
			`import subagents from ${JSON.stringify(extension)};\nimport { agentWakeDispatcher } from "@bastani/atomic";\nexport default pi => { subagents(pi); pi.events.on("test:dispatcher", request => { request.value = agentWakeDispatcher(); }); };\n`,
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
			additionalExtensionPaths: [entry],
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
			builtins: { subagents: false, workflows: false, intercom: false, mcp: false, "web-access": false },
		});
		const host = session.getAgentTaskHost();
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const tasks: string[] = [];
		const start = host.startAgentTask.bind(host);
		vi.spyOn(host, "startAgentTask").mockImplementation(async (intent, operation, _runner, schedule) => {
			tasks.push(intent.task);
			reached.resolve();
			await gate.promise;
			return start(
				intent,
				operation,
				() => ({
					result: finish.promise.then(() => ({ kind: "cancelled", cause: "user" })),
					cleanup: finish.promise.then(() => ({ kind: "reaped" })),
				}),
				schedule,
			);
		});
		const saved = Promise.withResolvers<void>();
		const append = manager.appendCustomEntry.bind(manager);
		vi.spyOn(manager, "appendCustomEntry").mockImplementation(async (type, data) => {
			const entryId = await append(type, data);
			const entry = manager.getEntry(entryId);
			if (entry && isSubagentChildRecord(entry) && entry.data?.childId === id && entry.data.state === "running")
				saved.resolve();
			return entryId;
		});
		let wake: Promise<void> | undefined;
		try {
			const request: { value?: AgentWakeDispatcher } = {};
			bus.emit("test:dispatcher", request);
			assert.ok(request.value);
			wake = request.value.deliver(`subagents/${manager.getSessionId()}:${id}`, {
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
			await session.reload({ failOnExtensionErrors: true });
			const runner = session.extensionRunner;
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
			await Promise.race([saved.promise, wake.then(() => assert.fail("wake did not wait for its live task"))]);
			const answer = await resume;
			const records = async () =>
				(await manager.getSessionStore().load(manager.getSessionId())).entries
					.filter(isSubagentChildRecord)
					.flatMap((entry) => (entry.data?.childId === id && entry.data.state === "running" ? [entry.data] : []));
			const running = await records();
			assert.equal(running.length, 1);
			assert.ok(answer.isError);
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
