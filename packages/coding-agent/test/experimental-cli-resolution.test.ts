import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { type ExperimentalCliContext, experimentalCli } from "../src/cli/experimental/cli.ts";

const UNSUPPORTED_SERVER_OPTIONS = "The experimental server command does not support existing CLI options yet";
const UNSUPPORTED_CLIENT_OPTIONS = "The experimental client command does not support existing CLI options yet";

function parseCommand(argv: readonly string[]) {
	const result = experimentalCli.parse(argv);
	if (!result.ok)
		throw new Error(`Expected a parsed command for ${JSON.stringify(argv)}: ${result.errors.join(", ")}`);
	return result.command;
}

describe("experimental CLI command composition", () => {
	test("composes Atomic command options with the existing parser", () => {
		const command = parseCommand([
			"--listen",
			"unix:///tmp/atomic.sock",
			"--auth-token",
			"secret",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet",
			"--thinking",
			"high",
			"inspect",
		]);

		assert.equal(command.command, "atomic");
		if (command.command !== "atomic") return;
		assert.deepEqual(command.listen, [{ transport: "unix", path: "/tmp/atomic.sock" }]);
		assert.deepEqual(command.auth, { type: "token", token: "secret" });
		assert.equal(command.options.provider, "anthropic");
		assert.equal(command.options.model, "claude-sonnet");
		assert.equal(command.options.thinking, "high");
		assert.deepEqual(command.options.messages, ["inspect"]);
	});

	for (const option of ["--help", "--version"] as const) {
		test(`keeps Atomic ${option} handling in existing CLI options`, () => {
			const command = parseCommand([option]);
			assert.equal(command.command, "atomic");
			if (command.command !== "atomic") return;
			assert.equal(option === "--help" ? command.options.help : command.options.version, true);
		});
	}

	for (const [command, option, error] of [
		["server", "--help", UNSUPPORTED_SERVER_OPTIONS],
		["server", "--version", UNSUPPORTED_SERVER_OPTIONS],
		["client", "--help", UNSUPPORTED_CLIENT_OPTIONS],
		["client", "--version", UNSUPPORTED_CLIENT_OPTIONS],
	] as const) {
		test(`rejects deferred ${command} ${option} handling`, () => {
			assert.deepEqual(experimentalCli.parse([command, option]), { ok: false, errors: [error] });
		});
	}

	test("rejects existing options that the server command does not support yet", () => {
		assert.deepEqual(experimentalCli.parse(["server", "--model", "claude-sonnet", "prompt"]), {
			ok: false,
			errors: [UNSUPPORTED_SERVER_OPTIONS],
		});
	});

	test("rejects existing options that the client command does not support yet", () => {
		assert.deepEqual(experimentalCli.parse(["client", "--model", "claude-sonnet", "@prompt.md"]), {
			ok: false,
			errors: [UNSUPPORTED_CLIENT_OPTIONS],
		});
	});

	test("reports existing parser errors before capability errors", () => {
		assert.deepEqual(experimentalCli.parse(["client", "-x", "--model", "claude-sonnet"]), {
			ok: false,
			errors: ["Unknown option: -x", UNSUPPORTED_CLIENT_OPTIONS],
		});
	});

	test("parses an empty server command", () => {
		assert.deepEqual(experimentalCli.parse(["server"]), {
			ok: true,
			command: { command: "server" },
		});
	});

	for (const [name, argv] of [
		["atomic", []],
		["server", ["server"]],
		["client", ["client"]],
	] as const) {
		test(`executes the parsed ${name} command`, async () => {
			const calls = { atomic: 0, server: 0, client: 0 };
			const context: ExperimentalCliContext = {
				runAtomic: () => {
					calls.atomic++;
				},
				runServer: () => {
					calls.server++;
				},
				runClient: () => {
					calls.client++;
				},
			};
			const result = await experimentalCli.execute(argv, context);

			if (!result.ok) throw new Error(result.errors.join(", "));
			assert.equal(result.command.command, name);
			assert.equal(calls.atomic, name === "atomic" ? 1 : 0);
			assert.equal(calls.server, name === "server" ? 1 : 0);
			assert.equal(calls.client, name === "client" ? 1 : 0);
		});
	}
});
