/**
 * `atomic auth print-api-key` / `print-bearer-token` — the credential-export door.
 *
 * Upstream 99e34013, tightened by this repository's design: a typed Secret, one
 * exit code per failure, `--min-expiry` rejected for API keys, and stdout that
 * carries the credential or nothing at all.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { inspect } from "node:util";
import { ModelsError } from "@earendil-works/pi-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type Args, parseArgs } from "../src/cli/args.ts";
import {
	AuthCommandError,
	isAuthCommandHelp,
	parseAuthCommand,
	printAuthCommandHelp,
} from "../src/cli/auth-command.ts";
import {
	type CredentialJsonFields,
	CredentialPrintError,
	type CredentialPrintErrorCode,
	classifyOAuthFailure,
	DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS,
	EXIT_CODES,
	emitCredential,
	OAUTH_EXPIRES_TOO_SOON_PHRASE,
	OAUTH_REFRESH_FAILED_PHRASE,
	resolveCredentialForPrint,
	Secret,
	STDOUT_EMPTY_ON_EXIT,
	toCredentialPrintError,
	validateCredentialPrintArgs,
} from "../src/cli/credential-print.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { RpcProviderAuth } from "../src/modes/rpc/rpc-provider-auth.ts";
import { bunExecutable, cliPath, removeTempDirs, runCliProcess } from "./cli-test-helpers.ts";

/**
 * Structural: each case starts a real `atomic` child, so the cost is a process
 * spawn plus a Bun transpile of the CLI graph, not a slow assertion.
 */
const REAL_CLI_SUITE_TIMEOUT_MS = 120_000;

const tempRoot = mkdtempSync(join(tmpdir(), "atomic-credential-print-suite-"));
const tempDirs: string[] = [];
afterEach(() => removeTempDirs(tempDirs));
afterAll(() => removeTempDirs([tempRoot]));

function agentDirWith(credentials: Record<string, unknown>): string {
	const root = mkdtempSync(join(tempRoot, "case-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(credentials, null, 2));
	return agentDir;
}

function cliEnv(agentDir: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		ATOMIC_CODING_AGENT_DIR: agentDir,
		ATOMIC_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
		ATOMIC_OFFLINE: "1",
		ATOMIC_SKIP_VERSION_CHECK: "1",
		ATOMIC_INTERACTIVE_ENGINE_CHILD: undefined,
		ATOMIC_INTERACTIVE_ENGINE_API_KEY: undefined,
		NO_COLOR: "1",
	};
}

/** How long a child gets before the pipe-close race is called a hang. */
const CLOSED_PIPE_CHILD_TIMEOUT_MS = 60_000;

/**
 * Start a real `atomic` child and close the read end of its stdout pipe at
 * once.
 *
 * This is the EPIPE race a stubbed `process.stdout.write` cannot reach: the
 * failure comes from the OS, at whatever point the child has actually got to,
 * and it is the only way to observe what a real caller's stdout holds when the
 * process exits.
 */
function runCliWithClosedStdout(
	argv: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
	const child = spawn(bunExecutable(), [cliPath, ...argv], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let stdout = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	// Anything the child already managed to write is captured above; from here
	// the pipe has no reader at all.
	child.stdout.destroy();
	child.stderr.resume();

	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), CLOSED_PIPE_CHILD_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			resolvePromise({ code, signal, stdout });
		});
	});
}

function args(overrides: Partial<Args> = {}): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [], ...overrides } as Args;
}

/**
 * A ModelRuntime stub narrowed to the members this door and `resolveCliModel`
 * consume. Each provider gets one model whose id is `modelId`, so provider
 * selection is what the assertions actually exercise.
 *
 * `credentials` is what `auth.json` holds. `providers` defaults to those same
 * providers; pass it to model one that offers the model while persisting
 * nothing. `resolvedAuth` is what `checkAuth` reports — the auth a request would
 * actually use — and defaults to the persisted type, so a provider with no
 * persisted credential and no explicit entry reads as unconfigured.
 */
function runtimeStub(options: {
	credentials: Array<{ providerId: string; type: "api_key" | "oauth" }>;
	providers?: string[];
	resolvedAuth?: Record<string, "api_key" | "oauth">;
	modelId?: string;
	getAuth: (
		model: { provider: string },
		overrides?: { minOAuthValidityMs?: number },
	) => Promise<{ auth: { apiKey?: string; headers?: Record<string, string> } } | undefined>;
}): ModelRuntime {
	const modelId = options.modelId ?? "claude-sonnet-4-5";
	const providerIds = options.providers ?? options.credentials.map(({ providerId }) => providerId);
	const persisted = new Map(options.credentials.map(({ providerId, type }) => [providerId, type]));
	const resolved = new Map<string, "api_key" | "oauth">([...persisted, ...Object.entries(options.resolvedAuth ?? {})]);
	const models = providerIds.map((providerId) => ({
		id: modelId,
		name: modelId,
		provider: providerId,
		api: "anthropic-messages",
		reasoning: false,
	}));
	return {
		listCredentials: async () => options.credentials,
		checkAuth: async (providerId: string) => {
			const type = resolved.get(providerId);
			return type ? { type } : undefined;
		},
		getProviders: () => providerIds.map((id) => ({ id, auth: { apiKey: {} } })),
		getModels: () => models,
		getAuth: options.getAuth,
	} as unknown as ModelRuntime;
}

/** The `@earendil-works/pi-ai` build this checkout actually resolves. */
function installedPiAiResolveJs(): string {
	for (let dir = import.meta.dirname; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "auth", "resolve.js");
		if (existsSync(candidate)) return candidate;
		if (dirname(dir) === dir) throw new Error("installed @earendil-works/pi-ai not found");
	}
}

interface SecretRuntimeProbe {
	inspect: string;
	bunInspect: string;
	clone: string;
	cloneKeys: string[];
	hidden: string;
}

/**
 * Re-run the Secret refusals under Bun, the runtime the published binary is
 * compiled on. Bun.inspect is unreachable from this Node-hosted suite, so the
 * probe is a real child rather than a shim.
 */
function runSecretProbeUnderBun(value: string): SecretRuntimeProbe {
	const root = mkdtempSync(join(tempRoot, "secret-probe-"));
	tempDirs.push(root);
	const modulePath = resolve(import.meta.dirname, "..", "src", "cli", "credential-print.ts");
	const probePath = join(root, "secret-probe.ts");
	writeFileSync(
		probePath,
		`import { inspect } from "node:util";
import { Secret } from ${JSON.stringify(modulePath)};

const secret = new Secret(${JSON.stringify(value)});
const clone: object = structuredClone(secret);
process.stdout.write(
	JSON.stringify({
		inspect: inspect(secret),
		bunInspect: Bun.inspect(secret),
		clone: inspect(clone),
		cloneKeys: Object.keys(clone),
		hidden: inspect(secret, { showHidden: true, customInspect: false }),
	}),
);
`,
	);

	const child = spawnSync(bunExecutable(), [probePath], { encoding: "utf8" });
	if (child.status !== 0) {
		throw new Error(`Secret probe failed under Bun (${child.status}): ${child.stderr}`);
	}
	return JSON.parse(child.stdout) as SecretRuntimeProbe;
}

describe("Secret", () => {
	it("refuses every path that would copy the value into a string", () => {
		const secret = new Secret("sk-live-value");

		expect(() => `${secret}`).toThrow("cannot be interpolated");
		expect(() => secret.toString()).toThrow("cannot be converted to a string");
		expect(() => JSON.stringify(secret)).toThrow("cannot be serialized");
		// biome-ignore lint/style/useTemplate: concatenation is the coercion path under test
		expect(() => secret + "").toThrow("cannot be interpolated");
		// console.log and Node error formatting both route through inspect.
		expect(inspect(secret)).toBe("[Secret]");
		expect(inspect({ nested: secret })).not.toContain("sk-live-value");
	});

	it("is consumed exactly once", () => {
		const secret = new Secret("sk-live-value");

		expect(secret.take()).toBe("sk-live-value");
		expect(() => secret.take()).toThrow("already been consumed");
	});

	/**
	 * The published binary is Bun-compiled while this suite runs under Node, so
	 * every refusal above is checked on both runtimes. Bun.inspect is a separate
	 * formatter from node:util inspect, and it is the one a stray `console.log`
	 * inside the shipped binary would reach.
	 */
	it(
		"survives the runtime the binary ships on",
		() => {
			const secret = new Secret("sk-live-value");
			const clone: object = structuredClone(secret);

			expect(inspect(secret)).toBe("[Secret]");
			expect(Object.keys(clone)).toEqual([]);
			expect(inspect(clone)).not.toContain("sk-live-value");
			expect(inspect(secret, { showHidden: true, customInspect: false })).not.toContain("sk-live-value");

			const probe = runSecretProbeUnderBun("sk-live-value");
			expect(probe.inspect).toBe("[Secret]");
			expect(probe.bunInspect).toBe("[Secret]");
			expect(probe.cloneKeys).toEqual([]);
			expect(probe.clone).not.toContain("sk-live-value");
			expect(probe.hidden).not.toContain("sk-live-value");
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);
});

describe("emitCredential", () => {
	/**
	 * `writeRawStdoutOnce` and the trailing drain both resolve against the real
	 * stdout writer, so stubbing `process.stdout.write` is what puts each of the
	 * failure points under test.
	 *
	 * The stub also models `bytesWritten`, because that counter is how the guard
	 * tells an emitted payload from a dropped one. `emitOnCallbackError` means the
	 * stream flushed bytes and *then* failed, so the counter advances and the text
	 * is recorded; without it the chunk was buffered and dropped, and neither
	 * moves. `onSubmit` models the write call throwing, before either can happen.
	 */
	function withStubbedStdout<T>(
		onWrite: (text: string) => Error | undefined,
		body: (written: string[]) => Promise<T>,
		options: {
			onSubmit?: (text: string) => Error | undefined;
			emitOnCallbackError?: boolean;
			/** Bytes the stream flushed before failing, for the truncated case. */
			flushedOnCallbackError?: number;
		} = {},
	): Promise<T> {
		const original = process.stdout.write;
		const originalBytesWritten = Object.getOwnPropertyDescriptor(process.stdout, "bytesWritten");
		const written: string[] = [];
		let bytesWritten = 0;
		Object.defineProperty(process.stdout, "bytesWritten", {
			configurable: true,
			get: () => bytesWritten,
		});
		process.stdout.write = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean => {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			const text = String(chunk);
			const refused = options.onSubmit?.(text);
			if (refused) throw refused;
			const failure = onWrite(text);
			if (!failure || options.emitOnCallbackError) {
				written.push(text);
				bytesWritten += Buffer.byteLength(text);
			} else if (options.flushedOnCallbackError !== undefined && text.length > 0) {
				// A fragment reached the reader before the stream failed.
				written.push(text.slice(0, options.flushedOnCallbackError));
				bytesWritten += options.flushedOnCallbackError;
			}
			done?.(failure ?? null);
			return true;
		}) as typeof process.stdout.write;
		return body(written).finally(() => {
			process.stdout.write = original;
			if (originalBytesWritten) Object.defineProperty(process.stdout, "bytesWritten", originalBytesWritten);
			else delete (process.stdout as { bytesWritten?: unknown }).bytesWritten;
		});
	}

	it("allows only readiness fields in a credential JSON envelope", async () => {
		await withStubbedStdout(
			() => undefined,
			async (written) => {
				const fields = {
					status: "ready",
					provider: "anthropic",
					authType: "api_key",
					diagnostic: "must-not-reach-stdout",
				};
				await emitCredential(new Secret("credential-value"), fields);

				expect(JSON.parse(written.join(""))).toEqual({
					status: "ready",
					provider: "anthropic",
					authType: "api_key",
					credentials: "credential-value",
				});
			},
		);
	});

	it("validates a JSON envelope before consuming its credential", async () => {
		await withStubbedStdout(
			() => undefined,
			async (written) => {
				const secret = new Secret("credential-value");
				await expect(
					emitCredential(secret, { status: undefined, provider: "anthropic" } as unknown as CredentialJsonFields),
				).rejects.toThrow("Invalid credential JSON fields");

				await emitCredential(secret, undefined);
				expect(written.join("")).toBe("credential-value\n");
			},
		);
	});

	it("a post-write drain failure still exits zero with the credential on stdout", async () => {
		const reported: string[] = [];
		const originalConsoleError = console.error;
		console.error = ((...parts: unknown[]) => {
			reported.push(parts.map(String).join(" "));
		}) as typeof console.error;
		const originalExitCode = process.exitCode;
		process.exitCode = undefined;

		try {
			await withStubbedStdout(
				// The payload write succeeds; the trailing drain rejects, which is
				// the EPIPE-on-close shape the guard's separate flush operation
				// exposes.
				(text) => (text.length === 0 ? new Error("EPIPE on the trailing flush") : undefined),
				async (written) => {
					await expect(emitCredential(new Secret("sk-x"), undefined)).resolves.toBeUndefined();

					expect(written).toEqual(["sk-x\n"]);
					// Once those bytes are on stdout the command has succeeded. A
					// non-zero exit here would be a non-zero exit with a credential
					// on the stream, which is the one thing this door never does.
					expect(process.exitCode ?? 0).toBe(0);
					// The broken reader is still reported — on stderr.
					expect(reported.join("\n")).toContain("did not drain cleanly");
					expect(reported.join("\n")).not.toContain("sk-x");
				},
			);
		} finally {
			console.error = originalConsoleError;
			process.exitCode = originalExitCode;
		}
	});

	/**
	 * The taxonomy, walked rather than sampled. Adding a code to `EXIT_CODES`
	 * without an exercised path here fails the first assertion; adding one that
	 * puts bytes on stdout without declaring itself in `STDOUT_EMPTY_ON_EXIT`
	 * fails the second.
	 */
	it("every declared exit code keeps the stdout contract it declares", async () => {
		const oauthFailure = (message: string) =>
			runtimeStub({
				credentials: [{ providerId: "anthropic", type: "oauth" }],
				getAuth: async () => {
					throw new ModelsError("oauth", message);
				},
			});
		const anthropic = args({ model: "claude-sonnet-4-5", provider: "anthropic" });

		const cases: Array<{
			code: CredentialPrintErrorCode;
			onWrite?: (text: string) => Error | undefined;
			onSubmit?: (text: string) => Error | undefined;
			flushedOnCallbackError?: number;
			run: () => Promise<unknown>;
		}> = [
			{
				code: "Usage",
				run: async () => validateCredentialPrintArgs(args()),
			},
			{
				code: "NoCredentialConfigured",
				run: () =>
					resolveCredentialForPrint(
						args({ model: "not-a-configured-model" }),
						runtimeStub({
							credentials: [{ providerId: "anthropic", type: "api_key" }],
							getAuth: async () => ({ auth: { apiKey: "sk-ant-value" } }),
						}),
						"api_key",
					),
			},
			{
				code: "ProviderAmbiguous",
				run: () =>
					resolveCredentialForPrint(
						args({ model: "claude-sonnet-4-5" }),
						runtimeStub({
							credentials: [
								{ providerId: "anthropic", type: "api_key" },
								{ providerId: "openai", type: "api_key" },
							],
							getAuth: async () => ({ auth: { apiKey: "sk-ambiguous" } }),
						}),
						"api_key",
					),
			},
			{
				code: "KindUnsupportedForProvider",
				run: () =>
					resolveCredentialForPrint(
						anthropic,
						runtimeStub({
							credentials: [{ providerId: "anthropic", type: "oauth" }],
							getAuth: async () => ({ auth: { apiKey: "token-value" } }),
						}),
						"api_key",
					),
			},
			{
				code: "RefreshFailed",
				run: () =>
					resolveCredentialForPrint(anthropic, oauthFailure("OAuth refresh failed for anthropic"), "bearer_token"),
			},
			{
				code: "MinValidityUnreachable",
				run: () =>
					resolveCredentialForPrint(
						anthropic,
						oauthFailure("OAuth refresh returned a token that expires too soon for anthropic"),
						"bearer_token",
					),
			},
			{
				code: "OAuthUnavailable",
				run: () =>
					resolveCredentialForPrint(
						anthropic,
						oauthFailure("OAuth auth derivation failed for anthropic"),
						"bearer_token",
					),
			},
			{
				code: "CredentialNotEmitted",
				// The write call itself throws, which is the only payload failure that
				// happens before a byte can leave. A callback error after the stream
				// took the chunk is not this, and is covered separately below.
				onSubmit: (text) => (text.length > 0 ? new Error("stdout destroyed before the write") : undefined),
				run: () => emitCredential(new Secret("sk-not-emitted"), undefined),
			},
			{
				code: "CredentialTruncated",
				// The stream flushed a fragment and then failed. Those bytes cannot be
				// recalled, so this is the one code whose stdout is not empty.
				onWrite: (text) => (text.length > 0 ? new Error("EPIPE after a partial flush") : undefined),
				flushedOnCallbackError: 3,
				run: () => emitCredential(new Secret("sk-truncated-value"), undefined),
			},
		];

		// The reviewed taxonomy, restated so a new member is a failure here
		// rather than an unexamined exit code.
		expect(EXIT_CODES).toEqual({
			Usage: 1,
			NoCredentialConfigured: 2,
			ProviderAmbiguous: 3,
			KindUnsupportedForProvider: 4,
			RefreshFailed: 5,
			MinValidityUnreachable: 6,
			OAuthUnavailable: 7,
			CredentialNotEmitted: 8,
			CredentialTruncated: 9,
		});

		const nonZero = Object.entries(EXIT_CODES).filter(([, exitCode]) => exitCode !== 0);
		expect(cases.map(({ code }) => code).sort()).toEqual(nonZero.map(([code]) => code).sort());
		// Exactly one code is allowed to leave bytes behind, and it is the one whose
		// whole purpose is reporting that they escaped.
		expect([...STDOUT_EMPTY_ON_EXIT].sort()).toEqual(
			Object.keys(EXIT_CODES)
				.filter((code) => code !== "CredentialTruncated")
				.sort(),
		);

		for (const { code, onWrite, onSubmit, flushedOnCallbackError, run } of cases) {
			await withStubbedStdout(
				onWrite ?? (() => undefined),
				async (written) => {
					const failure = await Promise.resolve()
						.then(run)
						.then(
							() => undefined,
							(error: unknown) => error as CredentialPrintError,
						);

					expect(failure, `${code} did not fail`).toBeInstanceOf(CredentialPrintError);
					expect(failure?.code).toBe(code);
					expect(failure?.exitCode).toBe(EXIT_CODES[code]);
					if (STDOUT_EMPTY_ON_EXIT.has(code)) {
						// The invariant these codes promise: nothing reached stdout.
						expect(written, `${code} wrote to stdout`).toEqual([]);
					} else {
						// And the one that cannot: it reports bytes that already left.
						expect(written.join(""), `${code} claimed a truncation with nothing written`).not.toBe("");
					}
				},
				{
					...(onSubmit ? { onSubmit } : {}),
					...(flushedOnCallbackError !== undefined ? { flushedOnCallbackError } : {}),
				},
			);
		}
	});

	/**
	 * The help text is the contract a caller automates against, so it has to name
	 * every exit code the door can actually produce. Exit 9 shipped documented
	 * only in the source: `atomic auth --help` stopped at 8 and still promised an
	 * empty stdout on every failure, so a caller reading it had no way to know a
	 * truncated credential can reach stdout and must be discarded.
	 */
	it("documents every exit code it can produce, and the one that leaves bytes behind", () => {
		const lines: string[] = [];
		const originalError = console.error;
		console.error = (text: string) => {
			lines.push(text);
		};
		try {
			printAuthCommandHelp();
		} finally {
			console.error = originalError;
		}

		const help = lines.join("\n");
		const documented = new Set([...help.matchAll(/^ {2}(\d+) {2}\S/gmu)].map(([, code]) => Number(code)));

		// 0 is success, which the help lists alongside the failures.
		expect([...documented].sort((a, b) => a - b)).toEqual([0, ...Object.values(EXIT_CODES)].sort((a, b) => a - b));

		// And the promise the taxonomy actually keeps: empty stdout on every
		// failure except the one whose purpose is reporting that it could not be.
		expect(help).not.toContain("stdout stays empty on\nany failure");
		expect(help).toContain(`stdout holds an unusable`);
	});

	it("reports a payload write that never reached the stream, with nothing emitted", async () => {
		await withStubbedStdout(
			() => undefined,
			async (written) => {
				const failure = await emitCredential(new Secret("sk-y"), undefined).then(
					() => undefined,
					(error: unknown) => error as CredentialPrintError,
				);

				expect(written).toEqual([]);
				expect(failure?.code).toBe("CredentialNotEmitted");
				expect(toCredentialPrintError(failure).exitCode).toBe(8);
			},
			{ onSubmit: (text) => (text.length > 0 ? new Error("stdout destroyed before the write") : undefined) },
		);
	});

	it("never exits non-zero over a payload the stream already accepted", async () => {
		// A pipe can flush part or all of the payload and only then report EPIPE.
		// Treating that callback error as "nothing was emitted" produced exit 8
		// with the credential on stdout — the one thing this door must never do.
		const reported: string[] = [];
		const originalConsoleError = console.error;
		console.error = ((...parts: unknown[]) => {
			reported.push(parts.map(String).join(" "));
		}) as typeof console.error;
		const originalExitCode = process.exitCode;
		process.exitCode = undefined;

		try {
			await withStubbedStdout(
				(text) => (text.length > 0 ? new Error("EPIPE after the payload was flushed") : undefined),
				async (written) => {
					await expect(emitCredential(new Secret("sk-flushed"), undefined)).resolves.toBeUndefined();

					expect(written).toEqual(["sk-flushed\n"]);
					expect(process.exitCode ?? 0).toBe(0);
					expect(reported.join("\n")).toContain("did not complete cleanly");
					expect(reported.join("\n")).not.toContain("sk-flushed");
				},
				{ emitOnCallbackError: true },
			);
		} finally {
			console.error = originalConsoleError;
			process.exitCode = originalExitCode;
		}
	});

	it("an accepted write that emitted nothing is still exit 8, not a silent success", async () => {
		// The other half of the same ambiguity: stdout can take the chunk into its
		// buffer and report EPIPE before any byte reaches the OS. Treating an
		// accepted write as success would hand the caller exit 0 and an empty
		// stream — a successful export of nothing — which is the mirror of the
		// non-zero-with-bytes failure the emitted case avoids. `bytesWritten` is
		// what tells them apart: here it never moves.
		await withStubbedStdout(
			(text) => (text.length > 0 ? new Error("EPIPE before any byte was flushed") : undefined),
			async (written) => {
				const failure = await emitCredential(new Secret("sk-buffered"), undefined).then(
					() => undefined,
					(error: unknown) => error as CredentialPrintError,
				);

				expect(written).toEqual([]);
				expect(failure?.code).toBe("CredentialNotEmitted");
				expect(toCredentialPrintError(failure).exitCode).toBe(8);
			},
		);
	});
});

describe("auth command parsing", () => {
	it("treats bare auth and its help flags as help", () => {
		for (const argv of [["auth"], ["auth", "help"], ["auth", "--help"], ["auth", "-h"]]) {
			expect(isAuthCommandHelp(argv)).toBe(true);
		}
		expect(isAuthCommandHelp(["auth", "check", "--help"])).toBe(true);
		expect(isAuthCommandHelp(["auth", "check", "--", "--help"])).toBe(false);
		expect(isAuthCommandHelp(["auth", "print-api-key"])).toBe(false);
		expect(isAuthCommandHelp(["auth", "print-api-key", "--help"])).toBe(false);
		expect(isAuthCommandHelp(["config"])).toBe(false);
	});

	it("ignores argv it does not own", () => {
		expect(parseAuthCommand(["--model", "gpt-5.5"])).toBeUndefined();
		expect(parseAuthCommand([])).toBeUndefined();
	});

	it("names every auth subcommand when the command is unknown", () => {
		try {
			parseAuthCommand(["auth", "print-everything"]);
			expect.unreachable("expected a usage error");
		} catch (error) {
			expect(error).toBeInstanceOf(AuthCommandError);
			const failure = error as AuthCommandError;
			expect(failure.exitCode).toBe(1);
			expect(failure.message).toContain("atomic auth print-api-key");
			expect(failure.message).toContain("atomic auth print-bearer-token");
			expect(failure.message).toContain("atomic auth check");
			// Branding seam: upstream's help says `pi`.
			expect(failure.message).not.toContain("pi auth");
		}
	});

	it("keeps parse-time exit codes with their auth subcommand", () => {
		try {
			parseAuthCommand(["auth", "check", "--min-expiry", "30m"]);
			expect.unreachable("expected a usage error");
		} catch (error) {
			expect(error).toBeInstanceOf(AuthCommandError);
			expect((error as AuthCommandError).exitCode).toBe(2);
		}
	});

	it("rejects --min-expiry for print-api-key in every position", () => {
		for (const spelling of [
			["--min-expiry", "30m"],
			["--min-expiry=30m"],
			["--", "--min-expiry", "30m"],
			["--", "--min-expiry=30m"],
		]) {
			try {
				parseAuthCommand(["auth", "print-api-key", "--model", "gpt-5.5", ...spelling]);
				expect.unreachable("expected a usage error");
			} catch (error) {
				expect(error).toBeInstanceOf(AuthCommandError);
				const failure = error as AuthCommandError;
				expect(failure.exitCode).toBe(1);
				expect(failure.message).toContain("only supported by print-bearer-token");
			}
		}
	});

	it("accepts ms, s, m, and h durations and rejects anything else", () => {
		const parse = (value: string) =>
			parseAuthCommand(["auth", "print-bearer-token", "--min-expiry", value])?.minExpiryMs;

		expect(parse("500ms")).toBe(500);
		expect(parse("45s")).toBe(45_000);
		expect(parse("30m")).toBe(1_800_000);
		expect(parse("2h")).toBe(7_200_000);

		for (const bad of ["30", "m", "-5m", "30 minutes", "1d"]) {
			expect(() => parse(bad)).toThrow("duration such as 30m or 1h");
		}
		expect(() => parseAuthCommand(["auth", "print-bearer-token", "--min-expiry"])).toThrow();
	});

	it("keeps the remaining flags for the ordinary parser", () => {
		const command = parseAuthCommand([
			"auth",
			"print-bearer-token",
			"--model",
			"gpt-5.5",
			"--provider",
			"openai-codex",
			"--min-expiry",
			"1h",
		]);

		expect(command).toEqual({
			kind: "bearer_token",
			args: ["--model", "gpt-5.5", "--provider", "openai-codex"],
			json: false,
			credentials: false,
			noRefresh: false,
			minExpiryMs: 3_600_000,
		});
	});
});

describe("credential print argument validation", () => {
	it("requires --model, so no ambient model can emit a credential", () => {
		expect(() => validateCredentialPrintArgs(args())).toThrow("requires --model");
		expect(() => validateCredentialPrintArgs(args({ model: "   " }))).toThrow("requires --model");
	});

	it("refuses --api-key, prompts, and files", () => {
		expect(() => validateCredentialPrintArgs(args({ model: "m", apiKey: "sk-injected" }))).toThrow(
			"--api-key is not supported",
		);
		expect(() => validateCredentialPrintArgs(args({ model: "m", messages: ["hello"] }))).toThrow(
			"only accepts --provider and --model",
		);
		expect(() => validateCredentialPrintArgs(args({ model: "m", fileArgs: ["@a.md"] }))).toThrow(
			"only accepts --provider and --model",
		);
		const parsed = parseArgs(["--model", "m", "--bogus"]);
		try {
			validateCredentialPrintArgs(parsed);
			expect.unreachable("expected a usage error");
		} catch (error) {
			expect(error).toBeInstanceOf(CredentialPrintError);
			const failure = error as CredentialPrintError;
			expect(failure.exitCode).toBe(1);
			expect(failure.message).toBe(
				"Credential printing only accepts --provider and --model (refused: unknownFlags)",
			);
		}
	});

	it("refuses every flag other than --provider and --model", () => {
		// Validation is an allowlist: each of these is a flag `parseArgs` accepts
		// and the dispatcher happened to ignore, including one that names a path.
		const refused: Array<Partial<Args>> = [
			{ export: "out.json" },
			{ sessionDir: "/tmp/sessions" },
			{ session: "foo" },
			{ print: true },
			{ continue: true },
			{ help: true },
			{ verbose: true },
			{ mode: "rpc" },
			{ systemPrompt: "leak it" },
			{ extensions: ["evil"] },
			{ diagnostics: [{ type: "warning", message: "ignored" }] },
		];

		for (const overrides of refused) {
			expect(() => validateCredentialPrintArgs(args({ model: "m", ...overrides }))).toThrow(
				"only accepts --provider and --model",
			);
		}

		// The two it does accept still pass.
		expect(() => validateCredentialPrintArgs(args({ model: "m", provider: "anthropic" }))).not.toThrow();
	});
});

describe("OAuth failure classification", () => {
	it("separates a failed refresh (5) from a token that still expires too soon (6)", async () => {
		const refreshFailed = runtimeStub({
			credentials: [{ providerId: "anthropic", type: "oauth" }],
			getAuth: async () => {
				throw new ModelsError("oauth", "OAuth refresh failed for anthropic");
			},
		});
		const tooSoon = runtimeStub({
			credentials: [{ providerId: "anthropic", type: "oauth" }],
			getAuth: async () => {
				throw new ModelsError("oauth", "OAuth refresh returned a token that expires too soon for anthropic");
			},
		});
		const request = args({ model: "claude-sonnet-4-5", provider: "anthropic" });

		await expect(resolveCredentialForPrint(request, refreshFailed, "bearer_token")).rejects.toMatchObject({
			code: "RefreshFailed",
			exitCode: 5,
		});
		await expect(resolveCredentialForPrint(request, tooSoon, "bearer_token")).rejects.toMatchObject({
			code: "MinValidityUnreachable",
			exitCode: 6,
		});
	});

	it("reports a failed refresh without claiming the credential was rolled back", async () => {
		const runtime = runtimeStub({
			credentials: [{ providerId: "anthropic", type: "oauth" }],
			getAuth: async () => {
				throw new ModelsError("oauth", "OAuth refresh failed for anthropic");
			},
		});

		await expect(
			resolveCredentialForPrint(
				args({ model: "claude-sonnet-4-5", provider: "anthropic" }),
				runtime,
				"bearer_token",
			),
		).rejects.toThrow("the stored credential was left untouched");
	});

	it("keeps a credential the provider quoted back out of the reported message", async () => {
		// A refresh failure is reported on stderr, and the provider writes that
		// text. Some echo the request they sent or the body they got back, either
		// of which can carry the very value this door keeps off every stream but
		// stdout — so it must not travel in the message a caller prints.
		const OPAQUE = "7f3a91c2d4e6b8a0";
		const quoted: ReadonlyArray<{ readonly text: string; readonly value: string }> = [
			// Shapes that announce themselves, recognised wherever they appear.
			{ text: "Bearer ya29.a0AfB_bykLongLivedAccessTokenValue", value: "ya29.a0AfB_bykLongLivedAccessTokenValue" },
			{
				text: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
				value: "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
			},
			{ text: "sk-live-0123456789abcdefghij", value: "sk-live-0123456789abcdefghij" },
			// Opaque values, which no shape can recognise: reached by the field name
			// they are filed under, in the header, JSON, and query spellings a quoted
			// request or response body uses.
			{ text: `x-api-key: ${OPAQUE}`, value: OPAQUE },
			{ text: `"api_key": "${OPAQUE}"`, value: OPAQUE },
			{ text: `?access_token=${OPAQUE}`, value: OPAQUE },
			{ text: `Authorization: ${OPAQUE}`, value: OPAQUE },
			// An opaque value behind an auth scheme, which neither pass reaches on
			// its own: the shape pass needs the `Bearer` the header pass consumes,
			// and the header pass stops at the space unless it takes the scheme too.
			{ text: `Authorization: Bearer ${OPAQUE}`, value: OPAQUE },
			{ text: `authorization: bearer ${OPAQUE}`, value: OPAQUE },
			{ text: `Authorization: Basic ${OPAQUE}`, value: OPAQUE },
			{ text: `"Authorization": "Bearer ${OPAQUE}"`, value: OPAQUE },
		];

		for (const { text, value } of quoted) {
			const runtime = runtimeStub({
				credentials: [{ providerId: "anthropic", type: "oauth" }],
				getAuth: async () => {
					throw new ModelsError("oauth", `${OAUTH_REFRESH_FAILED_PHRASE} anthropic: rejected ${text}`);
				},
			});

			const failure = await resolveCredentialForPrint(
				args({ model: "claude-sonnet-4-5", provider: "anthropic" }),
				runtime,
				"bearer_token",
			).then(
				() => undefined,
				(error: unknown) => error as CredentialPrintError,
			);

			expect(failure).toBeInstanceOf(CredentialPrintError);
			const reported = failure as CredentialPrintError;
			// Redaction runs after classification, so the 5/6/7 split is unaffected.
			expect(reported.code).toBe("RefreshFailed");
			// The credential itself, not merely the field name it was filed under.
			expect(reported.message, text).not.toContain(value);
			expect(reported.message, text).toContain("[redacted]");
			// The diagnosis survives redaction, so the exit code is still actionable.
			expect(reported.message).toContain(`${OAUTH_REFRESH_FAILED_PHRASE} anthropic`);
			// The unredacted error is still reachable for a debugger, as `cause`,
			// which this door never logs.
			expect((reported.cause as Error).message).toContain(value);
		}
	});

	it("exit 5 claims a rollback only for a real refresh failure", () => {
		const derivationFailed = classifyOAuthFailure(
			new ModelsError("oauth", "OAuth auth derivation failed for anthropic"),
		);

		// Derivation fails after credentials.modify may already have persisted a
		// rotated credential, so it cannot claim the stored one was left alone.
		expect(derivationFailed.message).not.toContain("left untouched");
		expect(derivationFailed.code).toBe("OAuthUnavailable");
		expect(derivationFailed.exitCode).toBe(7);

		const refreshFailed = classifyOAuthFailure(new ModelsError("oauth", "OAuth refresh failed for anthropic"));
		expect(refreshFailed.exitCode).toBe(5);
		expect(refreshFailed.message).toContain("left untouched");

		// The 5/6 split rests on upstream prose. Pin both phrases against the
		// installed build so a rewording fails here instead of collapsing exit 6
		// into exit 5 with a rollback claim nobody verified.
		const resolveSource = readFileSync(installedPiAiResolveJs(), "utf8");
		expect(resolveSource).toContain(OAUTH_REFRESH_FAILED_PHRASE);
		expect(resolveSource).toContain(OAUTH_EXPIRES_TOO_SOON_PHRASE);
	});
});

describe("bearer token extraction", () => {
	it("falls back to the Authorization header when the provider exposes no apiKey", async () => {
		const runtime = runtimeStub({
			credentials: [{ providerId: "anthropic", type: "oauth" }],
			getAuth: async () => ({ auth: { headers: { Authorization: "Bearer header-token-value" } } }),
		});

		const secret = await resolveCredentialForPrint(
			args({ model: "claude-sonnet-4-5", provider: "anthropic" }),
			runtime,
			"bearer_token",
		);

		expect(secret.take()).toBe("header-token-value");
	});
});

describe("provider inference", () => {
	it("resolves a provider whose credential comes from the environment, not auth.json", async () => {
		// openai authenticates from OPENAI_API_KEY: checkAuth reports api_key, but
		// it never appears in listCredentials().
		const runtime = runtimeStub({
			credentials: [],
			providers: ["openai"],
			resolvedAuth: { openai: "api_key" },
			modelId: "gpt-4.1",
			getAuth: async () => ({ auth: { apiKey: "sk-env-openai" } }),
		});

		const secret = await resolveCredentialForPrint(args({ model: "gpt-4.1" }), runtime, "api_key");

		expect(secret.take()).toBe("sk-env-openai");
	});

	it("infers the same credential that naming the provider returns", async () => {
		const stub = () =>
			runtimeStub({
				credentials: [],
				providers: ["openai"],
				resolvedAuth: { openai: "api_key" },
				modelId: "gpt-4.1",
				getAuth: async () => ({ auth: { apiKey: "sk-env-openai" } }),
			});

		const inferred = await resolveCredentialForPrint(args({ model: "gpt-4.1" }), stub(), "api_key");
		const named = await resolveCredentialForPrint(args({ model: "gpt-4.1", provider: "openai" }), stub(), "api_key");

		expect(inferred.take()).toBe(named.take());
	});

	it("passes over an inferred candidate that cannot authenticate", async () => {
		const runtime = runtimeStub({
			credentials: [],
			providers: ["anthropic", "openai"],
			resolvedAuth: { anthropic: "api_key", openai: "api_key" },
			modelId: "shared-model",
			getAuth: async (model) => {
				if (model.provider === "anthropic") throw new Error("no credential for anthropic");
				return { auth: { apiKey: "sk-env-openai" } };
			},
		});

		const secret = await resolveCredentialForPrint(args({ model: "shared-model" }), runtime, "api_key");

		// One candidate failing means "not this one", not a failed request: the
		// provider that can authenticate still answers.
		expect(secret.take()).toBe("sk-env-openai");
	});

	it("reports an inferred OAuth failure by its own exit code when nothing else answers", async () => {
		// Two candidates, both OAuth, both failing. Skipping the first must not
		// throw away why it failed: exit 6 is the answer, not a generic exit 2.
		const runtime = runtimeStub({
			credentials: [],
			providers: ["anthropic", "openai-codex"],
			resolvedAuth: { anthropic: "oauth", "openai-codex": "oauth" },
			modelId: "shared-model",
			getAuth: async (model) => {
				if (model.provider === "anthropic") {
					throw new ModelsError("oauth", "refreshed token expires too soon for anthropic");
				}
				throw new ModelsError("oauth", "refresh failed for openai-codex");
			},
		});

		await expect(
			resolveCredentialForPrint(args({ model: "shared-model" }), runtime, "bearer_token"),
		).rejects.toMatchObject({ code: "MinValidityUnreachable", exitCode: 6 });
	});

	it("prefers a working credential over an inferred candidate's OAuth failure", async () => {
		const runtime = runtimeStub({
			credentials: [],
			providers: ["anthropic", "openai-codex"],
			resolvedAuth: { anthropic: "oauth", "openai-codex": "oauth" },
			modelId: "shared-model",
			getAuth: async (model) => {
				if (model.provider === "anthropic") throw new ModelsError("oauth", "refresh failed for anthropic");
				return { auth: { headers: { Authorization: "Bearer codex-token" } } };
			},
		});

		const secret = await resolveCredentialForPrint(args({ model: "shared-model" }), runtime, "bearer_token");

		expect(secret.take()).toBe("codex-token");
	});

	it("still reports the failure, with its exit code, when the caller named the provider", async () => {
		const runtime = runtimeStub({
			credentials: [],
			providers: ["anthropic"],
			getAuth: async () => {
				throw new Error("no credential for anthropic");
			},
		});

		await expect(
			resolveCredentialForPrint(args({ model: "claude-sonnet-4-5", provider: "anthropic" }), runtime, "api_key"),
		).rejects.toMatchObject({ code: "NoCredentialConfigured", exitCode: 2 });
	});

	it("keeps an OAuth-only provider out of an inferred API-key request", async () => {
		const runtime = runtimeStub({
			credentials: [{ providerId: "anthropic", type: "oauth" }],
			providers: ["anthropic"],
			getAuth: async () => ({ auth: { apiKey: "should-not-be-reached" } }),
		});

		await expect(
			resolveCredentialForPrint(args({ model: "claude-sonnet-4-5" }), runtime, "api_key"),
		).rejects.toMatchObject({ code: "NoCredentialConfigured", exitCode: 2 });
	});

	it("exports an OAuth bearer token the provider resolves without persisting it", async () => {
		// A custom resolver or environment-supplied OAuth credential: checkAuth
		// reports oauth, but auth.json holds nothing for it.
		const runtime = runtimeStub({
			credentials: [],
			providers: ["custom-oauth"],
			resolvedAuth: { "custom-oauth": "oauth" },
			modelId: "custom-model",
			getAuth: async () => ({ auth: { headers: { Authorization: "Bearer resolved-token-value" } } }),
		});

		const secret = await resolveCredentialForPrint(args({ model: "custom-model" }), runtime, "bearer_token");

		expect(secret.take()).toBe("resolved-token-value");
	});

	it("never prints an environment API key as a bearer token", async () => {
		// openai sends `Authorization: Bearer <api key>`, so the header cannot be
		// what decides. checkAuth reporting api_key is what refuses it.
		const runtime = runtimeStub({
			credentials: [],
			providers: ["openai"],
			resolvedAuth: { openai: "api_key" },
			modelId: "gpt-4.1",
			getAuth: async () => ({
				auth: { apiKey: "sk-env-openai", headers: { Authorization: "Bearer sk-env-openai" } },
			}),
		});

		await expect(
			resolveCredentialForPrint(args({ model: "gpt-4.1" }), runtime, "bearer_token"),
		).rejects.toMatchObject({ code: "NoCredentialConfigured", exitCode: 2 });

		// The same credential is still exportable as what it actually is.
		const asKey = await resolveCredentialForPrint(args({ model: "gpt-4.1" }), runtime, "api_key");
		expect(asKey.take()).toBe("sk-env-openai");
	});

	it("resolves a dual-auth provider by the credential in force, not by its capability", async () => {
		// anthropic offers both. With ANTHROPIC_API_KEY set and nothing persisted,
		// checkAuth reports api_key — and getAuth would hand back that key under an
		// Authorization: Bearer header if asked, so capability alone would have
		// exported an API key through the bearer-token interface.
		const runtime = runtimeStub({
			credentials: [],
			providers: ["anthropic"],
			resolvedAuth: { anthropic: "api_key" },
			getAuth: async () => ({
				auth: { apiKey: "sk-ant-env", headers: { Authorization: "Bearer sk-ant-env" } },
			}),
		});

		await expect(
			resolveCredentialForPrint(args({ model: "claude-sonnet-4-5" }), runtime, "bearer_token"),
		).rejects.toMatchObject({ code: "NoCredentialConfigured", exitCode: 2 });

		const asKey = await resolveCredentialForPrint(args({ model: "claude-sonnet-4-5" }), runtime, "api_key");
		expect(asKey.take()).toBe("sk-ant-env");
	});

	it("exports the OAuth token when the same dual-auth provider resolves to OAuth", async () => {
		const runtime = runtimeStub({
			credentials: [],
			providers: ["anthropic"],
			resolvedAuth: { anthropic: "oauth" },
			getAuth: async () => ({ auth: { headers: { Authorization: "Bearer oauth-token-value" } } }),
		});

		const secret = await resolveCredentialForPrint(args({ model: "claude-sonnet-4-5" }), runtime, "bearer_token");

		expect(secret.take()).toBe("oauth-token-value");
	});
});

describe("provider selection", () => {
	it("refuses to guess between configured providers and names the candidates (exit 3)", async () => {
		const runtime = runtimeStub({
			credentials: [
				{ providerId: "anthropic", type: "api_key" },
				{ providerId: "openai", type: "api_key" },
			],
			getAuth: async () => ({ auth: { apiKey: "sk-ambiguous" } }),
		});

		const failure = await resolveCredentialForPrint(args({ model: "claude-sonnet-4-5" }), runtime, "api_key").then(
			() => undefined,
			(error: unknown) => error as CredentialPrintError,
		);

		expect(failure?.code).toBe("ProviderAmbiguous");
		expect(failure?.exitCode).toBe(3);
		// Listing the candidates is the point: the caller has to be told which
		// --provider values would resolve.
		expect(failure?.message).toContain("anthropic");
		expect(failure?.message).toContain("openai");
		expect(failure?.message).not.toContain("sk-ambiguous");

		// Naming one of them resolves it.
		const secret = await resolveCredentialForPrint(
			args({ model: "claude-sonnet-4-5", provider: "openai" }),
			runtime,
			"api_key",
		);
		expect(secret.take()).toBe("sk-ambiguous");
	});
});

describe("bearer token minimum validity", () => {
	it("requests 30m of remaining life by default and passes --min-expiry through", async () => {
		const requested: Array<number | undefined> = [];
		const runtime = runtimeStub({
			credentials: [{ providerId: "anthropic", type: "oauth" }],
			getAuth: async (_model, overrides) => {
				requested.push(overrides?.minOAuthValidityMs);
				return { auth: { apiKey: "token-value" } };
			},
		});
		const request = args({ model: "claude-sonnet-4-5", provider: "anthropic" });

		expect(DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS).toBe(30 * 60_000);
		await resolveCredentialForPrint(request, runtime, "bearer_token");
		await resolveCredentialForPrint(request, runtime, "bearer_token", 60_000);

		expect(requested).toEqual([DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS, 60_000]);
	});

	it("never asks an API key for a validity window it cannot have", async () => {
		const requested: Array<{ minOAuthValidityMs?: number } | undefined> = [];
		const runtime = runtimeStub({
			credentials: [{ providerId: "anthropic", type: "api_key" }],
			getAuth: async (_model, overrides) => {
				requested.push(overrides);
				return { auth: { apiKey: "sk-ant-value" } };
			},
		});

		await resolveCredentialForPrint(args({ model: "claude-sonnet-4-5", provider: "anthropic" }), runtime, "api_key");

		expect(requested).toEqual([{}]);
	});
});

describe("atomic auth on the wire", () => {
	it(
		"writes the API key alone on stdout with one trailing newline",
		async () => {
			const agentDir = agentDirWith({ anthropic: { type: "api_key", key: "sk-ant-print-me" } });

			const result = await runCliProcess(
				["auth", "print-api-key", "--model", "claude-sonnet-4-5", "--provider", "anthropic"],
				{ cwd: agentDir, env: cliEnv(agentDir) },
			);

			expect(result.code).toBe(0);

			expect(result.stdout).toBe("sk-ant-print-me\n");
			expect(result.stderr).toBe("");
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"reports readiness without exposing a configured credential",
		async () => {
			const key = "command-backed-auth-key";
			const configuredKey = `!echo ${key}`;
			const agentDir = agentDirWith({ anthropic: { type: "api_key", key: configuredKey } });

			const result = await runCliProcess(["auth", "check", "--provider", "anthropic"], {
				cwd: agentDir,
				env: cliEnv(agentDir),
			});

			expect(result.code).toBe(0);
			expect(result.stdout).toBe("ready\n");
			expect(result.stdout).not.toContain(key);
			expect(result.stderr).not.toContain(key);

			const json = await runCliProcess(["auth", "check", "--provider", "anthropic", "--json"], {
				cwd: agentDir,
				env: cliEnv(agentDir),
			});
			expect(json.code).toBe(0);
			expect(JSON.parse(json.stdout)).toEqual({ status: "ready", provider: "anthropic", authType: "api_key" });
			expect(json.stdout).not.toContain(key);
			expect(json.stderr).not.toContain(key);

			const model = await runCliProcess(["auth", "check", "--model", "claude-opus-4-5", "--no-refresh", "--json"], {
				cwd: agentDir,
				env: cliEnv(agentDir),
			});
			expect(model.code).toBe(0);
			expect(JSON.parse(model.stdout)).toEqual({ status: "ready", provider: "anthropic", authType: "api_key" });
			expect(model.stdout).not.toContain(key);
			expect(model.stderr).not.toContain(key);

			const exported = await runCliProcess(
				["auth", "check", "--provider", "anthropic", "--no-refresh", "--credentials"],
				{
					cwd: agentDir,
					env: cliEnv(agentDir),
				},
			);
			expect(exported.code).toBe(0);
			expect(exported.stdout).toBe(`${key}\n`);
			expect(exported.stdout).not.toContain(configuredKey);
			expect(exported.stderr).not.toContain(key);
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"emits a resolved auth-check credential only when explicitly requested",
		async () => {
			const key = "opaque-auth-check-credential-value";
			const agentDir = agentDirWith({ anthropic: { type: "api_key", key } });
			const run = (argv: string[]) => runCliProcess(argv, { cwd: agentDir, env: cliEnv(agentDir) });

			const defaultCheck = await run(["auth", "check", "--provider", "anthropic", "--json"]);
			expect(defaultCheck.code).toBe(0);
			expect(JSON.parse(defaultCheck.stdout)).toEqual({
				status: "ready",
				provider: "anthropic",
				authType: "api_key",
			});
			expect(defaultCheck.stdout).not.toContain(key);
			expect(defaultCheck.stderr).not.toContain(key);

			const exported = await run(["auth", "check", "--provider", "anthropic", "--credentials"]);
			expect(exported.code).toBe(0);
			expect(exported.stdout).toBe(`${key}\n`);
			expect(exported.stderr).not.toContain(key);

			const json = await run(["auth", "check", "--provider", "anthropic", "--credentials", "--json"]);
			expect(json.code).toBe(0);
			expect(JSON.parse(json.stdout)).toEqual({
				status: "ready",
				provider: "anthropic",
				authType: "api_key",
				credentials: key,
			});
			expect(json.stderr).not.toContain(key);

			const exactModel = await run(["auth", "check", "--model", "anthropic/claude-opus-4-5", "--credentials"]);
			expect(exactModel.code).toBe(0);
			expect(exactModel.stdout).toBe(`${key}\n`);
			expect(exactModel.stderr).not.toContain(key);

			const notReady = await run(["auth", "check", "--provider", "not-installed", "--credentials"]);
			expect(notReady.code).toBe(1);
			expect(notReady.stdout).toBe("");
			expect(notReady.stderr).toContain("not_ready");
			expect(notReady.stderr).not.toContain(key);

			const afterTerminator = await run(["auth", "check", "--provider", "anthropic", "--", "--credentials"]);
			expect(afterTerminator.code).toBe(2);
			expect(afterTerminator.stdout).toBe("");
			expect(afterTerminator.stderr).not.toContain(key);
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"refuses fuzzy model credential export without exposing any configured key",
		async () => {
			const googleKey = "google-fuzzy-export-key";
			const openRouterKey = "openrouter-fuzzy-export-key";
			const agentDir = agentDirWith({
				google: { type: "api_key", key: googleKey },
				openrouter: { type: "api_key", key: openRouterKey },
			});

			const result = await runCliProcess(["auth", "check", "--model", "gemini", "--credentials", "--json"], {
				cwd: agentDir,
				env: cliEnv(agentDir),
			});

			expect(result.code).toBe(2);
			expect(JSON.parse(result.stdout)).toMatchObject({ status: "invalid" });
			for (const stream of [result.stdout, result.stderr]) {
				expect(stream).not.toContain(googleKey);
				expect(stream).not.toContain(openRouterKey);
			}
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"reports expired OAuth credentials as not ready without emitting or rewriting them",
		async () => {
			const access = "expired-auth-check-access";
			const refresh = "expired-auth-check-refresh";
			const agentDir = agentDirWith({
				anthropic: { type: "oauth", access, refresh, expires: 1 },
			});
			const authPath = join(agentDir, "auth.json");
			const before = readFileSync(authPath, "utf8");
			const run = (argv: string[]) => runCliProcess(argv, { cwd: agentDir, env: cliEnv(agentDir) });

			const noRefresh = await run(["auth", "check", "--provider", "anthropic", "--no-refresh", "--json"]);
			expect(noRefresh.code).toBe(1);
			expect(JSON.parse(noRefresh.stdout)).toEqual({
				status: "not_ready",
				provider: "anthropic",
				reason: "credential_expired",
			});

			const refreshed = await run(["auth", "check", "--provider", "anthropic", "--json"]);
			expect(refreshed.code).toBe(1);
			expect(JSON.parse(refreshed.stdout)).toEqual({
				status: "not_ready",
				provider: "anthropic",
				reason: "credential_not_available",
			});
			for (const result of [noRefresh, refreshed]) {
				expect(result.stdout).not.toContain(access);
				expect(result.stdout).not.toContain(refresh);
				expect(result.stderr).not.toContain(access);
				expect(result.stderr).not.toContain(refresh);
			}
			expect(readFileSync(authPath, "utf8")).toBe(before);
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"does not export an OAuth credential that cannot meet the no-refresh safety window",
		async () => {
			const access = "short-lived-auth-check-access";
			const refresh = "short-lived-auth-check-refresh";
			const agentDir = agentDirWith({
				anthropic: { type: "oauth", access, refresh, expires: Date.now() + 10 * 60_000 },
			});
			const run = (argv: string[]) => runCliProcess(argv, { cwd: agentDir, env: cliEnv(agentDir) });

			const raw = await run(["auth", "check", "--provider", "anthropic", "--credentials", "--no-refresh"]);
			expect(raw.code).toBe(1);
			expect(raw.stdout).toBe("");
			expect(raw.stderr).toContain("not_ready");

			const json = await run([
				"auth",
				"check",
				"--provider",
				"anthropic",
				"--credentials",
				"--no-refresh",
				"--json",
			]);
			expect(json.code).toBe(1);
			expect(JSON.parse(json.stdout)).toEqual({
				status: "not_ready",
				provider: "anthropic",
				reason: "credential_not_available",
			});
			for (const stream of [raw.stdout, raw.stderr, json.stdout, json.stderr]) {
				expect(stream).not.toContain(access);
				expect(stream).not.toContain(refresh);
			}
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"distinguishes unavailable providers from invalid readiness commands",
		async () => {
			const agentDir = agentDirWith({ anthropic: { type: "api_key", key: "sk-auth-check-status" } });
			const run = (argv: string[]) => runCliProcess(argv, { cwd: agentDir, env: cliEnv(agentDir) });

			const missingTarget = await run(["auth", "check"]);
			expect(missingTarget.code).toBe(2);
			expect(missingTarget.stdout).toBe("");
			expect(missingTarget.stderr).toContain("Auth checks require --provider <provider> or --model <model>");

			const unavailable = await run(["auth", "check", "--provider", "not-installed"]);
			expect(unavailable.code).toBe(1);
			expect(unavailable.stdout).toBe("not_ready\n");

			const unknownModel = await run(["auth", "check", "--model", "does-not-exist-auth-check"]);
			expect(unknownModel.stderr).toContain('Model "does-not-exist-auth-check" not found.');
			expect(unknownModel.code).toBe(2);
			expect(unknownModel.stdout).toBe("invalid\n");

			const unknownModelJson = await run(["auth", "check", "--model", "does-not-exist-auth-check", "--json"]);
			expect(unknownModelJson.code).toBe(2);
			expect(JSON.parse(unknownModelJson.stdout)).toEqual({ status: "invalid", reason: "invalid_state" });

			const unknownOption = await run(["auth", "check", "--provider", "anthropic", "--bogus"]);
			expect(unknownOption.code).toBe(2);
			expect(unknownOption.stdout).toBe("");
			expect(unknownOption.stderr).toContain('Unknown option --bogus for "auth check".');
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"a reader that closes the pipe never yields a non-zero exit with a credential on stdout",
		async () => {
			const key = "sk-ant-print-me";
			const agentDir = agentDirWith({ anthropic: { type: "api_key", key } });

			// A genuine race, so run it more than once: the child can lose the
			// pipe before its write, during it, or after the bytes are already
			// buffered, and the invariant has to hold on every outcome.
			for (let attempt = 0; attempt < 3; attempt++) {
				const result = await runCliWithClosedStdout(
					["auth", "print-api-key", "--model", "claude-sonnet-4-5", "--provider", "anthropic"],
					{ cwd: agentDir, env: cliEnv(agentDir) },
				);

				// Bytes on stdout mean the command succeeded.
				if (result.stdout.length > 0) expect(result.code).toBe(0);

				// And the other direction: a non-zero exit carries no part of the
				// configured key, not even its first character.
				if (result.code !== 0) {
					expect(result.stdout).toBe("");
					for (let length = 1; length <= key.length; length++) {
						expect(result.stdout).not.toContain(key.slice(0, length));
					}
				}
			}
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"a failed auth-check credential write never falls back to readiness output",
		async () => {
			const key = "sk-ant-print-me";
			const agentDir = agentDirWith({ anthropic: { type: "api_key", key } });

			// A genuine race, so run it more than once: the child can lose the
			// pipe before its write, during it, or after the bytes are already
			// buffered, and the invariant has to hold on every outcome.
			for (let attempt = 0; attempt < 3; attempt++) {
				const result = await runCliWithClosedStdout(["auth", "check", "--provider", "anthropic", "--credentials"], {
					cwd: agentDir,
					env: cliEnv(agentDir),
				});

				// Bytes on stdout mean the command succeeded.
				if (result.stdout.length > 0) expect(result.code).toBe(0);

				// And the other direction: a non-zero exit carries no part of the
				// configured key, not even its first character.
				if (result.code !== 0) {
					expect(result.stdout).toBe("");
					for (let length = 1; length <= key.length; length++) {
						expect(result.stdout).not.toContain(key.slice(0, length));
					}
				}
			}
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"keeps stdout empty and uses a distinct exit code on every failure",
		async () => {
			const agentDir = agentDirWith({ anthropic: { type: "api_key", key: "sk-ant-print-me" } });
			const run = (argv: string[]) => runCliProcess(argv, { cwd: agentDir, env: cliEnv(agentDir) });

			const unknownSubcommand = await run(["auth", "print-everything"]);
			expect(unknownSubcommand.code).toBe(1);

			const missingModel = await run(["auth", "print-api-key"]);
			expect(missingModel.code).toBe(1);

			const minExpiryOnApiKey = await run([
				"auth",
				"print-api-key",
				"--model",
				"claude-sonnet-4-5",
				"--min-expiry",
				"30m",
			]);
			expect(minExpiryOnApiKey.code).toBe(1);

			const helpFlag = await run(["auth", "print-api-key", "--model", "claude-sonnet-4-5", "--help"]);
			expect(helpFlag.code).toBe(1);

			const noCredential = await run(["auth", "print-api-key", "--model", "not-a-real-model"]);
			expect(noCredential.code).toBe(2);

			const wrongKind = await run([
				"auth",
				"print-bearer-token",
				"--model",
				"claude-sonnet-4-5",
				"--provider",
				"anthropic",
			]);
			expect(wrongKind.code).toBe(4);

			for (const result of [unknownSubcommand, missingModel, minExpiryOnApiKey, helpFlag, noCredential, wrongKind]) {
				expect(result.stdout).toBe("");
				expect(result.stderr).not.toContain("sk-ant-print-me");
			}
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"leaves the stored credential untouched when an OAuth refresh fails",
		async () => {
			const credentials = {
				anthropic: { type: "oauth", access: "OLD-ACCESS", refresh: "BOGUS-REFRESH", expires: 1 },
			};
			const agentDir = agentDirWith(credentials);
			const authPath = join(agentDir, "auth.json");
			const before = readFileSync(authPath, "utf8");

			const result = await runCliProcess(
				["auth", "print-bearer-token", "--model", "claude-sonnet-4-5", "--provider", "anthropic"],
				{ cwd: agentDir, env: cliEnv(agentDir) },
			);

			expect(result.code).toBe(5);
			expect(result.stdout).toBe("");
			// The invalid_grant stranding class: a failed refresh must not clear or
			// rewrite the credential the user still owns.
			expect(readFileSync(authPath, "utf8")).toBe(before);
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"renders help under the atomic name and keeps it off the credential stream",
		async () => {
			const agentDir = agentDirWith({});

			for (const argv of [["auth"], ["auth", "--help"], ["auth", "check", "--help"]]) {
				const result = await runCliProcess(argv, { cwd: agentDir, env: cliEnv(agentDir) });

				expect(result.code).toBe(0);
				expect(result.stderr).toContain("atomic auth print-api-key");
				expect(result.stderr).toContain("atomic auth print-bearer-token");
				expect(result.stderr).toContain("atomic auth check");
				expect(result.stderr).toContain("Auth checks require");
				expect(result.stderr).toContain("--credentials");
				expect(result.stderr).not.toContain("pi auth");
				// stdout for this command family is a credential or nothing.
				expect(result.stdout).toBe("");
			}
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"both subcommands refuse to run without --model",
		async () => {
			const agentDir = agentDirWith({ anthropic: { type: "api_key", key: "sk-ant-print-me" } });

			for (const subcommand of ["print-api-key", "print-bearer-token"]) {
				const result = await runCliProcess(["auth", subcommand, "--provider", "anthropic"], {
					cwd: agentDir,
					env: cliEnv(agentDir),
				});

				expect(result.code).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("requires --model");
			}
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"--min-expiry is a usage error for print-api-key in every spelling, including after --",
		async () => {
			const agentDir = agentDirWith({ anthropic: { type: "api_key", key: "sk-ant-print-me" } });

			for (const spelling of [
				["--min-expiry", "30m"],
				["--min-expiry=30m"],
				// It remains an auth option after -- rather than becoming a prompt.
				["--", "--min-expiry=30m"],
			]) {
				const result = await runCliProcess(
					["auth", "print-api-key", "--model", "claude-sonnet-4-5", "--provider", "anthropic", ...spelling],
					{ cwd: agentDir, env: cliEnv(agentDir) },
				);

				expect(result.code).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("--min-expiry is only supported by print-bearer-token");
			}

			// The same two spellings must actually reach the provider on the
			// subcommand that owns the option, rather than being dropped as an
			// unknown flag.
			const requested: Array<number | undefined> = [];
			const runtime = runtimeStub({
				credentials: [{ providerId: "anthropic", type: "oauth" }],
				getAuth: async (_model, overrides) => {
					requested.push(overrides?.minOAuthValidityMs);
					return { auth: { apiKey: "token-value" } };
				},
			});
			for (const spelling of [["--min-expiry", "30m"], ["--min-expiry=30m"]]) {
				const command = parseAuthCommand(["auth", "print-bearer-token", ...spelling]);
				await resolveCredentialForPrint(
					args({ model: "claude-sonnet-4-5", provider: "anthropic" }),
					runtime,
					"bearer_token",
					command?.minExpiryMs,
				);
			}

			expect(requested).toEqual([1_800_000, 1_800_000]);
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);

	it(
		"stdout stays empty on the ambiguity and minimum-validity exits",
		async () => {
			const agentDir = agentDirWith({
				anthropic: { type: "api_key", key: "sk-ant-print-me" },
				opencode: { type: "api_key", key: "sk-oc-print-me" },
			});

			const ambiguous = await runCliProcess(["auth", "print-api-key", "--model", "claude-sonnet-4-5"], {
				cwd: agentDir,
				env: cliEnv(agentDir),
			});

			expect(ambiguous.code).toBe(3);
			expect(ambiguous.stdout).toBe("");
			expect(ambiguous.stderr).toContain("anthropic");
			expect(ambiguous.stderr).toContain("opencode");

			// Exit 6 needs a provider that refreshes and still mints a short token.
			// No builtin provider can be driven into that state without a live
			// OAuth server, so it is stubbed — but stdout is still the process's
			// own fd 1, captured around the call.
			const runtime = runtimeStub({
				credentials: [{ providerId: "anthropic", type: "oauth" }],
				getAuth: async () => {
					throw new ModelsError("oauth", "OAuth refresh returned a token that expires too soon for anthropic");
				},
			});
			const original = process.stdout.write;
			const stdout: string[] = [];
			process.stdout.write = ((chunk: string | Uint8Array): boolean => {
				stdout.push(String(chunk));
				return true;
			}) as typeof process.stdout.write;
			let failure: CredentialPrintError | undefined;
			try {
				failure = await resolveCredentialForPrint(
					args({ model: "claude-sonnet-4-5", provider: "anthropic" }),
					runtime,
					"bearer_token",
					45 * 60_000,
				).then(
					() => undefined,
					(error: unknown) => error as CredentialPrintError,
				);
			} finally {
				process.stdout.write = original;
			}

			expect(failure?.exitCode).toBe(6);
			expect(stdout.join("")).toBe("");
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);
});

/**
 * The chokepoint claim, checked against the whole source tree rather than
 * asserted in a comment: `src/cli/credential-print.ts` is the only module in
 * `packages/coding-agent/src` that writes a credential to stdout.
 *
 * The scan enumerates what reaches the real stdout rather than searching for
 * words that look like credentials. A name-based filter measured spelling, not
 * data flow: it was blind to `writeRawStdout(serializeRpcOutputRecord(record))`,
 * whose payload is a helper call, so `writeRawStdout(\`${key}\n\`)` could have
 * been added with the suite still green. Every data-bearing write to the real
 * stdout is listed below, and `the scan reports a planted second egress` is the
 * negative control that fails if the scanner goes blind again.
 */
describe("credential egress chokepoint", () => {
	const SRC_ROOT = resolve(import.meta.dirname, "..", "src");
	const RPC_TYPES_MODULE = "modes/rpc/rpc-types.ts";
	const EGRESS_MODULE = "cli/credential-print.ts";

	function sourceFiles(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			return entry.isFile() && path.endsWith(".ts") ? [path] : [];
		});
	}

	function withoutComments(source: string): string {
		return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
	}

	/**
	 * Keep code, drop prose: quoted strings disappear and a template literal
	 * keeps only its `${…}` substitutions. Help text that merely *mentions*
	 * `print-api-key` is prose; `${secret.take()}` is data.
	 */
	function codeOnly(text: string): string {
		const stack: string[] = [];
		let out = "";
		for (let index = 0; index < text.length; index++) {
			const char = text[index];
			const state = stack[stack.length - 1];
			const inString = state === "'" || state === '"' || state === "`";
			if (inString && char === "\\") {
				index++;
				continue;
			}
			if (state === "'" || state === '"') {
				if (char === state) stack.pop();
				continue;
			}
			if (state === "`") {
				if (char === "`") stack.pop();
				else if (char === "$" && text[index + 1] === "{") {
					stack.push("$");
					index++;
				}
				continue;
			}
			if (char === "'" || char === '"' || char === "`") {
				stack.push(char);
				continue;
			}
			if (char === "{") stack.push("{");
			else if (char === "}" && (state === "{" || state === "$")) stack.pop();
			out += char;
		}
		return out;
	}

	/** Every function that reaches the real stdout the guard protects. */
	const RAW_STDOUT_WRITER =
		/(?:writeRawStdoutOnce|writeRawStdoutControl|writeRawStdout|process\.stdout\.write)\s*\(/gu;

	/** Console methods that reach stdout when the guard has not taken it over. */
	const CONSOLE_WRITER = /console\.(?:log|info|debug|dir)\s*\(/gu;

	/** Names a credential in code, not a word that appears in help text. */
	const CREDENTIAL_MATERIAL = /secret|credential|api[-_]?key|bearer|access[-_]?token|refresh[-_]?token|\.take\(\)/iu;

	/** Direct and optional property calls that can open a Secret. */
	const DIRECT_SECRET_TAKE = /(?:\?\.|\.)\s*take\s*\(\s*\)/gu;

	/** Literal computed property calls that can open a Secret. */
	const COMPUTED_SECRET_TAKE = /\[\s*(?:"take"|'take')\s*\]\s*\(\s*\)/gu;

	/** The only source locations allowed to open a Secret. */
	const SECRET_TAKE_SITES = [
		`${EGRESS_MODULE}: credentialPayload: .take()`,
		`${EGRESS_MODULE}: credentialPayload: .take()`,
	];

	function callsTo(writer: RegExp, source: string): string[] {
		const calls: string[] = [];
		writer.lastIndex = 0;
		for (let match = writer.exec(source); match; match = writer.exec(source)) {
			// `export function writeRawStdout(text: string)` declares the writer;
			// it does not call it.
			if (source.slice(0, match.index).trimEnd().endsWith("function")) continue;
			let depth = 1;
			let index = match.index + match[0].length;
			while (index < source.length && depth > 0) {
				const char = source[index];
				if (char === "(") depth++;
				else if (char === ")") depth--;
				index++;
			}
			calls.push(source.slice(match.index, index).replace(/\s+/gu, " "));
		}
		return calls;
	}

	const stdoutWrites = (source: string): string[] => callsTo(RAW_STDOUT_WRITER, source);

	/**
	 * True when anything other than a literal reaches stdout. This is the test
	 * the identifier regex could not make: `serializeRpcOutputRecord(record)`
	 * names nothing suspicious and carried a live API key.
	 */
	function carriesData(call: string): boolean {
		const code = codeOnly(call);
		return /[A-Za-z_$]/u.test(code.slice(code.indexOf("(")));
	}

	/**
	 * Every data-bearing write to the real stdout in `src`. A new entry is a new
	 * way for a value to leave the process on the stream a caller captures, and
	 * has to be reviewed here before it ships.
	 */
	const RAW_STDOUT_EGRESS = [
		`cli/credential-print.ts: writeRawStdoutOnce(payload)`,
		`main.ts: writeRawStdout(\`\${output}\\n\`)`,
		`modes/interactive-engine/engine-child-liveness.ts: writeRawStdoutControl(serializeInteractiveEngineMessage({ type: "engine_activity_started", activity }))`,
		`modes/interactive/external-editor.ts: process.stdout.write( \`Launching external editor: \${request.command}\\n\${APP_NAME} will resume when the editor exits.\\n\`, )`,
		`modes/interactive/interactive-process-lifecycle.ts: process.stdout.write(\`\${chalk.dim("To resume this session:")} \${resumeCommand}\\n\`)`,
		`modes/print-mode.ts: writeRawStdout(\`\${JSON.stringify(toJsonEvent(event))}\\n\`)`,
		`modes/print-mode.ts: writeRawStdout(\`\${JSON.stringify(header)}\\n\`)`,
		`modes/print-mode.ts: writeRawStdout(\`\${content.text}\\n\`)`,
		`modes/print-mode.ts: writeRawStdout(\`\${text}\\n\`)`,
		`modes/print-mode.ts: writeRawStdout(\`\${text}\\n\`)`,
		`modes/rpc/rpc-mode.ts: writeRawStdout( serializeInteractiveEngineMessage({ type: "engine_request_accepted", requestId, command }), )`,
		`modes/rpc/rpc-mode.ts: writeRawStdout(serializeInteractiveEngineMessage({ type: "engine_keybindings_reloaded", state }))`,
		`modes/rpc/rpc-output-buffer.ts: writeRawStdout(serializeRpcOutputRecord(record))`,
		`modes/rpc/rpc-output-buffer.ts: writeRawStdout(serializeRpcOutputRecord(record))`,
		`package-manager-cli.ts: process.stdout.write(chalk.dim(\`\${event.message}\\n\`))`,
		`utils/clipboard.ts: process.stdout.write(\`\\x1b]52;c;\${encoded}\\x07\`)`,
	];

	const modules = sourceFiles(SRC_ROOT).map((path) => ({
		path: relative(SRC_ROOT, path).split(/[\\/]/u).join("/"),
		source: withoutComments(readFileSync(path, "utf8")),
	}));

	function scan(candidates: ReadonlyArray<{ path: string; source: string }>): string[] {
		return candidates
			.flatMap(({ path, source }) =>
				stdoutWrites(source)
					.filter(carriesData)
					.map((call) => `${path}: ${call}`),
			)
			.sort();
	}

	function sourceFunctionName(source: string, index: number): string {
		const declarations = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/gu;
		let name = "<module>";
		for (
			let match = declarations.exec(source.slice(0, index));
			match;
			match = declarations.exec(source.slice(0, index))
		) {
			name = match[1] ?? name;
		}
		return name;
	}
	function secretTakeCalls(candidates: ReadonlyArray<{ path: string; source: string }>): string[] {
		const calls: string[] = [];
		for (const { path, source } of candidates) {
			const code = codeOnly(source);
			DIRECT_SECRET_TAKE.lastIndex = 0;
			for (let match = DIRECT_SECRET_TAKE.exec(code); match; match = DIRECT_SECRET_TAKE.exec(code)) {
				calls.push(`${path}: ${sourceFunctionName(code, match.index)}: ${match[0].replace(/\s+/gu, "")}`);
			}
			COMPUTED_SECRET_TAKE.lastIndex = 0;
			for (let match = COMPUTED_SECRET_TAKE.exec(source); match; match = COMPUTED_SECRET_TAKE.exec(source)) {
				calls.push(`${path}: ${sourceFunctionName(source, match.index)}: ${match[0].replace(/\s+/gu, "")}`);
			}
		}
		return calls.sort();
	}

	it("finds the door it is guarding", () => {
		expect(modules.length).toBeGreaterThan(100);
		expect(modules.map(({ path }) => path)).toContain(EGRESS_MODULE);
		expect(modules.map(({ path }) => path)).toContain(RPC_TYPES_MODULE);
	});

	it("writes nothing to the real stdout beyond the enumerated set", () => {
		expect(scan(modules)).toEqual([...RAW_STDOUT_EGRESS].sort());
	});

	it("opens a Secret only at the enumerated source sites", () => {
		expect(secretTakeCalls(modules)).toEqual([...SECRET_TAKE_SITES].sort());
	});

	it("the Secret-opening scan reports direct, optional, and computed third calls", () => {
		const planted = secretTakeCalls([
			{
				path: EGRESS_MODULE,
				source: `
					function credentialPayload(secret: Secret) {
						secret.take();
						secret?.take();
						secret["take"]();
					}
				`,
			},
		]);

		expect(planted).toEqual([
			`${EGRESS_MODULE}: credentialPayload: .take()`,
			`${EGRESS_MODULE}: credentialPayload: ?.take()`,
			`${EGRESS_MODULE}: credentialPayload: ["take"]()`,
		]);
		expect(planted).not.toEqual([...SECRET_TAKE_SITES].sort());
	});

	it("the scan reports a planted second egress", () => {
		// Two shapes the previous identifier-based filter missed. The first spells
		// no credential word; the second hides its payload behind a helper call —
		// which is exactly how a live API key reached stdout through the RPC
		// login response.
		const planted = [
			{ path: "modes/planted-interpolated.ts", source: `writeRawStdout(\`\${key}\\n\`);` },
			{ path: "modes/planted-helper.ts", source: `writeRawStdout(serializeRpcOutputRecord(record));` },
		];

		const reported = scan(planted);

		expect(reported).toHaveLength(2);
		expect(reported).toEqual([
			`modes/planted-helper.ts: writeRawStdout(serializeRpcOutputRecord(record))`,
			`modes/planted-interpolated.ts: writeRawStdout(\`\${key}\\n\`)`,
		]);
		// And neither is in the enumerated set, so planting one in `src` fails the
		// assertion above.
		for (const entry of reported) expect(RAW_STDOUT_EGRESS).not.toContain(entry);
	});

	it("no console path names credential material either", () => {
		// A secondary net over the stdout-capable console methods, which reach the
		// real stream whenever the guard has not taken it over. Name-based, and
		// labelled as such: the enumerated scan above is the structural check.
		const named = modules.flatMap(({ path, source }) =>
			callsTo(CONSOLE_WRITER, source)
				.filter((call) => CREDENTIAL_MATERIAL.test(codeOnly(call)))
				.map((call) => `${path}: ${call}`),
		);

		expect(named).toEqual([]);
	});

	it("no RPC login response carries a credential to stdout", async () => {
		const inputForm = { open: async () => ({ value: "sk-canary" }) };
		const session = {
			scopedModels: [],
			modelRuntime: {
				getProvider: () => ({ auth: { apiKey: {} } }),
				login: async (
					_provider: string,
					_type: string,
					options: { prompt: (prompt: { message: string }) => Promise<string> },
				) => ({ type: "api_key", key: await options.prompt({ message: "API key" }) }),
				getAvailableSnapshot: () => [],
				getOAuthProviderMetadata: () => [],
			},
		} as unknown as AgentSession;

		const result = await new RpcProviderAuth(inputForm).login(session, "anthropic");

		// The host typed the key into its own input form; echoing it back down the
		// stdout pipe would make this response a second egress.
		expect(JSON.stringify(result)).not.toContain("sk-canary");
		expect("credential" in result).toBe(false);
		expect(result).toMatchObject({ provider: "anthropic", cancelled: false, type: "api_key" });
	});

	it("no type reachable from an RPC output record names a credential", () => {
		const source = withoutComments(readFileSync(join(SRC_ROOT, "modes", "rpc", "rpc-types.ts"), "utf8"));
		const declaration = /^export (?:type|interface) (\w+)/gmu;
		const starts: Array<{ name: string; index: number }> = [];
		for (let match = declaration.exec(source); match; match = declaration.exec(source)) {
			starts.push({ name: match[1], index: match.index });
		}

		// Commands and UI responses travel *in* on stdin; a credential member
		// there is the caller handing one over, not this process emitting one.
		const INBOUND = new Set(["RpcCommand", "RpcCommandType", "RpcExtensionUIResponse"]);
		const declared = new Map(
			starts.map(({ name, index }, position) => [
				name,
				source.slice(index, starts[position + 1]?.index ?? source.length),
			]),
		);

		// Guard the guard: a rename must not quietly empty either side.
		for (const name of INBOUND) expect(declared.has(name)).toBe(true);
		expect(declared.has("RpcLoginProviderResult")).toBe(true);
		expect(declared.has("RpcResponse")).toBe(true);

		const responseTypeSource = [...declared]
			.filter(([name]) => !INBOUND.has(name))
			.map(([, body]) => body)
			.join("\n");

		expect(responseTypeSource).not.toMatch(/credential\s*:/u);
	});

	it("is the only module in src that can read a Secret", () => {
		const readers = modules.filter(({ source }) => /\.take\s*\(/u.test(source)).map(({ path }) => path);

		// main.ts holds the Secret and hands it to emitCredential; it cannot open it.
		expect(readers).toEqual([EGRESS_MODULE]);
	});

	it("has no sink other than stdout", () => {
		const source = modules.find(({ path }) => path === EGRESS_MODULE)?.source ?? "";

		for (const sink of ["node:fs", "node:child_process", "clipboard", "--output", "writeFileSync"]) {
			expect(source).not.toContain(sink);
		}
	});
});
