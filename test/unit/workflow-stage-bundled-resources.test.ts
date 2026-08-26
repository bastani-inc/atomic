/// <reference path="../../packages/coding-agent/src/utils/highlight-js-lib-index.d.ts" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ProviderHeaders,
} from "@bastani/pi-ai";
import { getModel } from "@bastani/pi-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { getBuiltinPackagePaths } from "../../packages/coding-agent/src/core/builtin-packages.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { type PackageSource, SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { discoverAgentsAll } from "../../packages/subagents/src/agents/agents.js";
import type { Details } from "../../packages/subagents/src/shared/types.js";
import {
	type PiCodingAgentSdk,
	type PiSdkResourceLoader,
	type PiSdkSettingsManager,
	prepareAtomicStageSessionOptions,
} from "../../packages/workflows/src/extension/wiring.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";

const REAL_WORKFLOW_STAGE_RESOURCE_TIMEOUT_MS = 120_000;
const tempDirs: string[] = [];
const ENV_KEYS = [
	"ATOMIC_SUBAGENT_CHILD",
	"ATOMIC_SUBAGENT_FANOUT_CHILD",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_FANOUT_CHILD",
	"ATOMIC_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
] as const;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function snapshotEnv(): Map<string, string | undefined> {
	return new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: ReadonlyMap<string, string | undefined>): void {
	for (const key of ENV_KEYS) {
		const value = snapshot.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

class StageDefaultResourceLoader extends DefaultResourceLoader implements PiSdkResourceLoader {
	constructor(options: {
		readonly cwd: string;
		readonly agentDir: string;
		readonly settingsManager?: PiSdkSettingsManager;
		readonly builtinPackagePaths?: PackageSource[];
	}) {
		super({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager: options.settingsManager as SettingsManager | undefined,
			builtinPackagePaths: options.builtinPackagePaths,
		});
	}
}

function makeSdk(agentDir: string): PiCodingAgentSdk {
	return {
		getAgentDir: () => agentDir,
		getBuiltinPackagePaths,
		SettingsManager,
		DefaultResourceLoader: StageDefaultResourceLoader,
		async createAgentSession(options) {
			const result = await createAgentSession(options as CreateAgentSessionOptions);
			return { session: result.session as unknown as StageSessionRuntime };
		},
	};
}

async function createWorkflowStageSession(options: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly tools?: readonly string[];
	readonly noTools?: CreateAgentSessionOptions["noTools"];
	readonly excludedTools?: readonly string[];
	readonly model?: Model<Api>;
	readonly modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
}) {
	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	assert.notEqual(model, undefined);
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
	const orchestrationContext = {
		kind: "workflow-stage",
		workflowRunId: "run-test",
		workflowStageId: "stage-test",
		workflowStageName: "Stage Test",
		intercomGroup: `workflow-test:${randomUUID()}`,
		constraints: {
			disableWorkflowTool: true,
		},
	} satisfies CreateAgentSessionOptions["orchestrationContext"];
	const excludedTools = Array.from(new Set([...(options.excludedTools ?? []), "workflow"]));
	const sessionOptions = await prepareAtomicStageSessionOptions(
		{
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager,
			...(options.tools === undefined ? {} : { tools: [...options.tools] }),
			...(options.noTools === undefined ? {} : { noTools: options.noTools }),
			excludedTools,
			model: model!,
			...(options.modelRuntime === undefined ? {} : { modelRuntime: options.modelRuntime }),
			orchestrationContext,
		},
		makeSdk(options.agentDir),
	);
	if (sessionOptions === undefined) {
		throw new Error("prepareAtomicStageSessionOptions returned undefined.");
	}
	if (sessionOptions.resourceLoader === undefined) {
		throw new Error("prepareAtomicStageSessionOptions did not create a resource loader.");
	}

	return createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		resourceLoader: sessionOptions.resourceLoader as DefaultResourceLoader,
		...(options.tools === undefined ? {} : { tools: [...options.tools] }),
		...(options.noTools === undefined ? {} : { noTools: options.noTools }),
		excludedTools,
		orchestrationContext,
		subagentPolicy: sessionOptions.subagentPolicy,
		sessionManager: SessionManager.inMemory(options.cwd),
		model: model!,
		...(sessionOptions.modelRuntime === undefined ? {} : { modelRuntime: sessionOptions.modelRuntime }),
	});
}

const CREDENTIAL_ENDPOINT = "https://credential.example/v1";
const CREDENTIAL_HEADERS: ProviderHeaders = { Authorization: null, "x-credential": "present" };

type CapturedRequest = {
	baseUrl: string | undefined;
	headers: ProviderHeaders | undefined;
};

function endpointProbeModel(provider: string): Model<Api> {
	return {
		id: "credential-endpoint-probe",
		name: "Credential endpoint probe",
		api: "openai-completions",
		provider,
		baseUrl: "https://catalog.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function completedStream(model: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.end(message);
	return stream;
}

function assertCredentialRequest(request: CapturedRequest | undefined): void {
	assert.ok(request, "expected a workflow-stage model request");
	assert.equal(request.baseUrl, CREDENTIAL_ENDPOINT);
	assert.equal(request.headers?.Authorization, null);
	assert.equal(request.headers?.["x-credential"], "present");
	assert.equal(Object.hasOwn(request.headers ?? {}, "Authorization"), true);
}

describe("workflow stage bundled resources", () => {
	test("discovers bundled subagent definitions from the packaged repo", () => {
		const snapshot = snapshotEnv();
		const cwd = tempDir("atomic-workflow-stage-agents-cwd-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		try {
			process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
			delete process.env.PI_CODING_AGENT_DIR;

			const builtinAgents = discoverAgentsAll(cwd).builtin;
			const builtinNames = new Set(builtinAgents.map((agent) => agent.name));
			for (const name of [
				"code-simplifier",
				"codebase-analyzer",
				"codebase-locator",
				"codebase-online-researcher",
				"codebase-pattern-finder",
				"codebase-research-analyzer",
				"codebase-research-locator",
				"debugger",
				"worker",
			]) {
				assert.ok(builtinNames.has(name), `expected bundled subagent ${name}`);
			}
			const debuggerAgent = builtinAgents.find((agent) => agent.name === "debugger");
			const workerAgent = builtinAgents.find((agent) => agent.name === "worker");
			assert.ok(debuggerAgent, "expected bundled debugger definition");
			assert.ok(workerAgent, "expected bundled worker definition");
			assert.deepEqual(debuggerAgent.tools, workerAgent.tools);
			assert.ok(debuggerAgent.tools?.includes("edit"));
			assert.ok(debuggerAgent.tools?.includes("write"));
			assert.match(debuggerAgent.systemPrompt, /apply the smallest in-scope fix with `edit` or `write`/i);
		} finally {
			restoreEnv(snapshot);
		}
	});

	test(
		"keeps bundled subagent active by default in workflow stages",
		async () => {
			const snapshot = snapshotEnv();
			const cwd = tempDir("atomic-workflow-stage-default-subagent-cwd-");
			const agentDir = join(cwd, "agent");
			mkdirSync(agentDir, { recursive: true });
			try {
				const { session } = await createWorkflowStageSession({ cwd, agentDir });
				try {
					const allToolNames = session.getAllTools().map((tool) => tool.name);
					const activeToolNames = session.getActiveToolNames();
					assert.ok(allToolNames.includes("subagent"), "expected subagent in all workflow stage tools");
					assert.ok(activeToolNames.includes("subagent"), "expected subagent to be active by default");
				} finally {
					session.dispose();
				}
			} finally {
				restoreEnv(snapshot);
			}
		},
		REAL_WORKFLOW_STAGE_RESOURCE_TIMEOUT_MS,
	);

	test(
		"dispatches workflow-stage requests to the credential endpoint without dropping null headers",
		async () => {
			const cwd = tempDir("atomic-workflow-stage-endpoint-cwd-");
			const agentDir = join(cwd, "agent");
			mkdirSync(agentDir, { recursive: true });
			const model = endpointProbeModel("workflow-endpoint-probe");
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const requests: CapturedRequest[] = [];
			modelRuntime.registerProvider(model.provider, {
				api: model.api,
				apiKey: "test-key",
				baseUrl: model.baseUrl,
				streamSimple: (requestModel, _context, streamOptions) => {
					requests.push({ baseUrl: requestModel.baseUrl, headers: streamOptions?.headers });
					return completedStream(requestModel);
				},
			});
			vi.spyOn(modelRuntime, "getAuth").mockResolvedValue({
				auth: { apiKey: "credential-key", baseUrl: CREDENTIAL_ENDPOINT, headers: CREDENTIAL_HEADERS },
			});

			try {
				const { session } = await createWorkflowStageSession({ cwd, agentDir, model, modelRuntime });
				try {
					const stream = await session.agent.streamFunction(model, { messages: [] });
					await stream.result();
					assertCredentialRequest(requests[0]);
				} finally {
					session.dispose();
				}
			} finally {
				modelRuntime.unregisterProvider(model.provider);
				vi.restoreAllMocks();
			}
		},
		REAL_WORKFLOW_STAGE_RESOURCE_TIMEOUT_MS,
	);

	test("delegates through the registered subagent tool from a workflow stage", async () => {
		const snapshot = snapshotEnv();
		const cwd = tempDir("atomic-workflow-stage-delegation-cwd-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		try {
			const { session } = await createWorkflowStageSession({ cwd, agentDir });
			try {
				await session.bindExtensions({});
				const tool = session.getToolDefinition("subagent");
				assert.ok(tool, "workflow stages must register the subagent tool");
				const result = await tool.execute(
					"stage-delegation",
					{ agent: "worker", task: "complete this test task", context: "fresh" } as never,
					undefined,
					undefined,
					session.extensionRunner.createContext(),
				);
				const details = result.details as Details;
				assert.ok(
					details.results.some((child) => child.envelope?.includes("done") === true),
					"the stage tool must return the in-process child result",
				);
			} finally {
				session.dispose();
			}
		} finally {
			restoreEnv(snapshot);
		}
	});

	test("keeps explicit workflow stage tool allowlists authoritative", async () => {
		const cwd = tempDir("atomic-workflow-stage-explicit-tools-cwd-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });

		const { session } = await createWorkflowStageSession({
			cwd,
			agentDir,
			tools: ["read"],
		});
		try {
			assert.deepEqual(
				session.getAllTools().map((tool) => tool.name),
				["read"],
			);
			assert.deepEqual(session.getActiveToolNames(), ["read"]);
		} finally {
			session.dispose();
		}
	});

	test("keeps excluded subagent unavailable even though it is a workflow default", async () => {
		const cwd = tempDir("atomic-workflow-stage-exclude-subagent-cwd-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });

		const { session } = await createWorkflowStageSession({
			cwd,
			agentDir,
			excludedTools: ["subagent"],
		});
		try {
			const allToolNames = session.getAllTools().map((tool) => tool.name);
			const activeToolNames = session.getActiveToolNames();
			assert.equal(allToolNames.includes("subagent"), false);
			assert.equal(activeToolNames.includes("subagent"), false);
		} finally {
			session.dispose();
		}
	});

	test("honors noTools all over workflow default subagent", async () => {
		const cwd = tempDir("atomic-workflow-stage-no-tools-cwd-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });

		const { session } = await createWorkflowStageSession({
			cwd,
			agentDir,
			noTools: "all",
		});
		try {
			assert.deepEqual(
				session.getAllTools().map((tool) => tool.name),
				[],
			);
			assert.deepEqual(session.getActiveToolNames(), []);
		} finally {
			session.dispose();
		}
	});

	test("keeps explicitly allowlisted bundled subagent tool in workflow stages launched by subagents", async () => {
		const snapshot = snapshotEnv();
		const cwd = tempDir("atomic-workflow-stage-subagent-tool-cwd-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		try {
			const { session } = await createWorkflowStageSession({
				cwd,
				agentDir,
				tools: ["subagent"],
			});
			try {
				assert.deepEqual(
					session.getAllTools().map((tool) => tool.name),
					["subagent"],
				);
				assert.deepEqual(session.getActiveToolNames(), ["subagent"]);
			} finally {
				session.dispose();
			}
		} finally {
			restoreEnv(snapshot);
		}
	});

	test("keeps explicitly allowlisted bundled extension tools visible", async () => {
		const cwd = tempDir("atomic-workflow-stage-extension-tools-cwd-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });

		const { session } = await createWorkflowStageSession({
			cwd,
			agentDir,
			tools: ["web_search", "fetch_content", "intercom"],
		});
		try {
			const allToolNames = session
				.getAllTools()
				.map((tool) => tool.name)
				.sort();
			const activeToolNames = session.getActiveToolNames().sort();
			assert.deepEqual(allToolNames, ["fetch_content", "intercom", "web_search"]);
			assert.deepEqual(activeToolNames, ["fetch_content", "intercom", "web_search"]);
		} finally {
			session.dispose();
		}
	});
});
