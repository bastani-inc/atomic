import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@bastani/atomic";
import { describe, test } from "vitest";
import { CONFIG_DIR_NAME } from "../../packages/coding-agent/src/config.js";
import { BUNDLED_EXTENSION_SLASH_COMMANDS } from "../../packages/coding-agent/src/core/slash-commands.js";
import type { SubagentParamsLike } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { SubagentState } from "../../packages/subagents/src/shared/types.js";
import { registerSlashSubagentBridge } from "../../packages/subagents/src/slash/slash-bridge.js";
import { registerSlashCommands } from "../../packages/subagents/src/slash/slash-commands.js";

type EventHandler = (data: unknown) => void;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

class FakeEvents {
	private readonly handlers = new Map<string, Set<EventHandler>>();

	on(event: string, handler: EventHandler): () => void {
		const handlers = this.handlers.get(event) ?? new Set<EventHandler>();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, data: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(data);
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

function makeContext(cwd: string): ExtensionCommandContext {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: {
			notify: () => {},
			setToolsExpanded: () => {},
			setStatus: () => {},
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

	test("removed slash commands are not registered", async () => {
		await withSlashHarness(async ({ registeredCommands }) => {
			const removed = ["ch" + "ain", "run-" + "ch" + "ain"];
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
