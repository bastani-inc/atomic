import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { test, vi } from "vitest";
import * as config from "../src/config.js";
import { AgentSession } from "../src/core/agent-session.js";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	createUnstartedAgentSessionFromServices,
} from "../src/core/agent-session-services.ts";
import { getBuiltinPackagePaths } from "../src/core/builtin-packages.ts";
import { noOpUIContext } from "../src/core/extensions/runner-ui.ts";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession, createUnstartedAgentSession } from "../src/core/sdk.ts";
import type { AtomicBuiltin, CreateAgentSessionOptions } from "../src/core/sdk-types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getDefaultToolNames } from "../src/core/tools/index.ts";
import type {
	ExtensionBindings,
	ExtensionContext,
	HostDiagnostic,
	HostInput,
	HostInputOptions,
	QuestionnaireResult,
	QuestionParams,
} from "../src/index.js";

// #3105: the ordinary SDK factory, not CLI setup, supplies Atomic's shipped capabilities.
test("default SDK creation returns an Atomic AgentSession with builtin tools and resources", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-parity-"));
	try {
		const { session, extensionsResult } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			assert.ok(session instanceof AgentSession);
			for (const name of ["workflow", "subagent", "mcp", "intercom", "web_search", "fetch_content"]) {
				assert.ok(
					session.getAllTools().some((tool) => tool.name === name),
					`missing builtin ${name}`,
				);
				assert.ok(session.getActiveToolNames().includes(name), `inactive builtin ${name}`);
			}
			assert.equal(extensionsResult.errors.length, 0);
			assert.ok(session.systemPrompt.includes("<available_skills>"));
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// Two full builtin-package loads (session creation, then `session.reload()`) are
// structural; under a loaded full-suite run they exceed the 30 s default.
const REAL_BUILTIN_RELOAD_TEST_TIMEOUT_MS = 120_000;

// #3105: custom discovery remains caller-owned while Atomic supplies its builtins.
test(
	"custom loaders retain their resources and factories while startup runs once",
	async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-custom-"));
		let starts = 0;
		const reasons: string[] = [];
		const settingsManager = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager,
			noExtensions: true,
			noContextFiles: true,
			systemPrompt: "Caller-owned prompt",
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (event) => {
						await Promise.resolve();
						starts++;
						reasons.push(event.reason);
					});
				},
			],
		});
		await loader.reload();
		const originalExtensions = [...loader.getExtensions().extensions];
		const options = Object.freeze({
			cwd,
			agentDir: join(cwd, "agent"),
			resourceLoader: loader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		try {
			const { session } = await createAgentSession(options);
			try {
				assert.equal(starts, 1);
				// #3105: mandatory composition must reuse the genuine overlay registration.
				const builtins = session.resourceLoader
					.getExtensions()
					.extensions.filter((extension) => extension.sourceInfo.configurationOrigin === "bundled");
				assert.equal(builtins.length, 5);
				assert.equal(new Set(builtins.map((extension) => extension.resolvedPath)).size, 5);
				assert.ok(session.getAllTools().some((tool) => tool.name === "workflow"));
				assert.ok(session.systemPrompt.startsWith("Caller-owned prompt"));
				assert.deepEqual(loader.getExtensions().extensions, originalExtensions);
				await Promise.all([session.bindExtensions({}), session.bindExtensions({})]);
				assert.equal(starts, 1);
				await session.reload();
				await session.bindExtensions({});
				assert.equal(
					session.resourceLoader
						.getExtensions()
						.extensions.filter((extension) => extension.sourceInfo.configurationOrigin === "bundled").length,
					5,
				);
				assert.deepEqual(reasons, ["startup", "reload"]);
			} finally {
				await session.dispose();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	},
	REAL_BUILTIN_RELOAD_TEST_TIMEOUT_MS,
);

// #3105: CLI services and the direct SDK share default composition.
test("CLI service creation supplies the same default builtin families", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-services-"));
	try {
		const services = await createAgentSessionServices({ cwd, agentDir: join(cwd, "agent") });
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		try {
			for (const name of ["workflow", "subagent", "mcp", "intercom", "web_search"])
				assert.ok(session.getActiveToolNames().includes(name), name);
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: absence is an installation error, never a bare-agent fallback.
test("missing shipped builtin assets reject with the package identity", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-missing-"));
	const packageDir = vi.spyOn(config, "getPackageDir").mockReturnValue(cwd);
	try {
		await assert.rejects(
			createAgentSession({ cwd, agentDir: join(cwd, "agent"), sessionManager: SessionManager.inMemory(cwd) }),
			(error: Error & { code?: string }) =>
				error.code === "BuiltinUnavailable" && error.message.includes("@bastani/workflows"),
		);
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
		});
		try {
			assert.equal(session.resourceLoader.getExtensions().extensions.length, 0);
			assert.ok(session.getActiveToolNames().includes("read"));
		} finally {
			await session.dispose();
		}
	} finally {
		packageDir.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: failing startup must await every acquired extension's shutdown before rejection.
test("failed startup awaits rollback and never returns a partially started session", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-rollback-"));
	const events: string[] = [];
	const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					events.push(`start:${ctx.mode}`);
					pi.registerProvider("startup-provider", {
						apiKey: "fixture",
						baseUrl: "https://example.invalid",
						api: "openai-completions",
						models: [],
					});
				});
				pi.on("session_shutdown", async () => {
					await Promise.resolve();
					events.push("released");
				});
			},
			(pi) => {
				pi.on("session_start", () => {
					throw new Error("injected startup failure");
				});
				pi.on("session_shutdown", async () => {
					await Promise.resolve();
					events.push("failed-extension-released");
				});
			},
		],
	});
	await loader.reload();
	try {
		await assert.rejects(
			createAgentSession({
				cwd,
				agentDir: join(cwd, "agent"),
				resourceLoader: loader,
				modelRuntime,
				sessionManager: SessionManager.inMemory(cwd),
				extensionBindings: { mode: "rpc" },
			}),
			/Extension startup failed/,
		);
		assert.deepEqual(events, ["start:rpc", "released", "failed-extension-released"]);
		assert.equal(modelRuntime.getRegisteredProviderConfig("startup-provider"), undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: repeated references to shipped identities do not install duplicate factories.
test("repeated shipped roots and loader identities compose once without rewriting caller arrays", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-dedup-"));
	const roots = getBuiltinPackagePaths();
	const builtinPackagePaths = [...roots, ...roots];
	const originalPaths = [...builtinPackagePaths];
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		builtinPackagePaths,
		settingsManager: SettingsManager.inMemory(),
		noContextFiles: true,
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	const repeated = [...loaded.extensions, ...loaded.extensions];
	const caller: DefaultResourceLoader = Object.create(loader);
	caller.getExtensions = () => ({ ...loaded, extensions: repeated });
	try {
		const { session, extensionsResult } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			resourceLoader: caller,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			assert.equal(extensionsResult.extensions.length, roots.length);
			assert.deepEqual(builtinPackagePaths, originalPaths);
			assert.equal(caller.getExtensions().extensions, repeated);
			assert.equal(repeated.length, roots.length * 2);
			assert.deepEqual(
				extensionsResult.extensions.map((extension) => extension.resolvedPath),
				loaded.extensions.map((extension) => extension.resolvedPath),
			);
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: the internal CLI construction cycle mounts the real host before the same once-only startup.
for (const fail of [false, true]) {
	test(`deferred CLI first binding ${fail ? "awaits failure rollback" : "starts with the mounted host once"}`, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-cli-start-"));
		const events: string[] = [];
		try {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: join(cwd, "agent"),
				resourceLoaderOptions: {
					extensionFactories: [
						(pi) => {
							pi.on("session_start", async (_event, ctx) => {
								events.push(`${ctx.mode}:${ctx.hasUI}`);
								assert.equal(await ctx.ui.confirm("startup", "mounted host"), true);
								if (fail) throw new Error("deferred startup failure");
							});
							pi.on("session_shutdown", async () => {
								await Promise.resolve();
								events.push("released");
							});
						},
					],
				},
			});
			const { session } = await createUnstartedAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(cwd),
			});
			try {
				assert.deepEqual(events, []);
				const binding = { mode: "tui" as const, uiContext: { ...noOpUIContext, confirm: async () => true } };
				if (fail) {
					await assert.rejects(session.bindExtensions(binding), /Extension startup failed/);
					assert.deepEqual(events, ["tui:true", "released"]);
					await assert.rejects(session.bindExtensions(binding), /Extension startup failed/);
					assert.deepEqual(events, ["tui:true", "released"]);
				} else {
					await session.bindExtensions(binding);
					await session.bindExtensions(binding);
					assert.deepEqual(events, ["tui:true"]);
				}
			} finally {
				await session.dispose();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}

// #3105: the public services factory retains eager startup and forwards host bindings.
test("services factory forwards bindings before startup", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-services-bind-"));
	const modes: string[] = [];
	try {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: join(cwd, "agent"),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (_event, ctx) => {
							modes.push(ctx.mode);
						});
					},
				],
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			extensionBindings: { mode: "rpc" },
		});
		try {
			assert.deepEqual(modes, ["rpc"]);
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: resource discovery is not the end of fallible creation finalization.
test.each([false, true])("prompt finalization failure rolls back once (deferred=%s)", async (deferred) => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-finalization-"));
	const events: string[] = [];
	let discovered = false;
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.on("session_start", () => {
					events.push("acquire");
				});
				pi.on("resources_discover", () => {
					discovered = true;
					return {};
				});
				pi.on("session_shutdown", async () => {
					await Promise.resolve();
					events.push("release");
				});
			},
		],
	});
	await loader.reload();
	const options = {
		cwd,
		agentDir: join(cwd, "agent"),
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		systemPromptTransform: (prompt: string) => {
			if (discovered) throw new Error("post-discovery prompt failure");
			return prompt;
		},
	};
	try {
		if (deferred) {
			const { session } = await createUnstartedAgentSession(options);
			await assert.rejects(session.bindExtensions({}), /post-discovery prompt failure/);
			await assert.rejects(session.bindExtensions({}), /post-discovery prompt failure/);
		} else {
			await assert.rejects(createAgentSession(options), /post-discovery prompt failure/);
		}
		assert.deepEqual(events, ["acquire", "release"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: constructor failures restore borrowed provider state before rejecting.
test("constructor failure restores new and replaced providers without starting a session", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-constructor-"));
	const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
	const original = {
		apiKey: "original",
		baseUrl: "https://original.invalid",
		api: "openai-completions" as const,
		models: [],
	};
	modelRuntime.registerProvider("existing-provider", original);
	const events: string[] = [];
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.registerProvider("existing-provider", { ...original, apiKey: "replacement" });
				pi.registerProvider("constructor-provider", original);
				pi.on("session_start", () => {
					events.push("start");
				});
			},
		],
	});
	await loader.reload();
	try {
		await assert.rejects(
			createAgentSession({
				cwd,
				agentDir: join(cwd, "agent"),
				resourceLoader: loader,
				modelRuntime,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				systemPromptTransform: () => {
					throw new Error("constructor transform failed");
				},
			}),
			/constructor transform failed/,
		);
		assert.equal(modelRuntime.getRegisteredProviderConfig("constructor-provider"), undefined);
		assert.deepEqual(modelRuntime.getRegisteredProviderConfig("existing-provider"), original);
		assert.deepEqual(events, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: explicit suppression applies equally to coding and extension tools after reload.
test("noTools all suppresses Intercom and remains empty after reload", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-selection-"));
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(cwd),
			noTools: "all",
			tools: ["read", "intercom"],
		});
		try {
			assert.deepEqual(session.getActiveToolNames(), []);
			await session.reload();
			assert.deepEqual(session.getActiveToolNames(), []);
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: flag lookup must not require own enumerable properties, including after reload.
test.each(["inherited getter", "nonenumerable"])("builtin %s false flags survive reload", async (shape) => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-flag-shape-"));
	class Selection {
		workflows = false;
		mcp = false;
		"web-access" = false;
		intercom = false;
		get subagents() {
			return false;
		}
	}
	const builtins: Partial<Record<AtomicBuiltin, boolean>> = new Selection();
	if (shape === "nonenumerable") Object.defineProperty(builtins, "subagents", { value: false, enumerable: false });
	Object.freeze(builtins);
	const descriptors = Object.getOwnPropertyDescriptors(builtins);
	const prototype = Object.getPrototypeOf(builtins);
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			builtins,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			for (let generation = 0; generation < 2; generation++) {
				assert.equal(session.resourceLoader.getExtensions().extensions.length, 0);
				assert.equal(session.resourceLoader.getSkills().skills.length, 0);
				assert.ok(session.getActiveToolNames().includes("read"));
				assert.equal(
					session.getAllTools().some((tool) => tool.name === "subagent"),
					false,
				);
				assert.deepEqual(Object.getOwnPropertyDescriptors(builtins), descriptors);
				assert.equal(Object.getPrototypeOf(builtins), prototype);
				if (generation === 0) await session.reload();
			}
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: package suppression removes resources as well as tools across generations.
test.each(["preferred", "dist"])(
	"disabled builtins stay absent with %s custom discovery and reload",
	async (layout) => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-disabled-"));
		// #3111: package tests run without an Atomic build. Own the alternate
		// layout instead of depending on a developer's existing dist/builtin.
		const packageDir = config.getPackageDir();
		const fixture = layout === "dist" ? mkdtempSync(join(packageDir, ".sdk-layout-")) : undefined;
		const packageDirSpy = fixture ? vi.spyOn(config, "getPackageDir").mockReturnValue(fixture) : undefined;
		try {
			if (fixture) {
				cpSync(join(packageDir, "..", "subagents"), join(fixture, "dist", "builtin", "subagents"), {
					recursive: true,
				});
			}
			const settingsManager = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir: join(cwd, "agent"),
				settingsManager,
				builtinPackagePaths:
					layout === "preferred"
						? getBuiltinPackagePaths()
						: [join(config.getPackageDir(), "dist", "builtin", "subagents")],
				noContextFiles: true,
			});
			await loader.reload();
			const original = [...loader.getExtensions().extensions];
			assert.ok(original.length > 0, "the supplied shipped extension must actually be loaded");
			const originalArray = loader.getExtensions().extensions;
			const originalSkills = loader.getSkills().skills;
			const builtins = Object.freeze({
				workflows: false,
				subagents: false,
				mcp: false,
				"web-access": false,
				intercom: false,
			});
			try {
				const { session } = await createAgentSession({
					cwd,
					agentDir: join(cwd, "agent"),
					settingsManager,
					sessionManager: SessionManager.inMemory(cwd),
					resourceLoader: loader,
					builtins,
				});
				try {
					for (let generation = 0; generation < 2; generation++) {
						assert.equal(session.resourceLoader.getExtensions().extensions.length, 0);
						assert.equal(session.resourceLoader.getSkills().skills.length, 0);
						assert.equal(session.resourceLoader.getPrompts().prompts.length, 0);
						assert.ok(session.getActiveToolNames().includes("read"));
						assert.ok(!session.getActiveToolNames().includes("intercom"));
						if (generation === 0) {
							assert.deepEqual(loader.getExtensions().extensions, original);
							assert.equal(loader.getExtensions().extensions, originalArray);
							assert.equal(loader.getSkills().skills, originalSkills);
							await session.reload();
						}
					}
				} finally {
					await session.dispose();
				}
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		} finally {
			packageDirSpy?.mockRestore();
			if (fixture) rmSync(fixture, { recursive: true, force: true });
		}
	},
);

const extensionToolNames = [
	"workflow",
	"subagent",
	"mcp",
	"web_search",
	"code_search",
	"fetch_content",
	"get_search_content",
	"intercom",
];
// #3105: active selection is independent from composition and must survive reload unchanged.
test.each<{
	name: string;
	options: Pick<CreateAgentSessionOptions, "tools" | "noTools" | "excludedTools">;
	defaults?: string[];
	expected: string[];
}>([
	{
		name: "omitted selection",
		options: {},
		expected: [...getDefaultToolNames(), ...extensionToolNames, "custom_probe"],
	},
	{ name: "empty allowlist", options: { tools: [] }, expected: [] },
	{ name: "all without allowlist", options: { noTools: "all" }, expected: [] },
	{ name: "builtin suppression", options: { noTools: "builtin" }, expected: [...extensionToolNames, "custom_probe"] },
	{
		name: "builtin with explicit allowlist",
		options: { noTools: "builtin", tools: ["read", "intercom"] },
		expected: ["read", "intercom"],
	},
	{ name: "empty configured defaults", options: {}, defaults: [], expected: [...extensionToolNames, "custom_probe"] },
	{
		name: "configured coding defaults",
		options: {},
		defaults: ["read"],
		expected: ["read", ...extensionToolNames, "custom_probe"],
	},
	{
		name: "explicit beats configured defaults",
		options: { tools: ["custom_probe", "intercom"] },
		defaults: ["read"],
		expected: ["custom_probe", "intercom"],
	},
	{
		name: "exclusions win",
		options: { tools: ["read", "intercom", "custom_probe"], excludedTools: ["intercom", "custom_probe", "unknown"] },
		expected: ["read"],
	},
	{
		name: "unknown exclusions ignored",
		options: { tools: ["intercom", "read"], excludedTools: ["unknown"] },
		expected: ["intercom", "read"],
	},
])("tool selection: $name", async ({ options, defaults, expected }) => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-matrix-"));
	const snapshot = structuredClone(options);
	if (options.tools) Object.freeze(options.tools);
	if (options.excludedTools) Object.freeze(options.excludedTools);
	Object.freeze(options);
	try {
		const { session } = await createAgentSession({
			...options,
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager: SettingsManager.inMemory(defaults === undefined ? {} : { defaultTools: defaults }),
			sessionManager: SessionManager.inMemory(cwd),
			customTools: [
				{
					name: "custom_probe",
					label: "Probe",
					description: "Custom selection probe",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				},
			],
		});
		try {
			assert.deepEqual([...session.getActiveToolNames()].sort(), [...expected].sort());
			if (options.tools && options.noTools !== "all") assert.deepEqual(session.getActiveToolNames(), expected);
			assert.ok(session.resourceLoader.getExtensions().extensions.length >= 5);
			await session.reload();
			assert.deepEqual([...session.getActiveToolNames()].sort(), [...expected].sort());
			for (const excluded of options.excludedTools ?? [])
				assert.equal(session.getToolDefinition(excluded), undefined);
			assert.deepEqual(options, snapshot);
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: omitted keys, empty selection and explicit true all retain shipped descriptor order.
test.each<Partial<Record<AtomicBuiltin, boolean>>>([
	{},
	{ workflows: true, subagents: true, mcp: true, "web-access": true, intercom: true },
	{ workflows: false },
	{ subagents: false },
	{ mcp: false },
	{ "web-access": false },
	{ intercom: false },
])("builtin selection %j preserves enabled families after reload", async (builtins) => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-builtins-"));
	Object.freeze(builtins);
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			builtins,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			for (let generation = 0; generation < 2; generation++) {
				for (const [family, tool] of [
					["workflows", "workflow"],
					["subagents", "subagent"],
					["mcp", "mcp"],
					["web-access", "web_search"],
					["intercom", "intercom"],
				] as const) {
					assert.equal(session.getActiveToolNames().includes(tool), builtins[family] !== false, family);
				}
				if (generation === 0) await session.reload();
			}
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: a Node callback, without a terminal, answers the existing questionnaire tool.
test("SDK host callback answers a questionnaire without rendering", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-host-input-"));
	const params = {
		questions: [
			{
				question: "Choose?",
				header: "Choice",
				options: [
					{ label: "Yes", description: "Proceed" },
					{ label: "No", description: "Decline" },
				],
			},
		],
	};
	const answer: QuestionnaireResult = {
		answers: [{ questionIndex: 0, question: "Choose?", kind: "option", answer: "Yes" }],
		cancelled: false,
	};
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			extensionBindings: {
				humanInput: {
					confirm: async () => false,
					select: async () => undefined,
					input: async () => "",
					editor: async () => "",
					questionnaire: async (received, options) => {
						assert.deepEqual(received, params);
						assert.equal(options.sessionId, session.sessionId);
						assert.ok(options.requestId);
						return answer;
					},
				},
			},
		});
		try {
			const tool = session.agent.state.tools.find((entry) => entry.name === "ask_user_question")!;
			const result = await tool.execute("question", params, new AbortController().signal);
			assert.deepEqual(result.details, answer);
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

const callbackHost = (overrides: Partial<HostInput> = {}): HostInput => ({
	confirm: async () => false,
	select: async () => undefined,
	input: async () => "",
	editor: async () => "",
	questionnaire: async () => ({ answers: [], cancelled: true }),
	...overrides,
});

async function hostSession(bindings: ExtensionBindings = {}, options: CreateAgentSessionOptions = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-host-contract-"));
	const contexts: ExtensionContext[] = [];
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, context) => {
					contexts.push(context);
				});
				pi.registerCommand("diagnostic-test", {
					description: "fixture",
					handler: async () => {
						throw new Error("secret prompt token");
					},
				});
			},
		],
	});
	await loader.reload();
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			extensionBindings: bindings,
			...options,
		});
		return {
			session,
			contexts,
			loader,
			close: async () => {
				await session.dispose();
				rmSync(cwd, { recursive: true, force: true });
			},
		};
	} catch (error) {
		rmSync(cwd, { recursive: true, force: true });
		throw error;
	}
}

// #3105: host cancellation is runtime-owned even when callbacks never cooperate.
test("SDK abort cancels host input and ignores late approval", async () => {
	let identity: HostInputOptions | undefined;
	let approve!: (value: boolean) => void;
	const fixture = await hostSession({
		humanInput: callbackHost({
			confirm: async (_title, _message, options) => {
				identity = options;
				return new Promise<boolean>((resolve) => {
					approve = resolve;
				});
			},
		}),
	});
	try {
		const pending = fixture.contexts[0].ui.confirm("Approve", "Run?");
		const rejected = assert.rejects(pending, { code: "HumanInputCancelled" });
		await Promise.resolve();
		await fixture.session.abort();
		await rejected;
		assert.equal(identity?.signal.aborted, true);
		approve(true);
		await fixture.session.bindExtensions({ humanInput: callbackHost() });
		assert.equal(await fixture.contexts[0].ui.confirm("Again", "Run?"), false);
	} finally {
		await fixture.close();
	}
});

// #3105: creation, omitted rebinding, explicit override and null are distinct.
test("SDK human capability is separate from rendering and binding preserves pending requests", async () => {
	let resolve!: (value: string) => void;
	const ui = {
		...noOpUIContext,
		input: async () =>
			new Promise<string>((done) => {
				resolve = done;
			}),
	};
	const fixture = await hostSession({ uiContext: ui });
	try {
		const context = fixture.contexts[0];
		assert.equal(context.hasUI, true);
		assert.equal(context.hasHumanInput, true);
		const pending = context.ui.input("Raw");
		await Promise.resolve();
		await fixture.session.bindExtensions({});
		resolve("  unchanged\n");
		assert.equal(await pending, "  unchanged\n");
		assert.equal(fixture.contexts.length, 1);
		await fixture.session.bindExtensions({ humanInput: callbackHost({ input: async () => "" }) });
		assert.equal(await context.ui.input("Raw"), "");
		await fixture.session.bindExtensions({ humanInput: null });
		assert.equal(context.hasUI, true);
		assert.equal(context.hasHumanInput, false);
		await assert.rejects(context.ui.confirm("No", "Approval"), { code: "HumanInputUnavailable" });
		await fixture.session.bindExtensions({ uiContext: ui });
		assert.equal(context.hasHumanInput, false);
	} finally {
		await fixture.close();
	}
});

// #3105: runtime validation is not TypeScript trust or truthy coercion.
test("SDK dialogs preserve raw arguments and reject malformed host replies", async () => {
	const identities: HostInputOptions[] = [];
	const choices = [" same ", "same", " same ", ""];
	const fixture = await hostSession({
		humanInput: callbackHost({
			confirm: async (title, message, options) => {
				assert.equal(title, "  title\n");
				assert.equal(message, "");
				identities.push(options);
				return false;
			},
			select: async (title, values, options) => {
				assert.equal(title, "");
				assert.deepEqual(values, choices);
				identities.push(options);
				return "";
			},
			input: async (_title, placeholder) => {
				assert.equal(placeholder, "  ");
				return "";
			},
			editor: async (_title, initial) => {
				assert.equal(initial, "\n raw ");
				return "\n raw ";
			},
		}),
	});
	try {
		const ctx = fixture.contexts[0];
		assert.equal(ctx.hasUI, false);
		assert.equal(ctx.hasHumanInput, true);
		assert.equal(await ctx.ui.confirm("  title\n", ""), false);
		assert.equal(await ctx.ui.select("", choices), "");
		assert.equal(await ctx.ui.input("", "  "), "");
		assert.equal(await ctx.ui.editor("", "\n raw "), "\n raw ");
		assert.notEqual(identities[0].requestId, identities[1].requestId);
		for (const identity of identities) {
			assert.deepEqual(Object.keys(identity).sort(), ["requestId", "sessionId", "signal"]);
			assert.equal(identity.sessionId, fixture.session.sessionId);
		}
		for (const invalid of ["true", 1, undefined, null]) {
			await fixture.session.bindExtensions({ humanInput: callbackHost({ confirm: async () => invalid as never }) });
			await assert.rejects(ctx.ui.confirm("", ""), { code: "InvalidHostInput" });
		}
		await fixture.session.bindExtensions({
			humanInput: callbackHost({
				select: async () => "foreign",
				input: async () => 1 as never,
				editor: async () => false as never,
			}),
		});
		await assert.rejects(ctx.ui.select("", choices), { code: "InvalidHostInput" });
		await assert.rejects(ctx.ui.input(""), { code: "InvalidHostInput" });
		await assert.rejects(ctx.ui.editor(""), { code: "InvalidHostInput" });
		await assert.rejects(
			ctx.ui.custom(async () => {
				throw new Error("must not mount");
			}),
			{ code: "HumanInputUnavailable" },
		);
	} finally {
		await fixture.close();
	}
});

// #3105: caller cancellation, timeout, rejection, withdrawal and generations cannot approve.
test("SDK pending host requests settle at each cancellation boundary", async () => {
	const fixture = await hostSession();
	try {
		await assert.rejects(fixture.contexts[0].ui.input(""), { code: "HumanInputUnavailable" });
		for (const boundary of ["signal", "timeout", "withdraw", "reload", "dispose"] as const) {
			let identity!: HostInputOptions;
			let answer!: (value: boolean) => void;
			await fixture.session.bindExtensions({
				humanInput: callbackHost({
					confirm: async (_t, _m, options) => {
						identity = options;
						return new Promise<boolean>((resolve) => {
							answer = resolve;
						});
					},
				}),
			});
			const context = fixture.contexts.at(-1)!;
			const controller = new AbortController();
			const pending = context.ui.confirm("", "", {
				signal: controller.signal,
				...(boundary === "timeout" ? { timeout: 0 } : {}),
			});
			const rejected = assert.rejects(pending, { code: "HumanInputCancelled" });
			await Promise.resolve();
			if (boundary === "signal") controller.abort();
			if (boundary === "withdraw") await fixture.session.bindExtensions({ humanInput: null });
			if (boundary === "reload") await fixture.session.reload();
			if (boundary === "dispose") await fixture.session.dispose();
			await rejected;
			assert.equal(identity.signal.aborted, true);
			answer(true);
			if (boundary === "reload") {
				assert.throws(() => context.hasHumanInput);
				assert.equal(fixture.contexts.at(-1)!.hasHumanInput, true);
			}
		}
		await assert.rejects(fixture.session.bindExtensions({}), { code: "SessionClosed" });
	} finally {
		await fixture.close();
	}
	const failure = new Error("adapter refused");
	const rejected = await hostSession({
		humanInput: callbackHost({
			confirm: async () => {
				throw failure;
			},
		}),
	});
	try {
		await assert.rejects(rejected.contexts[0].ui.confirm("", ""), (error) => error === failure);
	} finally {
		await rejected.close();
	}
});

// #3105: exact questionnaire result types and schema failures survive the Node bridge.
test("SDK questionnaire preserves rich answers and rejects malformed results and request schemas", async () => {
	const params: QuestionParams = {
		questions: [
			{
				question: " Raw? ",
				header: "",
				options: [
					{ label: " yes ", description: "", preview: "\n## Preview\n" },
					{ label: "no", description: "" },
				],
			},
		],
	};
	const result: QuestionnaireResult = {
		answers: [
			{
				questionIndex: 0,
				question: " Raw? ",
				kind: "option",
				answer: " yes ",
				preview: "\n## Preview\n",
				notes: " raw notes ",
			},
		],
		cancelled: false,
	};
	let calls = 0;
	const fixture = await hostSession({
		humanInput: callbackHost({
			questionnaire: async (received) => {
				calls++;
				assert.deepEqual(received, params);
				return result;
			},
		}),
	});
	try {
		const execute = (request: QuestionParams) =>
			fixture.session.agent.state.tools
				.find((tool) => tool.name === "ask_user_question")!
				.execute("question", request, new AbortController().signal);
		assert.deepEqual((await execute(params)).details, result);
		assert.equal(calls, 1);
		for (const [request, error] of [
			[{ questions: [] }, "no_questions"],
			[{ questions: [params.questions[0], params.questions[0]] }, "duplicate_question"],
			[
				{
					questions: [
						{ ...params.questions[0], options: [params.questions[0].options[0], params.questions[0].options[0]] },
					],
				},
				"duplicate_option_label",
			],
			[
				{
					questions: [
						{
							...params.questions[0],
							options: [{ label: "Other", description: "" }, params.questions[0].options[1]],
						},
					],
				},
				"reserved_label",
			],
		] as const) {
			const response = await execute(request as QuestionParams);
			assert.equal((response.details as QuestionnaireResult).error, error);
		}
		assert.equal(calls, 1);
		for (const malformed of [
			null,
			{},
			{ answers: [], cancelled: "false" },
			{ ...result, answers: [{ ...result.answers[0], answer: "foreign" }] },
			{ ...result, answers: [result.answers[0], result.answers[0]] },
		]) {
			await fixture.session.bindExtensions({
				humanInput: callbackHost({ questionnaire: async () => malformed as never }),
			});
			await assert.rejects(execute(params), { code: "InvalidHostInput" });
		}
		await fixture.session.bindExtensions({ humanInput: callbackHost() });
		assert.deepEqual((await execute(params)).details, { answers: [], cancelled: true });
		await fixture.session.bindExtensions({ humanInput: null });
		assert.deepEqual((await execute(params)).details, { answers: [], cancelled: true, error: "no_ui" });
	} finally {
		await fixture.close();
	}
});

// #3105: operational diagnostics belong to this session and omit arbitrary exception text.
test("SDK diagnostic sinks are session attributed and remain separate", async () => {
	const first: HostDiagnostic[] = [];
	const second: HostDiagnostic[] = [];
	const a = await hostSession({ onDiagnostic: (diagnostic) => first.push(diagnostic) });
	const b = await hostSession({ onDiagnostic: (diagnostic) => second.push(diagnostic) });
	try {
		await a.session.prompt("/diagnostic-test");
		assert.equal(first.length, 1);
		assert.equal(second.length, 0);
		assert.equal(first[0].sessionId, a.session.sessionId);
		assert.equal(first[0].level, "error");
		assert.ok(first[0].source);
		assert.ok(!first[0].message.includes("secret prompt token"));
		await b.session.prompt("/diagnostic-test");
		assert.equal(second[0].sessionId, b.session.sessionId);
	} finally {
		await a.close();
		await b.close();
	}
});

// #3105: callbacks see untouched multi-selection, custom text and omitted optional fields.
test("SDK questionnaire preserves multi-selection and empty custom answers", async () => {
	const params: QuestionParams = {
		questions: [
			{
				question: "Multiple?",
				header: "Multi",
				multiSelect: true,
				options: [
					{ label: "A", description: "" },
					{ label: "B", description: "" },
				],
			},
			{
				question: "Text?",
				header: "Text",
				options: [
					{ label: "A", description: "" },
					{ label: "B", description: "" },
				],
			},
		],
	};
	const result: QuestionnaireResult = {
		answers: [
			{ questionIndex: 1, question: "Text?", kind: "custom", answer: "" },
			{ questionIndex: 0, question: "Multiple?", kind: "multi", answer: null, selected: ["B", "A"], notes: "  \n" },
		],
		cancelled: false,
	};
	const fixture = await hostSession({
		humanInput: callbackHost({
			questionnaire: async (received) => {
				assert.deepEqual(received, params);
				return result;
			},
		}),
	});
	try {
		const tool = fixture.session.agent.state.tools.find((entry) => entry.name === "ask_user_question")!;
		assert.deepEqual((await tool.execute("question", params, new AbortController().signal)).details, result);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(tool.execute("cancelled", params, controller.signal), { code: "HumanInputCancelled" });
	} finally {
		await fixture.close();
	}
});

// #3105: a fully typed adapter is present before the first startup event, not after it.
test("SDK startup hooks can await human input without rendering", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-host-start-"));
	const settingsManager = SettingsManager.inMemory();
	const calls: string[] = [];
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async (_event, context) => {
					assert.equal(context.hasUI, false);
					assert.equal(context.hasHumanInput, true);
					calls.push((await context.ui.input("Startup")) ?? "unanswered");
				});
			},
		],
	});
	try {
		await loader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			extensionBindings: { humanInput: callbackHost({ input: async () => "  initial " }) },
		});
		try {
			assert.deepEqual(calls, ["  initial "]);
			await session.bindExtensions({});
			assert.deepEqual(calls, ["  initial "]);
			await session.reload();
			assert.deepEqual(calls, ["  initial ", "  initial "]);
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: JavaScript hosts cannot advertise a partial or non-object human adapter.
test("SDK rejects adapters without every required method", async () => {
	for (const humanInput of [false, 0, "", {}, { confirm: async () => true }]) {
		await assert.rejects(hostSession({ humanInput: humanInput as never }), { code: "InvalidHostInput" });
	}
});

// #3105: array holes must not bypass the questionnaire's runtime schema.
test("SDK questionnaire rejects sparse answers and selections", async () => {
	const params: QuestionParams = {
		questions: [
			{
				question: "Choose?",
				header: "",
				multiSelect: true,
				options: [
					{ label: " A ", description: "" },
					{ label: "B", description: "" },
				],
			},
		],
	};
	for (const answers of [
		Array(1),
		[{ questionIndex: 0, question: "Choose?", kind: "multi", answer: null, selected: Array(1) }],
	]) {
		const fixture = await hostSession({
			humanInput: callbackHost({ questionnaire: async () => ({ cancelled: false, answers }) }),
		});
		try {
			const tool = fixture.session.agent.state.tools.find((entry) => entry.name === "ask_user_question")!;
			await assert.rejects(tool.execute("sparse", params, new AbortController().signal), {
				code: "InvalidHostInput",
			});
		} finally {
			await fixture.close();
		}
	}
});

// #3105: malformed accessor failures settle and release the owning request, not a detached promise.
test("SDK questionnaire settles throwing reply validation and releases the request", async () => {
	let identity!: HostInputOptions;
	let malformed = true;
	const valid: QuestionnaireResult = {
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Choose?", kind: "option", answer: " A " }],
	};
	const fixture = await hostSession({
		humanInput: callbackHost({
			questionnaire: async (_params, options) => {
				identity = options;
				return malformed
					? {
							cancelled: false,
							get answers(): QuestionnaireResult["answers"] {
								throw new Error("broken reply accessor");
							},
						}
					: valid;
			},
		}),
	});
	try {
		const tool = fixture.session.agent.state.tools.find((entry) => entry.name === "ask_user_question")!;
		const params: QuestionParams = {
			questions: [
				{
					question: "Choose?",
					header: "",
					options: [
						{ label: " A ", description: "" },
						{ label: "B", description: "" },
					],
				},
			],
		};
		await assert.rejects(tool.execute("throwing", params, new AbortController().signal), {
			code: "InvalidHostInput",
		});
		await fixture.session.abort();
		assert.equal(identity.signal.aborted, false, "settled request is no longer pending during abort");
		malformed = false;
		assert.equal((await tool.execute("valid", params, new AbortController().signal)).details, valid);
	} finally {
		await fixture.close();
	}
}, 1000);

// #3105: child creation cannot discard the invoking SDK session's host or ceiling.
test("child session inherits callback and config without resurrecting disabled builtins", async () => {
	const requests: HostInputOptions[] = [];
	const fixture = await hostSession({
		humanInput: callbackHost({
			input: async (_title, _placeholder, options) => {
				requests.push(options);
				return "  child text  ";
			},
		}),
	});
	try {
		const options = fixture.contexts[0]!.getChildSessionOptions!({
			builtins: { intercom: true, workflows: true },
			sessionManager: SessionManager.inMemory(fixture.session.sessionManager.getCwd()),
		});
		const { session: child } = await createAgentSession(options);
		try {
			assert.equal(child.settingsManager, fixture.session.settingsManager);
			assert.equal(child.getActiveToolNames().includes("intercom"), false);
			assert.equal(child.getActiveToolNames().includes("workflow"), false);
			assert.equal(await child.extensionRunner.createContext().ui.input("raw"), "  child text  ");
			assert.equal(requests[0]!.sessionId, child.sessionManager.getSessionId());
			assert.notEqual(requests[0]!.sessionId, fixture.session.sessionManager.getSessionId());
		} finally {
			await child.dispose();
		}
	} finally {
		await fixture.close();
	}
});

// #3105: omitted selection, empty selection, and excluded tools are distinct child ceilings.
test.each([
	{ tools: [] },
	{ noTools: "all" as const },
	{ tools: ["read"], excludedTools: ["read"] },
	{ noTools: "builtin" as const },
])("child selections cannot widen parent %j", async (selection) => {
	const fixture = await hostSession();
	const base = fixture.contexts[0]!.getChildSessionOptions!({});
	const { session: parent } = await createAgentSession({
		...base,
		...selection,
		sessionManager: SessionManager.inMemory(base.cwd),
	});
	let child: AgentSession | undefined;
	try {
		const input = Object.freeze({ tools: Object.freeze(["read", "bash", "intercom"]) });
		const options = parent.extensionRunner.createContext().getChildSessionOptions!({
			tools: [...input.tools],
			sessionManager: SessionManager.inMemory(base.cwd),
		});
		child = (await createAgentSession(options)).session;
		assert.deepEqual(child.getActiveToolNames(), []);
		assert.deepEqual(input.tools, ["read", "bash", "intercom"]);
	} finally {
		await child?.dispose();
		await parent.dispose();
		await fixture.close();
	}
});

// #3105: siblings and replacement children retain their invoking owner's configuration.
test("child callbacks, diagnostics and relative cwd stay owner-local across rebinding and reload", async () => {
	const diagnostics: HostDiagnostic[][] = [[], []];
	const fixtures = await Promise.all(
		["left", "right"].map((label, index) =>
			hostSession({
				humanInput: callbackHost({ input: async () => label }),
				onDiagnostic: (diagnostic) => diagnostics[index]!.push(diagnostic),
			}),
		),
	);
	const children: AgentSession[] = [];
	try {
		for (let index = 0; index < fixtures.length; index++) {
			const fixture = fixtures[index]!;
			const cwd = join(fixture.session.sessionManager.getCwd(), "child");
			mkdirSync(cwd);
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir: join(fixture.session.sessionManager.getCwd(), "agent"),
				settingsManager: fixture.session.settingsManager,
				resourceLoaderInheritanceSnapshot: fixture.loader.getInheritanceSnapshot(),
			});
			await loader.reload();
			const { session } = await createAgentSession(
				fixture.contexts[0]!.getChildSessionOptions!({
					cwd: "child",
					resourceLoader: loader,
					sessionManager: SessionManager.inMemory(cwd),
				}),
			);
			children.push(session);
			assert.equal(session.extensionRunner.createContext().cwd, cwd);
			assert.equal(session.settingsManager, fixture.session.settingsManager);
			assert.equal(await session.extensionRunner.createContext().ui.input("raw"), index === 0 ? "left" : "right");
			await session.prompt("/diagnostic-test");
			assert.equal(diagnostics[index]!.length, 1);
			assert.equal(diagnostics[index]![0]!.sessionId, session.sessionId);
		}
		await fixtures[0]!.session.bindExtensions({ humanInput: callbackHost({ input: async () => "replacement" }) });
		await fixtures[0]!.session.reload();
		const source = fixtures[0]!.session.extensionRunner.createContext();
		const { session: replacement } = await createAgentSession(
			source.getChildSessionOptions!({
				sessionManager: SessionManager.inMemory(fixtures[0]!.session.sessionManager.getCwd()),
			}),
		);
		children.push(replacement);
		assert.equal(await replacement.extensionRunner.createContext().ui.input("raw"), "replacement");
		assert.equal(replacement.getActiveToolNames().includes("intercom"), false);
		assert.equal(await children[1]!.extensionRunner.createContext().ui.input("raw"), "right");
		assert.equal(diagnostics[1]!.length, 1);
	} finally {
		for (const child of children) await child.dispose();
		for (const fixture of fixtures) await fixture.close();
	}
});

// #3105: the child manager supplies cwd unless an explicit parent-relative cwd wins.
test("child working directory honors manager before inherited default", async () => {
	const fixture = await hostSession();
	const parentCwd = fixture.session.sessionManager.getCwd();
	const managerCwd = join(parentCwd, "manager");
	mkdirSync(managerCwd);
	try {
		for (const cwd of [undefined, "", "."]) {
			const sessionManager = SessionManager.inMemory(managerCwd);
			const input = Object.freeze({ cwd, sessionManager });
			const { session } = await createAgentSession(fixture.contexts[0]!.getChildSessionOptions!(input));
			try {
				assert.equal(session.extensionRunner.createContext().cwd, cwd === undefined ? managerCwd : parentCwd);
				assert.equal(session.sessionManager, sessionManager);
				assert.equal(input.cwd, cwd);
			} finally {
				await session.dispose();
			}
		}
	} finally {
		await fixture.close();
	}
});

// #3105: optional undefined is omission, not a replacement model or host withdrawal.
test("undefined child configuration retains inherited values and callback identities", async () => {
	const diagnostics: HostDiagnostic[] = [];
	const host = callbackHost({ input: async () => "  inherited\n" });
	const fallbackModels = ["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"];
	const customTools = [
		{
			name: "inherited_fixture",
			label: "Fixture",
			description: "Inherited custom tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: " raw " }], details: {} }),
		},
	];
	const fixture = await hostSession(
		{ humanInput: host, onDiagnostic: (entry) => diagnostics.push(entry) },
		{ fallbackModels, customTools, thinkingLevel: "high", isFallbackModelAllowed: () => false },
	);
	try {
		const resolve = fixture.contexts[0]!.getChildSessionOptions!;
		const baseline = resolve({});
		const input: CreateAgentSessionOptions = Object.freeze({
			agentDir: undefined,
			modelRuntime: undefined,
			settingsManager: undefined,
			model: undefined,
			thinkingLevel: undefined,
			fallbackModels: undefined,
			isFallbackModelAllowed: undefined,
			builtins: Object.freeze({ intercom: undefined }),
			tools: undefined,
			noTools: undefined,
			excludedTools: undefined,
			customTools: undefined,
			extensionBindings: Object.freeze({ humanInput: undefined, onDiagnostic: undefined }),
		});
		const options = resolve(input);
		const { session } = await createAgentSession({ ...options, resourceLoader: fixture.loader });
		try {
			assert.equal(session.model, fixture.session.model);
			assert.equal(session.settingsManager, fixture.session.settingsManager);
			assert.ok(session.getAllTools().some((tool) => tool.name === "inherited_fixture"));
			assert.equal(await session.extensionRunner.createContext().ui.input("raw"), "  inherited\n");
			await session.prompt("/diagnostic-test");
			assert.equal(diagnostics.length, 1);
			assert.equal(diagnostics[0]!.sessionId, session.sessionId);
			assert.deepEqual(options, baseline);
			for (const key of ["model", "modelRuntime", "settingsManager", "customTools", "fallbackModels"] as const) {
				assert.equal(options[key], baseline[key], key);
			}
			assert.equal(options.extensionBindings!.humanInput, host);
			assert.equal(input.extensionBindings!.humanInput, undefined);
		} finally {
			await session.dispose();
		}
	} finally {
		await fixture.close();
	}
});

// #3105: public disposal owns awaited shutdown and closes admission immediately.
test("public disposal awaits shutdown once and seals admission synchronously", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-close-"));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let shutdowns = 0;
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				pi.on("session_shutdown", async () => {
					shutdowns++;
					await gate;
				});
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	try {
		const closing = session.dispose();
		assert.ok(closing instanceof Promise);
		assert.equal(session.dispose(), closing);
		await assert.rejects(session.prompt("must not start"), { code: "SessionClosed" });
		await assert.rejects(session.bindExtensions({}), { code: "SessionClosed" });
		await assert.rejects(session.reload(), { code: "SessionClosed" });
		await assert.rejects(session.extensionRunner.createContext().ui.input("cannot ask"), { code: "SessionClosed" });
		let settled = false;
		void closing.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(settled, false);
		assert.equal(shutdowns, 1);
		release();
		await closing;
		assert.equal(session.dispose(), closing);
	} finally {
		release();
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: one failed extension must not skip sibling cleanup or close borrowed settings.
test.each(["none", "diagnostic", "error"] as const)(
	"public disposal aggregates failures with %s observer failure and preserves a sibling",
	async (observerFailure) => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-close-failure-"));
		const settingsManager = SettingsManager.inMemory();
		const attempts: string[] = [];
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", () => {
						attempts.push("first");
						throw new Error("first cleanup failed");
					});
				},
				(pi) => {
					pi.on("session_shutdown", () => {
						attempts.push("second");
						throw new Error("second cleanup failed");
					});
				},
			],
		});
		await resourceLoader.reload();
		const builtins = { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false };
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			builtins,
			extensionBindings: {
				onDiagnostic:
					observerFailure === "diagnostic"
						? () => {
								throw new Error("diagnostic observer failed");
							}
						: undefined,
				onError:
					observerFailure === "error"
						? () => {
								throw new Error("error observer failed");
							}
						: undefined,
			},
		});
		const { session: sibling } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			builtins,
		});
		const flushSettings = vi.spyOn(settingsManager, "flush").mockImplementationOnce(async () => {
			attempts.push("settings");
			throw new Error("settings flush failed");
		});
		const flushSession = vi.spyOn(session.sessionManager, "flush").mockImplementationOnce(() => {
			attempts.push("session");
		});
		try {
			const closing = session.dispose();
			await assert.rejects(closing, (error: Error & { code?: string }) => {
				assert.equal(error.code, "ShutdownFailed");
				assert.ok(error instanceof AggregateError);
				assert.equal(error.errors.length, observerFailure === "none" ? 3 : 5);
				return true;
			});
			assert.deepEqual(attempts, ["first", "second", "settings", "session"]);
			assert.equal(session.dispose(), closing);
			await assert.rejects(session.bindExtensions({}), { code: "SessionClosed" });
			await sibling.bindExtensions({
				humanInput: {
					confirm: async () => true,
					select: async () => undefined,
					input: async () => "alive",
					editor: async () => undefined,
					questionnaire: async () => ({ answers: [], cancelled: true }),
				},
			});
			assert.equal(await sibling.extensionRunner.createContext().ui.input("still live"), "alive");
			assert.equal(sibling.settingsManager, settingsManager);
		} finally {
			flushSettings.mockRestore();
			flushSession.mockRestore();
			await sibling.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: cancellation is not settlement; close must await the shell's drain.
test("public disposal aborts and drains active shell work and pending human input", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-close-active-"));
	let inputSignal: AbortSignal | undefined;
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		extensionBindings: {
			humanInput: {
				confirm: async () => false,
				select: async () => undefined,
				input: (_title, _placeholder, options) => {
					inputSignal = options.signal;
					return new Promise(() => {});
				},
				editor: async () => undefined,
				questionnaire: async () => ({ answers: [], cancelled: true }),
			},
		},
	});
	let release!: () => void;
	const drain = new Promise<void>((resolve) => {
		release = resolve;
	});
	let aborted = false;
	const input = session.extensionRunner.createContext().ui.input("pending");
	const inputRejected = assert.rejects(input, { code: "HumanInputCancelled" });
	const shell = session.executeBash("controlled", undefined, {
		operations: {
			exec: async (_command, _cwd, options) => {
				await new Promise<void>((resolve) => {
					options.signal!.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve();
						},
						{ once: true },
					);
				});
				await drain;
				throw new Error("aborted");
			},
		},
	});
	try {
		const closing = session.dispose();
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(aborted, true);
		assert.equal(inputSignal?.aborted, true);
		assert.equal(closed, false);
		await assert.rejects(session.executeBash("cannot start"), { code: "SessionClosed" });
		release();
		await shell;
		await inputRejected;
		await closing;
	} finally {
		release();
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: queued admission is owned even before the child runner starts.
test("public disposal cancels a queued child without dispatching it", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-close-queued-"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	let dispatch!: () => Promise<void>;
	let started = 0;
	try {
		const host = session.getAgentTaskHost();
		const admitted = await host.startAgentTask(
			{ kind: "agent", agent: "fixture", task: "must remain queued" },
			"queued-close" as Parameters<typeof host.startAgentTask>[1],
			() => {
				started++;
				return {
					result: Promise.resolve({ kind: "completed", output: "unexpected" }),
					cleanup: Promise.resolve({ kind: "reaped" }),
				};
			},
			(run) => {
				dispatch = run;
			},
		);
		assert.ok(admitted.ok);
		await session.dispose();
		await dispatch();
		assert.equal(started, 0);
		const terminal = await host.close("session-close");
		assert.ok(terminal.ok, JSON.stringify(terminal));
		assert.equal(terminal.value.state, "closed");
		assert.equal(terminal.value.tasks.length, 1);
		const execution = terminal.value.tasks[0]!.execution;
		assert.equal(execution.kind, "settled");
		if (execution.kind === "settled") assert.equal(execution.result.kind, "cancelled");
	} finally {
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: a shared communication bus is not a shared lifecycle owner.
test("independent loaders sharing an event bus retain distinct scopes across reload", async () => {
	const { createEventBus } = await import("../src/core/event-bus.ts");
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-shared-bus-"));
	const eventBus = createEventBus();
	const scopes: object[][] = [[], []];
	const sessions: AgentSession[] = [];
	try {
		for (const ownerScopes of scopes) {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: join(cwd, "agent"),
				settingsManager,
				eventBus,
				noExtensions: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							ownerScopes.push(pi.lifecycleScope!);
						});
					},
				],
			});
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				cwd,
				agentDir: join(cwd, "agent"),
				settingsManager,
				resourceLoader,
				sessionManager: SessionManager.inMemory(cwd),
				builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			});
			sessions.push(session);
		}
		assert.notEqual(scopes[0]![0], scopes[1]![0]);
		await sessions[0]!.reload();
		assert.equal(scopes[0]![1], scopes[0]![0]);
	} finally {
		await Promise.all(sessions.map((session) => session.dispose()));
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: admitted callback work must settle before close; stale preflight cannot enter a provider.
test.each(["input", "before_agent_start"] as const)("disposal drains suspended %s preflight", async (hook) => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-preflight-close-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const settingsManager = SettingsManager.inMemory();
	const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
	await modelRuntime.setRuntimeApiKey("anthropic", "fixture-key", {});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				pi.on(hook, async () => {
					entered.resolve();
					await release.promise;
				});
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		resourceLoader,
		modelRuntime,
		model: modelRuntime.getModels("anthropic")[0],
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	const provider = vi.spyOn(modelRuntime, "streamSimple").mockImplementation(() => {
		throw new Error("provider sentinel");
	});
	const turn = session.prompt("verbatim  ");
	const outcome = turn.then(
		() => undefined,
		(error: unknown) => error,
	);
	try {
		await entered.promise;
		let closed = false;
		const closing = session.dispose().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(closed, false, "pending callback is owned work, not completed cleanup");
		release.resolve();
		await closing;
		assert.equal(((await outcome) as { code?: string })?.code, "SessionClosed");
		assert.equal(provider.mock.calls.length, 0);
	} finally {
		release.resolve();
		await outcome;
		await session.dispose();
		provider.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: both unstarted and partially started transactional candidates belong to close.
test.each([
	{ phase: "before", failure: "none" },
	{ phase: "start", failure: "none" },
	{ phase: "discover", failure: "none" },
	{ phase: "old-shutdown", failure: "none" },
	{ phase: "before", failure: "callback" },
	{ phase: "start", failure: "callback" },
	{ phase: "discover", failure: "cleanup" },
] as const)("disposal drains reload suspended in $phase with $failure failure", async ({ phase, failure }) => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-reload-close-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const active = new Set<number>();
	const stops: number[] = [];
	let factories = 0;
	const suspend = async () => {
		entered.resolve();
		await release.promise;
		if (failure === "callback") throw new Error("callback rejected");
	};
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				const id = ++factories;
				pi.on("session_start", async () => {
					active.add(id);
					if (id === 2 && phase === "start") await suspend();
				});
				pi.on("resources_discover", async () => {
					if (id === 2 && phase === "discover") await suspend();
				});
				pi.on("session_shutdown", async () => {
					active.delete(id);
					stops.push(id);
					if (id === 1 && phase === "old-shutdown") await suspend();
					if (id === 2 && failure === "cleanup") throw new Error("candidate cleanup rejected");
				});
			},
		],
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	const reload = session.reload({ beforeSessionStart: phase === "before" ? suspend : undefined });
	const outcome = reload.then(
		() => undefined,
		(error: unknown) => error,
	);
	try {
		await entered.promise;
		let closed = false;
		const closing = session.dispose().then(
			() => {
				closed = true;
				return undefined;
			},
			(error: unknown) => {
				closed = true;
				return error;
			},
		);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(closed, false);
		release.resolve();
		const closeError = await closing;
		const reloadError = await outcome;
		if (failure === "cleanup") {
			assert.equal((closeError as { code?: string })?.code, "ShutdownFailed");
			assert.equal((reloadError as { code?: string })?.code, "ShutdownFailed");
			assert.match(String(reloadError), /Reload rollback failed/);
		} else {
			assert.equal(closeError, undefined);
			if (failure === "none") assert.equal((reloadError as { code?: string })?.code, "SessionClosed");
			else assert.ok(reloadError instanceof Error);
		}
		assert.equal(active.size, 0);
		assert.equal(stops.filter((id) => id === 1).length, 1);
		assert.equal(stops.filter((id) => id === 2).length, 1);
		if (failure === "cleanup") await assert.rejects(session.dispose(), { code: "ShutdownFailed" });
		else await session.dispose();
	} finally {
		release.resolve();
		await outcome;
		if (failure === "cleanup") await assert.rejects(session.dispose(), { code: "ShutdownFailed" });
		else await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: tracking admitted prompts must not deadlock a reload invoked by their slash command.
test("an admitted slash command can reload without waiting on its own prompt", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-command-reload-"));
	const settingsManager = SettingsManager.inMemory();
	let session!: AgentSession;
	let starts = 0;
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				pi.on("session_start", () => {
					starts++;
				});
				pi.registerCommand("reload-self", {
					description: "Reload this fixture",
					handler: async () => {
						await session.reload();
					},
				});
			},
		],
	});
	await resourceLoader.reload();
	({ session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	}));
	try {
		await session.prompt("/reload-self");
		assert.equal(starts, 2);
		await session.prompt("/reload-self");
		assert.equal(starts, 3);
	} finally {
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: a settled rollback failure is still failed cleanup, not forgotten when close starts later.
test("disposal retains a reload candidate cleanup failure after reload has rejected", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-rollback-failure-"));
	const settingsManager = SettingsManager.inMemory();
	let factories = 0;
	const stops: number[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				const id = ++factories;
				pi.on("session_shutdown", () => {
					stops.push(id);
					if (id === 2) throw new Error("candidate resource cleanup failed");
				});
			},
		],
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	try {
		await assert.rejects(
			session.reload({
				beforeSessionStart: () => {
					throw new Error("preparation failed");
				},
			}),
			{ code: "ShutdownFailed" },
		);
		await new Promise((resolve) => setImmediate(resolve));
		await assert.rejects(session.dispose(), { code: "ShutdownFailed" });
		assert.deepEqual(stops, [2, 1]);
	} finally {
		await session.dispose().catch(() => {});
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: reopening prompt admission for startup effects does not finish the reload transaction.
test("reload publication cannot admit an overlapping reload", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-reload-publication-"));
	const settingsManager = SettingsManager.inMemory();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let factories = 0;
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				const id = ++factories;
				pi.on("session_start", () => {
					if (id === 2) pi.sendUserMessage("startup input");
				});
				pi.on("input", async () => {
					entered.resolve();
					await release.promise;
					return { action: "handled" };
				});
			},
		],
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	const first = session.reload();
	try {
		await entered.promise;
		const second = session.reload().then(
			() => undefined,
			(error: unknown) => error,
		);
		release.resolve();
		await first;
		assert.equal(((await second) as { code?: string })?.code, "SessionClosed");
		assert.equal(factories, 2);
	} finally {
		release.resolve();
		await first;
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: manual compaction is admitted work, including noncooperative extension preflight.
test("compaction drains admitted hooks and refuses terminal admission", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-compact-close-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let effects = 0;
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async () => {
					effects++;
					entered.resolve();
					await release.promise;
					return { compactedText: "retained" };
				});
			},
		],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		settingsManager,
		resourceLoader,
		sessionManager,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	sessionManager.appendMessage({
		role: "user",
		content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
		timestamp: 0,
	});
	const before = sessionManager.getEntries().length;
	const result = session.compact({ preserve_recent: 0 }).catch((error: unknown) => error);
	try {
		await entered.promise;
		let closed = false;
		const closing = session.dispose().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(closed, false);
		release.resolve();
		await closing;
		assert.equal(((await result) as { code?: string }).code, "SessionClosed");
		await assert.rejects(session.compact(), { code: "SessionClosed" });
		await assert.rejects(session.setModel(session.model!), { code: "SessionClosed" });
		await assert.rejects(session.cycleModel(), { code: "SessionClosed" });
		await assert.rejects(session.completeStartupResources(resourceLoader), { code: "SessionClosed" });
		await assert.rejects(session.extendResourcesFromExtensions("startup"), { code: "SessionClosed" });
		assert.equal(effects, 1);
		assert.equal(sessionManager.getEntries().length, before);
	} finally {
		release.resolve();
		await result;
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: tree preflight is also work admission, even without requesting a summary.
test("tree navigation drains preflight and refuses a retired generation", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-tree-close-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				pi.on("session_before_tree", async () => {
					entered.resolve();
					await release.promise;
				});
			},
		],
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		settingsManager,
		resourceLoader,
		sessionManager,
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	const target = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 0 });
	sessionManager.appendMessage({ role: "user", content: "second", timestamp: 1 });
	const leaf = sessionManager.getLeafId();
	const result = session.navigateTree(target).catch((error: unknown) => error);
	try {
		await entered.promise;
		let closed = false;
		const closing = session.dispose().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(closed, false);
		release.resolve();
		await closing;
		assert.equal(((await result) as { code?: string }).code, "SessionClosed");
		assert.equal(sessionManager.getLeafId(), leaf);
		await assert.rejects(session.navigateTree(target), { code: "SessionClosed" });
	} finally {
		release.resolve();
		await result;
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: caller policies are resources, not replaceable extension-generation state.
test.each(["subclass", "instance"])(
	"borrowed %s policy and facade generations preserve exact resources",
	async (kind) => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-loader-policy-"));
		const raw = "Respect caller custom loader policy  \n";
		const settingsManager = SettingsManager.inMemory();
		const active = new Set<object>();
		class HostLoader extends DefaultResourceLoader {
			override getSystemPrompt() {
				return raw;
			}
		}
		const loader = new (kind === "subclass" ? HostLoader : DefaultResourceLoader)({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					const owner = {};
					pi.on("session_start", () => {
						active.add(owner);
					});
					pi.on("session_shutdown", () => {
						active.delete(owner);
					});
				},
			],
		});
		if (kind === "instance") loader.getSystemPrompt = () => raw;
		await loader.reload();
		const discovery = loader.getExtensions();
		const facade = new Proxy(loader, {
			get(target, key) {
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const create = async (resourceLoader: CreateAgentSessionOptions["resourceLoader"]) =>
			(
				await createAgentSession({
					cwd,
					agentDir: cwd,
					settingsManager,
					resourceLoader,
					sessionManager: SessionManager.inMemory(cwd),
					builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
				})
			).session;
		const a = await create(loader);
		const b = await create(facade);
		try {
			assert.ok(a instanceof AgentSession);
			assert.equal(a.resourceLoader.getSystemPrompt(), raw);
			assert.equal(b.resourceLoader.getSystemPrompt(), raw);
			assert.equal(active.size, 2);
			await b.dispose();
			assert.equal(active.size, 1);
			assert.equal(loader.getExtensions(), discovery);
			assert.equal(loader.getSystemPrompt(), raw);
		} finally {
			await a.dispose();
			await b.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
		assert.equal(active.size, 0);
	},
);

test.each([false, true])(
	"direct initial binding drains and rolls back suspended startup (failure=%s)",
	async (fail) => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-initial-bind-"));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const settingsManager = SettingsManager.inMemory();
		const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
		let active = false;
		let stops = 0;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async () => {
						entered.resolve();
						await release.promise;
						active = true;
						if (fail) throw new Error("startup failed");
					});
					pi.on("session_shutdown", () => {
						active = false;
						stops++;
					});
				},
			],
		});
		await resourceLoader.reload();
		const session = new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			cwd,
			modelRuntime,
			resourceLoader,
		});
		const startup = session.bindExtensions({}).catch((error: unknown) => error);
		await entered.promise;
		let settled = false;
		const closing = session.dispose();
		void closing.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(settled, false);
		assert.equal(stops, 0);
		release.resolve();
		assert.ok((await startup) instanceof Error);
		await closing;
		assert.equal(active, false);
		assert.equal(stops, 1);
		assert.equal(session.dispose(), closing);
		rmSync(cwd, { recursive: true, force: true });
	},
);

// #3105: failed discovered factories own their acquisitions before returning.
test("failed path factory runs registered cleanup before returning discovery diagnostics", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-path-rollback-"));
	const agentDir = join(cwd, "agent");
	const marker = join(cwd, "released");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(
		join(agentDir, "extensions", "broken.ts"),
		`import { writeFileSync } from "node:fs";
export default function(pi) {
 pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(marker)}, "released"));
 throw new Error("path factory failed");
}`,
	);
	try {
		const { session, extensionsResult } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			tools: [],
		});
		try {
			assert.equal(existsSync(marker), true);
			assert.match(extensionsResult.errors[0]!.error, /path factory failed/);
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: a captured dialog cannot open new requests while its generation retires.
test("reload seals captured input before candidate preparation and keeps successor bindings", async () => {
	const calls: string[] = [];
	const fixture = await hostSession({
		humanInput: callbackHost({
			confirm: async (title) => {
				calls.push(title);
				return true;
			},
		}),
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const oldConfirm = fixture.contexts[0]!.ui.confirm;
	const reloading = fixture.session.reload({
		beforeSessionStart: async () => {
			entered.resolve();
			await release.promise;
		},
	});
	try {
		await entered.promise;
		await assert.rejects(oldConfirm("old generation", "  raw\n"), { code: "SessionClosed" });
		assert.deepEqual(calls, []);
	} finally {
		release.resolve();
		await reloading;
	}
	try {
		assert.equal(await fixture.contexts.at(-1)!.ui.confirm("new generation", "  raw\n"), true);
		assert.deepEqual(calls, ["new generation"]);
	} finally {
		await fixture.close();
	}
});

// #3105: synchronous setters must retain their asynchronous extension execution.
test.each(["thinking", "name", "bus", "observer", "context", "shortcut"] as const)(
	"disposal drains detached %s handlers before registered cleanup",
	async (kind) => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-thinking-drain-"));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let active = 0;
		let shutdowns = 0;
		let emitBus = () => {};
		const suspend = async () => {
			entered.resolve();
			await release.promise;
			active++;
		};
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					pi.on("thinking_level_select", kind === "thinking" ? suspend : () => {});
					pi.on("session_info_changed", kind === "name" ? suspend : () => {});
					if (kind === "context") pi.on("context", suspend);
					pi.registerShortcut("ctrl+shift+j", { handler: suspend });
					pi.events.on("drain", suspend);
					emitBus = () => pi.events.emit("drain", {});
					pi.on("session_shutdown", () => {
						shutdowns++;
						active = 0;
					});
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			settingsManager,
			resourceLoader,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			tools: [],
		});
		if (kind === "thinking") assert.equal(session.setThinkingLevel("high"), undefined);
		else if (kind === "name") session.setSessionName("raw name  ");
		else if (kind === "bus") emitBus();
		else if (kind === "observer") session.extensionRunner.createContext().observeWorkflowActivity(suspend);
		else if (kind === "shortcut")
			void session.extensionRunner
				.getShortcuts({})
				.get("ctrl+shift+j")!
				.handler(session.extensionRunner.createContext());
		else void session.extensionRunner.emitContext([]);
		await entered.promise;
		let closed = false;
		const closing = session.dispose().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		const closedBeforeRelease = closed;
		const shutdownsBeforeRelease = shutdowns;
		release.resolve();
		await closing;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(closedBeforeRelease, false);
		assert.equal(shutdownsBeforeRelease, 0);
		assert.equal(active, 0);
		assert.equal(shutdowns, 1);
		if (kind === "context") await assert.rejects(session.extensionRunner.emitContext([]), { code: "SessionClosed" });
		rmSync(cwd, { recursive: true, force: true });
	},
);

// #3105: rollback failure is not an ordinary extension discovery diagnostic.
test.each(["path", "inline"] as const)("failed %s factory rejects with original and cleanup causes", async (kind) => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-factory-causes-"));
	const agentDir = join(cwd, "agent");
	const settingsManager = SettingsManager.inMemory();
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	const source = `export default function(pi) {
		pi.on("session_shutdown", () => { throw new Error("cleanup rejected"); });
		throw new Error("factory rejected");
	}`;
	if (kind === "path") writeFileSync(join(agentDir, "extensions", "broken.ts"), source);
	const resourceLoader =
		kind === "inline"
			? new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager,
					extensionFactories: [
						(pi) => {
							pi.on("session_shutdown", () => {
								throw new Error("cleanup rejected");
							});
							throw new Error("factory rejected");
						},
					],
				})
			: undefined;
	try {
		const creation =
			kind === "inline"
				? resourceLoader!.reload()
				: createAgentSession({
						cwd,
						agentDir,
						settingsManager,
						sessionManager: SessionManager.inMemory(cwd),
						builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
						tools: [],
					});
		await assert.rejects(creation, (error: Error & { code?: string }) => {
			assert.equal(error.code, "ShutdownFailed");
			assert.ok(error instanceof AggregateError);
			assert.deepEqual(
				error.errors.map((cause: Error) => cause.message),
				["factory rejected", "cleanup rejected"],
			);
			return true;
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: sealing fresh dispatch must not discard already completed conversation events.
test("closing preserves queued message persistence and completion hooks", async () => {
	const { createAssistantMessageEventStream } = await import("@bastani/pi-ai/compat");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const completed = Promise.withResolvers<void>();
	const cwd = mkdtempSync(join(tmpdir(), "sdk-queued-persistence-"));
	const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null });
	await modelRuntime.setRuntimeApiKey("anthropic", "fixture", {});
	const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
	const events: string[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				// Provider requests wait for queued session events to settle, so the gate
				// holds the run open after the conversation events completed instead of
				// blocking the first request.
				pi.on("agent_end", async () => {
					entered.resolve();
					await release.promise;
				});
				pi.on("message_start", (event) => {
					events.push(`start:${event.message.role}`);
				});
				pi.on("message_end", (event) => {
					events.push(`end:${event.message.role}`);
				});
			},
		],
	});
	modelRuntime.streamSimple = (model) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "completed before close" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
			stream.end();
			completed.resolve();
		});
		return stream;
	};
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime,
		model: getModel("anthropic", "claude-sonnet-4-5"),
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		tools: [],
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	try {
		const turn = session.prompt("preserve this prompt");
		await entered.promise;
		await completed.promise;
		await new Promise((resolve) => setTimeout(resolve, 30));
		const closing = session.dispose();
		release.resolve();
		await Promise.all([turn, closing]);
		assert.deepEqual(
			session.sessionManager.buildSessionContext().messages.map((message) => message.role),
			["system", "user", "assistant"],
		);
		assert.deepEqual(events, [
			"start:system",
			"end:system",
			"start:user",
			"end:user",
			"start:assistant",
			"end:assistant",
		]);
	} finally {
		release.resolve();
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: candidate factories belong to rollback even before a transaction/runner exists.
test.each(["override", "cleanup"] as const)("failed reload preparation releases acquisitions: %s", async (failure) => {
	const cwd = mkdtempSync(join(tmpdir(), "sdk-prepare-rollback-"));
	const settingsManager = SettingsManager.inMemory();
	let fail = false;
	let next = 0;
	const active = new Set<number>();
	const shutdowns: number[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				const id = ++next;
				active.add(id);
				pi.on("session_shutdown", () => {
					active.delete(id);
					shutdowns.push(id);
					if (fail && id === 2 && failure === "cleanup") throw new Error("earlier cleanup failed");
				});
			},
			(pi) => {
				if (fail && failure === "cleanup") {
					pi.on("session_shutdown", () => {
						throw new Error("later cleanup failed");
					});
					throw new Error("later factory failed");
				}
			},
		],
		extensionsOverride: (base) => {
			if (fail && failure === "override") throw new Error("override failed");
			return base;
		},
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		tools: [],
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	try {
		fail = true;
		const error = await session.reload().then(
			() => undefined,
			(cause: unknown) => cause,
		);
		assert.ok(error instanceof Error);
		assert.deepEqual([...active], [1], "borrowed old generation survives; failed candidate is released");
		if (failure === "cleanup") {
			assert.equal((error as Error & { code: string }).code, "ShutdownFailed");
			const messages = (cause: unknown): string =>
				cause instanceof AggregateError ? [...cause.errors].map(messages).join(";") : String(cause);
			assert.match(messages(error), /later factory failed/);
			assert.match(messages(error), /later cleanup failed/);
			assert.match(messages(error), /earlier cleanup failed/);
		}
	} finally {
		await session.dispose().catch((error) => {
			if (failure !== "cleanup") throw error;
			assert.equal(error.code, "ShutdownFailed");
		});
		rmSync(cwd, { recursive: true, force: true });
	}
	assert.deepEqual([...active], []);
	assert.deepEqual(shutdowns, [2, 1]);
});

// #3105: cancellation of current and superseded summaries is not their settlement.
test.each([1, 2])("disposal drains %i admitted background summaries", async (count) => {
	const { createAssistantMessageEventStream } = await import("@bastani/pi-ai/compat");
	const cwd = mkdtempSync(join(tmpdir(), "sdk-summary-drain-"));
	const release = Promise.withResolvers<void>();
	const signals: AbortSignal[] = [];
	let active = 0;
	const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null });
	await modelRuntime.setRuntimeApiKey("anthropic", "fixture", {});
	modelRuntime.streamSimple = (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const complete = () => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "response" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
			stream.end();
		};
		if (JSON.stringify(context.messages).includes("Describe this coding session in one short sentence")) {
			active++;
			signals.push(options!.signal!);
			void release.promise.then(() => {
				active--;
				complete();
			});
		} else queueMicrotask(complete);
		return stream;
	};
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime,
		model: getModel("anthropic", "claude-sonnet-4-5"),
		settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: true } }),
		sessionManager: SessionManager.inMemory(cwd),
		tools: [],
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		extensionBindings: { mode: "rpc" },
	});
	try {
		for (let index = 0; index < count; index++) {
			await session.prompt(`turn ${index}`);
			await vi.waitFor(() => assert.equal(active, index + 1));
		}
		let closed = false;
		const closing = session.dispose().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		const beforeRelease = closed;
		assert.ok(signals.every((signal) => signal.aborted));
		release.resolve();
		await closing;
		assert.equal(beforeRelease, false);
		assert.equal(active, 0);
		assert.equal(
			session.sessionManager.getEntries().some((entry) => entry.type === "session_summary"),
			false,
		);
	} finally {
		release.resolve();
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: the tool has already executed; closing must retain its result and hook.
test("closing preserves admitted tool results", async () => {
	const { createAssistantMessageEventStream } = await import("@bastani/pi-ai/compat");
	const cwd = mkdtempSync(join(tmpdir(), "sdk-tool-completion-"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null });
	await modelRuntime.setRuntimeApiKey("anthropic", "fixture", {});
	let calls = 0;
	let hooks = 0;
	modelRuntime.streamSimple = (model) => {
		const stream = createAssistantMessageEventStream();
		const tool = ++calls === 1;
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: tool ? "toolUse" : "stop",
				message: {
					role: "assistant",
					content: tool
						? [{ type: "toolCall", id: "one", name: "fixture_effect", arguments: {} }]
						: [{ type: "text", text: "done" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: tool ? "toolUse" : "stop",
					timestamp: Date.now(),
				},
			});
			stream.end();
		});
		return stream;
	};
	const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				pi.on("tool_result", () => {
					hooks++;
					return { content: [{ type: "text", text: "  completed\n" }] };
				});
			},
		],
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime,
		model: getModel("anthropic", "claude-sonnet-4-5"),
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		customTools: [
			{
				name: "fixture_effect",
				label: "effect",
				description: "fixture",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					entered.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "completed" }], details: { completed: true } };
				},
			},
		],
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	try {
		session.setActiveToolsByName(["fixture_effect"]);
		const turn = session.prompt("run fixture");
		await entered.promise;
		const closing = session.dispose();
		release.resolve();
		await Promise.all([turn, closing]);
		const result = session.sessionManager
			.buildSessionContext()
			.messages.find((message) => message.role === "toolResult");
		assert.equal(hooks, 1);
		assert.ok(result?.role === "toolResult");
		assert.equal(result.isError, false);
		assert.deepEqual(result.content, [{ type: "text", text: "  completed\n" }]);
		assert.deepEqual(result.details, { completed: true });
	} finally {
		release.resolve();
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: ordinary custom loaders have the same acquisition rollback obligation.
test.each([false, true])(
	"nontransactional reload rolls back owned acquisitions, cleanup failure=%s",
	async (cleanupFailure) => {
		const cwd = mkdtempSync(join(tmpdir(), "sdk-ordinary-rollback-"));
		const settingsManager = SettingsManager.inMemory();
		let fail = false;
		let next = 0;
		const active = new Set<number>();
		class OrdinaryLoader extends DefaultResourceLoader {
			override supportsTransactionalReload() {
				return false;
			}
		}
		const resourceLoader = new OrdinaryLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					const id = ++next;
					active.add(id);
					pi.on("session_shutdown", () => {
						active.delete(id);
						if (id === 3 && cleanupFailure) throw new Error("candidate cleanup failed");
					});
				},
			],
			extensionsOverride: (base) => {
				if (fail) throw new Error("discovery failed");
				return base;
			},
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			tools: [],
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		});
		try {
			assert.deepEqual([...active], [1, 2]);
			fail = true;
			await assert.rejects(session.reload(), cleanupFailure ? { code: "ShutdownFailed" } : /discovery failed/);
			assert.deepEqual([...active], [1], "only caller-owned discovery survives");
		} finally {
			await session.dispose().catch((error) => {
				if (!cleanupFailure) throw error;
				assert.equal(error.code, "ShutdownFailed");
			});
			rmSync(cwd, { recursive: true, force: true });
		}
		assert.deepEqual([...active], [1]);
	},
);

// Each `/replace-me` continuation waits on a real `ctx.newSession()`: a fresh
// `createAgentSession` with its own resource loader, extension binding and model
// runtime. Two of those in sequence on a loaded runner exceed `vi.waitFor`'s 1 s
// default, so the resume wait gets a budget sized for the structural cost.
const COMMAND_REPLACEMENT_RESUME_TIMEOUT_MS = 15_000;

// #3105: replacement hands off its invoking command, but terminal close still owns it.
test.each([1, 2])(
	"command replacement drains peers and retains %s continuations until terminal cleanup",
	async (count) => {
		const { createAgentSessionRuntime } = await import("../src/core/agent-session-runtime.ts");
		const { createEventBus } = await import("../src/core/event-bus.ts");
		const eventBus = createEventBus();
		const retiredDeliveries: number[] = [];
		const cwd = mkdtempSync(join(tmpdir(), "sdk-command-retirement-"));
		const settingsManager = SettingsManager.inMemory();
		const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null });
		const peerEntered = Promise.withResolvers<void>();
		const peerRelease = Promise.withResolvers<void>();
		const commandEntered = Promise.withResolvers<void>();
		const continuation = Promise.withResolvers<void>();
		let generations = 0;
		let resumed = false;
		let active = 0;
		const shutdowns: number[] = [];
		let entered = 0;
		let returns = 0;
		const joinReplacement = Promise.withResolvers<void>();
		const runtime = await createAgentSessionRuntime(
			async ({ sessionManager, sessionStartEvent }) => {
				const id = ++generations;
				const resourceLoader = new DefaultResourceLoader({
					cwd,
					agentDir: cwd,
					settingsManager,
					noExtensions: true,
					eventBus,
					extensionFactories: [
						(pi) => {
							pi.events.on("retired-replacement", () => {
								retiredDeliveries.push(id);
							});
							pi.on("thinking_level_select", async () => {
								peerEntered.resolve();
								await peerRelease.promise;
							});
							pi.on("session_shutdown", () => {
								shutdowns.push(id);
								if (id === 1) active = 0;
								if (id === 1) pi.events.emit("retired-replacement");
							});
							pi.registerCommand("replace-me", {
								description: "fixture",
								handler: async (_args, ctx) => {
									entered++;
									commandEntered.resolve();
									if (entered === 2) await joinReplacement.promise;
									await ctx.newSession();
									returns++;
									resumed = returns === count;
									await continuation.promise;
									active++;
								},
							});
						},
					],
				});
				return {
					...(await createAgentSession({
						cwd,
						agentDir: cwd,
						sessionManager,
						sessionStartEvent,
						settingsManager,
						modelRuntime,
						model: getModel("anthropic", "claude-sonnet-4-5"),
						resourceLoader,
						builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
					})),
					services: { cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader, diagnostics: [] },
					diagnostics: [],
				};
			},
			{ cwd, agentDir: cwd, sessionManager: SessionManager.inMemory(cwd) },
		);
		const old = runtime.session;
		await old.bindExtensions({
			commandContextActions: {
				waitForIdle: async () => {},
				newSession: (options) => runtime.newSession(options),
				fork: (id, options) => runtime.fork(id, options),
				navigateTree: (id, options) => runtime.session.navigateTree(id, options),
				switchSession: (file, options) => runtime.switchSession(file, options),
				reload: () => runtime.session.reload(),
			},
		});
		old.setThinkingLevel("high");
		await peerEntered.promise;
		const turns = Array.from({ length: count }, () => old.prompt("/replace-me"));
		const turn = Promise.all(turns);
		await commandEntered.promise;
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(generations, 1, "unrelated admitted work must drain before handoff");
			joinReplacement.resolve();
			peerRelease.resolve();
			await vi.waitFor(() => assert.equal(resumed, true), { timeout: COMMAND_REPLACEMENT_RESUME_TIMEOUT_MS });
			assert.equal(generations, count + 1);
			assert.equal(shutdowns.includes(1), false, "old cleanup waits for every continuation");
			await assert.rejects(old.prompt("late"), { code: "SessionClosed" });
			let closed = false;
			const closing = runtime.dispose().then(() => {
				closed = true;
			});
			let oldClosed = false;
			const oldClosing = old.dispose().then(() => {
				oldClosed = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(closed, false);
			assert.equal(oldClosed, false);
			continuation.resolve();
			await Promise.all([turn, closing, oldClosing]);
			assert.equal(active, 0);
			assert.ok(shutdowns.includes(1));
			assert.deepEqual(retiredDeliveries, [], "retired cleanup cannot deliver into a replacement sharing the bus");
		} finally {
			peerRelease.resolve();
			joinReplacement.resolve();
			continuation.resolve();
			if (resumed) await runtime.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: publication is still candidate-owned until activation and commit succeed.
test.each(["activate", "commit", "settings", "activate-cleanup"])("reload publication rollback at %s", async (mode) => {
	const cwd = mkdtempSync(join(tmpdir(), "sdk-publication-rollback-"));
	const settingsManager = SettingsManager.inMemory();
	const active = new Set<number>();
	let next = 0;
	class Loader extends DefaultResourceLoader {
		override async prepareReload(...args: Parameters<DefaultResourceLoader["prepareReload"]>) {
			const transaction = await super.prepareReload(...args);
			return {
				...transaction,
				activate: (settings: SettingsManager) => {
					if (mode.startsWith("activate")) throw new Error("activation failed");
					transaction.activate(settings);
				},
				prepareCommit: () => {
					const prepared = transaction.prepareCommit!();
					return {
						...prepared,
						commit: () => {
							if (mode === "commit") throw new Error("commit failed");
							prepared.commit();
						},
					};
				},
			};
		}
	}
	const resourceLoader = new Loader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				const id = ++next;
				pi.on("session_start", () => {
					active.add(id);
				});
				pi.on("session_shutdown", () => {
					active.delete(id);
					if (mode === "activate-cleanup" && id === 4) throw new Error("candidate cleanup failed");
				});
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		tools: [],
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	if (mode === "settings") {
		const prepare = settingsManager.prepareReload.bind(settingsManager);
		settingsManager.prepareReload = async () => ({
			...(await prepare()),
			commit: () => {
				throw new Error("settings commit failed");
			},
		});
	}
	try {
		await assert.rejects(session.reload(), mode.endsWith("cleanup") ? { code: "ShutdownFailed" } : /failed/);
		assert.deepEqual([...active], [2], "only the original generation remains owned");
	} finally {
		await session.dispose().catch((error) => {
			if (!mode.endsWith("cleanup")) throw error;
			assert.equal(error.code, "ShutdownFailed");
		});
		rmSync(cwd, { recursive: true, force: true });
	}
	assert.equal(active.size, 0);
});

// #3105: installing a successor must not lose retiring ownership if reconstruction throws.
test.each(["failure", "shutdown", "invalidation", "control"])(
	"postcommit rebuild retains retiring cleanup: %s",
	async (mode) => {
		const cwd = mkdtempSync(join(tmpdir(), "sdk-postcommit-cleanup-"));
		const settingsManager = SettingsManager.inMemory();
		const active = new Set<number>();
		const stopped: number[] = [];
		const setupError = new Error("postcommit prompt failed");
		const shutdownError = new Error("retiring shutdown failed");
		const invalidationError = new Error("retiring invalidation failed");
		let committed = false;
		let next = 0;
		class Loader extends DefaultResourceLoader {
			override getSystemPrompt() {
				if (committed && mode !== "control") throw setupError;
				return super.getSystemPrompt();
			}
			override async prepareReload(...args: Parameters<DefaultResourceLoader["prepareReload"]>) {
				const transaction = await super.prepareReload(...args);
				return {
					...transaction,
					prepareCommit: () => {
						const prepared = transaction.prepareCommit!();
						return {
							...prepared,
							commit: () => {
								prepared.commit();
								committed = true;
							},
						};
					},
				};
			}
		}
		const resourceLoader = new Loader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					const id = ++next;
					pi.on("session_start", () => {
						active.add(id);
					});
					pi.on("session_shutdown", () => {
						active.delete(id);
						stopped.push(id);
						if (id === 2 && mode === "shutdown") throw shutdownError;
					});
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			tools: [],
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		});
		const oldRunner = session.extensionRunner;
		const invalidate = oldRunner.invalidate.bind(oldRunner);
		let invalidated = false;
		oldRunner.invalidate = (...args) => {
			invalidated = true;
			invalidate(...args);
			if (mode === "invalidation") throw invalidationError;
		};
		const causes = (error: unknown): unknown[] =>
			error instanceof AggregateError
				? [error, ...error.errors.flatMap(causes)]
				: error instanceof Error && error.cause
					? [error, ...causes(error.cause)]
					: [error];
		try {
			if (mode === "control") await session.reload();
			else
				await assert.rejects(session.reload(), (error) => {
					const all = causes(error);
					assert.ok(all.includes(setupError));
					if (mode === "invalidation") assert.ok(all.includes(invalidationError));
					if (mode === "shutdown") assert.match(all.map(String).join("\n"), /retiring shutdown failed/);
					return true;
				});
			assert.deepEqual([...active], [4]);
			assert.equal(invalidated, true);
		} finally {
			await session.dispose().catch((error) => {
				assert.ok(mode === "shutdown" || mode === "invalidation");
				assert.equal(error.code, "ShutdownFailed");
			});
			rmSync(cwd, { recursive: true, force: true });
		}
		assert.equal(active.size, 0);
		assert.deepEqual(stopped, [3, 2, 4], "discovery acquisition also cleans up before the two started generations");
	},
);

// #3105: preparation discovery is owned even when composition re-instantiates it.
test.each(["success", "failure", "cleanup"])("reload preparation transfers every acquisition: %s", async (mode) => {
	const cwd = mkdtempSync(join(tmpdir(), "sdk-prepared-ownership-"));
	const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
	const active = new Set<number>();
	let next = 0;
	class Loader extends DefaultResourceLoader {
		override getSystemPrompt() {
			return super.getSystemPrompt();
		}
	}
	const resourceLoader = new Loader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				const id = ++next;
				active.add(id);
				pi.on("session_shutdown", () => {
					active.delete(id);
					if (mode === "cleanup" && id === 3) throw new Error("prepared cleanup failed");
				});
			},
		],
	});
	await resourceLoader.reload();
	const discovery = resourceLoader.getExtensions();
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		tools: [],
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	try {
		const reload = session.reload(
			mode === "failure"
				? {
						beforeSessionStart: () => {
							throw new Error("declined reload");
						},
					}
				: undefined,
		);
		if (mode === "success") await reload;
		else await assert.rejects(reload, mode === "cleanup" ? { code: "ShutdownFailed" } : /declined reload/);
		if (mode !== "success") assert.equal(resourceLoader.getExtensions(), discovery);
		assert.equal(active.has(3), false, "unpublished preparation acquisition must be released");
	} finally {
		await session.dispose().catch((error) => {
			assert.equal(mode, "cleanup");
			assert.equal(error.code, "ShutdownFailed");
		});
		rmSync(cwd, { recursive: true, force: true });
	}
	assert.deepEqual([...active], [1], "only caller discovery remains borrowed");
});

// #3105: candidate startup rejection must not race its admitted callbacks.
test.each([false, true])("failed reload candidate drains callbacks before cleanup: %s", async (cleanupFails) => {
	const cwd = mkdtempSync(join(tmpdir(), "sdk-candidate-callback-"));
	const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
	let release!: () => void;
	let enter!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let candidate = false;
	let next = 0;
	const active = new Set<number>();
	const shutdowns: number[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				const id = ++next;
				pi.events.on("acquire", async () => {
					enter();
					await gate;
					active.add(id);
				});
				pi.on("session_start", () => {
					if (candidate) {
						pi.events.emit("acquire");
						throw new Error("candidate failed");
					}
				});
				pi.on("session_shutdown", () => {
					shutdowns.push(id);
					active.delete(id);
					if (id === 2 && cleanupFails) throw new Error("candidate cleanup failed");
				});
			},
		],
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		tools: [],
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	candidate = true;
	let settled = false;
	const reload = session.reload().then(
		() => {
			settled = true;
			return undefined;
		},
		(error) => {
			settled = true;
			return error;
		},
	);
	try {
		await entered;
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(settled, false);
		assert.deepEqual(shutdowns, []);
	} finally {
		release();
		const error = await reload;
		assert.ok(error);
		if (cleanupFails) assert.equal(error.code, "ShutdownFailed");
		await session.dispose().catch((error) => {
			assert.equal(cleanupFails, true);
			assert.equal(error.code, "ShutdownFailed");
		});
		rmSync(cwd, { recursive: true, force: true });
	}
	assert.equal(active.size, 0);
	assert.deepEqual(shutdowns, [2, 1]);
});

// #3105: self-reload hands off, but its invoking continuation still owns old cleanup.
test.each([false, true])("self reload retains invoking continuation cleanup: %s", async (cleanupFails) => {
	const cwd = mkdtempSync(join(tmpdir(), "sdk-reload-caller-"));
	const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
	let release!: () => void;
	let enter!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const returned = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let session!: AgentSession;
	let next = 0;
	const active = new Set<number>();
	const shutdowns: number[] = [];
	const capabilities: Array<{ write: () => void; host: () => object }> = [];
	const retiredDeliveries: number[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				const id = ++next;
				pi.on("session_start", (_event, ctx) => {
					capabilities.push({
						write: () => pi.setSessionName(`generation-${id}`),
						host: () => ctx.getAgentTaskHost(),
					});
				});
				pi.events.on("retired-cleanup", () => {
					retiredDeliveries.push(id);
				});
				pi.registerCommand("reload-acquire", {
					description: "reload then acquire",
					handler: async () => {
						await session.reload();
						enter();
						await gate;
						active.add(id);
					},
				});
				pi.on("session_shutdown", (_event, ctx) => {
					assert.equal(ctx.cwd, cwd, "shutdown retains scoped cleanup capabilities");
					assert.equal(pi.getSessionName(), "generation-2");
					if (id === 1) {
						assert.throws(() => pi.setSessionName("retired-cleanup-write"), /stale|no longer active/i);
						assert.throws(() => ctx.getAgentTaskHost(), /stale|no longer active/i);
						pi.events.emit("retired-cleanup");
					}
					shutdowns.push(id);
					active.delete(id);
					if (id === 1 && cleanupFails) throw new Error("retiring cleanup failed");
				});
			},
		],
	});
	({ session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		tools: [],
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	}));
	const prompt = session.prompt("/reload-acquire");
	let close: Promise<void> | undefined;
	try {
		await Promise.race([returned, prompt.catch(() => {})]);
		assert.deepEqual(shutdowns, [], "old cleanup cannot precede the command continuation");
		assert.throws(capabilities[0].write, /stale|no longer active/i);
		assert.throws(capabilities[0].host, /stale|no longer active/i);
		capabilities[1].write();
		assert.ok(capabilities[1].host());
		assert.equal(session.sessionManager.getSessionName(), "generation-2");
		let closed = false;
		close = session.dispose();
		void close.then(
			() => {
				closed = true;
			},
			() => {
				closed = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(closed, false);
	} finally {
		release();
		await prompt.catch((error) => {
			assert.equal(cleanupFails, true);
			assert.equal(error.code, "ShutdownFailed");
		});
		await (close ?? session.dispose()).catch((error) => {
			assert.equal(cleanupFails, true);
			assert.equal(error.code, "ShutdownFailed");
		});
		rmSync(cwd, { recursive: true, force: true });
	}
	assert.deepEqual(shutdowns, [1, 2]);
	assert.equal(active.size, 0);
	assert.deepEqual(retiredDeliveries, []);
});

// #3105: discovery selection cannot discard ownership or revoke selected capabilities.
test.each(["subset", "none", "all", "startup", "cleanup"])(
	"filtered creation owns every acquisition: %s",
	async (mode) => {
		const cwd = mkdtempSync(join(tmpdir(), "sdk-filtered-"));
		const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
		const active = new Set<string>();
		const stopped: string[] = [];
		const started: string[] = [];
		let calls = 0;
		let omittedCalls = 0;
		const writes = new Map<string, () => void>();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: ["keep", "omit"].map((name) => (pi) => {
				active.add(name);
				writes.set(name, () => pi.setSessionName("omitted-write"));
				pi.events.on("selected-ping", () => {
					if (name === "keep") calls++;
					else omittedCalls++;
				});
				pi.registerCommand(name, {
					description: name,
					handler: async (_args, ctx) => {
						pi.setSessionName("  selected\n");
						assert.ok(ctx.getAgentTaskHost());
						pi.events.emit("selected-ping");
					},
				});
				pi.on("session_start", () => {
					started.push(name);
					if (mode === "startup") throw new Error("selected startup failed");
				});
				pi.on("session_shutdown", () => {
					stopped.push(name);
					active.delete(name);
					if (mode === "cleanup" && name === "omit") throw new Error("omitted cleanup failed");
				});
			}),
			extensionsOverride: (base) => ({
				...base,
				extensions: mode === "all" ? base.extensions : base.extensions.slice(0, mode === "none" ? 0 : 1),
			}),
		});
		let session: AgentSession | undefined;
		try {
			const creation = createAgentSession({
				cwd,
				agentDir: cwd,
				settingsManager,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(cwd),
				tools: [],
				builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			});
			if (mode === "startup" || mode === "cleanup") {
				await assert.rejects(creation, (error: Error & { code?: string }) => {
					if (mode === "cleanup") assert.equal(error.code, "ShutdownFailed");
					const messages = (cause: unknown): string =>
						cause instanceof AggregateError ? cause.errors.map(messages).join(";") : String(cause);
					assert.match(messages(error), mode === "cleanup" ? /omitted cleanup failed/ : /selected startup failed/);
					return true;
				});
			} else {
				({ session } = await creation);
				assert.deepEqual(started, mode === "none" ? [] : mode === "all" ? ["keep", "omit"] : ["keep"]);
				assert.deepEqual(
					session.extensionRunner.getRegisteredCommands().map((command) => command.name),
					started,
				);
				if (mode !== "all") assert.throws(writes.get("omit")!, /stale|no longer active/i);
				if (mode !== "none") {
					await session.prompt("/keep");
					assert.equal(session.sessionManager.getSessionName(), "selected");
					assert.equal(calls, 1);
					assert.equal(omittedCalls, mode === "all" ? 1 : 0, "omitted subscriptions are released");
				}
			}
		} finally {
			await session?.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
		assert.deepEqual([...active], []);
		assert.deepEqual(stopped.sort(), ["keep", "omit"]);
	},
);

// #3105: reload transfers selected factories, not the shared runtime's omitted owners.
test.each(["subset", "none", "all", "rollback", "cleanup"])(
	"filtered reload preserves owner boundaries: %s",
	async (mode) => {
		const cwd = mkdtempSync(join(tmpdir(), "sdk-filtered-reload-"));
		const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
		const records: Array<{ name: string; generation: number; calls: number; stops: number; write: () => void }> = [];
		let generation = 0;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: ["keep", "omit"].map((name) => (pi) => {
				if (name === "keep") generation++;
				const record = {
					name,
					generation,
					calls: 0,
					stops: 0,
					write: () => pi.setSessionName(`selected-${generation}`),
				};
				records.push(record);
				pi.events.on("selected-ping", () => {
					record.calls++;
				});
				pi.registerCommand(name, {
					description: name,
					handler: async (_args, ctx) => {
						record.write();
						assert.ok(ctx.getAgentTaskHost());
						pi.events.emit("selected-ping");
					},
				});
				pi.on("session_shutdown", () => {
					record.stops++;
					if (mode === "cleanup" && record.generation === 2 && name === "omit")
						throw new Error("omitted reload cleanup failed");
				});
			}),
			extensionsOverride: (base) => ({
				...base,
				extensions: mode === "all" ? base.extensions : base.extensions.slice(0, mode === "none" ? 0 : 1),
			}),
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			tools: [],
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		});
		try {
			const reload = session.reload({
				beforeSessionStart: async () => {
					if (mode === "rollback") throw new Error("candidate rejected");
				},
			});
			if (mode === "rollback" || mode === "cleanup") {
				await assert.rejects(reload, mode === "rollback" ? /candidate rejected/ : { code: "ShutdownFailed" });
				assert.equal(records.find((r) => r.generation === 1 && r.name === "keep")!.stops, 0);
				for (const record of records.filter((r) => r.generation === 2)) {
					assert.equal(record.stops, 1);
					assert.throws(record.write, /stale|no longer active/i);
				}
			} else await reload;
			if (mode !== "none") {
				await session.prompt("/keep");
				const current = mode === "rollback" || mode === "cleanup" ? 1 : 2;
				assert.equal(records.find((r) => r.generation === current && r.name === "keep")!.calls, 1);
				assert.equal(
					records.find((r) => r.generation === current && r.name === "omit")!.calls,
					mode === "all" ? 1 : 0,
				);
			}
			for (const record of records.filter((r) => r.stops > 0))
				assert.throws(record.write, /stale|no longer active/i);
		} finally {
			await session.dispose().catch((error) => {
				assert.equal(mode, "cleanup");
				assert.equal(error.code, "ShutdownFailed");
			});
			rmSync(cwd, { recursive: true, force: true });
		}
		assert.ok(records.every((r) => r.stops === 1));
	},
);

// #3105: direct captured actions obey the same synchronous seal as dispatched work.
test.each(["close", "reload", "rollback", "cancel"])(
	"direct extension admission seals before awaiting: %s",
	async (mode) => {
		const cwd = mkdtempSync(join(tmpdir(), "sdk-direct-admission-"));
		const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
		let api!: import("../src/index.js").ExtensionAPI;
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let completedCleanup = false;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						api = pi;
					});
					pi.on("session_shutdown", async () => {
						if (mode === "close") {
							enter();
							await gate;
							pi.appendEntry("cleanup", { complete: true });
							completedCleanup = true;
						}
					});
				},
			],
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			tools: [],
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		});
		const exec = () => api.exec(process.execPath, ["-e", 'process.stdout.write("allowed")']);
		let operation: Promise<void> | undefined;
		let close: Promise<void> | undefined;
		try {
			assert.equal((await exec()).stdout, "allowed");
			await session.abort();
			assert.equal((await exec()).stdout, "allowed");
			const retired = api;
			operation =
				mode === "close"
					? session.dispose()
					: session.reload({
							beforeSessionStart: async () => {
								enter();
								await gate;
								if (mode === "rollback") throw new Error("reject candidate");
							},
						});
			void operation.catch(() => {});
			const refuses = () => {
				assert.throws(
					() => retired.exec(process.execPath, ["-e", 'throw Error("must not launch")']),
					/closed|stale|no longer active/i,
				);
				assert.throws(() => retired.setSessionName("unadmitted"), /closed|stale|no longer active/i);
				assert.throws(
					() => retired.registerCommand("unadmitted", { description: "forbidden", handler: async () => {} }),
					/closed|stale|no longer active/i,
				);
				assert.throws(() => retired.events.on("unadmitted", () => {}), /closed|stale|no longer active/i);
			};
			refuses();
			await entered;
			refuses();
			if (mode === "cancel") {
				close = session.dispose();
				void close.catch(() => {});
			}
			release();
			if (mode === "rollback") await assert.rejects(operation, /reject candidate/);
			else if (mode === "cancel") await assert.rejects(operation, { code: "SessionClosed" });
			else await operation;
			if (mode === "reload" || mode === "rollback") assert.equal((await exec()).stdout, "allowed");
			if (mode === "close") assert.equal(completedCleanup, true);
		} finally {
			release();
			await operation?.catch(() => {});
			await (close ?? session.dispose());
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: a subprocess admitted before the seal remains owned through completion.
test("direct extension execution drains before shutdown", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "sdk-exec-drain-"));
	const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
	let api!: import("../src/index.js").ExtensionAPI;
	let shutdown = false;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				pi.on("session_start", () => {
					api = pi;
				});
				pi.on("session_shutdown", () => {
					shutdown = true;
				});
			},
		],
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		settingsManager,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		tools: [],
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	const child = api.exec(process.execPath, [
		"-e",
		'const fs=require("node:fs"); fs.writeFileSync("started", ""); const timer=setInterval(()=>{if(fs.existsSync("release")){clearInterval(timer);process.stdout.write("completed");}},10);',
	]);
	let close: Promise<void> | undefined;
	try {
		await vi.waitFor(() => assert.equal(existsSync(join(cwd, "started")), true));
		close = session.dispose();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(shutdown, false, "shutdown cannot precede admitted subprocess completion");
		writeFileSync(join(cwd, "release"), "");
		assert.equal((await child).stdout, "completed");
		await close;
		assert.equal(shutdown, true);
	} finally {
		writeFileSync(join(cwd, "release"), "");
		await child;
		await (close ?? session.dispose());
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: replacement's deferred cleanup cannot notify a live successor on a borrowed bus.
test("retired replacement cleanup cannot deliver successor events", async () => {
	const { createAgentSessionRuntime } = await import("../src/core/agent-session-runtime.ts");
	const { createEventBus } = await import("../src/core/event-bus.ts");
	const cwd = mkdtempSync(join(tmpdir(), "sdk-retired-replacement-"));
	const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null });
	const eventBus = createEventBus();
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const cleaned = Promise.withResolvers<void>();
	const deliveries: number[] = [];
	let generation = 0;
	const runtime = await createAgentSessionRuntime(
		async ({ sessionManager, sessionStartEvent }) => {
			const id = ++generation;
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: cwd,
				settingsManager,
				eventBus,
				noExtensions: true,
				extensionFactories: [
					(pi) => {
						pi.events.on("retired", () => {
							deliveries.push(id);
						});
						pi.registerCommand("replace", {
							description: "replace",
							handler: async (_args, ctx) => {
								await ctx.newSession();
								entered.resolve();
								await gate.promise;
							},
						});
						pi.on("session_shutdown", () => {
							if (id === 1) {
								pi.events.emit("retired");
								cleaned.resolve();
							}
						});
					},
				],
			});
			return {
				...(await createAgentSession({
					cwd,
					agentDir: cwd,
					settingsManager,
					modelRuntime,
					resourceLoader,
					sessionManager,
					sessionStartEvent,
					tools: [],
					builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
				})),
				services: { cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader, diagnostics: [] },
				diagnostics: [],
			};
		},
		{ cwd, agentDir: cwd, sessionManager: SessionManager.inMemory(cwd) },
	);
	await runtime.session.bindExtensions({
		commandContextActions: { newSession: (options) => runtime.newSession(options) },
	});
	const prompt = runtime.session.prompt("/replace");
	try {
		await entered.promise;
		gate.resolve();
		await prompt;
		await cleaned.promise;
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(deliveries, []);
		assert.equal(generation, 2);
	} finally {
		gate.resolve();
		await prompt;
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: rollback must not ask the failed resource view for permission to clean acquisitions.
test.each(["ordinary", "ordinary-cleanup", "transaction", "transaction-cleanup", "after-transfer", "control"])(
	"reload acquisition rollback survives unavailable views (%s)",
	async (mode) => {
		const cwd = mkdtempSync(join(tmpdir(), "sdk-getter-rollback-"));
		const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
		const modelRuntime = await ModelRuntime.create({
			authPath: join(cwd, "auth"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const primary = new Error("extension view unavailable");
		const cleanup = new Error("acquisition cleanup failed");
		const active = new Set<number>();
		let next = 0;
		let unavailable = false;
		class Loader extends DefaultResourceLoader {
			override supportsTransactionalReload() {
				return mode.startsWith("transaction");
			}
			override getExtensions() {
				if (unavailable) throw primary;
				return super.getExtensions();
			}
			override async reload() {
				await super.reload();
				if (next > 1 && mode !== "control" && mode !== "after-transfer") unavailable = true;
			}
			override async prepareReload(): Promise<never> {
				await this.reload();
				throw primary;
			}
		}
		const loader = new Loader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					const id = ++next;
					active.add(id);
					pi.on("session_shutdown", () => {
						active.delete(id);
						if (id > 1 && mode.endsWith("cleanup")) throw cleanup;
					});
				},
			],
		});
		await loader.reload();
		const session = new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			cwd,
			modelRuntime,
			resourceLoader: loader,
		});
		await session.bindExtensions({});
		try {
			const error = await session
				.reload({
					beforeSessionStart: () => {
						if (mode === "after-transfer") {
							unavailable = true;
							throw primary;
						}
					},
				})
				.then(
					() => undefined,
					(cause: unknown) => cause,
				);
			unavailable = false;
			if (mode === "control") assert.equal(error, undefined);
			else if (mode.endsWith("cleanup")) {
				assert.ok(error instanceof AggregateError);
				assert.ok(error.errors.includes(primary));
				assert.ok(error.errors.includes(cleanup));
			} else assert.equal(error, primary);
			assert.deepEqual(
				[...active],
				mode.startsWith("transaction") ? [1] : mode === "control" || mode === "after-transfer" ? [2] : [],
			);
			const closed = await session.dispose().then(
				() => undefined,
				(cause: unknown) => cause,
			);
			if (mode.endsWith("cleanup")) assert.equal((closed as { code: string }).code, "ShutdownFailed");
			else assert.equal(closed, undefined);
			assert.equal(active.size, 0);
		} finally {
			unavailable = false;
			await session.dispose().catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: cleanup can launch tracked execution without awaiting it; teardown still owns settlement.
test.each(["close", "close-error", "candidate", "factory"])(
	"cleanup subprocess settles before teardown (%s)",
	async (mode) => {
		const cwd = mkdtempSync(join(tmpdir(), "sdk-cleanup-exec-"));
		const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
		const modelRuntime = await ModelRuntime.create({
			authPath: join(cwd, "auth"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		let child: Promise<import("../src/core/extensions/types.ts").ExecResult> | undefined;
		let cleanupAPI!: import("../src/core/extensions/types.ts").ExtensionAPI;
		let generation = 0;
		let settled = false;
		let completed = false;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					const id = ++generation;
					pi.on("session_shutdown", async () => {
						if (mode === "candidate" && id === 1) return;
						cleanupAPI = pi;
						child = pi.exec(process.execPath, [
							"-e",
							'const fs=require("node:fs");fs.writeFileSync("started","");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);process.stdout.write("complete");}},10);',
						]);
						void child.then(() => {
							settled = true;
						});
						await vi.waitFor(() => assert.ok(existsSync(join(cwd, "started"))));
						entered();
						if (mode === "close-error") throw new Error("shutdown primary");
					});
					if (mode === "factory") throw new Error("factory primary");
					if (mode === "candidate" && id > 1)
						pi.on("session_start", () => {
							throw new Error("startup primary");
						});
				},
			],
		});
		let session: AgentSession | undefined;
		const creating = createAgentSession({
			cwd,
			agentDir: cwd,
			settingsManager,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			tools: [],
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		});
		const teardown =
			mode === "factory"
				? creating.then((result) => {
						session = result.session;
					})
				: creating.then(async (result) => {
						session = result.session;
						if (mode === "candidate") await session.reload();
						else await session.dispose();
					});
		const outcome = teardown.then(
			() => {
				completed = true;
				return undefined;
			},
			(error: unknown) => {
				completed = true;
				return error;
			},
		);
		try {
			await started;
			await new Promise((resolve) => setTimeout(resolve, 30));
			const premature = completed;
			assert.equal(settled, false);
			assert.throws(() => cleanupAPI.events.on("fresh-during-cleanup", () => {}), /closed|stale|no longer active/i);
			const closing = mode === "candidate" ? session!.dispose().catch((error: unknown) => error) : undefined;
			writeFileSync(join(cwd, "release"), "");
			assert.equal((await child!).stdout, "complete");
			const error = await outcome;
			await closing;
			assert.equal(premature, false, "teardown returned while cleanup child was live");
			if (mode === "close-error") assert.equal((error as { code: string }).code, "ShutdownFailed");
			if (mode === "candidate") {
				assert.ok(error instanceof AggregateError);
				assert.match(error.errors.map(String).join("\n"), /startup primary/);
			}
		} finally {
			writeFileSync(join(cwd, "release"), "");
			await child;
			await outcome;
			await session?.dispose().catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: public releases must forget their captures even while the owner remains reachable.
test.each(["manual", "invalidate", "throwing", "invalidate-throwing"])(
	"factory release bookkeeping retires completed handles (%s)",
	async (mode) => {
		const { createEventBus } = await import("../src/core/event-bus.ts");
		const cwd = mkdtempSync(join(tmpdir(), "sdk-release-ledger-"));
		const settingsManager = SettingsManager.inMemory();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(cwd, "auth"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const bus = createEventBus();
		let releases = 0;
		const eventBus = {
			emit: bus.emit,
			on: (channel: string, handler: (...args: unknown[]) => void) => {
				const release = bus.on(channel, handler);
				return () => {
					release();
					releases++;
					if (mode.endsWith("throwing")) throw new Error("release failed");
				};
			},
		};
		let api!: import("../src/core/extensions/types.ts").ExtensionAPI;
		let finish!: () => void;
		let entered!: () => void;
		const held = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			eventBus,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("session_shutdown", async () => {
						entered();
						await held;
					});
				},
			],
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			settingsManager,
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			tools: [],
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		});
		const extension = session.resourceLoader.getExtensions().extensions[0];
		const ledger = (extension as unknown as Record<symbol, { releases: Set<() => void> }>)[
			Symbol.for("atomic.extension-api-lifetime.v1")
		].releases;
		const unsubscribe = api.events.on("ephemeral", () => {});
		const publisher = api.registerWorkflowActivityPublisher();
		const closing = session.dispose().then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			await started;
			assert.equal(ledger.size, 2);
			if (!mode.startsWith("invalidate")) {
				if (mode === "throwing") assert.throws(unsubscribe, /release failed/);
				else unsubscribe();
				unsubscribe();
				publisher.dispose();
				publisher.dispose();
				assert.equal(ledger.size, 0);
			}
			finish();
			const error = await closing;
			if (mode === "invalidate-throwing") assert.equal((error as { code: string }).code, "ShutdownFailed");
			else assert.equal(error, undefined);
			assert.equal(ledger.size, 0);
			assert.equal(releases, 1);
		} finally {
			finish();
			await closing;
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: a failed factory still owns acquisitions made by already-admitted callbacks.
test("factory rollback drains admitted callbacks before shutdown", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "sdk-factory-predrain-"));
	const settingsManager = SettingsManager.inMemory();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(cwd, "auth"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	let release!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const log: string[] = [];
	const live = new Set<ReturnType<typeof setInterval>>();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			async (pi) => {
				pi.on("session_shutdown", () => {
					log.push("shutdown");
					for (const timer of live) clearInterval(timer);
					live.clear();
				});
				pi.events.on("acquire", async () => {
					log.push("started");
					entered();
					await held;
					pi.events.on("late-owned-subscription", () => {});
					live.add(setInterval(() => {}, 1000));
					log.push("acquired");
				});
				pi.events.emit("acquire", {});
				throw new Error("factory primary");
			},
		],
	});
	const creating = createAgentSession({
		cwd,
		agentDir: cwd,
		settingsManager,
		modelRuntime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		tools: [],
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	try {
		await started;
		await new Promise((resolve) => setTimeout(resolve, 25));
		const beforeRelease = [...log];
		release();
		const { session } = await creating;
		await session.dispose();
		assert.deepEqual(beforeRelease, ["started"]);
		assert.deepEqual(log, ["started", "acquired", "shutdown"]);
		assert.equal(live.size, 0);
	} finally {
		release();
		await creating.then(
			({ session }) => session.dispose(),
			() => {},
		);
		for (const timer of live) clearInterval(timer);
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: the failed attempt, not sequential cleanup, defines the closing set.
test.each(["creation", "creation-error", "replay", "ordinary", "transaction", "transaction-overlap"])(
	"factory rollback seals all owned peers (%s)",
	async (mode) => {
		const cwd = mkdtempSync(join(tmpdir(), "sdk-rollback-peers-"));
		const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
		const modelRuntime = await ModelRuntime.create({
			authPath: join(cwd, "auth"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		let release!: () => void;
		let entered!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const primary = new Error("setup rejected");
		const cleanup = new Error("cleanup rejected");
		let generation = 0;
		let deliveries = 0;
		let peer!: import("../src/core/extensions/types.ts").ExtensionAPI;
		const shutdowns: string[] = [];
		const reloading = mode === "ordinary" || mode.startsWith("transaction");
		class Loader extends DefaultResourceLoader {
			supportsTransactionalReload() {
				return mode.startsWith("transaction");
			}
			async reload() {
				await super.reload();
				if (generation > 1) throw primary;
			}
			async prepareReload() {
				await this.reload();
				throw primary;
			}
		}
		const LoaderClass = reloading || mode === "replay" ? Loader : DefaultResourceLoader;
		const resourceLoader = new LoaderClass({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					const id = ++generation;
					peer = pi;
					pi.events.on("peer", () => {
						deliveries++;
					});
					pi.on("session_shutdown", () => {
						shutdowns.push(`peer${id}`);
					});
				},
				(pi) => {
					const id = generation;
					pi.on("session_shutdown", async () => {
						shutdowns.push(`held${id}`);
						if ((!reloading && mode !== "replay") || id > 1) {
							entered();
							await held;
						}
						if (mode === "creation-error") throw cleanup;
					});
					if (mode === "replay" && id > 1) throw primary;
				},
			],
		});
		let session: AgentSession | undefined;
		if (reloading || mode === "replay") await resourceLoader.reload();
		if (reloading) {
			session = new AgentSession({
				agent: new Agent(),
				cwd,
				settingsManager,
				modelRuntime,
				resourceLoader,
				sessionManager: SessionManager.inMemory(cwd),
			});
			await session.bindExtensions({});
		}
		const operation = (
			reloading
				? session!.reload()
				: createAgentSession({
						cwd,
						agentDir: cwd,
						settingsManager,
						modelRuntime,
						resourceLoader,
						sessionManager: SessionManager.inMemory(cwd),
						tools: [],
						builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
						initialContextTransform() {
							throw primary;
						},
					})
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			await started;
			let closed = false;
			let closing: Promise<void> | undefined;
			if (mode === "transaction-overlap") {
				await session!.abort();
				closing = session!.dispose().then(() => {
					closed = true;
				});
				await new Promise((resolve) => setTimeout(resolve, 25));
				assert.equal(closed, false, "terminal close escaped held factory rollback");
			}
			let execError: unknown;
			try {
				await peer.exec(process.execPath, ["-e", "process.stdout.write('fresh')"]);
			} catch (error) {
				execError = error;
			}
			let subscriptionError: unknown;
			try {
				peer.events.on("fresh", () => {});
			} catch (error) {
				subscriptionError = error;
			}
			let emitError: unknown;
			try {
				peer.events.emit("peer", {});
			} catch (error) {
				emitError = error;
			}
			release();
			const error = await operation;
			await closing;
			assert.ok(execError, "closing peer admitted fresh exec");
			assert.ok(subscriptionError, "closing peer admitted fresh subscription");
			assert.ok(emitError, "closing peer admitted fresh bus emission");
			assert.equal(deliveries, 0);
			const causes = (value: unknown): unknown[] =>
				value instanceof AggregateError ? [value, ...value.errors.flatMap(causes)] : [value];
			assert.ok(causes(error).includes(primary));
			if (mode === "creation-error") assert.ok(causes(error).includes(cleanup));
			const id = reloading || mode === "replay" ? 2 : 1;
			assert.equal(shutdowns.filter((value) => value === `peer${id}`).length, 1);
			assert.equal(shutdowns.filter((value) => value === `held${id}`).length, 1);
			if (mode === "replay") assert.ok(!shutdowns.includes("peer1"), "borrowed discovery was closed");
		} finally {
			release();
			await operation;
			await session?.dispose().catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: omitted factories drain their own work, never a selected sibling's receipt.
test.each([false, true])(
	"factory rollback drains the omitted set without selected sibling work (startup failure=%s)",
	async (startupFails) => {
		const cwd = mkdtempSync(join(tmpdir(), "sdk-omitted-drain-"));
		const settingsManager = SettingsManager.inMemory();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(cwd, "auth"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const defer = () => {
			let resolve!: () => void;
			const promise = new Promise<void>((done) => {
				resolve = done;
			});
			return { promise, resolve };
		};
		const selectedWork = defer(),
			omittedWork = defer(),
			cleanupWork = defer(),
			entered = defer(),
			admitted = defer();
		const live = new Set<ReturnType<typeof setInterval>>();
		const log: string[] = [];
		let selected!: import("../src/core/extensions/types.ts").ExtensionAPI;
		let omitted!: import("../src/core/extensions/types.ts").ExtensionAPI;
		let other!: import("../src/core/extensions/types.ts").ExtensionAPI;
		let unrelatedError: unknown;
		const primary = new Error("startup rejected");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					selected = pi;
					pi.events.on("selected", async () => {
						await selectedWork.promise;
					});
					pi.events.emit("selected", {});
					pi.on("session_start", () => {
						if (startupFails) throw primary;
					});
				},
				(pi) => {
					omitted = pi;
					pi.on("session_shutdown", () => {
						log.push("peer-shutdown");
						for (const timer of live) clearInterval(timer);
						live.clear();
					});
					pi.events.on("omitted", async () => {
						admitted.resolve();
						await omittedWork.promise;
						pi.events.on("late", () => {});
						try {
							other.events.on("unrelated", () => {});
						} catch (error) {
							unrelatedError = error;
						}
						live.add(setInterval(() => {}, 1000));
						log.push("acquired");
					});
					pi.events.emit("omitted", {});
				},
				(pi) => {
					other = pi;
					pi.on("session_shutdown", async () => {
						log.push("last-shutdown");
						entered.resolve();
						await cleanupWork.promise;
					});
				},
			],
			extensionsOverride: (result) => ({ ...result, extensions: result.extensions.slice(0, 1) }),
		});
		let session: AgentSession | undefined;
		let completed = false;
		const creating = createAgentSession({
			cwd,
			agentDir: cwd,
			settingsManager,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			tools: [],
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		}).then(
			(result) => {
				session = result.session;
				completed = true;
				return undefined;
			},
			(error: unknown) => {
				completed = true;
				return error;
			},
		);
		try {
			await admitted.promise;
			await new Promise((resolve) => setTimeout(resolve, 25));
			assert.deepEqual(log, [], "all omitted callbacks precede the first shutdown");
			assert.equal(
				(await selected.exec(process.execPath, ["-e", "process.stdout.write('selected')"])).stdout,
				"selected",
			);
			omittedWork.resolve();
			await entered.promise;
			assert.ok(unrelatedError, "admitted callback gained unrelated closing authority");
			assert.throws(() => omitted.events.on("fresh", () => {}), /closed|stale/i);
			cleanupWork.resolve();
			if (startupFails) selectedWork.resolve();
			await vi.waitFor(() => assert.ok(completed, "omitted cleanup waited on selected sibling"));
			const error = await creating;
			if (startupFails) assert.ok(error instanceof AggregateError);
			else assert.equal(error, undefined);
			assert.deepEqual(log, ["acquired", "last-shutdown", "peer-shutdown"]);
			assert.equal(live.size, 0);
			selectedWork.resolve();
			await session?.dispose();
		} finally {
			selectedWork.resolve();
			omittedWork.resolve();
			cleanupWork.resolve();
			await creating;
			await session?.dispose().catch(() => {});
			for (const timer of live) clearInterval(timer);
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

// #3105: SDK-invoked resource providers retain ownership until their acquisitions settle.
test.each(["dispose", "reload", "control", "error", "replay", "replay-error"])(
	"admitted workflow refresh drains before cleanup (%s)",
	async (mode) => {
		const cwd = mkdtempSync(join(tmpdir(), "sdk-refresh-drain-"));
		const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
		const modelRuntime = await ModelRuntime.create({
			authPath: join(cwd, "auth"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		let release!: () => void;
		let enter!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const order: string[] = [];
		let api!: import("../src/core/extensions/types.ts").ExtensionAPI;
		let live = 0;
		let generation = 0;
		const replay = mode.startsWith("replay");
		const primary = new Error("refresh replay primary");
		const providerError = new Error("refresh provider failed");
		const cleanupError = new Error("refresh cleanup failed");
		let refreshing!: ReturnType<import("../src/core/extensions/types.ts").ExtensionAPI["refreshWorkflowResources"]>;
		class Loader extends DefaultResourceLoader {
			async refreshWorkflowResources() {
				enter();
				await held;
				// Completion retains its own API authority while unrelated fresh calls are sealed.
				const unsubscribe = api.events.on("late-refresh", () => {});
				unsubscribe();
				live++;
				order.push("acquired");
				if (mode.endsWith("error")) throw providerError;
				return [];
			}
		}
		const resourceLoader = new Loader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					const id = ++generation;
					api = pi;
					pi.on("session_shutdown", () => {
						order.push(`shutdown${id}`);
						live = 0;
						if (mode.endsWith("error")) throw cleanupError;
					});
					if (replay && id === 2) {
						refreshing = pi.refreshWorkflowResources();
						void refreshing.catch(() => {});
						throw primary;
					}
				},
			],
		});
		await resourceLoader.reload();
		let session: AgentSession | undefined;
		const creating = createAgentSession({
			cwd,
			agentDir: cwd,
			settingsManager,
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			tools: [],
		});
		let settled = false;
		let observed: Promise<unknown>;
		if (replay) {
			observed = creating
				.catch((error: unknown) => error)
				.finally(() => {
					settled = true;
				});
		} else {
			({ session } = await creating);
			refreshing = api.refreshWorkflowResources();
			void refreshing.catch(() => {});
			await entered;
			if (mode === "control") {
				release();
				await refreshing;
			}
			const closing = mode === "reload" ? session.reload() : session.dispose();
			if (mode !== "reload") assert.equal(session.dispose(), closing);
			observed = closing
				.catch((error: unknown) => error)
				.finally(() => {
					settled = true;
				});
		}
		await entered;
		let outcome: unknown;
		let refreshOutcome: unknown;
		try {
			await assert.rejects(api.refreshWorkflowResources(), /closed|stale/i);
			await new Promise((resolve) => setTimeout(resolve, 25));
			if (mode !== "control") {
				assert.equal(settled, false, `${mode} completed before refresh`);
				assert.deepEqual(order, []);
			}
		} finally {
			release();
			[refreshOutcome, outcome] = await Promise.all([refreshing.catch((error: unknown) => error), observed]);
			await session?.dispose().catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
		}
		assert.equal(live, 0);
		assert.equal(order[0], "acquired");
		assert.equal(order.filter((item) => item === "shutdown2").length, 1);
		assert.ok(!order.includes("shutdown1"), "borrowed discovery is not shut down");
		if (mode.endsWith("error")) {
			assert.equal(refreshOutcome, providerError);
			assert.ok(outcome instanceof AggregateError);
			const causes = (value: unknown): unknown[] =>
				value instanceof AggregateError
					? [value, ...value.errors.flatMap(causes)]
					: value instanceof Error && value.cause
						? [value, ...causes(value.cause)]
						: [value];
			if (replay) {
				assert.ok(causes(outcome).includes(cleanupError));
				assert.ok(causes(outcome).includes(primary));
			} else {
				// Runner diagnostics attribute shutdown errors; factory rollback preserves objects.
				assert.match(causes(outcome).map(String).join("\n"), /refresh cleanup failed/);
			}
		} else {
			assert.deepEqual(refreshOutcome, []);
			if (replay) assert.equal(outcome, primary);
			else assert.equal(outcome, undefined);
		}
	},
);

// #3105: discovering uncached direct tools must not connect a lazy MCP server.
test("SDK MCP discovery stays lazy until an owned gateway call", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-lazy-mcp-"));
	let requests = 0;
	const server = createServer(async (request, response) => {
		requests++;
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const message = JSON.parse(body) as { id?: number; method: string };
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		const result =
			message.method === "initialize"
				? {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "fixture", version: "1" },
					}
				: { tools: [] };
		response
			.writeHead(200, { "Content-Type": "application/json" })
			.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	writeFileSync(
		join(cwd, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				fixture: { url: `http://127.0.0.1:${address.port}/mcp`, directTools: true },
			},
		}),
	);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(cwd, "agent"));
	let session: AgentSession | undefined;
	try {
		({ session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		}));
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		assert.equal(requests, 0, "startup connected an uncached lazy server");
		const gateway = session.agent.state.tools.find((tool) => tool.name === "mcp")!;
		const result = await gateway.execute("connect", { connect: "fixture" }, new AbortController().signal);
		assert.ok(requests > 0, "first owned use did not connect");
		assert.equal(result.details?.error, undefined, JSON.stringify(result));
	} finally {
		await session?.dispose();
		vi.unstubAllEnvs();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: an eager/keep-alive sibling must not bootstrap uncached lazy direct tools.
test.each(["eager", "keep-alive"] as const)("SDK mixed %s MCP startup preserves lazy discovery", async (lifecycle) => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-mixed-mcp-"));
	const requests = { eager: 0, lazy: 0 };
	const server = createServer(async (request, response) => {
		const name = request.url === "/lazy" ? "lazy" : "eager";
		requests[name]++;
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const message = JSON.parse(body) as { id?: number; method: string };
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		const result =
			message.method === "initialize"
				? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name, version: "1" } }
				: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] };
		response
			.writeHead(200, { "Content-Type": "application/json" })
			.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	writeFileSync(
		join(cwd, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				eager: { url: `http://127.0.0.1:${address.port}/eager`, lifecycle },
				lazy: { url: `http://127.0.0.1:${address.port}/lazy`, directTools: true },
			},
		}),
	);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(cwd, "agent"));
	let session: AgentSession | undefined;
	try {
		({ session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		}));
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		assert.ok(requests.eager > 0, "startup did not connect the eager/keep-alive sibling");
		assert.equal(requests.lazy, 0, "mixed startup connected an uncached lazy server");
		assert.ok(!session.agent.state.tools.some((tool) => tool.name === "lazy_echo"), "startup registered lazy_echo");
		const gateway = session.agent.state.tools.find((tool) => tool.name === "mcp")!;
		const result = await gateway.execute("connect", { connect: "lazy" }, new AbortController().signal);
		assert.ok(requests.lazy > 0, "first owned lazy use did not connect");
		assert.equal(result.details?.error, undefined, JSON.stringify(result));
	} finally {
		await session?.dispose();
		vi.unstubAllEnvs();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #3105: startup failures are operational diagnostics, not remote text printed by the SDK.
test("MCP startup diagnostics are quiet, redacted and owner attributed", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-sdk-mcp-diagnostics-"));
	const diagnostics: HostDiagnostic[][] = [[], []];
	const sessions: AgentSession[] = [];
	const errorOutput = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		for (let index = 0; index < 2; index++) {
			const cwd = join(root, String(index));
			mkdirSync(cwd);
			writeFileSync(
				join(cwd, ".mcp.json"),
				JSON.stringify({
					mcpServers: {
						[`secret-supervisor-token-${index}`]: {
							command: join(cwd, "missing-secret-credential"),
							lifecycle: "eager",
						},
					},
				}),
			);
			const { session } = await createAgentSession({
				cwd,
				agentDir: join(cwd, "agent"),
				sessionManager: SessionManager.inMemory(cwd),
				settingsManager: SettingsManager.inMemory(),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				builtins: { workflows: false, subagents: false, intercom: false, "web-access": false },
				extensionBindings: { onDiagnostic: (entry) => diagnostics[index]!.push(entry) },
			});
			sessions.push(session);
			const gateway = session.agent.state.tools.find((tool) => tool.name === "mcp")!;
			await gateway.execute("status", {}, new AbortController().signal);
		}
		assert.equal(errorOutput.mock.calls.length, 0, "MCP startup wrote unsolicited console output");
		for (let index = 0; index < 2; index++) {
			assert.ok(diagnostics[index]!.length > 0);
			assert.ok(diagnostics[index]!.every((entry) => entry.sessionId === sessions[index]!.sessionId));
			assert.doesNotMatch(JSON.stringify(diagnostics[index]), /secret|missing|supervisor-token/);
			assert.equal(diagnostics[index]![0]!.source, "mcp");
		}
	} finally {
		await Promise.all(sessions.map((session) => session.dispose()));
		errorOutput.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});

// #3105: local HTTP content and stored results belong to the session that fetched them.
test("web results survive sibling initialization and overlapping close", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-sdk-web-owners-"));
	const sessions: AgentSession[] = [];
	const text = "Owner-local web content. ".repeat(100);
	const server = createServer((_request, response) =>
		response.writeHead(200, { "Content-Type": "text/plain" }).end(text),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const url = `http://127.0.0.1:${address.port}/content`;
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager: SettingsManager.inMemory(),
		builtinPackagePaths: getBuiltinPackagePaths({ workflows: false, subagents: false, mcp: false, intercom: false }),
	});
	await resourceLoader.reload();
	try {
		for (let index = 0; index < 2; index++) {
			const cwd = join(root, String(index));
			mkdirSync(cwd);
			const { session } = await createAgentSession({
				cwd,
				agentDir: join(root, "agent"),
				sessionManager: SessionManager.inMemory(cwd),
				resourceLoader,
				settingsManager: SettingsManager.inMemory(),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				builtins: { workflows: false, subagents: false, mcp: false, intercom: false },
			});
			sessions.push(session);
		}
		const fetch = sessions[0]!.agent.state.tools.find((tool) => tool.name === "fetch_content")!;
		const result = await fetch.execute("fetch", { urls: [url] }, new AbortController().signal);
		const details = result.details as { responseId: string; successful: number };
		assert.equal(details.successful, 1, JSON.stringify(result));
		assert.match(JSON.stringify(result.content), /Owner-local web content/);
		const siblingGet = sessions[1]!.agent.state.tools.find((tool) => tool.name === "get_search_content")!;
		const invisible = await siblingGet.execute(
			"read",
			{ responseId: details.responseId, urlIndex: 0 },
			new AbortController().signal,
		);
		assert.doesNotMatch(JSON.stringify(invisible.content), /Owner-local web content/);
		await Promise.all([sessions[1]!.dispose(), sessions[1]!.dispose()]);
		const get = sessions[0]!.agent.state.tools.find((tool) => tool.name === "get_search_content")!;
		const retained = await get.execute(
			"read",
			{ responseId: details.responseId, urlIndex: 0 },
			new AbortController().signal,
		);
		assert.match(JSON.stringify(retained.content), /Owner-local web content/);
	} finally {
		await Promise.all(sessions.map((session) => session.dispose()));
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		rmSync(root, { recursive: true, force: true });
	}
});

// #3105: the actual runner bridge preserves OAuth ownership when host bindings replace reporters.
test("OAuth transient ownership survives public SDK rebind and sibling close", async () => {
	const root = mkdtempSync(join(tmpdir(), "sdk-oauth-rebind-"));
	const sessions: AgentSession[] = [];
	const { getOAuthState, updateOAuthState } = await import("../../mcp/mcp-auth.js");
	const { shutdownOAuth } = await import("../../mcp/mcp-auth-flow.js");
	try {
		for (let index = 0; index < 2; index++) {
			const resourceLoader = new DefaultResourceLoader({
				cwd: root,
				agentDir: join(root, "agent"),
				settingsManager: SettingsManager.inMemory(),
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "oauth_probe",
							label: "OAuth probe",
							description: "Exercise builtin OAuth storage",
							parameters: Type.Object({ value: Type.Optional(Type.String()) }),
							execute: async (_id, params) => {
								if (params.value) updateOAuthState("same", params.value, "https://example.invalid/mcp");
								return { content: [{ type: "text", text: getOAuthState("same") ?? "absent" }], details: {} };
							},
						});
						pi.on("session_shutdown", () => shutdownOAuth());
					},
				],
			});
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: join(root, "agent"),
				resourceLoader,
				sessionManager: SessionManager.inMemory(root),
				settingsManager: SettingsManager.inMemory(),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			});
			sessions.push(session);
		}
		const call = (index: number, value?: string) =>
			sessions[index]!.agent.state.tools.find((tool) => tool.name === "oauth_probe")!.execute(
				"probe",
				{ value },
				new AbortController().signal,
			);
		await call(0, "first-private-state");
		await call(1, "second-private-state");
		await sessions[0]!.bindExtensions({ onDiagnostic: () => {} });
		assert.match(JSON.stringify((await call(0)).content), /first-private-state/);
		assert.match(JSON.stringify((await call(1)).content), /second-private-state/);
		await Promise.all([sessions[1]!.dispose(), sessions[1]!.dispose()]);
		assert.match(JSON.stringify((await call(0)).content), /first-private-state/);
		assert.equal(existsSync(join(root, "agent", "mcp-oauth", "same", "tokens.json")), false);
	} finally {
		await Promise.all(sessions.map((session) => session.dispose()));
		rmSync(root, { recursive: true, force: true });
	}
});
