/**
 * `atomic auth print-api-key` / `print-bearer-token` — the credential-export door.
 *
 * Upstream 99e34013, tightened by this repository's design: a typed Secret, one
 * exit code per failure, `--min-expiry` rejected for API keys, and stdout that
 * carries the credential or nothing at all.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { ModelsError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Args } from "../src/cli/args.ts";
import {
	CredentialPrintError,
	isCredentialPrintHelp,
	parseCredentialPrintCommand,
	resolveCredentialForPrint,
	Secret,
	validateCredentialPrintArgs,
} from "../src/cli/credential-print.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { removeTempDirs, runCliProcess } from "./cli-test-helpers.ts";

/**
 * Structural: each case starts a real `atomic` child, so the cost is a process
 * spawn plus a Bun transpile of the CLI graph, not a slow assertion.
 */
const REAL_CLI_SUITE_TIMEOUT_MS = 120_000;

const tempDirs: string[] = [];
afterEach(() => removeTempDirs(tempDirs));

function agentDirWith(credentials: Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-credential-print-"));
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
});

describe("auth command parsing", () => {
	it("treats bare auth and its help flags as help", () => {
		for (const argv of [["auth"], ["auth", "help"], ["auth", "--help"], ["auth", "-h"]]) {
			expect(isCredentialPrintHelp(argv)).toBe(true);
		}
		expect(isCredentialPrintHelp(["auth", "print-api-key"])).toBe(false);
		expect(isCredentialPrintHelp(["config"])).toBe(false);
	});

	it("ignores argv it does not own", () => {
		expect(parseCredentialPrintCommand(["--model", "gpt-5.5"])).toBeUndefined();
		expect(parseCredentialPrintCommand([])).toBeUndefined();
	});

	it("names both subcommands when the auth subcommand is unknown", () => {
		try {
			parseCredentialPrintCommand(["auth", "print-everything"]);
			expect.unreachable("expected a usage error");
		} catch (error) {
			expect(error).toBeInstanceOf(CredentialPrintError);
			const failure = error as CredentialPrintError;
			expect(failure.exitCode).toBe(1);
			expect(failure.message).toContain("atomic auth print-api-key");
			expect(failure.message).toContain("atomic auth print-bearer-token");
			// Branding seam: upstream's help says `pi`.
			expect(failure.message).not.toContain("pi auth");
		}
	});

	it("rejects --min-expiry for print-api-key rather than ignoring it", () => {
		try {
			parseCredentialPrintCommand(["auth", "print-api-key", "--model", "gpt-5.5", "--min-expiry", "30m"]);
			expect.unreachable("expected a usage error");
		} catch (error) {
			expect((error as CredentialPrintError).exitCode).toBe(1);
			expect((error as Error).message).toContain("only supported by print-bearer-token");
		}
	});

	it("accepts ms, s, m, and h durations and rejects anything else", () => {
		const parse = (value: string) =>
			parseCredentialPrintCommand(["auth", "print-bearer-token", "--min-expiry", value])?.minExpiryMs;

		expect(parse("500ms")).toBe(500);
		expect(parse("45s")).toBe(45_000);
		expect(parse("30m")).toBe(1_800_000);
		expect(parse("2h")).toBe(7_200_000);

		for (const bad of ["30", "m", "-5m", "30 minutes", "1d"]) {
			expect(() => parse(bad)).toThrow("duration such as 30m or 1h");
		}
		expect(() => parseCredentialPrintCommand(["auth", "print-bearer-token", "--min-expiry"])).toThrow();
	});

	it("keeps the remaining flags for the ordinary parser", () => {
		const command = parseCredentialPrintCommand([
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
		expect(() =>
			validateCredentialPrintArgs(args({ model: "m", unknownFlags: new Map([["--output", "keys.txt"]]) })),
		).toThrow("only accepts --provider and --model");
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
					throw new ModelsError("oauth", `refresh rejected for request with ${text}`);
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
			expect(reported.code).toBe("RefreshFailed");
			// The credential itself, not merely the field name it was filed under.
			expect(reported.message, text).not.toContain(value);
			expect(reported.message, text).toContain("[redacted]");
			// The diagnosis survives redaction, so the exit code is still actionable.
			expect(reported.message).toContain("refresh rejected for request with");
			// The unredacted error is still reachable for a debugger, as `cause`,
			// which this door never logs.
			expect((reported.cause as Error).message).toContain(value);
		}
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

			for (const result of [unknownSubcommand, missingModel, minExpiryOnApiKey, noCredential, wrongKind]) {
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

			const result = await runCliProcess(["auth"], { cwd: agentDir, env: cliEnv(agentDir) });

			expect(result.code).toBe(0);
			expect(result.stderr).toContain("atomic auth print-api-key");
			expect(result.stderr).toContain("atomic auth print-bearer-token");
			expect(result.stderr).not.toContain("pi auth");
			// stdout for this command family is a credential or nothing.
			expect(result.stdout).toBe("");
		},
		REAL_CLI_SUITE_TIMEOUT_MS,
	);
});
