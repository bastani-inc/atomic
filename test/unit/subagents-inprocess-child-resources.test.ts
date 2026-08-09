/// <reference path="../../packages/coding-agent/src/utils/highlight-js-lib-index.d.ts" />

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { SubagentChildPolicy } from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { inProcessChildResourceLoaderOptions } from "../../packages/subagents/src/runs/inprocess/runner.js";
import { MAX_SUBAGENT_NESTING_DEPTH } from "../../packages/subagents/src/shared/types.js";

const tempDirs: string[] = [];

/**
 * Structural cost, not a slow test: every case performs a full builtin-package
 * loader reload and creates a real agent session from the result. Do not reuse
 * this budget for a test that merely inspects data.
 */
const CHILD_SESSION_RELOAD_TIMEOUT_MS = 120_000;

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

function childAgent(): AgentConfig {
	return {
		name: "worker",
		description: "worker agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/worker.md",
	};
}

const stageContext = {
	kind: "workflow-stage",
	workflowRunId: "run-test",
	workflowStageId: "stage-test",
	workflowStageName: "Stage Test",
	constraints: { disableWorkflowTool: true, maxSubagentDepth: 5 },
} as const;

/** Create a child session the way the in-process runner does. */
async function createChildSession(options: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly orchestrationContext?: typeof stageContext;
	/** Drop the bundled package roots, reproducing the pre-fix child loader. */
	readonly withoutBundledPackages?: boolean;
	readonly policy?: Partial<SubagentChildPolicy>;
	readonly model?: Model<Api>;
	readonly modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
}) {
	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	assert.notEqual(model, undefined);
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
	const loaderOptions = inProcessChildResourceLoaderOptions({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		agent: childAgent(),
		orchestrationContext: options.orchestrationContext,
	});
	const resourceLoader = new DefaultResourceLoader(
		options.withoutBundledPackages ? { ...loaderOptions, builtinPackagePaths: [] } : loaderOptions,
	);
	await resourceLoader.reload();
	return createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(options.cwd),
		model: model!,
		...(options.modelRuntime === undefined ? {} : { modelRuntime: options.modelRuntime }),
		...(options.orchestrationContext ? { orchestrationContext: options.orchestrationContext } : {}),
		subagentPolicy: {
			managementActions: "full",
			fanoutAuthorized: true,
			inheritProjectContext: false,
			inheritSkills: false,
			depth: 1,
			...options.policy,
		},
	});
}

function sessionCwd(prefix: string): { cwd: string; agentDir: string } {
	const cwd = tempDir(prefix);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	return { cwd, agentDir };
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
	assert.ok(request, "expected an in-process child model request");
	assert.equal(request.baseUrl, CREDENTIAL_ENDPOINT);
	assert.equal(request.headers?.Authorization, null);
	assert.equal(request.headers?.["x-credential"], "present");
	assert.equal(Object.hasOwn(request.headers ?? {}, "Authorization"), true);
}

const REQUIRED_BUNDLED_TOOLS = ["subagent", "web_search", "fetch_content", "intercom"] as const;

describe("in-process child session resources", () => {
	test(
		"a child session registers every required bundled tool",
		async () => {
			const { cwd, agentDir } = sessionCwd("atomic-inprocess-child-tools-cwd-");
			const { session } = await createChildSession({ cwd, agentDir });
			try {
				const toolNames = session.getAllTools().map((tool) => tool.name);
				for (const bundled of REQUIRED_BUNDLED_TOOLS) {
					assert.ok(
						toolNames.includes(bundled),
						`expected the bundled '${bundled}' tool, got: ${toolNames.join(", ")}`,
					);
				}
			} finally {
				session.dispose();
			}
		},
		CHILD_SESSION_RELOAD_TIMEOUT_MS,
	);

	test(
		"dispatches in-process child requests to the credential endpoint without dropping null headers",
		async () => {
			const { cwd, agentDir } = sessionCwd("atomic-inprocess-child-endpoint-cwd-");
			const model = endpointProbeModel("subagent-endpoint-probe");
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
				const { session } = await createChildSession({ cwd, agentDir, model, modelRuntime });
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
		CHILD_SESSION_RELOAD_TIMEOUT_MS,
	);

	test(
		"a non-fanout child still registers the subagent tool but is refused delegation by policy",
		async () => {
			const { cwd, agentDir } = sessionCwd("atomic-inprocess-child-nonfanout-cwd-");
			// resolveChildModePolicy grants fanout only when the admitted tool
			// allowlist names `subagent`; an omitted allowlist still registers the
			// bundled tool through normal discovery. Registration is not authority.
			const { session } = await createChildSession({
				cwd,
				agentDir,
				policy: { managementActions: "restricted", fanoutAuthorized: false },
			});
			try {
				const tool = session.getToolDefinition("subagent");
				assert.ok(tool, "a non-fanout child still receives the registered subagent tool");

				const delegated = await tool.execute(
					"non-fanout-delegation",
					{ agent: "worker", task: "delegate one level further", context: "fresh" } as never,
					new AbortController().signal,
					undefined,
					session.extensionRunner.createContext(),
				);
				assert.equal(
					delegated.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
					"Subagent fanout is not authorized for this child.",
				);

				const listed = await tool.execute(
					"non-fanout-list",
					{ action: "list" } as never,
					new AbortController().signal,
					undefined,
					session.extensionRunner.createContext(),
				);
				assert.ok(
					!listed.content
						.map((part) => (part.type === "text" ? part.text : ""))
						.join("\n")
						.includes("Subagent fanout is not authorized"),
					"the observing `list` action stays available to a non-fanout child",
				);
			} finally {
				session.dispose();
			}
		},
		CHILD_SESSION_RELOAD_TIMEOUT_MS,
	);

	test(
		"a child whose agent tightened the maximum is refused delegation by its own subagent tool",
		async () => {
			assert.equal(MAX_SUBAGENT_NESTING_DEPTH, 5);
			const { cwd, agentDir } = sessionCwd("atomic-inprocess-child-inherited-max-cwd-");
			const { session } = await createChildSession({
				cwd,
				agentDir,
				policy: { depth: 1, maxSubagentDepth: 1 },
			});
			try {
				const tool = session.getToolDefinition("subagent");
				assert.ok(tool, "the child must register the bundled subagent tool");
				const result = await tool.execute(
					"inherited-max",
					{ agent: "worker", task: "delegate one level further", context: "fresh" } as never,
					new AbortController().signal,
					undefined,
					session.extensionRunner.createContext(),
				);
				const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

				assert.ok(text.startsWith("Nested subagent call blocked (depth=1, max=1)"), `unexpected message: ${text}`);
			} finally {
				session.dispose();
			}
		},
		CHILD_SESSION_RELOAD_TIMEOUT_MS,
	);

	test(
		"a child of a workflow stage registers every required bundled tool without the workflow tool",
		async () => {
			const { cwd, agentDir } = sessionCwd("atomic-inprocess-child-stage-tools-cwd-");
			const { session } = await createChildSession({ cwd, agentDir, orchestrationContext: stageContext });
			try {
				const toolNames = session.getAllTools().map((tool) => tool.name);
				for (const bundled of REQUIRED_BUNDLED_TOOLS) {
					assert.ok(
						toolNames.includes(bundled),
						`expected the bundled '${bundled}' tool, got: ${toolNames.join(", ")}`,
					);
				}
				assert.equal(
					toolNames.includes("workflow"),
					false,
					"a stage-owned child must not re-enter the workflow tool",
				);
			} finally {
				session.dispose();
			}
		},
		CHILD_SESSION_RELOAD_TIMEOUT_MS,
	);

	test(
		"dropping the bundled package roots leaves a child with no bundled tool at all",
		async () => {
			const { cwd, agentDir } = sessionCwd("atomic-inprocess-child-nobundled-cwd-");
			const { session } = await createChildSession({ cwd, agentDir, withoutBundledPackages: true });
			try {
				const toolNames = session.getAllTools().map((tool) => tool.name);
				for (const bundled of ["subagent", "web_search", "fetch_content", "intercom"]) {
					assert.equal(
						toolNames.includes(bundled),
						false,
						`expected the pre-fix loader to lose '${bundled}', got: ${toolNames.join(", ")}`,
					);
				}
			} finally {
				session.dispose();
			}
		},
		CHILD_SESSION_RELOAD_TIMEOUT_MS,
	);
});
