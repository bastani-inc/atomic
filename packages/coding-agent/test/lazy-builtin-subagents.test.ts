import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import subagentEagerFactory from "../../../packages/subagents/src/extension/index.js";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getBuiltinPackageLocations } from "../src/core/builtin-packages.ts";
import { createEventBus } from "../src/core/event-bus.js";
import { createLazyBuiltinFactory, hasLazyBuiltinSpec } from "../src/core/extensions/lazy-builtin.js";
import { subagentsLazyBuiltinSpec } from "../src/core/extensions/lazy-builtins/subagents.js";
import { loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.js";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function serializeToolSurface(tool: ToolDefinition | undefined): string {
	assert.ok(tool, "expected tool definition");
	return JSON.stringify({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: tool.parameters,
		exposure: tool.exposure,
		scriptAccess: tool.scriptAccess
			? {
					description: tool.scriptAccess.description,
					outputSchema: tool.scriptAccess.outputSchema,
				}
			: undefined,
	});
}

describe("lazy builtin subagents", () => {
	test("registers byte-identical tool, command, renderers, prepareArguments, and scriptAccess without loading subagents module", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-subagents-"));
		tempDirs.push(dir);
		const subLocation = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "subagents");
		assert.ok(subLocation, "subagents builtin location must exist");
		const entryPath = join(subLocation.packageDir, "src", "extension", "index.ts");

		const lazyLoaded = await loadExtensions([entryPath], dir);
		assert.equal(hasLazyBuiltinSpec("subagents"), true);
		assert.deepEqual(lazyLoaded.errors, []);
		assert.equal(lazyLoaded.extensions.length, 1);
		assert.equal(extensionLoaderTestHooks.hasNativeBuiltinFactory(entryPath), false);

		const eagerExt = await loadExtensionFromFactory(
			subagentEagerFactory,
			dir,
			createEventBus(),
			createExtensionRuntime(),
			entryPath,
		);
		const lazyExt = lazyLoaded.extensions[0]!;

		assert.deepEqual([...lazyExt.tools.keys()], [...eagerExt.tools.keys()]);
		assert.equal(
			serializeToolSurface(lazyExt.tools.get("subagent")?.definition),
			serializeToolSurface(eagerExt.tools.get("subagent")?.definition),
		);

		// scriptAccess.refuse parity
		const lazyRefuse = lazyExt.tools.get("subagent")!.definition.scriptAccess!.refuse!;
		const eagerRefuse = eagerExt.tools.get("subagent")!.definition.scriptAccess!.refuse!;
		for (const sample of [
			{ action: "list" },
			{ action: "get" },
			{ action: "create" },
			{ action: "update" },
			{ action: "delete" },
			{ action: "wait", id: "t1", budgetMs: 1000 },
			{ action: "wait", id: "t1", budgetMs: -1 },
			{ action: "wait" },
			{ action: "pause", all: true },
			{ action: "pause" },
			{ action: "resume", all: true },
			{ action: "status", runId: "r1" },
		]) {
			assert.equal(lazyRefuse(sample), eagerRefuse(sample), `refuse mismatch for ${JSON.stringify(sample)}`);
		}

		// prepareArguments parity (removed actions + legacy wait + removed routing fields)
		const lazyPrep = lazyExt.tools.get("subagent")!.definition.prepareArguments!;
		const eagerPrep = eagerExt.tools.get("subagent")!.definition.prepareArguments!;
		for (const removed of ["kill", "interrupt"]) {
			assert.throws(() => lazyPrep({ action: removed }), /was removed/i);
			assert.throws(() => eagerPrep({ action: removed }), /was removed/i);
		}
		assert.deepEqual(
			lazyPrep({ agent: "worker", task: "hi", wait: { kind: "foreground" }, taskNeeds: ["x"] }),
			eagerPrep({ agent: "worker", task: "hi", wait: { kind: "foreground" }, taskNeeds: ["x"] }),
		);

		// Commands & all 5 message renderers parity
		assert.deepEqual([...lazyExt.commands.keys()], [...eagerExt.commands.keys()]);
		assert.equal(lazyExt.commands.get("agents")?.description, eagerExt.commands.get("agents")?.description);
		assert.deepEqual([...lazyExt.messageRenderers.keys()].sort(), [...eagerExt.messageRenderers.keys()].sort());
	});

	test("answers dormant Intercom query bus events synchronously and buffers intercom:connected without activating", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-subagents-bus-"));
		tempDirs.push(dir);
		const subLocation = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "subagents");
		assert.ok(subLocation);
		const entryPath = join(subLocation.packageDir, "src", "extension", "index.ts");

		const bus = createEventBus();
		const loaded = await loadExtensions([entryPath], dir, bus);
		assert.deepEqual(loaded.errors, []);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			dir,
			SessionManager.inMemory(dir),
			new ModelRegistry(AuthStorage.inMemory()),
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
				getActiveTools: () => ["subagent"],
				getAllTools: () => [],
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
		await runner.emit({ type: "session_start", reason: "startup" });

		// Intercom emits its own sessionId while subagents is dormant (buffered for future activation).
		bus.emit("intercom:connected", { sessionId: "ic-session-123" });

		// Dormant Intercom queries assign completion synchronously and resolve empty without loading subagents.
		const listReq: { ownerSessionId: string; completion?: Promise<readonly unknown[]> } = {
			ownerSessionId: "owner-1",
		};
		bus.emit("subagent:list-intercom-children", listReq);
		assert.ok(listReq.completion instanceof Promise);
		assert.deepEqual(await listReq.completion, []);

		const asksReq: { ownerSessionId: string; asks: unknown[]; completion?: Promise<readonly string[]> } = {
			ownerSessionId: "owner-1",
			asks: [],
		};
		bus.emit("subagent:finished-asks", asksReq);
		assert.ok(asksReq.completion instanceof Promise);
		assert.deepEqual(await asksReq.completion, []);

		const peersReq: { ownerSessionId: string; completion?: Promise<readonly unknown[]> } = {
			ownerSessionId: "owner-1",
		};
		bus.emit("subagent:restored-intercom-peers", peersReq);
		assert.ok(peersReq.completion instanceof Promise);
		assert.deepEqual(await peersReq.completion, []);

		const restoreReq: {
			ownerSessionId: string;
			target: string;
			timeoutMs: number;
			completion?: Promise<string | undefined>;
		} = {
			ownerSessionId: "owner-1",
			target: "worker-1",
			timeoutMs: 100,
		};
		bus.emit("subagent:await-child-restoration", restoreReq);
		assert.ok(restoreReq.completion instanceof Promise);
		assert.equal(await restoreReq.completion, undefined);
	});

	test("replays buffered intercom:connected into implementation during onActivated before first tool execute", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-subagents-ic-replay-"));
		tempDirs.push(dir);
		const receivedConnected: unknown[] = [];
		const factory = createLazyBuiltinFactory(subagentsLazyBuiltinSpec, async () => (atomic) => {
			atomic.events.on("intercom:connected", (payload) => {
				receivedConnected.push(payload);
			});
			atomic.registerTool({
				name: "subagent",
				label: "Subagent",
				description: "Subagent",
				parameters: { type: "object", properties: {} } as never,
				execute: async () => ({
					content: [{ type: "text", text: `seen:${receivedConnected.length}` }],
					details: {},
				}),
			});
		});
		const bus = createEventBus();
		const runtime = createExtensionRuntime();
		const ext = await loadExtensionFromFactory(factory, dir, bus, runtime, "builtin:subagents");
		const runner = new ExtensionRunner(
			[ext],
			runtime,
			dir,
			SessionManager.inMemory(dir),
			new ModelRegistry(AuthStorage.inMemory()),
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
				getActiveTools: () => ["subagent"],
				getAllTools: () => [],
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
		await runner.emit({ type: "session_start", reason: "startup" });
		bus.emit("intercom:connected", { sessionId: "parent-ic-99" });
		assert.deepEqual(receivedConnected, []);

		const res = await ext.tools
			.get("subagent")!
			.definition.execute("c1", { action: "list" }, undefined, undefined, runner.createContext());
		assert.deepEqual(receivedConnected, [{ sessionId: "parent-ic-99" }]);
		assert.deepEqual(res.content, [{ type: "text", text: "seen:1" }]);
	});

	test("activates on session_start when tail-loaded session has archived subagent children", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-subagents-archived-"));
		tempDirs.push(dir);
		let activated = 0;
		const factory = createLazyBuiltinFactory(subagentsLazyBuiltinSpec, async () => () => {
			activated += 1;
		});
		const bus = createEventBus();
		const runtime = createExtensionRuntime();
		const ext = await loadExtensionFromFactory(factory, dir, bus, runtime, "builtin:subagents");
		const sessionManager = SessionManager.inMemory(dir);
		(sessionManager as unknown as { getArchivedChildCatalog: () => unknown[] }).getArchivedChildCatalog = () => [
			{ childId: "run1:0", agent: "worker", state: "terminal" },
		];
		const runner = new ExtensionRunner(
			[ext],
			runtime,
			dir,
			sessionManager,
			new ModelRegistry(AuthStorage.inMemory()),
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
				getActiveTools: () => ["subagent"],
				getAllTools: () => [],
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
		await runner.emit({ type: "session_start", reason: "resume" });
		assert.equal(activated, 1);
	});
});
