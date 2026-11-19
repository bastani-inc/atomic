// @ts-nocheck
import { describe, test } from "vitest";
import type { ExtensionAPI, PiCommandContext, PiCommandOptions, SentMessage } from "./slash-dispatch-utils.js";
import { assert, installSlashDispatchTestHooks, runFactory } from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

interface RawRegisteredCommand {
	name: string;
	options: PiCommandOptions;
}

function buildRawMockPi(): {
	pi: ExtensionAPI;
	commands: RawRegisteredCommand[];
	sent: SentMessage[];
} {
	const commands: RawRegisteredCommand[] = [];
	const sent: SentMessage[] = [];
	const pi: ExtensionAPI = {
		registerCommand: (name: string, options: PiCommandOptions) => {
			commands.push({ name, options });
		},
		sendMessage: (msg: SentMessage) => {
			sent.push(msg);
		},
	};
	return { pi, commands, sent };
}

describe("canonical registerCommand — opts.handler shape", () => {
	async function runFactoryRaw(): Promise<{
		commands: RawRegisteredCommand[];
		sent: SentMessage[];
	}> {
		const { pi, commands, sent } = buildRawMockPi();
		await runFactory(pi);
		return { commands, sent };
	}

	test.sequential("registerCommand receives 'workflows' and 'workflow-authoring' and never 'workflow' (#5224)", async () => {
		const { commands } = await runFactoryRaw();
		const names = commands.map((c) => c.name);
		assert.equal(names.includes("workflow"), false);
		assert.ok(names.includes("workflows"));
		assert.ok(names.includes("workflow-authoring"));
	});

	test.sequential("registerCommand does not receive per-workflow alias names", async () => {
		const { commands } = await runFactoryRaw();
		const names = commands.map((c) => c.name);
		assert.equal(
			names.some((n) => n.startsWith("workflow:")),
			false,
		);
	});

	test.sequential("opts passed to registerCommand have 'handler' (function)", async () => {
		const { commands } = await runFactoryRaw();
		for (const { name, options } of commands) {
			assert.equal(typeof options.handler, "function", `${name}: handler should be function`);
		}
	});

	test.sequential("opts passed to registerCommand do NOT have 'execute' property", async () => {
		const { commands } = await runFactoryRaw();
		for (const { name, options } of commands) {
			assert.equal(Object.hasOwn(options, "execute"), false, `${name}: opts must not have execute — use handler`);
		}
	});

	test.sequential("opts have 'description' string", async () => {
		const { commands } = await runFactoryRaw();
		for (const { name, options } of commands) {
			assert.equal(typeof options.description, "string", `${name}: description should be string`);
		}
	});

	test.sequential("the workflows handler is callable (#5224)", async () => {
		const { commands, sent } = await runFactoryRaw();
		const workflowsCmd = commands.find((c) => c.name === "workflows");
		assert.notEqual(workflowsCmd, undefined);
		const msgs: string[] = [];
		const ctx: PiCommandContext = {
			hasUI: false,
			ui: {
				notify(message: string) {
					msgs.push(message);
				},
			},
		};
		await workflowsCmd!.options.handler("", ctx);
		assert.equal(sent.length, 1);
	});
});
