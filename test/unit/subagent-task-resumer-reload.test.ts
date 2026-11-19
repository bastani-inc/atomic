import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerFauxProvider } from "@bastani/atomic-ai/compat";
import { test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { getOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";

const REAL_SUBAGENT_RELOAD_TIMEOUT_MS = 120_000;
const CONDITION_WAIT_MS = 20_000;

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + CONDITION_WAIT_MS;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(predicate(), "the child did not finish in time");
}

test(
	"a workflow stage's finished subagent chat resumes its child after reload without another parent turn (#5246)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-subagent-chat-reload-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(cwd, ".atomic", "agents", "reload-worker.md"),
			"---\nname: reload-worker\ndescription: reload worker\ntools: read\ninheritProjectContext: false\ninheritSkills: false\n---\nReply briefly.\n",
		);
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("NODE_TEST_CONTEXT", undefined);
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const faux = registerFauxProvider();
		const model = faux.getModel();
		const fauxApi = getApiProvider(faux.api);
		assert.ok(fauxApi);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			allowModelNetwork: false,
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			apiKey: "faux-key",
			models: faux.models,
			streamSimple: fauxApi.streamSimple,
		});
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false },
			sessionSummary: { enabled: false },
			defaultProjectTrust: "always",
		});
		const sessionManager = SessionManager.inMemory(cwd);
		const boundary = new WorkflowStageAdmissionBoundary();
		let parentTurns = 0;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			builtinPackagePaths: [],
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				registerSubagentExtension,
				(pi) => {
					pi.on("agent_start", (_event, ctx) => {
						if (ctx.sessionManager.getSessionId() === sessionManager.getSessionId()) parentTurns += 1;
					});
				},
			],
		});
		let session: AgentSession | undefined;
		try {
			await resourceLoader.reload();
			({ session } = await createAgentSession({
				cwd,
				agentDir,
				modelRuntime,
				model,
				settingsManager,
				sessionManager,
				resourceLoader,
				builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
				orchestrationContext: {
					kind: "workflow-stage",
					workflowRunId: "reload-workflow",
					workflowStageId: "reload-stage",
					workflowStageName: "reload-stage",
					constraints: { disableWorkflowTool: true },
					messageAdmission: { boundary, extensionState: new Map(), isOpen: () => boundary.isOpen() },
				},
			}));
			await session.bindExtensions({});
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("subagent", {
							agent: "reload-worker",
							task: "Reply briefly.",
							agentScope: "project",
							artifacts: false,
							sessionDir: join(root, "children"),
							heartbeatMs: 0,
						}),
					],
					{ stopReason: "toolUse" },
				),
				...Array.from({ length: 6 }, () => fauxAssistantMessage("the child finished")),
			]);
			await session.prompt("Launch the reload worker with the subagent tool.");
			const host = session.getAgentTaskHost();
			const child = host.taskRecords().find((task) => task.kind === "agent");
			assert.ok(child, "the parent launched a real subagent");
			await until(
				() => host.taskRecords().find((task) => task.ref.taskId === child.ref.taskId)?.execution.kind === "settled",
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await until(() => !session!.isStreaming);
			const taskSource = () => {
				const store = getOwnerTaskStore(session!);
				assert.ok(store);
				store.drain();
				return ownerTaskViewSource(store);
			};
			const beforeReload = taskSource();
			assert.ok(beforeReload.taskReadOnlyReason);
			assert.equal(beforeReload.taskReadOnlyReason(child.ref.taskId), undefined);
			const turnsBeforeReload = parentTurns;
			await session.reload();
			const source = taskSource();
			assert.equal(parentTurns, turnsBeforeReload, "reload did not start another parent turn");
			assert.ok(source.taskReadOnlyReason);
			assert.ok(source.sendTaskMessage);
			assert.equal(
				source.taskReadOnlyReason(child.ref.taskId),
				undefined,
				"reload keeps the finished child's chat writable",
			);
			faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("the resumed child answered")));
			await source.sendTaskMessage(child.ref.taskId, "Continue from this chat.");
			await until(() =>
				host
					.taskRecords()
					.some(
						(task) =>
							task.ref.taskId !== child.ref.taskId && task.kind === "agent" && task.execution.kind === "settled",
					),
			);
			const resumed = host
				.taskRecords()
				.find((task) => task.ref.taskId !== child.ref.taskId && task.kind === "agent");
			assert.ok(resumed);
			assert.equal(resumed.execution.kind, "settled");
			if (resumed.execution.kind === "settled") {
				assert.equal(resumed.execution.result.kind, "completed", JSON.stringify(resumed.execution.result));
			}
			assert.equal((await taskSource().taskDetailText(resumed.ref.taskId)).output, "the resumed child answered");
		} finally {
			await session?.dispose();
			await boundary.close();
			faux.unregister();
			vi.unstubAllEnvs();
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	REAL_SUBAGENT_RELOAD_TIMEOUT_MS,
);
