import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AuthStorage, ReadOnlyAuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import {
	clearConfigValueCache,
	resolveConfigValueOrThrow,
} from "../../packages/coding-agent/src/core/resolve-config-value.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { WorkflowToolArgs } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { routeWorkflowLaunch } from "../../packages/workflows/src/extension/workflow-router.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { registerWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool-registration.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { type JevFixtureRequest, jevFixtureResponse } from "../helpers/jev-tournament.js";
import { workflowRouterContext, workflowRouterState } from "../helpers/workflow-router.js";

const jevNone = async (_url: string, init: RequestInit) =>
	Response.json(
		jevFixtureResponse(
			JSON.parse(String(init.body)) as JevFixtureRequest,
			(_keys, id) =>
				({
					workflow: "none",
					duration: "15min",
					budget: "preserve",
					interaction: "executable",
					complexity: "workflow_beneficial",
					preference: "unspecified",
				})[id]!,
		),
	);

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execSync: vi.fn(() => {
		throw new Error("Unexpected credential command");
	}),
	spawnSync: vi.fn(() => {
		throw new Error("Unexpected credential command");
	}),
}));
beforeEach(() => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
});
afterEach(() => {
	setDurableBackend(undefined);
	clearConfigValueCache();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function fixture(description = "Review authorization handling") {
	const definition = workflow({
		name: "credential-contract",
		description,
		inputs: { authorization: Type.String(), nested: Type.Object({ secret: Type.String() }) },
		outputs: {},
		run: async () => ({}),
	});
	const other = workflow({
		name: "other",
		description: "Another candidate",
		inputs: {},
		outputs: {},
		run: async () => ({}),
	});
	const registry = createRegistry().register(definition).register(other);
	const runtime = createExtensionRuntime({ registry, store: createStore(), jobs: createJobTracker() });
	const ctx = workflowRouterContext("none");
	const infer = vi.spyOn(ctx.modelRegistry!, "streamSimple");
	const args = { workflow: definition.name, inputs: {}, state: workflowRouterState() };
	return {
		definition,
		other,
		ctx,
		infer,
		args,
		route: (input = args) => routeWorkflowLaunch(input, ctx, () => runtime),
	};
}

test("credential-named schema properties preserve every candidate and complete contract", async () => {
	const f = fixture();
	const result = await f.route();
	assert.equal(result.decision.workflowType, "none");
	const context = f.infer.mock.calls[0]![1];
	const { questions } = JSON.parse(context.messages[0]!.content as string);
	assert.deepEqual(Object.keys(questions.workflow.criteria), [
		"none",
		f.definition.normalizedName,
		f.other.normalizedName,
	]);
	assert.deepEqual(
		JSON.parse(questions.workflow.criteria[f.definition.normalizedName]).inputs,
		JSON.parse(JSON.stringify(f.definition.inputs)),
	);
});

test("supplied nested credential fields still fail before inference", async () => {
	const f = fixture();
	await assert.rejects(f.route({ ...f.args, inputs: { nested: { secret: "do-not-send" } } }), /credential field/);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("known credential text in contract metadata still fails before inference", async () => {
	const f = fixture("Do not send Bearer abcdefghijklmnop");
	await assert.rejects(f.route(), /credential-like text/);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("known credential text in task documents still fails before inference", async () => {
	const f = fixture();
	f.args.state.documents[0]!.content = "Bearer abcdefghijklmnop";
	await assert.rejects(f.route(), /credential-like text/);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("TypeSafe none preserves exact budget limits alongside credential-named contracts", async () => {
	const f = fixture();
	const budget = { maxTokens: 0, maxCost: 0.123456789, warnAtPercent: 12.345 };
	f.ctx.getRouterModel = () => "typesafe-ai/jev-latest";
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const transport = vi.fn(jevNone);
	vi.stubGlobal("fetch", transport);
	const result = await f.route({ ...f.args, state: workflowRouterState(budget) });
	assert.deepEqual(result.decision, { estimatedDuration: "15min", workflowType: "none", maxBudget: budget });
	assert.equal(transport.mock.calls.length, 1);
	assert.equal(f.infer.mock.calls.length, 0);
});

function registeredFixture(metadata?: { field: string; text: string }) {
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const admissions = vi.spyOn(backend, "registerWorkflow");
	const body = vi.fn(async () => ({ result: "Applied" }));
	const text = metadata?.text ?? "Safe contract";
	const definition = workflow({
		name: metadata?.field === "registry name" ? text : "approved-change",
		description: metadata?.field === "registry description" ? text : "Approved changes",
		inputs: {
			task: Type.String(),
			...(metadata?.field === "registry input key" ? { [text]: Type.String() } : {}),
			option: Type.Optional(Type.String({ default: metadata?.field === "registry default" ? text : "safe" })),
		},
		outputs: { result: Type.String({ description: metadata?.field === "registry output" ? text : "Result" }) },
		run: async (ctx) => ctx.tool("apply", {}, body),
	});
	const store = createStore();
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({ registry: createRegistry().register(definition), store, jobs });
	const execute = makeExecuteWorkflowTool(
		() => runtime,
		() => undefined,
	);
	const tool = registerWorkflowTool({ registerTool: () => {} }, execute, async (_policy, run) => run())!;
	const ctx = workflowRouterContext("none");
	const infer = vi.spyOn(ctx.modelRegistry!, "streamSimple");
	const transport = vi.fn(jevNone);
	vi.stubGlobal("fetch", transport);
	const args: WorkflowToolArgs = {
		action: "route",
		workflow: definition.name,
		inputs: { task: "Approved work" },
		state: workflowRouterState(),
	};
	return {
		args,
		ctx,
		infer,
		transport,
		call: () => tool.execute("credential-check", args, undefined, undefined, ctx),
		noLaunch: () => {
			assert.equal(admissions.mock.calls.length, 0);
			assert.equal(body.mock.calls.length, 0);
			assert.equal(store.runs().length, 0);
			assert.equal(jobs.runIds().length, 0);
		},
	};
}

const locations = [
	"literal request",
	"additional constraint",
	"conversation",
	"constraint",
	"document source",
	"document content",
	"budget provenance",
	"input value",
	"input key",
	"registry name",
	"registry description",
	"registry input key",
	"registry default",
	"registry output",
] as const;

// #3089: opaque configured keys must never reach either provider through the registered tool.
for (const action of ["route"] as const) {
	for (const provider of ["ordinary", "jev"] as const) {
		for (const [kind, key, envName] of [
			["opaque", "opaque-round-two-3089", "TYPESAFE_API_KEY"],
			["escaped", 'opaque-"quote"-\\slash-\nline-\ttab', "TYPESAFE_API_KEY"],
			["openai", "opaque-openai-repair-3089", "OPENAI_API_KEY"],
		] as const) {
			for (const location of locations) {
				test(`rejects ${kind} key in ${location} (${action ?? "default"}, ${provider})`, async () => {
					vi.stubEnv("TYPESAFE_API_KEY", "synthetic-jev-auth");
					vi.stubEnv(envName, key);
					const text = `Context ${key} end`;
					const f = registeredFixture({ field: location, text });
					f.args.action = action;
					f.ctx.getRouterModel = () => (provider === "jev" ? "typesafe-ai/jev-latest" : "decision-test/chat");
					const state = f.args.state!;
					switch (location) {
						case "literal request":
							state.task = text;
							break;
						case "additional constraint":
							state.constraints!.push(text);
							break;
						case "conversation":
							state.conversation![0]!.text = text;
							break;
						case "constraint":
							state.constraints!.push(text);
							break;
						case "document source":
							state.documents![0]!.source = text;
							break;
						case "document content":
							state.documents![0]!.content = text;
							break;
						case "budget provenance":
							state.userBudget = { limits: {}, provenance: text };
							break;
						case "input value":
							f.args.inputs = { task: "Approved", nested: [{ note: text }] };
							break;
						case "input key":
							f.args.inputs = { task: "Approved", nested: [{ [text]: "value" }] };
							break;
					}
					const result = await f.call();
					assert.equal(f.infer.mock.calls.length, 0, "ordinary inference must not receive the snapshot");
					assert.equal(f.transport.mock.calls.length, 0, "Jev inference must not receive the snapshot");
					f.noLaunch();
					assert.ok("status" in result.details);
					assert.equal(result.details.status, "failed");
					assert.match("error" in result.details ? (result.details.error ?? "") : "", /credential/);
					const diagnostic = JSON.stringify(result);
					assert.equal(diagnostic.includes(key), false);
					assert.equal(diagnostic.includes(JSON.stringify(key).slice(1, -1)), false);
				});
			}
		}
		for (const [kind, key] of [
			["unset", undefined],
			["empty", ""],
			["whitespace", "   "],
			["configured", "opaque-safe-3089"],
		] as const) {
			if (provider === "jev" && kind !== "configured") continue; // Jev itself requires authentication.
			test(`safe context routes with ${kind} key (${action ?? "default"}, ${provider})`, async () => {
				vi.stubEnv("TYPESAFE_API_KEY", key);
				const f = registeredFixture();
				f.args.action = action;
				f.ctx.getRouterModel = () => (provider === "jev" ? "typesafe-ai/jev-latest" : "decision-test/chat");
				const result = await f.call();
				assert.ok("status" in result.details);
				assert.equal(result.details.status, "not_launched");
				assert.ok("routerDecision" in result.details);
				assert.deepEqual(result.details.routerDecision, {
					estimatedDuration: "15min",
					workflowType: "none",
					maxBudget: {},
				});
				assert.equal(f.infer.mock.calls.length, provider === "ordinary" ? 1 : 0);
				assert.equal(f.transport.mock.calls.length, provider === "jev" ? 1 : 0);
				f.noLaunch();
			});
		}
	}
}

for (const provider of ["ordinary", "jev"] as const) {
	for (const source of [
		"stored key",
		"stored env",
		"oauth access",
		"oauth refresh",
		"runtime override",
		"models key",
		"models header",
		"models bearer token",
		"model header",
		"extension key",
		"extension header",
	] as const) {
		test(`registered ${provider} rejects ${source} without resolving auth`, async () => {
			const key = 'synthetic-opaque-"auth"-\\value';
			vi.stubEnv("TYPESAFE_API_KEY", "synthetic-jev-auth");
			const command = vi.mocked(childProcess.execSync);
			const spawn = vi.mocked(childProcess.spawnSync);
			command.mockClear();
			spawn.mockClear();
			const credentials = AuthStorage.inMemory({
				custom:
					source === "stored key"
						? { type: "api_key", key: key.replaceAll("$", "$$") }
						: source === "stored env"
							? { type: "api_key", key: "$CUSTOM_ROUTER_AUTH", env: { CUSTOM_ROUTER_AUTH: key } }
							: {
									type: "oauth",
									access: source === "oauth access" ? key : "synthetic-access",
									refresh: source === "oauth refresh" ? key : "synthetic-refresh",
									expires: 0,
								},
			});
			const directory = mkdtempSync(join(tmpdir(), "router-credentials-"));
			try {
				const modelsPath = join(directory, "models.json");
				writeFileSync(
					modelsPath,
					JSON.stringify({
						providers: {
							openai: {
								apiKey: source === "models key" ? key : "!never-execute-credential-command",
								headers: {
									"x-api-key":
										source === "models header"
											? key
											: source === "models bearer token"
												? `Bearer ${key}`
												: "!never-execute-header-command",
								},
								modelOverrides: {
									"gpt-4o": {
										headers: { "x-auth-token": source === "model header" ? key : "synthetic-header" },
									},
								},
							},
						},
					}),
				);
				const runtime = await ModelRuntime.create({
					credentials,
					modelsPath,
					refreshOnCreate: false,
					allowModelNetwork: false,
				});
				runtime.registerProvider("openai", {
					apiKey: source === "extension key" ? key : "!never-execute-extension-command",
					headers: { "x-api-key": source === "extension header" ? key : "synthetic-extension-header" },
				});
				if (source === "runtime override") await runtime.setRuntimeApiKey("custom", key, {});
				const auth = vi.spyOn(runtime, "getAuth");
				const read = vi.spyOn(credentials, "read");
				const registry = new ModelRegistry(runtime);
				const f = registeredFixture();
				f.ctx.modelRegistry!.containsConfiguredCredential = registry.containsConfiguredCredential.bind(registry);
				f.ctx.getRouterModel = () => (provider === "jev" ? "typesafe-ai/jev-latest" : "decision-test/chat");
				f.args.state!.conversation![0]!.text = `Context ${key} end`;
				const result = await f.call();
				assert.equal(f.infer.mock.calls.length, 0);
				assert.equal(f.transport.mock.calls.length, 0);
				assert.equal(auth.mock.calls.length, 0);
				assert.equal(read.mock.calls.length, 0);
				assert.equal(command.mock.calls.length, 0);
				assert.equal(spawn.mock.calls.length, 0);
				f.noLaunch();
				assert.ok("error" in result.details);
				assert.match(result.details.error ?? "", /configured credential/);
				assert.equal(JSON.stringify(result).includes(JSON.stringify(key).slice(1, -1)), false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
}

test("safe OAuth metadata routes without refreshing tokens or executing credential commands", async () => {
	const command = vi.mocked(childProcess.execSync);
	const spawn = vi.mocked(childProcess.spawnSync);
	command.mockClear();
	spawn.mockClear();
	const credentials = AuthStorage.inMemory({
		custom: {
			type: "oauth",
			access: "synthetic-access",
			refresh: "synthetic-refresh",
			expires: 0,
			accountId: "known-account",
			email: "user@example.test",
		},
		command: { type: "api_key", key: "!never-execute-secret-command" },
	});
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const auth = vi.spyOn(runtime, "getAuth");
	const registry = new ModelRegistry(runtime);
	const f = registeredFixture();
	f.ctx.modelRegistry!.containsConfiguredCredential = registry.containsConfiguredCredential.bind(registry);
	f.args.state!.conversation![0]!.text = "Review known-account for user@example.test";
	const result = await f.call();
	assert.equal(f.infer.mock.calls.length, 1);
	assert.equal(f.transport.mock.calls.length, 0);
	assert.ok("routerDecision" in result.details);
	assert.deepEqual(result.details.routerDecision, {
		estimatedDuration: "15min",
		workflowType: "none",
		maxBudget: {},
	});
	assert.equal(auth.mock.calls.length, 0);
	assert.equal(command.mock.calls.length, 0);
	assert.equal(spawn.mock.calls.length, 0);
	f.noLaunch();
});

test("previously resolved command credentials are excluded without executing again", async () => {
	const key = "synthetic-command-output";
	const command = vi.mocked(childProcess.execSync).mockReturnValueOnce(key);
	assert.equal(resolveConfigValueOrThrow("!synthetic-command", "test key"), key);
	command.mockClear();
	const credentials = AuthStorage.inMemory({ custom: { type: "api_key", key: "!synthetic-command" } });
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const registry = new ModelRegistry(runtime);
	const f = registeredFixture();
	f.ctx.modelRegistry!.containsConfiguredCredential = registry.containsConfiguredCredential.bind(registry);
	f.args.state!.task = `Review ${key}`;
	const result = await f.call();
	assert.equal(f.infer.mock.calls.length, 0);
	assert.equal(f.transport.mock.calls.length, 0);
	assert.ok("error" in result.details);
	assert.match(result.details.error ?? "", /configured credential/);
	assert.equal(command.mock.calls.length, 0);
	f.noLaunch();
});

test("credential storage failures stop routing without exposing their diagnostics", async () => {
	const f = registeredFixture();
	f.ctx.modelRegistry!.containsConfiguredCredential = async () => {
		throw new Error("synthetic-sensitive-store-diagnostic");
	};
	const result = await f.call();
	assert.equal(f.infer.mock.calls.length, 0);
	assert.equal(f.transport.mock.calls.length, 0);
	assert.ok("error" in result.details);
	assert.match(result.details.error ?? "", /could not check configured credentials/);
	assert.equal(JSON.stringify(result).includes("synthetic-sensitive-store-diagnostic"), false);
	f.noLaunch();
});

test("read-only auth storage screens raw credentials without executing commands", async () => {
	const directory = mkdtempSync(join(tmpdir(), "router-readonly-auth-"));
	const command = vi.mocked(childProcess.execSync);
	command.mockClear();
	try {
		const authPath = join(directory, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				command: { type: "api_key", key: "!never-execute-credential-command" },
				literal: { type: "api_key", key: "synthetic-readonly-key" },
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: new ReadOnlyAuthStorage(authPath),
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		assert.equal(await registry.containsConfiguredCredential(JSON.stringify({ text: "Safe context" })), false);
		assert.equal(
			await registry.containsConfiguredCredential(JSON.stringify({ text: "synthetic-readonly-key" })),
			true,
		);
		assert.equal(command.mock.calls.length, 0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
