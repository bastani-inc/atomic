import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@bastani/atomic-ai";
import { afterEach, describe, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getBuiltinPackageLocations } from "../src/core/builtin-packages.ts";
import { createEventBus } from "../src/core/event-bus.js";
import {
	createLazyBuiltinFactory,
	getLazyBuiltinSpec,
	type LazyBuiltinSpec,
	registerLazyBuiltin,
	unregisterLazyBuiltinForTest,
} from "../src/core/extensions/lazy-builtin.js";
import { instantiateExtensions, loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import { rollbackExtensionFactories } from "../src/core/extensions/loader-rollback.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tempDirs: string[] = [];
const savedSpecs: Array<{
	label: "subagents" | "mcp" | "web-access" | "intercom";
	previous: LazyBuiltinSpec | undefined;
}> = [];

afterEach(() => {
	for (const { label, previous } of savedSpecs.splice(0).reverse()) {
		if (previous) registerLazyBuiltin(label, previous);
		else unregisterLazyBuiltinForTest(label);
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createRunnerHarness(factory: ExtensionFactory) {
	const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-builtin-"));
	tempDirs.push(dir);
	const eventBus = createEventBus();
	const runtime = createExtensionRuntime();
	const sessionManager = SessionManager.inMemory(dir);
	const modelRegistry = new ModelRegistry(AuthStorage.inMemory());
	return { dir, eventBus, runtime, sessionManager, modelRegistry, factory };
}

async function mountExtension(factory: ExtensionFactory) {
	const harness = createRunnerHarness(factory);
	const extension = await loadExtensionFromFactory(
		factory,
		harness.dir,
		harness.eventBus,
		harness.runtime,
		"builtin:test",
	);
	const runner = new ExtensionRunner(
		[extension],
		harness.runtime,
		harness.dir,
		harness.sessionManager,
		harness.modelRegistry,
	);
	runner.bindCore(
		{
			sendMessage: () => {},
			sendMessages: () => {},
			sendUserMessage: () => {},
			appendEntry: async () => {},
			setSessionName: async () => {},
			getSessionName: () => undefined,
			setLabel: async () => {},
			getActiveTools: () => [...extension.tools.keys()],
			getAllTools: () =>
				[...extension.tools.values()].map(({ definition, sourceInfo }) => ({
					name: definition.name,
					description: definition.description,
					parameters: definition.parameters,
					sourceInfo,
				})),
			setActiveTools: () => {},
			refreshTools: () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => "off",
			setThinkingLevel: async () => {},
		},
		{
			getModel: () => undefined,
			getScopedModels: () => [],
			isIdle: () => true,
			isProjectTrusted: () => true,
			getSignal: () => undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		},
	);
	return { ...harness, extension, runner };
}

describe("lazy builtin extension mechanism", () => {
	test("registers static surface immediately and defers heavy load until first tool, command, or shortcut use", async () => {
		let loadCount = 0;
		const calls: string[] = [];
		const heavyFactory: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "demo_tool",
				label: "Demo",
				description: "Demo tool",
				parameters: Type.Object({ value: Type.String() }),
				execute: async (_id, params) => {
					calls.push(`tool:${(params as { value: string }).value}`);
					return { content: [{ type: "text", text: `ok:${(params as { value: string }).value}` }], details: {} };
				},
			});
			pi.registerCommand("demo", {
				description: "Demo command",
				handler: async (args) => {
					calls.push(`cmd:${args}`);
				},
			});
			pi.registerShortcut("alt+d", {
				description: "Demo shortcut",
				handler: async () => {
					calls.push("shortcut:alt+d");
				},
			});
		};
		const spec: LazyBuiltinSpec = {
			label: "demo",
			register(pi, controller) {
				pi.registerTool({
					name: "demo_tool",
					label: "Demo",
					description: "Demo tool",
					parameters: Type.Object({ value: Type.String() }),
					execute: (...args) => controller.executeTool("demo_tool", args),
				});
				pi.registerCommand("demo", {
					description: "Demo command",
					handler: (args, ctx) => controller.runCommand("demo", args, ctx),
				});
				pi.registerShortcut("alt+d", {
					description: "Demo shortcut",
					handler: (ctx) => controller.runShortcut("alt+d", ctx),
				});
			},
		};
		const lazyFactory = createLazyBuiltinFactory(spec, async () => {
			loadCount += 1;
			return heavyFactory;
		});

		const { extension, runner } = await mountExtension(lazyFactory);
		await runner.emit({ type: "session_start", reason: "startup" });

		// Requirement: heavy implementation is NOT loaded at startup or session_start.
		assert.equal(loadCount, 0);
		assert.equal(extension.tools.has("demo_tool"), true);
		assert.equal(extension.commands.has("demo"), true);
		assert.equal(extension.shortcuts.has("alt+d"), true);

		// First use loads heavy implementation once; subsequent uses reuse it.
		const tool = extension.tools.get("demo_tool")!.definition;
		const res = await tool.execute("call-1", { value: "hello" }, undefined, undefined, runner.createContext());
		assert.equal(loadCount, 1);
		assert.deepEqual(res.content, [{ type: "text", text: "ok:hello" }]);

		await extension.commands.get("demo")!.handler("arg1", runner.createCommandContext());
		await extension.shortcuts.get("alt+d")!.handler(runner.createContext());
		assert.equal(loadCount, 1);
		assert.deepEqual(calls, ["tool:hello", "cmd:arg1", "shortcut:alt+d"]);
	});

	test("activation preserves host edits to static registrations (limitMandatoryIntercomToTool) while forwarding dynamic tools", async () => {
		const heavyFactory: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "static_tool",
				label: "Static",
				description: "Static",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "static-ok" }], details: {} }),
			});
			pi.registerCommand("static_cmd", { description: "Static cmd", handler: async () => {} });
			pi.registerShortcut("alt+m", { description: "Static shortcut", handler: async () => {} });
			// Dynamic tool registered only when active (like mcp__* or contact_supervisor)
			pi.registerTool({
				name: "dynamic_tool",
				label: "Dynamic",
				description: "Dynamic",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "dynamic-ok" }], details: {} }),
			});
		};
		const spec: LazyBuiltinSpec = {
			label: "surface-check",
			register(pi, controller) {
				pi.registerTool({
					name: "static_tool",
					label: "Static",
					description: "Static",
					parameters: Type.Object({}),
					execute: (...args) => controller.executeTool("static_tool", args),
				});
				pi.registerCommand("static_cmd", {
					description: "Static cmd",
					handler: (args, ctx) => controller.runCommand("static_cmd", args, ctx),
				});
				pi.registerShortcut("alt+m", {
					description: "Static shortcut",
					handler: (ctx) => controller.runShortcut("alt+m", ctx),
				});
			},
		};
		const { extension, runner } = await mountExtension(createLazyBuiltinFactory(spec, async () => heavyFactory));
		// Simulate limitMandatoryIntercomToTool stripping local command & shortcut before activation.
		extension.commands.delete("static_cmd");
		extension.shortcuts.delete("alt+m");

		await runner.emit({ type: "session_start", reason: "startup" });
		const res = await extension.tools
			.get("static_tool")!
			.definition.execute("c1", {}, undefined, undefined, runner.createContext());
		assert.deepEqual(res.content, [{ type: "text", text: "static-ok" }]);
		// Static command & shortcut stay deleted (kills overwriteStatic mutant); no duplicateToolNames.
		assert.equal(extension.commands.has("static_cmd"), false);
		assert.equal(extension.shortcuts.has("alt+m"), false);
		assert.equal(extension.duplicateToolNames, undefined);
		// Dynamic runtime tool registered onto the live extension.
		assert.equal(extension.tools.has("dynamic_tool"), true);
	});

	test("serializes lifecycle replay so live events arriving mid-replay never overtake or duplicate", async () => {
		const observed: string[] = [];
		const gate = deferred<void>();
		const heavyFactory: ExtensionFactory = (pi) => {
			pi.on("session_start", async () => {
				observed.push("session_start:enter");
				await gate.promise;
				observed.push("session_start:exit");
			});
			pi.on("turn_start", async () => {
				observed.push("turn_start");
			});
			pi.on("agent_start", async () => {
				observed.push("agent_start");
			});
			pi.on("tool_execution_start", async (ev) => {
				observed.push(`tool_execution_start:${(ev as { toolCallId: string }).toolCallId}`);
			});
			pi.registerTool({
				name: "ordered",
				label: "Ordered",
				description: "Ordered",
				parameters: Type.Object({}),
				execute: async () => {
					observed.push("execute");
					return { content: [{ type: "text", text: "done" }], details: {} };
				},
			});
		};
		const spec: LazyBuiltinSpec = {
			label: "ordered",
			register(pi, controller) {
				pi.registerTool({
					name: "ordered",
					label: "Ordered",
					description: "Ordered",
					parameters: Type.Object({}),
					execute: (...args) => controller.executeTool("ordered", args),
				});
			},
		};
		const { extension, runner } = await mountExtension(createLazyBuiltinFactory(spec, async () => heavyFactory));
		await runner.emit({ type: "session_start", reason: "startup" });
		await runner.emit({ type: "turn_start", turnIndex: 0, timestamp: 1 });
		await runner.emit({ type: "agent_start" });

		// Start activation; it pauses inside session_start replay.
		const toolCall = extension.tools
			.get("ordered")!
			.definition.execute("c1", {}, undefined, undefined, runner.createContext());
		// Wait until session_start replay entered.
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual(observed, ["session_start:enter"]);

		// Live event arrives while replay is mid-flight (kills noReplaySerialize mutant).
		const liveEmit = runner.emit({
			type: "tool_execution_start",
			toolCallId: "live-1",
			toolName: "ordered",
			args: {},
		});
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual(observed, ["session_start:enter"]);

		gate.resolve();
		await Promise.all([toolCall, liveEmit]);
		assert.deepEqual(observed, [
			"session_start:enter",
			"session_start:exit",
			"turn_start",
			"agent_start",
			"tool_execution_start:live-1",
			"execute",
		]);
	});

	test("coalesces concurrent calls and isolates caller AbortSignal without poisoning sibling callers", async () => {
		const loadGate = deferred<ExtensionFactory>();
		let loadCalls = 0;
		const spec: LazyBuiltinSpec = {
			label: "coalesce",
			register(pi, controller) {
				pi.registerTool({
					name: "work",
					label: "Work",
					description: "Work",
					parameters: Type.Object({ who: Type.String() }),
					execute: (...args) => controller.executeTool("work", args),
				});
			},
		};
		const { extension, runner } = await mountExtension(
			createLazyBuiltinFactory(spec, () => {
				loadCalls += 1;
				return loadGate.promise;
			}),
		);
		await runner.emit({ type: "session_start", reason: "startup" });

		const abortA = new AbortController();
		const tool = extension.tools.get("work")!.definition;
		const callA = tool.execute("a", { who: "A" }, abortA.signal, undefined, runner.createContext());
		const callB = tool.execute("b", { who: "B" }, undefined, undefined, runner.createContext());
		await new Promise((r) => setImmediate(r));
		assert.equal(loadCalls, 1);

		const abortReason = new Error("caller-a-aborted");
		abortA.abort(abortReason);
		await assert.rejects(callA, (err) => err === abortReason);

		loadGate.resolve((pi) => {
			pi.registerTool({
				name: "work",
				label: "Work",
				description: "Work",
				parameters: Type.Object({ who: Type.String() }),
				execute: async (_id, params) => ({
					content: [{ type: "text", text: `ran:${(params as { who: string }).who}` }],
					details: {},
				}),
			});
		});
		const resB = await callB;
		assert.deepEqual(resB.content, [{ type: "text", text: "ran:B" }]);
		assert.equal(loadCalls, 1);
	});

	test("cleans up partial subscriptions on activation failure and retries cleanly on next trigger", async () => {
		let attempt = 0;
		let busListenerCalls = 0;
		let shutdownCalls = 0;
		const spec: LazyBuiltinSpec = {
			label: "retryable",
			register(pi, controller) {
				pi.registerTool({
					name: "ping",
					label: "Ping",
					description: "Ping",
					parameters: Type.Object({}),
					execute: (...args) => controller.executeTool("ping", args),
				});
			},
		};
		const { extension, runner, eventBus } = await mountExtension(
			createLazyBuiltinFactory(spec, async () => {
				attempt += 1;
				const currentAttempt = attempt;
				return (pi) => {
					pi.events.on("custom:ping", () => {
						busListenerCalls += 1;
					});
					pi.on("session_shutdown", () => {
						shutdownCalls += 1;
					});
					if (currentAttempt === 1) {
						pi.on("session_start", async () => {
							throw new Error("transient-init-boom");
						});
					}
					pi.registerTool({
						name: "ping",
						label: "Ping",
						description: "Ping",
						parameters: Type.Object({}),
						execute: async () => ({
							content: [{ type: "text", text: `ok-attempt-${currentAttempt}` }],
							details: {},
						}),
					});
				};
			}),
		);
		await runner.emit({ type: "session_start", reason: "startup" });
		const tool = extension.tools.get("ping")!.definition;

		// Attempt 1 fails during session_start replay -> candidate cleaned up (kills noCandidateCleanup).
		await assert.rejects(tool.execute("c1", {}, undefined, undefined, runner.createContext()), /transient-init-boom/);
		assert.equal(shutdownCalls, 1);
		eventBus.emit("custom:ping", {});
		assert.equal(busListenerCalls, 0);

		// Attempt 2 retries cleanly and succeeds (kills noRetryOnFail).
		const res = await tool.execute("c2", {}, undefined, undefined, runner.createContext());
		assert.deepEqual(res.content, [{ type: "text", text: "ok-attempt-2" }]);
		eventBus.emit("custom:ping", {});
		assert.equal(busListenerCalls, 1);
	});

	test("background activation does not block shutdown and orphaned completion cleans up without touching successor lease", async () => {
		const bgLoad = deferred<ExtensionFactory>();
		let controllerRef: Parameters<LazyBuiltinSpec["register"]>[1] | undefined;
		let loadCount = 0;
		let orphanedBusHits = 0;
		let orphanedShutdowns = 0;
		const spec: LazyBuiltinSpec = {
			label: "bg-orphan",
			register(pi, controller) {
				controllerRef = controller;
				pi.registerTool({
					name: "bg_tool",
					label: "BG",
					description: "BG",
					parameters: Type.Object({}),
					execute: (...args) => controller.executeTool("bg_tool", args),
				});
			},
		};
		const { extension, runner, eventBus } = await mountExtension(
			createLazyBuiltinFactory(spec, () => {
				loadCount += 1;
				if (loadCount === 1) return bgLoad.promise;
				return Promise.resolve((pi: ExtensionAPI) => {
					pi.registerTool({
						name: "bg_tool",
						label: "BG",
						description: "BG",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "lease-2-ok" }], details: {} }),
					});
				});
			}),
		);
		await runner.emit({ type: "session_start", reason: "startup" });
		// Kick off background activation (like Intercom's 3s startup join) and let it enter loadImplementation().
		const bgPromise = controllerRef!.activate(runner.createContext(), { background: true });
		bgPromise.catch(() => {});
		await new Promise((r) => setImmediate(r));
		assert.equal(loadCount, 1);

		// Shutdown must NOT block on background-only activation (kills bgBlocksShutdown).
		await runner.emit({ type: "session_shutdown", reason: "new" });

		// Start successor session (lease 2) while lease 1's background load is STILL pending!
		await runner.emit({ type: "session_start", reason: "new" });
		assert.equal(controllerRef!.active, null);

		// Now lease 1's orphaned background load resolves -> must fail lease fence and clean up (kills noLeaseFence).
		bgLoad.resolve((pi) => {
			pi.events.on("orphan:check", () => {
				orphanedBusHits += 1;
			});
			pi.on("session_shutdown", () => {
				orphanedShutdowns += 1;
			});
		});
		await assert.rejects(bgPromise, /invalidated by session shutdown/i);
		assert.equal(controllerRef!.active, null);
		eventBus.emit("orphan:check", {});
		assert.equal(orphanedBusHits, 0);
		assert.equal(orphanedShutdowns, 0); // Never instantiated because lease fence stopped it right after import!

		// Lease 2 activates cleanly on its own!
		const res = await extension.tools
			.get("bg_tool")!
			.definition.execute("c2", {}, undefined, undefined, runner.createContext());
		assert.deepEqual(res.content, [{ type: "text", text: "lease-2-ok" }]);
	});

	test("foreground shutdown waits for in-flight non-background activation cleanup and fences waiting callers", async () => {
		const loadGate = deferred<ExtensionFactory>();
		let cleanedUp = false;
		const spec: LazyBuiltinSpec = {
			label: "fg-shutdown",
			register(pi, controller) {
				pi.registerTool({
					name: "slow",
					label: "Slow",
					description: "Slow",
					parameters: Type.Object({}),
					execute: (...args) => controller.executeTool("slow", args),
				});
			},
		};
		const { extension, runner } = await mountExtension(createLazyBuiltinFactory(spec, () => loadGate.promise));
		await runner.emit({ type: "session_start", reason: "startup" });

		const call = extension.tools
			.get("slow")!
			.definition.execute("c1", {}, undefined, undefined, runner.createContext());
		await new Promise((r) => setImmediate(r));

		let shutdownResolved = false;
		const shutdown = runner.emit({ type: "session_shutdown", reason: "quit" }).then(() => {
			shutdownResolved = true;
		});
		await new Promise((r) => setImmediate(r));
		assert.equal(shutdownResolved, false);

		loadGate.resolve((pi) => {
			pi.on("session_shutdown", () => {
				cleanedUp = true;
			});
		});
		await shutdown;
		assert.equal(shutdownResolved, true);
		await assert.rejects(call, /invalidated by session shutdown/i);
		// Import returned after lease retired, so heavy factory never even ran.
		assert.equal(cleanedUp, false);
	});

	test("rollbackExtensionFactories shuts down dormant lazy builtin cleanly without activating or touching sessionManager", async () => {
		let loadCount = 0;
		let dormantCleanups = 0;
		const spec: LazyBuiltinSpec = {
			label: "rollback-safe",
			register(_pi, controller) {
				controller.onDormantShutdown(() => {
					dormantCleanups += 1;
				});
			},
		};
		const harness = createRunnerHarness(
			createLazyBuiltinFactory(spec, async () => {
				loadCount += 1;
				return () => {};
			}),
		);
		const extension = await loadExtensionFromFactory(
			harness.factory,
			harness.dir,
			harness.eventBus,
			harness.runtime,
			"builtin:rollback",
		);
		const failures = await rollbackExtensionFactories([extension], harness.dir);
		assert.deepEqual(failures, []);
		assert.equal(loadCount, 0);
		assert.equal(dormantCleanups, 1);
	});

	test("instantiateExtensions clones produce independent lazy state per session", async () => {
		let loadCount = 0;
		const spec: LazyBuiltinSpec = {
			label: "per-session",
			register(pi, controller) {
				pi.registerTool({
					name: "iso",
					label: "Iso",
					description: "Iso",
					parameters: Type.Object({}),
					execute: (...args) => controller.executeTool("iso", args),
				});
			},
		};
		const lazyFactory = createLazyBuiltinFactory(spec, async () => {
			loadCount += 1;
			const id = loadCount;
			return (pi) => {
				pi.registerTool({
					name: "iso",
					label: "Iso",
					description: "Iso",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: `instance-${id}` }], details: {} }),
				});
			};
		});
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-iso-"));
		tempDirs.push(dir);
		const discoveryRuntime = createExtensionRuntime();
		const discoveryExt = await loadExtensionFromFactory(
			lazyFactory,
			dir,
			createEventBus(),
			discoveryRuntime,
			"builtin:iso",
		);
		const discovery = { extensions: [discoveryExt], errors: [], warnings: [], runtime: discoveryRuntime };

		const s1 = await instantiateExtensions(discovery, dir);
		const s2 = await instantiateExtensions(discovery, dir);
		assert.equal(loadCount, 0);

		const ctx = {} as ExtensionContext;
		const res1 = await s1.extensions[0]!.tools.get("iso")!.definition.execute("1", {}, undefined, undefined, ctx);
		assert.deepEqual(res1.content, [{ type: "text", text: "instance-1" }]);
		assert.equal(loadCount, 1);

		// Session 2 is still dormant until used, then gets its own independent instance.
		const res2 = await s2.extensions[0]!.tools.get("iso")!.definition.execute("2", {}, undefined, undefined, ctx);
		assert.deepEqual(res2.content, [{ type: "text", text: "instance-2" }]);
		assert.equal(loadCount, 2);
	});

	test("loadExtensions uses registered lazy builtin spec without eagerly loading the builtin module", async () => {
		const webLocation = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "web-access");
		assert.ok(webLocation, "web-access builtin location must exist");
		const entryPath = join(webLocation.packageDir, "index.ts");
		let executed = false;

		savedSpecs.push({ label: "web-access", previous: getLazyBuiltinSpec("web-access") });
		registerLazyBuiltin("web-access", {
			label: "web-access",
			register(pi, controller) {
				pi.registerTool({
					name: "lazy_probe_tool",
					label: "Probe",
					description: "Probe",
					parameters: Type.Object({}),
					execute: async (id, params, signal, onUpdate, ctx) => {
						executed = true;
						assert.ok(controller);
						return {
							content: [
								{
									type: "text",
									text: `probe:${id}:${String(Boolean(params))}:${String(Boolean(signal))}:${String(Boolean(onUpdate))}:${String(Boolean(ctx))}`,
								},
							],
							details: {},
						};
					},
				});
			},
		});

		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-loader-"));
		tempDirs.push(dir);
		const loaded = await loadExtensions([entryPath], dir);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		assert.equal(loaded.extensions[0]!.path, entryPath);
		assert.equal(loaded.extensions[0]!.tools.has("lazy_probe_tool"), true);
		// Eager web_search tool from packages/web-access/index.ts was NOT loaded at discovery time!
		assert.equal(loaded.extensions[0]!.tools.has("web_search"), false);
		assert.equal(executed, false);
	});

	test("dispatches session_shutdown at most once when shutdown arrives during onActivated hook", async () => {
		const hookGate = deferred<void>();
		let shutdownCount = 0;
		const spec: LazyBuiltinSpec = {
			label: "shutdown-once",
			register(pi, controller) {
				controller.onActivated(async () => {
					await hookGate.promise;
				});
				pi.registerTool({
					name: "act",
					label: "Act",
					description: "Act",
					parameters: Type.Object({}),
					execute: (...args) => controller.executeTool("act", args),
				});
			},
		};
		const { extension, runner } = await mountExtension(
			createLazyBuiltinFactory(spec, async () => (pi) => {
				pi.on("session_shutdown", () => {
					shutdownCount += 1;
				});
				pi.registerTool({
					name: "act",
					label: "Act",
					description: "Act",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			}),
		);
		await runner.emit({ type: "session_start", reason: "startup" });
		const call = extension.tools
			.get("act")!
			.definition.execute("c1", {}, undefined, undefined, runner.createContext());
		await new Promise((r) => setImmediate(r));

		const shutdown = runner.emit({ type: "session_shutdown", reason: "quit" });
		hookGate.resolve();
		await shutdown;
		await assert.rejects(call, /invalidated by session shutdown/i);
		assert.equal(shutdownCount, 1);
	});

	test("retired background factory cannot mutate live ExtensionAPI after successor lease starts", async () => {
		const factoryGate = deferred<void>();
		let controllerRef: Parameters<LazyBuiltinSpec["register"]>[1] | undefined;
		let loadIndex = 0;
		const spec: LazyBuiltinSpec = {
			label: "proxy-fence",
			register(_pi, controller) {
				controllerRef = controller;
			},
		};
		const { extension, runner } = await mountExtension(
			createLazyBuiltinFactory(spec, async () => {
				loadIndex += 1;
				if (loadIndex === 1) {
					return async (pi) => {
						await factoryGate.promise;
						// Attempt to register a dynamic tool on the retired proxy after successor lease started!
						pi.registerTool({
							name: "stale_bg_tool",
							label: "Stale",
							description: "Stale",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "stale" }], details: {} }),
						});
					};
				}
				return () => {};
			}),
		);
		await runner.emit({ type: "session_start", reason: "startup" });
		const bgPromise = controllerRef!.activate(runner.createContext(), { background: true });
		bgPromise.catch(() => {});
		await new Promise((r) => setImmediate(r));

		// Retire lease 1 and start successor lease 2 while lease 1's async factory is suspended!
		await runner.emit({ type: "session_shutdown", reason: "new" });
		await runner.emit({ type: "session_start", reason: "new" });

		// Resume lease 1's async factory; proxy must reject mutation and leave lease 2's Extension untouched!
		factoryGate.resolve();
		await assert.rejects(bgPromise, /invalidated by session shutdown/i);
		assert.equal(extension.tools.has("stale_bg_tool"), false);
	});

	test("toolRenderers registered during failed activation do not leak or duplicate across retries", async () => {
		let attempt = 0;
		const resolverCalls: number[] = [];
		const spec: LazyBuiltinSpec = {
			label: "tool-renderer-retry",
			register(pi, controller) {
				pi.registerTool({
					name: "render_me",
					label: "RenderMe",
					description: "RenderMe",
					parameters: Type.Object({}),
					execute: (...args) => controller.executeTool("render_me", args),
				});
			},
		};
		const { extension, runner } = await mountExtension(
			createLazyBuiltinFactory(spec, async () => {
				attempt += 1;
				const currentAttempt = attempt;
				return (pi) => {
					pi.registerToolRenderer((toolName, next) => {
						resolverCalls.push(currentAttempt);
						return toolName === "render_me" ? {} : next();
					});
					if (currentAttempt === 1) throw new Error("fail-attempt-1");
					pi.registerTool({
						name: "render_me",
						label: "RenderMe",
						description: "RenderMe",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				};
			}),
		);
		await runner.emit({ type: "session_start", reason: "startup" });
		const tool = extension.tools.get("render_me")!.definition;

		await assert.rejects(tool.execute("c1", {}, undefined, undefined, runner.createContext()), /fail-attempt-1/);
		// Failed attempt 1's toolRenderer must NOT be invoked while dormant!
		runner.resolveToolRenderers("render_me", () => undefined);
		assert.deepEqual(resolverCalls, []);

		// Attempt 2 succeeds; ONLY attempt 2's toolRenderer runs (once, no leak from attempt 1).
		await tool.execute("c2", {}, undefined, undefined, runner.createContext());
		runner.resolveToolRenderers("render_me", () => undefined);
		assert.deepEqual(resolverCalls, [2]);
	});

	test("message_start arriving while lazy module import is awaiting is buffered and delivered in order", async () => {
		const loadGate = deferred<ExtensionFactory>();
		const observed: string[] = [];
		const spec: LazyBuiltinSpec = {
			label: "message-start-buffer",
			register(pi, controller) {
				pi.registerTool({
					name: "msg_tool",
					label: "MsgTool",
					description: "MsgTool",
					parameters: Type.Object({}),
					execute: (...args) => controller.executeTool("msg_tool", args),
				});
			},
		};
		const { extension, runner } = await mountExtension(createLazyBuiltinFactory(spec, () => loadGate.promise));
		await runner.emit({ type: "session_start", reason: "startup" });
		await runner.emit({ type: "turn_start", turnIndex: 0, timestamp: 1 });

		// Trigger activation (suspended inside loadImplementation()).
		const call = extension.tools
			.get("msg_tool")!
			.definition.execute("c1", {}, undefined, undefined, runner.createContext());
		await new Promise((r) => setImmediate(r));

		// message_start arrives while loadImplementation() is still pending!
		await runner.emit({
			type: "message_start",
			message: { role: "custom", customType: "intercom_message", content: "hi", display: true, timestamp: 2 },
		});

		loadGate.resolve((pi) => {
			pi.on("session_start", () => {
				observed.push("session_start");
			});
			pi.on("turn_start", () => {
				observed.push("turn_start");
			});
			pi.on("message_start", (event) => {
				observed.push(
					`message_start:${(event.message as { customType?: string }).customType ?? event.message.role}`,
				);
			});
			pi.registerTool({
				name: "msg_tool",
				label: "MsgTool",
				description: "MsgTool",
				parameters: Type.Object({}),
				execute: async () => {
					observed.push("execute");
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			});
		});
		await call;
		assert.deepEqual(observed, ["session_start", "turn_start", "message_start:intercom_message", "execute"]);
	});
});
