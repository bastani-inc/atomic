import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { experimentalCli } from "../src/cli/experimental/cli.ts";

function parseCommand(argv: readonly string[]) {
	const result = experimentalCli.parse(argv);
	if (!result.ok)
		throw new Error(`Expected a parsed command for ${JSON.stringify(argv)}: ${result.errors.join(", ")}`);
	return result.command;
}

function assertInvalid(argv: readonly string[], error: string): void {
	const result = experimentalCli.parse(argv);
	if (result.ok) throw new Error(`Expected invalid input for ${JSON.stringify(argv)}`);
	assert.ok(
		result.errors.some((candidate) => candidate.includes(error)),
		result.errors.join("\n"),
	);
}

describe("experimental CLI commands", () => {
	test("selects Atomic mode and parses existing CLI arguments", () => {
		const command = parseCommand([
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet",
			"--thinking",
			"high",
			"inspect",
			"the project",
		]);
		assert.equal(command.command, "atomic");
		if (command.command !== "atomic") return;
		assert.equal(command.options.provider, "anthropic");
		assert.equal(command.options.model, "claude-sonnet");
		assert.equal(command.options.thinking, "high");
		assert.deepEqual(command.options.messages, ["inspect", "the project"]);
	});

	test("parses a server listener", () => {
		const command = parseCommand(["server", "--listen", "unix:///tmp/atomic.sock"]);
		assert.equal(command.command, "server");
		if (command.command !== "server") return;
		assert.deepEqual(command.listen, [{ transport: "unix", path: "/tmp/atomic.sock" }]);
	});

	test("leaves experimental-looking existing option values with the existing parser", () => {
		const command = parseCommand(["--system-prompt", "--listen", "unix:///tmp/atomic.sock"]);
		assert.equal(command.command, "atomic");
		if (command.command !== "atomic") return;
		assert.equal(command.options.systemPrompt, "--listen");
		assert.deepEqual(command.options.messages, ["unix:///tmp/atomic.sock"]);
	});

	test("stops parsing command options when existing CLI arguments begin", () => {
		const command = parseCommand(["--model", "claude-sonnet", "--listen=unix:///tmp/second.sock"]);
		assert.equal(command.command, "atomic");
		if (command.command !== "atomic") return;
		assert.equal(command.options.model, "claude-sonnet");
		assert.equal(command.listen, undefined);
		assert.equal(command.options.unknownFlags.get("listen"), "unix:///tmp/second.sock");
	});

	test("parses a client transport address", () => {
		const command = parseCommand(["client", "--connect", "unix:///tmp/atomic.sock"]);
		assert.equal(command.command, "client");
		if (command.command !== "client") return;
		assert.deepEqual(command.connect, { transport: "unix", path: "/tmp/atomic.sock" });
	});

	for (const [argv, auth] of [
		[["--auth-token", "secret"], { type: "token", token: "secret" }],
		[["--auth-token-file", "/tmp/token"], { type: "file", path: "/tmp/token" }],
	] as const) {
		test(`parses authentication source ${JSON.stringify(argv)}`, () => {
			const command = parseCommand(argv);
			assert.equal(command.command, "atomic");
			if (command.command !== "atomic") return;
			assert.deepEqual(command.auth, auth);
		});
	}

	for (const argv of [[], ["server"], ["client"]] as const) {
		test(`permits omitted authentication for ${argv[0] ?? "atomic"}`, () => {
			const command = parseCommand(argv);
			assert.equal(command.auth, undefined);
		});
	}

	test("passes unknown options, file arguments, and the positional separator to the existing parser", () => {
		const command = parseCommand(["--unknown", "@prompt.md", "--", "--listen", "unix:///tmp/atomic.sock"]);
		assert.equal(command.command, "atomic");
		if (command.command !== "atomic") return;
		assert.deepEqual(command.options.fileArgs, ["prompt.md"]);
		assert.equal(command.options.unknownFlags.get("unknown"), true);
		// Atomic's legacy parser honors `--`, so tokens after it remain literal messages.
		assert.equal(command.listen, undefined);
		assert.equal(command.options.unknownFlags.get("listen"), undefined);
		assert.deepEqual(command.options.messages, ["--listen", "unix:///tmp/atomic.sock"]);
	});

	for (const [argv, error] of [
		[
			["--listen", "unix:///tmp/atomic.sock", "--listen", "unix:///tmp/atomic-admin.sock"],
			"--listen may only be specified once",
		],
		[
			["--auth-token", "secret", "--auth-token-file", "/tmp/token"],
			"--auth-token and --auth-token-file are mutually exclusive",
		],
		[["--auth-token", "first", "--auth-token", "second"], "--auth-token may only be specified once"],
		[
			["--auth-token-file", "/tmp/first", "--auth-token-file=/tmp/second"],
			"--auth-token-file may only be specified once",
		],
		[["--listen", "/tmp/atomic.sock"], 'Invalid --listen address "/tmp/atomic.sock"'],
		[["--listen", "ws://localhost:8080"], 'Unsupported --listen transport "ws:"'],
		[["--listen", "unix://relative.sock"], "Unix transport address must not include an authority"],
		[
			["--listen", "unix:///tmp/atomic.sock?wrong=value"],
			'Invalid --listen address "unix:///tmp/atomic.sock?wrong=value"',
		],
		[["--listen", "unix:///tmp/atomic.sock#fragment"], 'Invalid --listen address "unix:///tmp/atomic.sock#fragment"'],
		[["--listen", "unix:/tmp/atomic.sock"], 'Invalid --listen address "unix:/tmp/atomic.sock"'],
		[["--listen", "unix:///tmp/%00atomic.sock"], 'Invalid --listen address "unix:///tmp/%00atomic.sock"'],
		[
			["client", "--listen", "unix:///tmp/atomic.sock"],
			"The experimental client command does not support existing CLI options yet",
		],
		[
			["server", "--connect", "unix:///tmp/atomic.sock"],
			"The experimental server command does not support existing CLI options yet",
		],
		[["client", "--connect", "ws://localhost:8080"], 'Unsupported --connect transport "ws:"'],
		[["--listen"], "--listen requires a value"],
		[["--connect="], "--connect is only valid for client mode"],
	] as const) {
		test(`rejects invalid experimental input ${JSON.stringify(argv)}`, () => {
			assertInvalid(argv, error);
		});
	}

	test("rejects unsupported options without parsing them", () => {
		const result = experimentalCli.parse([
			"client",
			"--listen",
			"ws://localhost:8080",
			"--auth-token",
			"secret",
			"--auth-token-file",
			"/tmp/token",
		]);
		assert.deepEqual(result, {
			ok: false,
			errors: ["The experimental client command does not support existing CLI options yet"],
		});
	});

	test("treats command names after the first argument as existing CLI arguments", () => {
		const command = parseCommand(["--cwd", "/workspace", "server"]);
		assert.equal(command.command, "atomic");
		if (command.command !== "atomic") return;
		assert.deepEqual(command.options.messages, ["server"]);
	});
});
