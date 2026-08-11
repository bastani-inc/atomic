import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	isStaleExtensionContextError,
	STALE_EXTENSION_CONTEXT_MARKER,
} from "@bastani/atomic";
import { describe, test } from "vitest";
import { CONFIG_DIR_NAME } from "../../packages/coding-agent/src/config.js";
import { BUNDLED_EXTENSION_SLASH_COMMANDS } from "../../packages/coding-agent/src/core/slash-commands.js";
import type { SubagentParamsLike } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import {
	SLASH_SUBAGENT_CANCEL_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	type SubagentState,
} from "../../packages/subagents/src/shared/types.js";
import { registerSlashSubagentBridge } from "../../packages/subagents/src/slash/slash-bridge.js";
import { registerSlashCommands } from "../../packages/subagents/src/slash/slash-commands.js";

type EventHandler = (data: unknown) => void | Promise<void>;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type TerminalInputHandler = (input: string) => { consume?: boolean; data?: string } | undefined;
const STALE_RESPONSE_SETTLEMENT_TIMEOUT_MS = 5_000;

class FakeEvents {
	private readonly handlers = new Map<string, Set<EventHandler>>();

	constructor(private readonly beforeEmit?: (event: string) => void) {}

	on(event: string, handler: EventHandler): () => void {
		const handlers = this.handlers.get(event) ?? new Set<EventHandler>();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, data: unknown): void {
		this.beforeEmit?.(event);
		for (const handler of this.handlers.get(event) ?? []) {
			try {
				void Promise.resolve(handler(data)).catch(() => {});
			} catch {
				// Match the host event bus, which contains synchronous handler failures.
			}
		}
	}
}

function writeAgent(cwd: string, name: string): void {
	const agentsDir = join(cwd, CONFIG_DIR_NAME, "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, `${name}.md`),
		[
			"---",
			`name: ${name}`,
			`description: ${name} slash command fixture`,
			"---",
			"",
			"Run the assigned test task.",
		].join("\n"),
	);
}
interface FakeContextOptions {
	hasUI?: boolean;
	onNotify?: (message: string, type?: "info" | "warning" | "error") => void;
	onStatus?: (key: string, text: string | undefined) => void;
	onTerminalInput?: (handler: TerminalInputHandler) => () => void;
}

function makeContext(cwd: string, options: FakeContextOptions = {}): ExtensionCommandContext {
	return {
		cwd,
		mode: "tui",
		hasUI: options.hasUI ?? false,
		ui: {
			notify: options.onNotify ?? (() => {}),
			setToolsExpanded: () => {},
			setStatus: options.onStatus ?? (() => {}),
			onTerminalInput: options.onTerminalInput ?? (() => () => {}),
		},
		sessionManager: { getSessionFile: () => undefined },
	} as unknown as ExtensionCommandContext;
}

interface SlashHarness {
	invoke(command: string, args: string): Promise<SubagentParamsLike>;
	registeredCommands(): string[];
	dispose(): void;
}

function createSlashHarness(): SlashHarness {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-slash-handler-"));
	writeAgent(cwd, "slash-alpha");
	writeAgent(cwd, "slash-beta");

	const events = new FakeEvents();
	const commands = new Map<string, CommandOptions>();
	const received: SubagentParamsLike[] = [];
	const sent: unknown[] = [];
	const ctx = makeContext(cwd);
	const pi = {
		events,
		registerCommand: (name: string, options: CommandOptions) => commands.set(name, options),
		sendMessage: (message: unknown) => sent.push(message),
	} as unknown as ExtensionAPI;

	const bridge = registerSlashSubagentBridge({
		events,
		getContext: () => ctx,
		execute: async (_id, params) => {
			received.push(params);
			const mode = params.tasks ? "parallel" : "single";
			return { content: [{ type: "text", text: "done" }], details: { mode, results: [] } };
		},
	});
	registerSlashCommands(pi, { baseCwd: cwd } as SubagentState);

	return {
		async invoke(command, args) {
			const registration = commands.get(command);
			assert.ok(registration, `expected /${command} to be registered`);
			const receivedBefore = received.length;
			const sentBefore = sent.length;

			await registration.handler(args, ctx);

			assert.equal(received.length, receivedBefore + 1, `expected /${command} to reach the slash bridge`);
			assert.equal(sent.length, sentBefore + 2, `expected /${command} to publish initial and final results`);
			return received.at(-1)!;
		},
		registeredCommands: () => [...commands.keys()],
		dispose() {
			bridge.dispose();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

async function withSlashHarness(run: (harness: SlashHarness) => Promise<void>): Promise<void> {
	const harness = createSlashHarness();
	try {
		await run(harness);
	} finally {
		harness.dispose();
	}
}

describe("human subagent slash command bridge", () => {
	test("/run dispatches parsed single-run params through the slash event bridge", async () => {
		await withSlashHarness(async ({ invoke }) => {
			const params = await invoke(
				"run",
				"slash-alpha[output=reports/run.md,outputMode=file-only,reads=notes.md+spec.md,model=test/model,skills=tdd+tmux] fix the bug --bg --fork",
			);

			assert.deepEqual(params, {
				agent: "slash-alpha",
				task: "fix the bug",
				agentScope: "both",
				reads: ["notes.md", "spec.md"],
				output: "reports/run.md",
				outputMode: "file-only",
				skill: ["tdd", "tmux"],
				model: "test/model",
				async: true,
				context: "fork",
			});
		});
	});

	test("a stale response emit rejects the slash command instead of leaving it pending", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-stale-slash-"));
		writeAgent(cwd, "stale-worker");
		let stale = false;
		const events = new FakeEvents((event) => {
			if (stale && event === SLASH_SUBAGENT_RESPONSE_EVENT) throw new Error(STALE_EXTENSION_CONTEXT_MARKER);
		});
		const commands = new Map<string, CommandOptions>();
		const execution = Promise.withResolvers<{
			content: Array<{ type: "text"; text: string }>;
			details: { mode: "single"; results: [] };
		}>();
		const executionStarted = Promise.withResolvers<void>();
		const ctx = makeContext(cwd);
		const pi = {
			events,
			registerCommand: (name: string, options: CommandOptions) => commands.set(name, options),
			sendMessage: () => {},
		} as unknown as ExtensionAPI;
		const bridge = registerSlashSubagentBridge({
			events,
			getContext: () => ctx,
			execute: async () => {
				executionStarted.resolve();
				return execution.promise;
			},
		});
		registerSlashCommands(pi, { baseCwd: cwd } as SubagentState);
		const command = commands.get("run");
		assert.ok(command);
		const diagnostics: string[] = [];
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));

		try {
			const pending = command.handler("stale-worker wait", ctx);
			await executionStarted.promise;
			stale = true;
			execution.resolve({
				content: [{ type: "text", text: "done" }],
				details: { mode: "single", results: [] },
			});

			const bounded = await Promise.race([
				pending.then(
					() => ({ status: "resolved" as const }),
					(error: unknown) => ({ status: "rejected" as const, error }),
				),
				new Promise<{ status: "timed-out" }>((resolve) =>
					setTimeout(() => resolve({ status: "timed-out" }), STALE_RESPONSE_SETTLEMENT_TIMEOUT_MS),
				),
			]);

			assert.notEqual(bounded.status, "timed-out", "the slash command must settle after a stale response drop");
			assert.equal(bounded.status, "rejected");
			assert.equal(isStaleExtensionContextError(bounded.error), true);
			assert.match(diagnostics.join("\n"), /response runtime was replaced or reloaded/);
		} finally {
			console.error = originalConsoleError;
			bridge.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("stale Escape cancellation rejects the slash command instead of leaving it pending", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-stale-escape-"));
		writeAgent(cwd, "stale-escape-worker");
		let stale = false;
		let terminalInput: TerminalInputHandler | undefined;
		const events = new FakeEvents((event) => {
			if (stale && event === SLASH_SUBAGENT_CANCEL_EVENT) throw new Error(STALE_EXTENSION_CONTEXT_MARKER);
		});
		const commands = new Map<string, CommandOptions>();
		const execution = Promise.withResolvers<{
			content: Array<{ type: "text"; text: string }>;
			details: { mode: "single"; results: [] };
		}>();
		const executionStarted = Promise.withResolvers<void>();
		const ctx = makeContext(cwd, {
			hasUI: true,
			onTerminalInput: (handler) => {
				terminalInput = handler;
				return () => {};
			},
		});
		const pi = {
			events,
			registerCommand: (name: string, options: CommandOptions) => commands.set(name, options),
			sendMessage: () => {},
		} as unknown as ExtensionAPI;
		const bridge = registerSlashSubagentBridge({
			events,
			getContext: () => ctx,
			execute: async () => {
				executionStarted.resolve();
				return execution.promise;
			},
		});
		registerSlashCommands(pi, { baseCwd: cwd } as SubagentState);
		const command = commands.get("run");
		assert.ok(command);

		try {
			const pending = command.handler("stale-escape-worker wait", ctx);
			await executionStarted.promise;
			assert.ok(terminalInput, "the slash command must register its Escape handler");
			stale = true;
			assert.deepEqual(terminalInput!("\u001b"), { consume: true });

			const bounded = await Promise.race([
				pending.then(
					() => ({ status: "resolved" as const }),
					(error: unknown) => ({ status: "rejected" as const, error }),
				),
				new Promise<{ status: "timed-out" }>((resolve) =>
					setTimeout(() => resolve({ status: "timed-out" }), STALE_RESPONSE_SETTLEMENT_TIMEOUT_MS),
				),
			]);

			assert.notEqual(bounded.status, "timed-out", "stale Escape must settle the slash command");
			assert.equal(bounded.status, "rejected");
			assert.equal(isStaleExtensionContextError(bounded.error), true);
		} finally {
			execution.resolve({
				content: [{ type: "text", text: "done" }],
				details: { mode: "single", results: [] },
			});
			bridge.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	test("a non-stale bridge cancellation renders a terminal failure result", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-stopped-slash-"));
		writeAgent(cwd, "stopped-worker");
		const events = new FakeEvents();
		const commands = new Map<string, CommandOptions>();
		const sent: unknown[] = [];
		const statuses: Array<[string, string | undefined]> = [];
		const notifications: Array<[string, "info" | "warning" | "error" | undefined]> = [];
		const execution = Promise.withResolvers<{
			content: Array<{ type: "text"; text: string }>;
			details: { mode: "single"; results: [] };
		}>();
		const executionStarted = Promise.withResolvers<void>();
		const ctx = makeContext(cwd, {
			hasUI: true,
			onNotify: (message, type) => notifications.push([message, type]),
			onStatus: (key, text) => statuses.push([key, text]),
		});
		const pi = {
			events,
			registerCommand: (name: string, options: CommandOptions) => commands.set(name, options),
			sendMessage: (message: unknown) => sent.push(message),
		} as unknown as ExtensionAPI;
		const bridge = registerSlashSubagentBridge({
			events,
			getContext: () => ctx,
			execute: async () => {
				executionStarted.resolve();
				return execution.promise;
			},
		});
		registerSlashCommands(pi, { baseCwd: cwd } as SubagentState);
		const command = commands.get("run");
		assert.ok(command);

		try {
			const pending = command.handler("stopped-worker wait", ctx);
			await executionStarted.promise;
			bridge.cancelAll();

			const bounded = await Promise.race([
				pending.then(
					() => ({ status: "resolved" as const }),
					(error: unknown) => ({ status: "rejected" as const, error }),
				),
				new Promise<{ status: "timed-out" }>((resolve) =>
					setTimeout(() => resolve({ status: "timed-out" }), STALE_RESPONSE_SETTLEMENT_TIMEOUT_MS),
				),
			]);

			assert.notEqual(bounded.status, "timed-out", "bridge cancellation must settle the slash command");
			assert.equal(bounded.status, "resolved");
			assert.equal(sent.length, 2, "the command must publish its initial and terminal results");
			const failure = sent.at(-1) as { content?: unknown };
			assert.match(String(failure.content), /response delivery stopped/);
			assert.ok(statuses.some(([key, text]) => key === "subagent-slash" && text === undefined));
			assert.deepEqual(notifications.at(-1), [
				"Subagent response delivery stopped because its bridge was stopped before the response arrived (extension deactivation or replacement).",
				"error",
			]);
		} finally {
			execution.resolve({
				content: [{ type: "text", text: "done" }],
				details: { mode: "single", results: [] },
			});
			bridge.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("removed slash commands are not registered", async () => {
		await withSlashHarness(async ({ registeredCommands }) => {
			const removed = ["chain", "run-chain"];
			const commands = registeredCommands();
			assert.deepEqual(
				commands.filter((command) => removed.includes(command)),
				[],
			);
			assert.deepEqual(
				BUNDLED_EXTENSION_SLASH_COMMANDS.filter((command) => removed.includes(command.name)),
				[],
			);
		});
	});

	test("/parallel dispatches parsed parallel params through the slash event bridge", async () => {
		await withSlashHarness(async ({ invoke }) => {
			const params = await invoke(
				"parallel",
				'slash-alpha[output=false,progress=false] "inspect alpha" -> slash-beta[reads=one.md+two.md,model=test/beta] "inspect beta" --bg --fork',
			);

			assert.deepEqual(params, {
				tasks: [
					{ agent: "slash-alpha", task: "inspect alpha", output: false, progress: false },
					{ agent: "slash-beta", task: "inspect beta", reads: ["one.md", "two.md"], model: "test/beta" },
				],
				agentScope: "both",
				async: true,
				context: "fork",
			});
		});
	});
});
