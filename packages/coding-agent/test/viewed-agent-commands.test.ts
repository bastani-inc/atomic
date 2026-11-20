import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";
import {
	type MainCommandOrigin,
	type ViewedAgentCommand,
	viewedAgentCommand,
} from "../src/modes/interactive/subagent-chat-commands.js";

/** The main session's extension commands in these cases: one bundled with Atomic, one the user configured. */
function mainCommands(commands: Record<string, MainCommandOrigin> = {}) {
	return (name: string): MainCommandOrigin | undefined => commands[name];
}

const route = (text: string, commands?: Record<string, MainCommandOrigin>): ViewedAgentCommand =>
	viewedAgentCommand(text, mainCommands(commands));

/** Built-ins that replace, rewrite or switch the main conversation. */
const CONFIRMED = new Set(["new", "compact", "resume", "fork", "clone", "tree", "import"]);
/** Built-ins that set the main conversation's model or thinking level. */
const REFUSED = new Set(["model", "thinking"]);
/** Built-ins whose answer is printed into the main transcript. */
const PRINTED = new Set(["session", "tools", "changelog", "hotkeys", "name"]);

describe("slash commands typed while a subagent is viewed", () => {
	test("every built-in runs on main, asks first, or is refused; none reaches the subagent as text", () => {
		for (const { name } of BUILTIN_SLASH_COMMANDS) {
			const command = route(`/${name}`);
			if (name === "copy") assert.deepEqual(command, { kind: "copy" }, `/${name}`);
			else if (REFUSED.has(name)) assert.deepEqual(command, { kind: "refuse", name }, `/${name}`);
			else if (CONFIRMED.has(name)) assert.deepEqual(command, { kind: "confirm", name }, `/${name}`);
			else assert.deepEqual(command, { kind: "main", name, showMain: PRINTED.has(name) }, `/${name}`);
		}
	});

	test("built-ins keep the arguments main runs them with", () => {
		assert.deepEqual(route("/model other-model"), { kind: "refuse", name: "model" });
		assert.deepEqual(route("/thinking high"), { kind: "refuse", name: "thinking" });
		assert.deepEqual(route("/compact keep the plan"), { kind: "confirm", name: "compact" });
		assert.deepEqual(route("/resume abc123"), { kind: "confirm", name: "resume" });
		assert.deepEqual(route("/import ./a.jsonl"), { kind: "confirm", name: "import" });
		assert.deepEqual(route("/tasks task-1"), { kind: "main", name: "tasks", showMain: false });
		assert.deepEqual(route("/export out.html"), { kind: "main", name: "export", showMain: false });
		assert.deepEqual(route("/name release work"), { kind: "main", name: "name", showMain: true });
		assert.deepEqual(route("/session snapshot"), { kind: "main", name: "session", showMain: true });
		assert.deepEqual(route("/login anthropic"), { kind: "main", name: "login", showMain: false });
	});

	test("the built-ins main runs without listing them run on main with its transcript shown", () => {
		for (const name of ["debug", "arminsayshi", "dementedelves"])
			assert.deepEqual(route(`/${name}`), { kind: "main", name, showMain: true }, `/${name}`);
	});

	test("text main would send to its model goes to the subagent: skills, templates, unknown commands, built-in names with arguments they do not take", () => {
		for (const text of [
			"/skill:review the diff",
			"/review src/a.ts",
			"/copy that paragraph",
			"/new idea: cache it",
			"/settings please",
			"/clear",
			"/rewind",
			"hello",
		])
			assert.deepEqual(route(text), { kind: "agent" }, text);
	});

	test("extension commands bundled with Atomic act on Atomic and run on main; configured ones go to the subagent", () => {
		const commands = { mcp: "bundled", agents: "bundled", plan: "configured" } as const;
		assert.deepEqual(route("/mcp", commands), { kind: "main", name: "mcp", showMain: false });
		assert.deepEqual(route("/agents worker", commands), { kind: "main", name: "agents", showMain: false });
		assert.deepEqual(route("/plan", commands), { kind: "agent" });
	});

	test("a command registered as /clear or /rewind asks first and runs on main", () => {
		assert.deepEqual(route("/clear", { clear: "configured" }), { kind: "confirm", name: "clear" });
		assert.deepEqual(route("/rewind 3", { rewind: "bundled" }), { kind: "confirm", name: "rewind" });
	});
});
