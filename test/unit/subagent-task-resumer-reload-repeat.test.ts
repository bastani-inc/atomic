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
	"a finished subagent chat that resumed its child once resumes it again after a reload (#5246)",
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
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			builtinPackagePaths: [],
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [registerSubagentExtension],
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
			const evidence: Record<string, unknown> = {};
			const beforeReload = taskSource();
			assert.ok(beforeReload.taskReadOnlyReason);
			assert.ok(beforeReload.sendTaskMessage);
			evidence.t1BeforeResume = beforeReload.taskReadOnlyReason(child.ref.taskId) ?? null;
			faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("the first resume answered")));
			await beforeReload.sendTaskMessage(child.ref.taskId, "First resume from this chat.");
			const agentTasks = () => host.taskRecords().filter((task) => task.kind === "agent");
			await until(() => agentTasks().length >= 2 && agentTasks().every((task) => task.execution.kind === "settled"));
			const second = agentTasks().find((task) => task.ref.taskId !== child.ref.taskId);
			assert.ok(second);
			await until(() => !session!.isStreaming);
			evidence.t1AfterResumeBeforeReload = taskSource().taskReadOnlyReason!(child.ref.taskId) ?? null;
			evidence.t2BeforeReload = taskSource().taskReadOnlyReason!(second.ref.taskId) ?? null;
			await session.reload();
			const source = taskSource();
			evidence.t1KeptAfterReload = source.taskReadOnlyReason!(child.ref.taskId) ?? null;
			evidence.t2AfterReload = source.taskReadOnlyReason!(second.ref.taskId) ?? null;
			faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("the second resume answered")));
			try {
				await source.sendTaskMessage!(child.ref.taskId, "Second resume from the first chat.");
				await until(
					() => agentTasks().length >= 3 && agentTasks().every((task) => task.execution.kind === "settled"),
				);
				evidence.secondResume = "resumed";
			} catch (error) {
				evidence.secondResume = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			}
			assert.equal(evidence.t1AfterResumeBeforeReload, null, "the chat that resumed the child stays writable");
			assert.equal(evidence.t1KeptAfterReload, null, "and stays writable after a reload");
			assert.equal(evidence.secondResume, "resumed");
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
