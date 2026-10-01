import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { ExtensionRunner } from "../../packages/coding-agent/src/core/extensions/runner.js";
import {
	createExtensionContext,
	type ExtensionContextSource,
} from "../../packages/coding-agent/src/core/extensions/runner-context.js";
import intercom from "../../packages/intercom/index.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import { toolContext } from "../helpers/tool-context.js";

type HeavyModule = { default: (pi: ExtensionAPI) => void | Promise<void> };
type ConsoleErrorCall = [message?: unknown, ...optionalParams: unknown[]];
type ImportResult = { error: unknown } | { module: HeavyModule | Promise<HeavyModule> };
type LifecycleHandler = (event: object, ctx: ExtensionContext) => void | Promise<void>;

const originalConsoleError = console.error;
let consoleErrorCalls: ConsoleErrorCall[] = [];

beforeEach(() => {
	consoleErrorCalls = [];
	console.error = (...args: ConsoleErrorCall) => {
		consoleErrorCalls.push(args);
	};
});

afterEach(() => {
	console.error = originalConsoleError;
});

function fixture(importResults: ImportResult[], hasUI = false, mode: ExtensionContext["mode"] = "tui") {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const handlers = new Map<string, LifecycleHandler>();
	const eventHandlers = new Map<string, (payload: object) => void>();
	let imports = 0;
	const deliveries: Array<{ name: string; payload: unknown }> = [];
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			handlers.set(name, handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) {
			commands.set(name, command);
		},
		registerShortcut() {},
		events: {
			on(name: string, handler: (payload: object) => void) {
				eventHandlers.set(name, handler);
			},
			emit(name: string, payload: unknown) {
				deliveries.push({ name, payload });
			},
		},
	};
	intercom(pi as never, {
		async importHeavy() {
			const result = importResults[imports++];
			assert.ok(result, "each heavy initialization attempt needs a fixture result");
			if ("error" in result) throw result.error;
			return result.module;
		},
	});
	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = {
		hasUI,
		mode,
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
		},
	};
	return {
		notifications,
		deliveries,
		ctx,
		async fire(name: string, context: ExtensionContext | typeof ctx = ctx) {
			await handlers.get(name)?.({ type: name, reason: "startup" }, context as ExtensionContext);
		},
		emit(name: string, payload: object) {
			eventHandlers.get(name)?.(payload);
		},
		get imports() {
			return imports;
		},
		async executeCommand(context: ExtensionCommandContext) {
			const command = commands.get("intercom");
			assert.ok(command, "intercom command should be registered");
			await command.handler("", context);
		},
		executeIntercom(
			context: ExtensionContext | typeof ctx = ctx,
			params: { action: string; to?: string; message?: string } = { action: "list" },
		) {
			const tool = tools.get("intercom");
			assert.ok(tool, "intercom tool should be registered");
			return tool.execute(
				"tool-call",
				params,
				new AbortController().signal,
				undefined,
				toolContext(context as ExtensionContext),
			);
		},
	};
}

function successfulHeavyModule(): HeavyModule {
	return {
		default(heavyPi) {
			heavyPi.registerTool({
				name: "intercom",
				label: "Intercom",
				description: "test intercom",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "connected" }], details: {} };
				},
			});
		},
	};
}

/** Use the host's actual guarded getters, not a hasUI-only imitation. */
function guardedContext(mode: ExtensionContext["mode"]) {
	let active = true;
	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = createExtensionContext({
		assertActive() {
			if (!active) throw new Error("Extension context is stale");
		},
		getMode: () => mode,
		hasUI: () => mode === "tui" || mode === "rpc",
		getUIContext: () => ({
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
		}),
		getSubagentPolicy: () => undefined,
		getOrchestrationContext: () => undefined,
	} as ExtensionContextSource);
	return {
		ctx,
		notifications,
		invalidate() {
			active = false;
			for (const key of ["hasUI", "mode", "ui"] as const) {
				assert.throws(() => ctx[key], /Extension context is stale/);
			}
		},
	};
}

function runnerOwner(mode: ExtensionContext["mode"]) {
	const notifications: Array<{ message: string; level?: string }> = [];
	const runner = new ExtensionRunner(
		[],
		{ workflowActivityHub: { bindDispatcher() {} }, invalidate() {} } as never,
		"/tmp",
		{} as never,
		{} as never,
	);
	runner.setUIContext(
		mode === "tui" || mode === "rpc"
			? ({ notify: (message: string, level?: string) => notifications.push({ message, level }) } as never)
			: undefined,
		mode,
	);
	return { runner, notifications };
}

const unprintableFailures = [
	{ name: "null-prototype", create: () => Object.assign(Object.create(null) as object, { reason: "broken frame" }) },
	{
		name: "throwing toString",
		create: () => ({
			toString() {
				throw new Error("conversion failed");
			},
		}),
	},
	{
		name: "throwing toPrimitive",
		create: () => ({
			[Symbol.toPrimitive]() {
				throw new Error("conversion failed");
			},
		}),
	},
];

describe("Intercom lazy heavy-initialization diagnostics", () => {
	test("shows the reported retryable initialization failure as a warning without console or stack output", async () => {
		const failure = new Error("Connection closen");
		failure.stack = "Error: Connection closen\n    at Socket.onClose (client.ts:42:7)";
		const current = fixture([{ error: failure }, { module: successfulHeavyModule() }], true);
		const log = vi.spyOn(console, "log");
		const warn = vi.spyOn(console, "warn");
		try {
			await assert.rejects(current.executeIntercom(), (error) => error === failure);
			assert.deepEqual(current.notifications, [
				{
					message: "Intercom heavy initialization failed; a later call will retry: Connection closen",
					level: "warning",
				},
			]);
			assert.deepEqual(consoleErrorCalls, []);
			assert.equal(log.mock.calls.length, 0);
			assert.equal(warn.mock.calls.length, 0);
			assert.deepEqual(await current.executeIntercom(), {
				content: [{ type: "text", text: "connected" }],
				details: {},
			});
			assert.equal(current.imports, 2);
		} finally {
			log.mockRestore();
			warn.mockRestore();
		}
	});

	test("keeps rejected initialization and shutdown cleanup with their owners while replacement waits", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const failure = new Error("Connection closen");
		const cleanupFailure = new Error("cleanup failed during shutdown");
		const current = fixture(
			[
				{
					module: {
						default(pi) {
							pi.on("session_start", async () => {
								entered.resolve();
								await release.promise;
								throw failure;
							});
							pi.on("session_shutdown", () => {
								throw cleanupFailure;
							});
						},
					},
				},
				{ module: successfulHeavyModule() },
			],
			true,
		);
		const rejected = assert.rejects(current.executeIntercom(), (error) => error === failure);
		await entered.promise;
		const cleanupNotifications: string[] = [];
		const shutdown = current.fire("session_shutdown", {
			hasUI: true,
			mode: "tui",
			ui: {
				notify(message: string) {
					cleanupNotifications.push(message);
				},
			},
		});
		const replacement = current.fire("session_start", {
			hasUI: false,
			mode: "print",
			ui: {
				notify() {
					assert.fail("replacement received an old diagnostic");
				},
			},
		});
		release.resolve();
		await Promise.all([rejected, shutdown, replacement]);
		assert.deepEqual(cleanupNotifications, [
			"Intercom failed to clean rejected lazy candidate: cleanup failed during shutdown",
		]);
		assert.deepEqual(current.notifications, [
			{
				message: "Intercom heavy initialization failed; a later call will retry: Connection closen",
				level: "warning",
			},
		]);
		assert.deepEqual(consoleErrorCalls, []);
		await current.executeIntercom();
		assert.equal(current.imports, 2);
	});

	test("retains noninteractive diagnostic text and error identity across shared failure and later retry", async () => {
		const failure = new Error("Connection closen");
		const current = fixture([{ error: failure }, { module: successfulHeavyModule() }]);
		await Promise.all([1, 2].map(() => assert.rejects(current.executeIntercom(), (error) => error === failure)));
		assert.deepEqual(consoleErrorCalls, [
			["Intercom heavy initialization failed; a later call will retry: Connection closen", failure],
		]);
		assert.equal(consoleErrorCalls[0]?.[1], failure);
		assert.deepEqual(current.notifications, []);
		assert.equal(current.imports, 1);
		await current.executeIntercom();
		assert.equal(current.imports, 2);
	});

	for (const mode of ["tui", "rpc", "print", "json"] as const) {
		test(`routes ${mode} initialization diagnostics without changing shared failure or retry`, async () => {
			const failure = new Error("Connection closen");
			const current = fixture(
				[{ error: failure }, { module: successfulHeavyModule() }],
				mode === "tui" || mode === "rpc",
				mode,
			);
			await Promise.all([1, 2].map(() => assert.rejects(current.executeIntercom(), (error) => error === failure)));
			const message = "Intercom heavy initialization failed; a later call will retry: Connection closen";
			assert.deepEqual(current.notifications, mode === "tui" ? [{ message, level: "warning" }] : []);
			assert.deepEqual(consoleErrorCalls, mode === "tui" ? [] : [[message, failure]]);
			if (mode !== "tui") assert.equal(consoleErrorCalls[0]?.[1], failure);
			assert.equal(current.imports, 1);
			assert.deepEqual(await current.executeIntercom(), {
				content: [{ type: "text", text: "connected" }],
				details: {},
			});
			assert.equal(current.imports, 2);
		});
	}

	test("keeps background initialization diagnostics bound to the initiating context before replay", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const failure = new Error("Connection closen");
		const current = fixture(
			[
				{
					module: {
						async default() {
							entered.resolve();
							await release.promise;
							throw failure;
						},
					},
				},
			],
			true,
		);
		await current.fire("turn_start");
		const payload: { completion?: Promise<void> } = {};
		current.emit("atomic:workflow-pending-stage-route", payload);
		assert.ok(payload.completion);
		const rejected = assert.rejects(payload.completion, (error) => error === failure);
		await entered.promise;
		const replacement = {
			hasUI: false,
			mode: "print" as const,
			ui: {
				notify() {
					assert.fail("wrong session");
				},
			},
		};
		await current.fire("session_start", replacement);
		release.resolve();
		await rejected;
		await tick();
		assert.deepEqual(current.notifications, [
			{
				message: "Intercom heavy initialization failed; a later call will retry: Connection closen",
				level: "warning",
			},
			{
				message: "Intercom event relay failed (atomic:workflow-pending-stage-route): Connection closen",
				level: "error",
			},
		]);
		assert.deepEqual(consoleErrorCalls, []);
	});

	for (const mode of ["print", "json", "rpc", "tui"] as const) {
		for (const phase of ["during import", "after factory"] as const) {
			for (const dispatch of ["tool", "command"] as const) {
				test(`retains the ${mode} route across distinct runner dispatches (${dispatch}) expiring ${phase}`, async () => {
					const imported = Promise.withResolvers<HeavyModule>();
					const { runner, notifications } = runnerOwner(mode);
					const startup = runner.createContext();
					const invocation = dispatch === "command" ? runner.createCommandContext() : runner.createContext();
					assert.notEqual(startup, invocation, "normal dispatch creates separate wrappers");
					const failure = new Error("Connection closen");
					const current = fixture([{ module: imported.promise }, { module: successfulHeavyModule() }]);
					const log = vi.spyOn(console, "log").mockImplementation(() => {});
					const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
					try {
						await current.fire("session_start", startup);
						const pending =
							dispatch === "command"
								? current.executeCommand(invocation as ExtensionCommandContext)
								: current.executeIntercom(invocation);
						const rejected = assert.rejects(pending, (error) => error === failure);
						await tick();
						assert.equal(current.imports, 1);
						if (phase === "during import") runner.invalidate();
						imported.resolve({
							default(pi) {
								if (phase === "after factory") {
									assert.equal(invocation.mode, mode);
									queueMicrotask(() => runner.invalidate());
								}
								pi.on("session_start", (_event, ctx) => {
									assert.equal(ctx, startup);
									assert.throws(() => ctx.mode, /extension ctx is stale/);
									throw failure;
								});
							},
						});
						await rejected;
						await tick();
						const message = "Intercom heavy initialization failed; a later call will retry: Connection closen";
						assert.deepEqual(consoleErrorCalls, mode === "tui" ? [] : [[message, failure]]);
						if (mode !== "tui") assert.equal(consoleErrorCalls[0]?.[1], failure);
						assert.deepEqual(notifications, []);
						assert.equal(log.mock.calls.length, 0);
						assert.equal(warn.mock.calls.length, 0);
						const replacement = runnerOwner(mode);
						await current.fire("session_start", replacement.runner.createContext());
						assert.deepEqual(await current.executeIntercom(replacement.runner.createContext()), {
							content: [{ type: "text", text: "connected" }],
							details: {},
						});
						assert.equal(current.imports, 2);
						assert.deepEqual(replacement.notifications, []);
					} finally {
						log.mockRestore();
						warn.mockRestore();
					}
				});
			}

			test(`retains the ${mode} route when the same owner expires ${phase} before first replay`, async () => {
				const imported = Promise.withResolvers<HeavyModule>();
				const owner = guardedContext(mode);
				const failure = new Error("Connection closen");
				const current = fixture([{ module: imported.promise }, { module: successfulHeavyModule() }]);
				const log = vi.spyOn(console, "log").mockImplementation(() => {});
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				try {
					await current.fire("session_start", owner.ctx);
					const rejected = assert.rejects(current.executeIntercom(owner.ctx), (error) => error === failure);
					await tick();
					assert.equal(current.imports, 1, "the successful import is still pending");
					if (phase === "during import") owner.invalidate();
					imported.resolve({
						default(pi) {
							if (phase === "after factory") {
								assert.equal(owner.ctx.mode, mode, "the factory starts with a live owner");
								queueMicrotask(() => owner.invalidate());
							}
							pi.on("session_start", (_event, ctx) => {
								assert.equal(ctx, owner.ctx);
								assert.throws(() => ctx.mode, /Extension context is stale/);
								throw failure;
							});
						},
					});
					await rejected;
					await tick();
					const message = "Intercom heavy initialization failed; a later call will retry: Connection closen";
					assert.deepEqual(consoleErrorCalls, mode === "tui" ? [] : [[message, failure]]);
					if (mode !== "tui") assert.equal(consoleErrorCalls[0]?.[1], failure);
					assert.deepEqual(owner.notifications, []);
					assert.equal(log.mock.calls.length, 0);
					assert.equal(warn.mock.calls.length, 0);
					const replacement = guardedContext(mode);
					await current.fire("session_start", replacement.ctx);
					assert.deepEqual(await current.executeIntercom(replacement.ctx), {
						content: [{ type: "text", text: "connected" }],
						details: {},
					});
					assert.equal(current.imports, 2);
					assert.deepEqual(replacement.notifications, []);
				} finally {
					log.mockRestore();
					warn.mockRestore();
				}
			});
		}

		for (const phase of ["first replay", "later replay"] as const) {
			for (const state of ["live", "expired"] as const) {
				test(`routes ${phase} failure and cleanup to a new ${state} ${mode} owner only`, async () => {
					const imported = Promise.withResolvers<HeavyModule>();
					const replayEntered = Promise.withResolvers<void>();
					const replayRelease = Promise.withResolvers<void>();
					const owner = guardedContext(mode);
					const other = guardedContext(mode === "tui" ? "print" : "tui");
					const failure = new Error("Connection closen");
					const cleanupFailure = new Error("cleanup failed");
					const module: HeavyModule = {
						default(pi) {
							pi.on("session_start", async (_event, ctx) => {
								if (ctx === other.ctx) {
									replayEntered.resolve();
									await replayRelease.promise;
									return;
								}
								assert.equal(ctx, owner.ctx);
								if (state === "expired") assert.throws(() => ctx.mode, /Extension context is stale/);
								else assert.equal(ctx.mode, mode);
								throw failure;
							});
							pi.on("session_shutdown", (_event, ctx) => {
								assert.equal(ctx, owner.ctx, "cleanup follows the failed replay owner");
								throw cleanupFailure;
							});
						},
					};
					const current = fixture([{ module: imported.promise }, { module: successfulHeavyModule() }]);
					await current.fire("session_start", other.ctx);
					// Later replay returns to the initiating context after another owner has replayed.
					const rejected = assert.rejects(
						current.executeIntercom(phase === "first replay" ? other.ctx : owner.ctx),
						(error) => error === failure,
					);
					if (phase === "later replay") {
						imported.resolve(module);
						await replayEntered.promise;
					} else {
						await tick();
						assert.equal(current.imports, 1);
					}
					await current.fire("session_start", owner.ctx);
					if (state === "expired") owner.invalidate();
					imported.resolve(module);
					replayRelease.resolve();
					await rejected;
					await tick();
					const message = "Intercom heavy initialization failed; a later call will retry: Connection closen";
					assert.deepEqual(
						consoleErrorCalls,
						state === "expired" || mode === "tui"
							? []
							: [
									["Intercom failed to clean rejected lazy candidate:", cleanupFailure],
									[message, failure],
								],
					);
					if (state === "live" && mode !== "tui") {
						assert.equal(consoleErrorCalls[0]?.[1], cleanupFailure);
						assert.equal(consoleErrorCalls[1]?.[1], failure);
					}
					assert.deepEqual(
						owner.notifications,
						state === "live" && mode === "tui"
							? [
									{
										message: "Intercom failed to clean rejected lazy candidate: cleanup failed",
										level: "error",
									},
									{ message, level: "warning" },
								]
							: [],
					);
					assert.deepEqual(other.notifications, []);
					const replacement = guardedContext(mode);
					await current.fire("session_start", replacement.ctx);
					await current.executeIntercom(replacement.ctx);
					assert.equal(current.imports, 2);
					assert.deepEqual(replacement.notifications, []);
				});
			}
		}

		for (const phase of ["initializing", "replaying"] as const) {
			test(`retains the ${mode} ${phase} route when its guarded owner expires`, async () => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const failure = new Error("Connection closen");
				const fail = async () => {
					entered.resolve();
					await release.promise;
					throw failure;
				};
				const current = fixture([
					{
						module: {
							async default(pi) {
								if (phase === "initializing") await fail();
								else pi.on("session_start", fail);
							},
						},
					},
				]);
				const owner = guardedContext(mode);
				const other = guardedContext(mode === "tui" ? "print" : "tui");
				if (phase === "replaying") await current.fire("session_start", owner.ctx);
				const rejected = assert.rejects(
					current.executeIntercom(phase === "initializing" ? owner.ctx : other.ctx),
					(error) => error === failure,
				);
				await entered.promise;
				// Exercise the guarded boundary even if a host expires a pending owner.
				owner.invalidate();
				await current.fire("session_start", other.ctx);
				release.resolve();
				await rejected;
				await tick();
				const message = "Intercom heavy initialization failed; a later call will retry: Connection closen";
				assert.deepEqual(consoleErrorCalls, mode === "tui" ? [] : [[message, failure]]);
				if (mode !== "tui") assert.equal(consoleErrorCalls[0]?.[1], failure);
				assert.deepEqual(owner.notifications, []);
				assert.deepEqual(other.notifications, []);
			});
		}

		test(`retains the ${mode} shutdown cleanup route independently of its expired replay owner`, async () => {
			const replayEntered = Promise.withResolvers<void>();
			const replayRelease = Promise.withResolvers<void>();
			const cleanupEntered = Promise.withResolvers<void>();
			const cleanupRelease = Promise.withResolvers<void>();
			const failure = new Error("Connection closen");
			const cleanupFailure = new Error("cleanup failed");
			const owner = guardedContext(mode);
			const replayOwner = guardedContext(mode === "tui" ? "print" : "tui");
			const replacement = guardedContext("tui");
			const current = fixture([
				{
					module: {
						default(pi) {
							pi.on("session_start", async () => {
								replayEntered.resolve();
								await replayRelease.promise;
								throw failure;
							});
							pi.on("session_shutdown", async () => {
								cleanupEntered.resolve();
								await cleanupRelease.promise;
								throw cleanupFailure;
							});
						},
					},
				},
				{ module: successfulHeavyModule() },
			]);
			await current.fire("session_start", replayOwner.ctx);
			const rejected = assert.rejects(current.executeIntercom(owner.ctx), (error) => error === failure);
			await replayEntered.promise;
			const shutdown = current.fire("session_shutdown", owner.ctx);
			const replaced = current.fire("session_start", replacement.ctx);
			replayRelease.resolve();
			await cleanupEntered.promise;
			owner.invalidate();
			replayOwner.invalidate();
			cleanupRelease.resolve();
			await Promise.all([rejected, shutdown, replaced]);
			const expected =
				mode === "tui"
					? [["Intercom heavy initialization failed; a later call will retry: Connection closen", failure]]
					: [["Intercom failed to clean rejected lazy candidate:", cleanupFailure]];
			assert.deepEqual(consoleErrorCalls, expected);
			assert.equal(consoleErrorCalls[0]?.[1], mode === "tui" ? failure : cleanupFailure);
			assert.deepEqual(owner.notifications, []);
			assert.deepEqual(replayOwner.notifications, []);
			assert.deepEqual(replacement.notifications, []);
			await current.executeIntercom(replacement.ctx);
			assert.equal(current.imports, 2);
		});

		test(`retains the ${mode} shutdown route for all relays arriving after runner invalidation`, async () => {
			const current = fixture([]);
			const owner = guardedContext(mode);
			await current.fire("session_start", owner.ctx);
			await current.fire("session_shutdown", owner.ctx);
			owner.invalidate();
			for (const eventName of [
				"subagent:control-intercom",
				"subagent:result-intercom",
				"atomic:workflow-pending-stage-route",
				"atomic:workflow-pending-stage-undeliverable",
			]) {
				const payload = {
					completion: undefined as Promise<void> | Promise<boolean> | undefined,
					runId: "run",
					senderId: "sender",
					messageId: "message",
					notificationId: "notice",
					reason: "not_started",
				};
				current.emit(eventName, payload);
				if (eventName.endsWith("undeliverable")) assert.equal(await payload.completion, false);
				else if (eventName.endsWith("stage-route")) await assert.rejects(payload.completion!, /no active session/);
				await tick();
				if (mode !== "tui") {
					const args = consoleErrorCalls.shift();
					assert.equal(args?.[0], `Intercom event relay failed (${eventName}):`);
					assert.ok(args[1] instanceof Error);
					assert.equal(args[1].message, "Intercom initialization unavailable: no active session");
				}
				assert.deepEqual(consoleErrorCalls, []);
			}
			assert.deepEqual(owner.notifications, []);
			assert.equal(current.imports, 0, "a diagnostic route cannot reactivate the retired lease");
		});

		for (const eventName of [
			"subagent:control-intercom",
			"subagent:result-intercom",
			"atomic:workflow-pending-stage-route",
			"atomic:workflow-pending-stage-undeliverable",
		]) {
			test(`retains ${mode} late ${eventName} diagnostics after real context invalidation`, async () => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const failure = new Error("late relay failure");
				const current = fixture([
					{
						module: {
							default(pi) {
								pi.events.on(eventName, async () => {
									entered.resolve();
									await release.promise;
									throw failure;
								});
							},
						},
					},
					{ module: successfulHeavyModule() },
				]);
				const origin = guardedContext(mode);
				const replacement = guardedContext(mode === "tui" ? "print" : "tui");
				const log = vi.spyOn(console, "log").mockImplementation(() => {});
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				try {
					await current.fire("session_start", origin.ctx);
					const payload = {
						completion: undefined as Promise<void> | Promise<boolean> | undefined,
						requestId: "request",
						runId: "run",
						senderId: "sender",
						messageId: "message",
						notificationId: "notice",
						reason: "stage_never_started",
					};
					current.emit(eventName, payload);
					const settled = eventName.endsWith("undeliverable")
						? payload.completion!.then((value) => assert.equal(value, false))
						: eventName.endsWith("stage-route")
							? assert.rejects(payload.completion!, (error) => error === failure)
							: Promise.resolve();
					await entered.promise;
					await current.fire("session_shutdown", origin.ctx);
					origin.invalidate(); // Runner invalidates only after awaited shutdown.
					await current.fire("session_start", replacement.ctx);
					release.resolve();
					await settled;
					await tick();
					assert.deepEqual(origin.notifications, []);
					assert.deepEqual(replacement.notifications, []);
					assert.deepEqual(
						consoleErrorCalls,
						mode === "tui" ? [] : [[`Intercom event relay failed (${eventName}):`, failure]],
					);
					if (mode !== "tui") assert.equal(consoleErrorCalls[0]?.[1], failure);
					assert.equal(log.mock.calls.length, 0);
					assert.equal(warn.mock.calls.length, 0);
					assert.deepEqual(
						current.deliveries,
						eventName === "subagent:result-intercom"
							? [
									{
										name: "subagent:result-intercom-delivery",
										payload: { requestId: "request", delivered: false, error: failure.message },
									},
								]
							: [],
					);
					await current.executeIntercom(replacement.ctx);
					assert.equal(current.imports, 2, "the retired callback does not invalidate the replacement");
				} finally {
					release.resolve();
					log.mockRestore();
					warn.mockRestore();
				}
			});
		}
	}

	for (const eventName of [
		"subagent:control-intercom",
		"subagent:result-intercom",
		"atomic:workflow-pending-stage-route",
		"atomic:workflow-pending-stage-undeliverable",
	]) {
		test(`keeps ${eventName} diagnostics with the shutdown owner while cleanup drains`, async () => {
			const entered = Promise.withResolvers<void>();
			const drain = Promise.withResolvers<void>();
			let cleanups = 0;
			let relays = 0;
			const current = fixture(
				[
					{
						module: {
							default(pi) {
								successfulHeavyModule().default(pi);
								pi.events.on(eventName, () => {
									relays++;
								});
								pi.on("session_shutdown", async () => {
									cleanups++;
									entered.resolve();
									await drain.promise;
								});
							},
						},
					},
					{ module: successfulHeavyModule() },
				],
				true,
				"tui",
			);
			await current.fire("session_start");
			await current.executeIntercom();
			const shutdown = current.fire("session_shutdown");
			await entered.promise;
			const payload: {
				completion?: Promise<boolean>;
				runId: string;
				senderId: string;
				messageId: string;
				notificationId: string;
				reason: string;
			} = {
				runId: "run",
				senderId: "sender",
				messageId: "message",
				notificationId: "notice",
				reason: "not_started",
			};
			current.emit(eventName, payload);
			let replaced = false;
			const replacement = current
				.fire("session_start", {
					hasUI: true,
					mode: "tui",
					ui: {
						notify() {
							assert.fail("replacement received the shutdown diagnostic");
						},
					},
				})
				.then(() => {
					replaced = true;
				});
			try {
				if (eventName.endsWith("undeliverable")) {
					assert.ok(payload.completion);
					assert.equal(await payload.completion, false);
				} else if (eventName.endsWith("stage-route")) {
					assert.ok(payload.completion);
					await assert.rejects(payload.completion, /no active session/);
				}
				await tick();
				assert.equal(replaced, false, "replacement still awaits retired cleanup");
				assert.equal(current.imports, 1, "relay cannot activate a retired lease");
				assert.equal(relays, 0);
				assert.deepEqual(consoleErrorCalls, []);
				assert.deepEqual(current.notifications, [
					{
						message: `Intercom event relay failed (${eventName}): Intercom initialization unavailable: no active session`,
						level: "error",
					},
				]);
			} finally {
				drain.resolve();
				await Promise.all([shutdown, replacement]);
			}
			assert.equal(cleanups, 1);
			await current.executeIntercom();
			assert.equal(current.imports, 2);
		});
	}

	test("a throwing UI sink never logs or replaces the initialization error and remains retryable", async () => {
		const failure = new Error("Connection closen");
		const current = fixture([{ error: failure }, { module: successfulHeavyModule() }], true);
		current.ctx.ui.notify = () => {
			throw new Error("UI closed");
		};
		await assert.rejects(current.executeIntercom(), (error) => error === failure);
		await current.executeIntercom();
		assert.equal(current.imports, 2);
		assert.deepEqual(consoleErrorCalls, []);
	});

	test("attributes a failed startup replay to its lifecycle context rather than the tool caller", async () => {
		const failure = new Error("Connection closen");
		const current = fixture(
			[
				{
					module: {
						default(pi) {
							pi.on("session_start", () => {
								throw failure;
							});
						},
					},
				},
			],
			true,
		);
		await current.fire("session_start");
		const callerNotifications: string[] = [];
		const caller = {
			hasUI: false,
			mode: "print" as const,
			ui: {
				notify(message: string) {
					callerNotifications.push(message);
				},
			},
		};
		await assert.rejects(current.executeIntercom(caller), (error) => error === failure);
		assert.deepEqual(current.notifications, [
			{
				message: "Intercom heavy initialization failed; a later call will retry: Connection closen",
				level: "warning",
			},
		]);
		assert.deepEqual(callerNotifications, []);
		assert.deepEqual(consoleErrorCalls, []);
	});

	for (const hasUI of [true, false]) {
		test(`routes rejected-candidate cleanup with hasUI=${hasUI} and preserves the initialization error and retry`, async () => {
			const failure = new Error("Connection closen");
			const cleanupFailure = new Error("cleanup failed");
			let cleanups = 0;
			const current = fixture(
				[
					{
						module: {
							default(pi) {
								pi.on("session_start", () => {
									throw failure;
								});
								pi.on("session_shutdown", () => {
									cleanups++;
									throw cleanupFailure;
								});
							},
						},
					},
					{ module: successfulHeavyModule() },
				],
				hasUI,
			);
			await assert.rejects(current.executeIntercom(), (error) => error === failure);
			const prefix = "Intercom failed to clean rejected lazy candidate:";
			const initMessage = "Intercom heavy initialization failed; a later call will retry: Connection closen";
			assert.deepEqual(
				current.notifications,
				hasUI
					? [
							{ message: `${prefix} cleanup failed`, level: "error" },
							{ message: initMessage, level: "warning" },
						]
					: [],
			);
			assert.deepEqual(
				consoleErrorCalls,
				hasUI
					? []
					: [
							[prefix, cleanupFailure],
							[initMessage, failure],
						],
			);
			assert.equal(cleanups, 1);
			await current.executeIntercom();
			assert.equal(current.imports, 2);
		});

		for (const eventName of [
			"subagent:control-intercom",
			"subagent:result-intercom",
			"atomic:workflow-pending-stage-route",
			"atomic:workflow-pending-stage-undeliverable",
		]) {
			test(`routes ${eventName} failure with hasUI=${hasUI} without changing its acknowledgement`, async () => {
				const failure = new Error("Intercom protocol error: bad frame");
				const current = fixture(
					[
						{
							module: {
								default(pi) {
									pi.events.on(eventName, () => {
										throw failure;
									});
								},
							},
						},
					],
					hasUI,
				);
				// Background relays also run in hosts without session_start.
				await current.fire("turn_start");
				const payload: {
					completion?: Promise<void> | Promise<boolean>;
					handled?: boolean;
					runId: string;
					senderId: string;
					messageId: string;
					notificationId: string;
					reason: string;
				} = {
					runId: "run",
					senderId: "sender",
					messageId: "message",
					notificationId: "notice",
					reason: "stage_never_started",
				};
				current.emit(eventName, payload);
				if (eventName === "atomic:workflow-pending-stage-route") {
					assert.ok(payload.completion);
					await assert.rejects(payload.completion, (error) => error === failure);
				} else if (eventName === "atomic:workflow-pending-stage-undeliverable") {
					assert.equal(payload.handled, true);
					assert.ok(payload.completion);
					assert.equal(await payload.completion, false);
				}
				await tick();
				const prefix = `Intercom event relay failed (${eventName}):`;
				assert.deepEqual(
					current.notifications,
					hasUI ? [{ message: `${prefix} ${failure.message}`, level: "error" }] : [],
				);
				assert.deepEqual(consoleErrorCalls, hasUI ? [] : [[prefix, failure]]);
			});
		}
	}

	test("retains console diagnostics for a relay with no lifecycle context", async () => {
		const failure = new Error("relay before lifecycle");
		const eventName = "atomic:workflow-pending-stage-undeliverable";
		const current = fixture([
			{
				module: {
					default(pi) {
						pi.events.on(eventName, () => {
							throw failure;
						});
					},
				},
			},
		]);
		const payload = {
			runId: "run",
			senderId: "sender",
			messageId: "message",
			notificationId: "notice",
			reason: "not_started",
			completion: undefined as Promise<boolean> | undefined,
		};
		current.emit(eventName, payload);
		assert.ok(payload.completion);
		assert.equal(await payload.completion, false);
		assert.deepEqual(current.notifications, []);
		assert.deepEqual(consoleErrorCalls, [[`Intercom event relay failed (${eventName}):`, failure]]);
		assert.equal(consoleErrorCalls[0]?.[1], failure);
	});

	for (const mode of ["tui", "rpc", "print", "json"] as const) {
		for (const cause of unprintableFailures) {
			test(`preserves false relay acknowledgement and ${mode} diagnostics for ${cause.name}`, async () => {
				const failure = cause.create();
				const eventName = "atomic:workflow-pending-stage-undeliverable";
				const current = fixture(
					[
						{
							module: {
								default(pi) {
									pi.events.on(eventName, () => {
										throw failure;
									});
								},
							},
						},
					],
					mode === "tui" || mode === "rpc",
					mode,
				);
				await current.fire("session_start");
				const payload = {
					runId: "run",
					senderId: "sender",
					messageId: "message",
					notificationId: "notice",
					reason: "not_started",
					completion: undefined as Promise<boolean> | undefined,
				};
				current.emit(eventName, payload);
				assert.ok(payload.completion);
				assert.equal(await payload.completion, false);
				const prefix = `Intercom event relay failed (${eventName}):`;
				assert.deepEqual(
					current.notifications,
					mode === "tui" ? [{ message: `${prefix} Unprintable error`, level: "error" }] : [],
				);
				assert.deepEqual(consoleErrorCalls, mode === "tui" ? [] : [[prefix, failure]]);
				if (mode !== "tui") assert.equal(consoleErrorCalls[0]?.[1], failure);
			});

			test(`retains original ${cause.name} initialization rejection and retry in ${mode}`, async () => {
				const failure = cause.create();
				const current = fixture(
					[{ error: failure }, { module: successfulHeavyModule() }],
					mode === "tui" || mode === "rpc",
					mode,
				);
				await assert.rejects(current.executeIntercom(), (error) => error === failure);
				await tick();
				const message = "Intercom heavy initialization failed; a later call will retry: Unprintable error";
				assert.deepEqual(current.notifications, mode === "tui" ? [{ message, level: "warning" }] : []);
				assert.deepEqual(consoleErrorCalls, mode === "tui" ? [] : [[message, failure]]);
				if (mode !== "tui") assert.equal(consoleErrorCalls[0]?.[1], failure);
				await current.executeIntercom();
				assert.equal(current.imports, 2);
			});

			for (const recoverable of [false, true]) {
				test(`preserves ${recoverable ? "typed-disconnect send retry" : "original initialization failure"} after ${cause.name} cleanup in ${mode}`, async () => {
					const failure = recoverable ? new IntercomClientDisconnectedError() : new Error("Connection closen");
					const cleanupFailure = cause.create();
					const params = { action: "send", to: "peer", message: "  verbatim\nmessage  " };
					let cleanups = 0;
					let executions = 0;
					const current = fixture(
						[
							{
								module: {
									default(pi) {
										pi.on("session_start", () => {
											throw failure;
										});
										pi.on("session_shutdown", () => {
											cleanups++;
											throw cleanupFailure;
										});
									},
								},
							},
							{
								module: {
									default(pi) {
										pi.registerTool({
											name: "intercom",
											label: "Intercom",
											description: "recovered send",
											parameters: Type.Object({}),
											async execute(_id, actual) {
												executions++;
												assert.deepEqual(actual, params);
												return { content: [{ type: "text", text: "sent" }], details: {} };
											},
										});
									},
								},
							},
						],
						mode === "tui" || mode === "rpc",
						mode,
					);
					if (!recoverable) {
						await assert.rejects(current.executeIntercom(current.ctx, params), (error) => error === failure);
						assert.equal(current.imports, 1);
						assert.equal(executions, 0);
					}
					assert.deepEqual(await current.executeIntercom(current.ctx, params), {
						content: [{ type: "text", text: "sent" }],
						details: {},
					});
					assert.equal(current.imports, 2);
					assert.equal(executions, 1);
					assert.equal(cleanups, 1);
					const prefix = "Intercom failed to clean rejected lazy candidate:";
					const initMessage = "Intercom heavy initialization failed; a later call will retry: Connection closen";
					const expectedNotices = [{ message: `${prefix} Unprintable error`, level: "error" }];
					if (!recoverable) expectedNotices.push({ message: initMessage, level: "warning" });
					assert.deepEqual(current.notifications, mode === "tui" ? expectedNotices : []);
					const expectedConsole: ConsoleErrorCall[] = [[prefix, cleanupFailure]];
					if (!recoverable) expectedConsole.push([initMessage, failure]);
					assert.deepEqual(consoleErrorCalls, mode === "tui" ? [] : expectedConsole);
					if (mode !== "tui") assert.equal(consoleErrorCalls[0]?.[1], cleanupFailure);
				});
			}
		}
	}

	test("keeps a recoverable client disconnect out of console output while rejecting the caller", async () => {
		const disconnectError = new IntercomClientDisconnectedError();
		const current = fixture([{ error: disconnectError }]);

		await assert.rejects(current.executeIntercom(), disconnectError);
		await Promise.resolve();

		assert.deepEqual(consoleErrorCalls, []);
	});

	test("retries successfully after a silent recoverable client disconnect", async () => {
		const disconnectError = new IntercomClientDisconnectedError();
		const current = fixture([{ error: disconnectError }, { module: successfulHeavyModule() }]);

		await assert.rejects(current.executeIntercom(), disconnectError);
		const result = await current.executeIntercom();
		await Promise.resolve();

		assert.equal(current.imports, 2);
		assert.deepEqual(result, { content: [{ type: "text", text: "connected" }], details: {} });
		assert.deepEqual(consoleErrorCalls, []);
	});

	test("diagnoses a non-recoverable heavy-module import failure", async () => {
		const importError = new Error("Cannot import Intercom heavy module");
		const current = fixture([{ error: importError }]);

		await assert.rejects(current.executeIntercom(), importError);
		await Promise.resolve();

		assert.deepEqual(consoleErrorCalls, [
			[
				"Intercom heavy initialization failed; a later call will retry: Cannot import Intercom heavy module",
				importError,
			],
		]);
	});

	test("keeps neighboring client failures actionable", async () => {
		const disconnectingError = new Error("Client disconnecting");
		const current = fixture([{ error: disconnectingError }]);

		await assert.rejects(current.executeIntercom(), disconnectingError);
		await Promise.resolve();

		assert.deepEqual(consoleErrorCalls, [
			["Intercom heavy initialization failed; a later call will retry: Client disconnecting", disconnectingError],
		]);
	});

	test("keeps ambiguous, look-alike, and non-Error failures actionable", async () => {
		const failures: unknown[] = [
			new Error("Configuration failed after Client disconnected unexpectedly"),
			// Same wording, raised outside the broker client: classification is by
			// construction, so this stays actionable.
			new Error("Client disconnected"),
			"Client disconnected",
			{ reason: "Client disconnected" },
			undefined,
		];

		for (const failure of failures) {
			const current = fixture([{ error: failure }]);
			await assert.rejects(current.executeIntercom());
			await Promise.resolve();
		}

		assert.deepEqual(
			consoleErrorCalls.map(([message, error]) => [message, error]),
			failures.map((failure) => [
				`Intercom heavy initialization failed; a later call will retry: ${failure instanceof Error ? failure.message : String(failure)}`,
				failure,
			]),
		);
	});
});
