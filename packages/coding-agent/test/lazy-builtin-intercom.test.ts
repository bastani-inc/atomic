import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import intercomEagerFactory from "../../../packages/intercom/index.js";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getMandatoryBuiltinExtensionPaths } from "../src/core/builtin-packages.ts";
import { createEventBus } from "../src/core/event-bus.js";
import { createLazyBuiltinFactory, hasLazyBuiltinSpec } from "../src/core/extensions/lazy-builtin.js";
import { intercomLazyBuiltinSpec } from "../src/core/extensions/lazy-builtins/intercom.js";
import { loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.js";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];
const originalOrchestratorTarget = process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET;

afterEach(() => {
	if (originalOrchestratorTarget === undefined) delete process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET;
	else process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET = originalOrchestratorTarget;
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
		detachmentRequiresReady: tool.detachmentRequiresReady,
		scriptAccess: tool.scriptAccess
			? {
					description: tool.scriptAccess.description,
					outputSchema: tool.scriptAccess.outputSchema,
				}
			: undefined,
	});
}

describe("lazy builtin intercom", () => {
	test("registers byte-identical tool, command, and shortcut surfaces compared to eager intercom without loading intercom module", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-intercom-"));
		tempDirs.push(dir);
		const [intercomEntry] = getMandatoryBuiltinExtensionPaths();
		assert.ok(intercomEntry, "expected mandatory intercom entry path");

		// Load lazy via loadExtensions (must register default lazy builtins and NOT load intercom module).
		const lazyLoaded = await loadExtensions([intercomEntry], dir);
		assert.equal(hasLazyBuiltinSpec("intercom"), true);
		assert.deepEqual(lazyLoaded.errors, []);
		assert.equal(lazyLoaded.extensions.length, 1);
		assert.equal(extensionLoaderTestHooks.hasNativeBuiltinFactory(intercomEntry), false);

		// Load eager directly from packages/intercom/index.ts.
		const eagerExt = await loadExtensionFromFactory(
			intercomEagerFactory,
			dir,
			createEventBus(),
			createExtensionRuntime(),
			intercomEntry,
		);
		const lazyExt = lazyLoaded.extensions[0]!;

		// Tool names & serialized JSON schemas/descriptions/snippets/guidelines/scriptAccess must be byte-identical.
		assert.deepEqual([...lazyExt.tools.keys()], [...eagerExt.tools.keys()]);
		assert.equal(
			serializeToolSurface(lazyExt.tools.get("intercom")?.definition),
			serializeToolSurface(eagerExt.tools.get("intercom")?.definition),
		);

		// scriptAccess.refuse parity across all actions
		const lazyRefuse = lazyExt.tools.get("intercom")!.definition.scriptAccess!.refuse!;
		const eagerRefuse = eagerExt.tools.get("intercom")!.definition.scriptAccess!.refuse!;
		for (const sample of [
			{ action: "list" },
			{ action: "status" },
			{ action: "pending" },
			{ action: "send", to: "peer-1" },
			{ action: "send", to: "subagents:*" },
			{ action: "send", to: "peer-*" },
			{ action: "send", to: "peer-1", replyTo: "msg-1" },
			{ action: "ask", to: "peer-1" },
			{ action: "reply" },
			{ action: "join" },
		]) {
			assert.equal(lazyRefuse(sample), eagerRefuse(sample), `refuse mismatch for ${JSON.stringify(sample)}`);
		}

		// detachable parity
		const lazyDetach = lazyExt.tools.get("intercom")!.definition.detachable as (p: { action?: string }) => boolean;
		const eagerDetach = eagerExt.tools.get("intercom")!.definition.detachable as (p: { action?: string }) => boolean;
		for (const action of ["ask", "send", "list", "status", "reply", "cancel", "pending", "join", "leave"]) {
			assert.equal(lazyDetach({ action }), eagerDetach({ action }), `detachable mismatch for ${action}`);
		}

		// Commands & shortcuts parity
		assert.deepEqual([...lazyExt.commands.keys()], [...eagerExt.commands.keys()]);
		assert.equal(lazyExt.commands.get("intercom")?.description, eagerExt.commands.get("intercom")?.description);
		assert.deepEqual([...lazyExt.shortcuts.keys()], [...eagerExt.shortcuts.keys()]);
		assert.equal(lazyExt.shortcuts.get("alt+m")?.description, eagerExt.shortcuts.get("alt+m")?.description);
		assert.equal(lazyExt.messageRenderers.has("intercom_message"), true);
	});

	test("registers byte-identical contact_supervisor tool when subagent orchestrator env is present", async () => {
		process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET = "supervisor-session";
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-intercom-sub-"));
		tempDirs.push(dir);
		const [intercomEntry] = getMandatoryBuiltinExtensionPaths();
		assert.ok(intercomEntry);

		const lazyLoaded = await loadExtensions([intercomEntry], dir);
		const eagerExt = await loadExtensionFromFactory(
			intercomEagerFactory,
			dir,
			createEventBus(),
			createExtensionRuntime(),
			intercomEntry,
		);
		const lazyExt = lazyLoaded.extensions[0]!;

		assert.deepEqual([...lazyExt.tools.keys()], [...eagerExt.tools.keys()]);
		assert.equal(
			serializeToolSurface(lazyExt.tools.get("contact_supervisor")?.definition),
			serializeToolSurface(eagerExt.tools.get("contact_supervisor")?.definition),
		);
	});

	test("answers dormant drop/ack/mark-ended/release bus requests and format-released-reply without activating", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-intercom-bus-"));
		tempDirs.push(dir);
		const [intercomEntry] = getMandatoryBuiltinExtensionPaths();
		assert.ok(intercomEntry);
		const bus = createEventBus();
		const loaded = await loadExtensions([intercomEntry], dir, bus);
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
				getActiveTools: () => ["intercom"],
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

		for (const [channel, payload] of [
			["subagent:drop-released-children", { childNames: ["worker-1"] }],
			["subagent:acknowledge-released-child-wake", { childName: "worker-1" }],
			["subagent:mark-ended-children", { children: [{ childName: "worker-1", outcome: "completed" }] }],
			["subagent:release-restoring-child", { capability: "cap-1" }],
		] as const) {
			const req: Record<string, unknown> = { ...payload };
			bus.emit(channel, req);
			assert.ok(req.completion instanceof Promise, `${channel} must assign completion synchronously`);
			await req.completion;
		}

		// Synchronous format-released-reply must work while dormant
		const fmtReq: {
			toolName: string;
			args: { to?: string };
			outcome: { kind: "reply"; reply: { replyTo: string; text: string } };
			result?: { ok: boolean; formatted?: { content: Array<{ type: string; text: string }>; isError: boolean } };
		} = {
			toolName: "intercom",
			args: { to: "peer-1" },
			outcome: { kind: "reply", reply: { replyTo: "ask-1", text: "looks good" } },
		};
		bus.emit("intercom:format-released-reply", fmtReq);
		assert.equal(fmtReq.result?.ok, true);
		assert.equal(fmtReq.result?.formatted?.content[0]?.text, "**Reply from peer-1:**\nlooks good");
	});

	test("untrusted folder startup join survives agent_end and joins after a single 3s delay without a second 3s wait", async () => {
		const savedEnv = {
			orch: process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET,
			name: process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME,
			join: process.env.ATOMIC_INTERCOM_JOIN_AT_STARTUP,
		};
		delete process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET;
		delete process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME;
		delete process.env.ATOMIC_INTERCOM_JOIN_AT_STARTUP;
		vi.useFakeTimers();
		try {
			const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-intercom-join-"));
			tempDirs.push(dir);
			let implJoinCalls = 0;
			let implLoadCount = 0;
			const factory = createLazyBuiltinFactory(intercomLazyBuiltinSpec, async () => {
				implLoadCount += 1;
				return (pi) => {
					pi.events.on("intercom:startup-join", (payload) => {
						implJoinCalls += 1;
						(payload as { completion?: Promise<void> }).completion = Promise.resolve();
					});
				};
			});
			const bus = createEventBus();
			const runtime = createExtensionRuntime();
			const ext = await loadExtensionFromFactory(factory, dir, bus, runtime, "builtin:intercom");
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
					getActiveTools: () => ["intercom"],
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
					// Untrusted folder!
					isProjectTrusted: () => false,
					getSignal: () => undefined,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: () => {},
					getSystemPrompt: () => "",
				},
			);
			runner.setUIContext(runner.getUIContext(), "tui", false);
			await runner.emit({ type: "session_start", reason: "startup" });
			assert.equal(implLoadCount, 0);

			// First prompt runs and completes before the 3s timer fires (agent_end clears active agentStart).
			await runner.emit({ type: "agent_start" });
			await runner.emit({ type: "agent_end", messages: [] });
			assert.equal(implLoadCount, 0);

			// At 3s, dormantJoin fires, activates Intercom once, and dispatches intercom:startup-join immediately.
			await vi.advanceTimersByTimeAsync(3_100);
			assert.equal(implLoadCount, 1);
			assert.equal(implJoinCalls, 1);
		} finally {
			vi.useRealTimers();
			if (savedEnv.orch === undefined) delete process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET;
			else process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET = savedEnv.orch;
			if (savedEnv.name === undefined) delete process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME;
			else process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME = savedEnv.name;
			if (savedEnv.join === undefined) delete process.env.ATOMIC_INTERCOM_JOIN_AT_STARTUP;
			else process.env.ATOMIC_INTERCOM_JOIN_AT_STARTUP = savedEnv.join;
		}
	});
});
