import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { AuthCommandError, parseAuthCommand, printAuthCommandHelp } from "../src/cli/auth-command.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { main } from "../src/main.js";

class ProcessExit extends Error {
	readonly code: number | string | null | undefined;

	constructor(code: number | string | null | undefined) {
		super(`process.exit(${code})`);
		this.code = code;
	}
}

interface RawInput extends PassThrough {
	isTTY: boolean;
	setRawMode: ReturnType<typeof vi.fn>;
}

let agentDir: string;
const restoreTty: (() => void)[] = [];

function setStdoutTty(isTTY: boolean) {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true, writable: true });
	restoreTty.push(() => {
		if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
		else delete (process.stdout as { isTTY?: boolean }).isTTY;
	});
}

/** Capture writes to `stream`, completing each write so main()'s final stdio drain can finish. */
function captureWrites(stream: NodeJS.WriteStream) {
	const writes: string[] = [];
	vi.spyOn(stream, "write").mockImplementation(((
		chunk: string | Uint8Array,
		encodingOrDone?: BufferEncoding | ((error?: Error | null) => void),
		done?: (error?: Error | null) => void,
	) => {
		if (String(chunk) !== "") writes.push(String(chunk));
		(typeof encodingOrDone === "function" ? encodingOrDone : done)?.();
		return true;
	}) as typeof stream.write);
	return writes;
}

/** A terminal on stdin and stdout, with stdout and stderr captured as lines. */
function terminal() {
	const input = new PassThrough() as RawInput;
	input.isTTY = true;
	input.setRawMode = vi.fn();
	vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
	setStdoutTty(true);
	const stdout = captureWrites(process.stdout);
	const stderr = captureWrites(process.stderr);
	return { input, stdoutText: () => stdout.join(""), stderrText: () => stderr.join("") };
}

async function runMain(args: string[]): Promise<ProcessExit> {
	vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
		throw new ProcessExit(code);
	}) as typeof process.exit);
	const exit = await main(args).then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.ok(exit instanceof ProcessExit, `main() ended without process.exit: ${String(exit)}`);
	return exit;
}

function writeAuth(credentials: Record<string, unknown>) {
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(credentials));
}

function readAuth(): Record<string, unknown> {
	const path = join(agentDir, "auth.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
}

const sigintListeners = () => process.listeners("SIGINT");

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "atomic-auth-login-logout-"));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("ATOMIC_OFFLINE", "1");
	vi.stubEnv("ATOMIC_SKIP_VERSION_CHECK", "1");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	while (restoreTty.length > 0) restoreTty.pop()?.();
	process.exitCode = undefined;
	rmSync(agentDir, { recursive: true, force: true });
});

describe("atomic auth login and logout from main", () => {
	test("logs out without starting a session and ignores --offline", async () => {
		writeAuth({
			openai: { type: "api_key", key: "sk-test" },
			radius: { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000 },
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const logout = vi.spyOn(ModelRuntime.prototype, "logout");
		const create = vi.spyOn(ModelRuntime, "create");

		const exit = await runMain(["auth", "logout", "openai", "--offline"]);

		assert.equal(exit.code, 0);
		assert.deepEqual(
			create.mock.calls.map(([options]) => options),
			[{ allowModelNetwork: false }],
		);
		assert.deepEqual(log.mock.calls, [
			["Removed stored API key for OpenAI. Environment variables and models.json config are unchanged."],
		]);
		assert.deepEqual(Object.keys(readAuth()), ["radius"]);
		assert.equal(logout.mock.calls.length, 1);
		const signal = logout.mock.calls[0][1]?.signal;
		assert.ok(signal instanceof AbortSignal);
		assert.equal(signal.aborted, false);
	});

	test("reports logout errors on stderr with a non-zero exit", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const exit = await runMain(["auth", "logout", "nope"]);

		assert.equal(exit.code, 1);
		assert.deepEqual(error.mock.calls, [['Unknown provider "nope".'], ["Stored credentials: none"]]);
		assert.deepEqual(log.mock.calls, []);
	});

	test("leaves other auth commands to the auth command parser", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const exit = await runMain(["auth", "nope"]);

		assert.equal(exit.code, 1);
		const stderr = error.mock.calls.map(([text]) => String(text)).join("\n");
		assert.ok(stderr.includes('Unknown auth command "nope".'), stderr);
		assert.ok(!stderr.includes("Usage:"), stderr);
	});

	test("leaves login and logout of other commands, such as mcp, to those commands", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
			throw new ProcessExit(code);
		}) as typeof process.exit);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const create = vi.spyOn(ModelRuntime, "create");

		for (const command of ["login", "logout"]) {
			await main(["mcp", command, "nope"]);
			assert.equal(process.exitCode, 1);
		}

		assert.equal(exit.mock.calls.length, 0);
		assert.equal(create.mock.calls.length, 0);
		const output = [...log.mock.calls, ...error.mock.calls].map(([text]) => String(text)).join("\n");
		assert.ok(!output.includes("atomic auth"), output);
	});

	test("refuses to log in without a terminal, after dropping --offline", async () => {
		vi.spyOn(process, "stdin", "get").mockReturnValue(
			Object.assign(new PassThrough(), { isTTY: false }) as unknown as typeof process.stdin,
		);
		const stderr = captureWrites(process.stderr);
		const listeners = sigintListeners();

		const exit = await runMain(["auth", "login", "openai", "--offline"]);

		assert.equal(exit.code, 1);
		assert.deepEqual(stderr, [
			'"atomic auth login <provider> [--api-key] [--no-browser]" requires an interactive terminal\n',
		]);
		assert.deepEqual(sigintListeners(), listeners);
	});

	test("saves an API key typed at the terminal", async () => {
		const { input, stdoutText } = terminal();
		const create = vi.spyOn(ModelRuntime, "create");
		const pending = runMain(["auth", "login", "openai", "--api-key"]);
		await vi.waitFor(() => assert.deepEqual(input.setRawMode.mock.calls, [[true]]));
		input.write("sk-typed\n");

		const exit = await pending;

		assert.equal(exit.code, 0);
		assert.deepEqual(
			create.mock.calls.map(([options]) => options),
			[{ allowModelNetwork: false }],
		);
		assert.deepEqual(readAuth().openai, { type: "api_key", key: "sk-typed" });
		assert.ok(
			stdoutText().includes(`Saved API key for OpenAI. Credentials saved to ${join(agentDir, "auth.json")}\n`),
			stdoutText(),
		);
	});

	test("Ctrl+C at a prompt cancels the login and removes the SIGINT handler", async () => {
		const { input, stderrText } = terminal();
		const listeners = sigintListeners();
		const pending = runMain(["auth", "login", "openai", "--api-key"]);
		await vi.waitFor(() => assert.deepEqual(input.setRawMode.mock.calls, [[true]]));
		assert.equal(sigintListeners().length, listeners.length + 1);
		input.write("sk-\u0003");

		const exit = await pending;

		assert.equal(exit.code, 1);
		assert.equal(stderrText(), "Login cancelled.\n");
		assert.deepEqual(sigintListeners(), listeners);
	});

	test("SIGINT while the login waits cancels it", async () => {
		const { input, stderrText } = terminal();
		const listeners = sigintListeners();
		const pending = runMain(["auth", "login", "openai", "--api-key"]);
		await vi.waitFor(() => assert.deepEqual(input.setRawMode.mock.calls, [[true]]));
		const added = sigintListeners().filter((listener) => !listeners.includes(listener));
		assert.equal(added.length, 1);
		added[0]("SIGINT");

		const exit = await pending;

		assert.equal(exit.code, 1);
		assert.equal(stderrText(), "Login cancelled.\n");
		assert.equal(readAuth().openai, undefined);
		assert.deepEqual(sigintListeners(), listeners);
	});

	test("account sign-in gets the installation's device id from global settings", async () => {
		terminal();
		const deviceIds: (string | undefined)[] = [];
		vi.spyOn(ModelRuntime.prototype, "login").mockImplementation(async (_providerId, type, _interaction, options) => {
			assert.equal(type, "oauth");
			deviceIds.push(options?.getDeviceId?.());
			return { type: "api_key", key: "unused" };
		});

		const exit = await runMain(["auth", "login", "openai"]);

		assert.equal(exit.code, 0);
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { deviceId?: string };
		assert.equal(typeof settings.deviceId, "string");
		assert.deepEqual(deviceIds, [settings.deviceId]);
	});
});

describe("atomic auth help and usage name login and logout", () => {
	test("an auth command without a subcommand is unknown, with an empty name", () => {
		assert.throws(
			() => parseAuthCommand(["auth"]),
			(error: unknown) => error instanceof AuthCommandError && error.message.startsWith('Unknown auth command "".'),
		);
	});

	test("an unknown auth command lists all five commands", () => {
		assert.throws(
			() => parseAuthCommand(["auth", "sign-in"]),
			(error: unknown) =>
				error instanceof AuthCommandError &&
				error.exitCode === 1 &&
				error.message ===
					'Unknown auth command "sign-in". Use "atomic auth login", "atomic auth logout", "atomic auth print-api-key", "atomic auth print-bearer-token", or "atomic auth check".',
		);
	});

	test("help shows the login and logout usage", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		printAuthCommandHelp();
		const help = error.mock.calls.map(([text]) => String(text)).join("\n");
		assert.ok(help.includes("\n  atomic auth login <provider> [--api-key] [--no-browser]\n"));
		assert.ok(help.includes("\n  atomic auth logout <provider>\n"));
		assert.ok(help.includes("login needs an\ninteractive terminal."));
	});
});
