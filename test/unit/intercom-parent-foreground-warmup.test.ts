import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@bastani/atomic";
import intercom from "../../packages/intercom/index.js";

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => void | Promise<void>;

function fixture(options: { delayedRegistration?: boolean; delayedImport?: boolean; disabled?: boolean; child?: boolean; childSessionName?: string; importFailure?: boolean; readinessFailure?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const sequence: string[] = [];
	const sessionNames: string[] = [];
	let imports = 0;
	let finishRegistration: (() => void) | null = null;
	let failRegistration: ((error: Error) => void) | null = null;
	const registration = options.delayedRegistration
		? new Promise<void>((resolve, reject) => { finishRegistration = resolve; failRegistration = reject; })
		: Promise.resolve();
	let finishImport: (() => void) | null = null;
	const importReady = options.delayedImport
		? new Promise<void>((resolve) => { finishImport = resolve; })
		: Promise.resolve();
	const activeTools = new Map<string, string>();
	const pi = {
		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		registerTool() {}, registerCommand() {}, registerShortcut() {},
		setSessionName(name: string) { sessionNames.push(name); },
		events: { on() {} },
	};
	const priorOrchestratorTarget = process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET;
	const priorSessionName = process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME;
	if (options.child) process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET = "parent";
	else delete process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET;
	if (options.childSessionName) process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME = options.childSessionName;
	else delete process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME;
	intercom(pi as never, {
		isEnabled: () => !options.disabled,
		async importHeavy() {
			imports += 1;
			sequence.push("heavy-loaded");
			await importReady;
			if (options.importFailure) throw new Error("missing-heavy");
			return {
				default(heavyPi: ExtensionAPI) {
					heavyPi.on("session_start", () => { sequence.push("inbound-handlers-attached"); });
					heavyPi.on("tool_execution_start", (event) => {
						sequence.push("foreground-start-forwarded");
						activeTools.set(event.toolCallId, event.toolName);
					});
					heavyPi.on("tool_execution_end", (event) => { activeTools.delete(event.toolCallId); });
					if (options.delayedRegistration) {
						heavyPi.on("session_shutdown", () => {
							failRegistration?.(new Error("Intercom runtime no longer active"));
						});
					}
					return {
						enabled: !options.disabled,
						async awaitAutomaticBrokerReady() {
							if (options.disabled) throw new Error("disabled readiness must not be awaited");
							await registration;
							if (options.readinessFailure) throw new Error("connect failed");
							sequence.push("broker-registered");
						},
						async awaitForegroundBrokerReady() {
							if (options.disabled) throw new Error("disabled readiness must not be awaited");
							await registration;
							if (options.readinessFailure) throw new Error("connect failed");
							sequence.push("broker-registered");
						},
					};
				},
			};
		},
	});
	if (priorOrchestratorTarget === undefined) delete process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET;
	else process.env.ATOMIC_SUBAGENT_ORCHESTRATOR_TARGET = priorOrchestratorTarget;
	if (priorSessionName === undefined) delete process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME;
	else process.env.ATOMIC_SUBAGENT_INTERCOM_SESSION_NAME = priorSessionName;
	const ctx = { hasUI: true };
	async function emit(name: string, event: Record<string, unknown>, context = ctx): Promise<void> {
		for (const handler of handlers.get(name) ?? []) await handler(event, context);
	}
	return {
		sequence, sessionNames, get imports() { return imports; }, emit, ctx,
		get presence() { return activeTools.size > 0 ? `tool:${activeTools.values().next().value}` : "thinking"; },
		finishImport: () => finishImport?.(),
		finishRegistration: () => finishRegistration?.(),
		failRegistration: (error: Error) => failRegistration?.(error),
	};
}

describe("lightweight intercom parent foreground warmup", () => {
	test("interactive parent session start remains lazy until foreground launch", async () => {
		const current = fixture();
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		await Bun.sleep(1);
		assert.equal(current.imports, 0);
		assert.deepEqual(current.sequence, []);
	});

	test("foreground launch loads and registers before child launch", async () => {
		const current = fixture();
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		await current.emit("tool_execution_start", {
			type: "tool_execution_start", toolCallId: "child-1", toolName: "subagent",
			args: { agent: "worker", task: "ask the parent" },
		});
		current.sequence.push("child-launch");
		assert.equal(current.imports, 1);
		assert.equal(current.sequence.at(-1), "child-launch");
		assert.ok(current.sequence.includes("broker-registered"));
	});

	test("foreground lifecycle is forwarded exactly once and matching end clears presence", async () => {
		const current = fixture();
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		await Bun.sleep(1);
		await current.emit("tool_execution_start", {
			type: "tool_execution_start", toolCallId: "warm-child", toolName: "subagent", args: {},
		});
		assert.equal(current.sequence.filter((entry) => entry === "foreground-start-forwarded").length, 1);
		assert.equal(current.presence, "tool:subagent");
		await current.emit("tool_execution_end", {
			type: "tool_execution_end", toolCallId: "warm-child", toolName: "subagent", result: {}, isError: false,
		});
		assert.equal(current.presence, "thinking");
	});

	test("cold load-race replay owns foreground lifecycle delivery exactly once", async () => {
		const current = fixture({ delayedImport: true });
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		const startPromise = current.emit("tool_execution_start", {
			type: "tool_execution_start", toolCallId: "cold-child", toolName: "subagent", args: {},
		});
		await Bun.sleep(1);
		current.finishImport();
		await startPromise;
		assert.equal(current.sequence.filter((entry) => entry === "foreground-start-forwarded").length, 1);
		assert.equal(current.presence, "tool:subagent");
		await current.emit("tool_execution_end", {
			type: "tool_execution_end", toolCallId: "cold-child", toolName: "subagent", result: {}, isError: false,
		});
		assert.equal(current.presence, "thinking");
	});

	test("disabled intercom does not gate unrelated foreground subagent launches", async () => {
		const current = fixture({ disabled: true });
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		await current.emit("tool_execution_start", {
			type: "tool_execution_start", toolCallId: "unrelated-child", toolName: "subagent", args: {},
		});
		current.sequence.push("child-launch");

		assert.equal(current.imports, 0);
		assert.deepEqual(current.sequence, ["child-launch"]);
	});

	test("foreground tool start waits for broker registration readiness", async () => {
		const current = fixture({ delayedRegistration: true });
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		let settled = false;
		const start = current.emit("tool_execution_start", {
			type: "tool_execution_start", toolCallId: "child-delayed", toolName: "subagent", args: {},
		}).then(() => { settled = true; });
		await Promise.resolve();
		await Bun.sleep(1);
		assert.equal(settled, false, "child launch must remain gated while registration is pending");
		assert.deepEqual(current.sequence, ["heavy-loaded", "inbound-handlers-attached", "foreground-start-forwarded"]);

		current.finishRegistration();
		await start;
		assert.equal(settled, true);
		assert.equal(current.sequence.at(-1), "broker-registered");
	});
	test("session shutdown degrades pending foreground readiness without hanging", async () => {
		const current = fixture({ delayedRegistration: true });
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		const start = current.emit("tool_execution_start", {
			type: "tool_execution_start", toolCallId: "child-stale", toolName: "subagent", args: {},
		});
		await Bun.sleep(1);
		await current.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		await start;
	});

	test("background management and noninteractive parent starts preserve lazy loading", async () => {
		const noninteractive = fixture();
		await noninteractive.emit("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
		await noninteractive.emit("tool_execution_start", {
			type: "tool_execution_start", toolCallId: "background", toolName: "subagent", args: { async: true },
		}, { hasUI: false });
		assert.equal(noninteractive.imports, 0);
	});

	test("UI management actions do not wait for broker readiness", async () => {
		const current = fixture({ delayedRegistration: true });
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		for (const action of ["list", "status", "interrupt", "doctor"]) {
			await current.emit("tool_execution_start", {
				type: "tool_execution_start", toolCallId: action, toolName: "subagent", args: { action },
			});
		}
		assert.equal(current.imports, 0, "management-only actions preserve lazy loading");
		assert.equal(current.sequence.includes("broker-registered"), false);
		current.finishRegistration();
	});

	test("resume remains launch-capable and waits for broker readiness", async () => {
		const current = fixture({ delayedRegistration: true });
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		let settled = false;
		const start = current.emit("tool_execution_start", {
			type: "tool_execution_start", toolCallId: "resume", toolName: "subagent", args: { action: "resume" },
		}).then(() => { settled = true; });
		await Bun.sleep(1);
		assert.equal(settled, false);
		current.finishRegistration();
		await start;
	});

	test("bridged child applies its deterministic intercom name before automatic registration", async () => {
		const child = fixture({ child: true, childSessionName: "subagent-worker-live-1" });
		await child.emit("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
		assert.deepEqual(child.sessionNames, ["subagent-worker-live-1"]);
		assert.ok(child.sequence.indexOf("broker-registered") >= 0);
	});

	test("bridged child import failure is diagnosed and does not break startup", async () => {
		const current = fixture({ child: true, importFailure: true });
		await current.emit("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
		assert.equal(current.imports, 1);
	});

	test("foreground readiness failure does not prevent launch lifecycle", async () => {
		const current = fixture({ readinessFailure: true });
		await current.emit("session_start", { type: "session_start", reason: "startup" });
		await current.emit("tool_execution_start", {
			type: "tool_execution_start", toolCallId: "failure", toolName: "subagent", args: {},
		});
		current.sequence.push("child-launch");
		assert.equal(current.sequence.at(-1), "child-launch");
	});
	test("bridged child registers during session start before agent work", async () => {
		const child = fixture({ child: true });
		await child.emit("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
		assert.equal(child.imports, 1);
		assert.equal(child.sequence.at(-1), "broker-registered");
	});
});
