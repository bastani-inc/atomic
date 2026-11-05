import assert from "node:assert/strict";
import type { Model, ModelsRefreshResult, Provider } from "@bastani/pi-ai";
import { afterEach, describe, test, vi } from "vitest";
import { runAuthLogin } from "../src/cli/auth-login.js";
import type { LoginTerminal } from "../src/cli/auth-terminal.js";
import { getAuthPath } from "../src/config.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { CredentialSynchronizationError, ModelRuntime } from "../src/core/model-runtime.js";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.js";

const PROVIDER_ID = "login-test";
const HOUR_MS = 3_600_000;

interface ScriptedTerminal extends LoginTerminal {
	lines: string[];
	errors: string[];
	questions: string[];
	secrets: string[];
	opened: string[];
}

/** Answers prompts in order; `secret` and `question` share one answer queue. */
function scriptedTerminal(answers: string[], interactive = true): ScriptedTerminal {
	const lines: string[] = [];
	const errors: string[] = [];
	const questions: string[] = [];
	const secrets: string[] = [];
	const opened: string[] = [];
	const answer = (asked: string[]) => async (message: string, signal: AbortSignal) => {
		asked.push(message);
		if (signal.aborted) throw signal.reason;
		const next = answers.shift();
		if (next === undefined) throw new Error(`Unexpected prompt: ${message}`);
		return next;
	};
	return {
		interactive,
		lines,
		errors,
		questions,
		secrets,
		opened,
		write: (line) => lines.push(line),
		error: (line) => errors.push(line),
		question: answer(questions),
		secret: answer(secrets),
		openUrl: (url) => opened.push(url),
	};
}

function testModel(providerId: string): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		provider: providerId,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function testProvider(auth: Provider["auth"], providerId: string): Provider {
	const unused = () => {
		throw new Error("unused");
	};
	return {
		id: providerId,
		name: "Login Test",
		auth,
		getModels: () => [testModel(providerId)],
		stream: unused,
		streamSimple: unused,
	};
}

const oauthToken = (access: string) =>
	({ type: "oauth", access, refresh: "refresh", expires: Date.now() + HOUR_MS }) as const;

type OAuthAuth = NonNullable<Provider["auth"]["oauth"]>;
type ApiKeyAuth = NonNullable<Provider["auth"]["apiKey"]>;

const oauthAuth: OAuthAuth = {
	name: "Login Test account",
	login: async (interaction) => {
		const method = await interaction.prompt({
			type: "select",
			message: "Sign in to Login Test:",
			options: [
				{ id: "browser", label: "Sign in with browser" },
				{ id: "device", label: "Sign in with device code" },
			],
		});
		if (method === "device") {
			interaction.notify({
				type: "device_code",
				userCode: "ABCD-1234",
				verificationUri: "https://example.test/device",
			});
			return oauthToken("access-device");
		}
		interaction.notify({
			type: "auth_url",
			url: "https://example.test/authorize",
			instructions: "Finish in the browser",
		});
		const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
		return oauthToken(`access-${code}`);
	},
	refresh: async (credential) => credential,
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

const apiKeyAuth: ApiKeyAuth = {
	name: "Login Test API key",
	login: async (interaction) => ({
		type: "api_key",
		key: await interaction.prompt({ type: "secret", message: "Enter Login Test API key" }),
	}),
	resolve: async () => undefined,
};

const bothMethods: Provider["auth"] = { oauth: oauthAuth, apiKey: apiKeyAuth };

function oauthLogin(login: OAuthAuth["login"]): Provider["auth"] {
	return { oauth: { ...oauthAuth, login } };
}

async function setup(auth: Provider["auth"], providerId = PROVIDER_ID) {
	const credentials = AuthStorage.inMemory();
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(testProvider(auth, providerId));
	return { credentials, modelRuntime };
}

/** The stored credential's kind and secret, which is what a login is expected to leave behind. */
async function stored(credentials: AuthStorage, providerId = PROVIDER_ID) {
	const credential = await credentials.read(providerId);
	if (credential?.type === "oauth") return { type: credential.type, access: credential.access };
	if (credential?.type === "api_key") return { type: credential.type, key: credential.key };
	return credential;
}

function run(
	args: string[],
	modelRuntime: ModelRuntime,
	terminal: LoginTerminal,
	signal = new AbortController().signal,
) {
	return runAuthLogin(args, { modelRuntime, terminal, getDeviceId: () => "device", signal });
}

function refreshResult(result: Partial<ModelsRefreshResult> = {}): ModelsRefreshResult {
	return { aborted: false, errors: new Map(), ...result };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("atomic auth login", () => {
	const usage = "Usage: atomic auth login <provider> [--api-key] [--no-browser]";

	test("requires exactly one provider and known options", async () => {
		const { modelRuntime } = await setup(bothMethods);
		for (const args of [[], ["--api-key"], ["--provider", PROVIDER_ID], [PROVIDER_ID, "extra"], ["-h"]]) {
			const terminal = scriptedTerminal([]);
			assert.equal(await run(args, modelRuntime, terminal), 1);
			assert.deepEqual(terminal.errors, [usage]);
		}
	});

	test("rejects --no-browser with --api-key", async () => {
		const { modelRuntime } = await setup(bothMethods);
		for (const args of [
			[PROVIDER_ID, "--api-key", "--no-browser"],
			["--no-browser", "--api-key", PROVIDER_ID],
		]) {
			const terminal = scriptedTerminal([]);
			assert.equal(await run(args, modelRuntime, terminal), 1);
			assert.deepEqual(terminal.errors, ["--no-browser only applies to account sign-in; omit it with --api-key."]);
		}
	});

	test("rejects an unknown provider and lists only the providers with a login flow, sorted", async () => {
		const { modelRuntime } = await setup(bothMethods);
		modelRuntime.registerNativeProvider({
			...testProvider({ apiKey: { name: "Ambient", resolve: async () => undefined } }, "ambient-only"),
			name: "Ambient Only",
		});
		modelRuntime.registerNativeProvider({
			...testProvider({ apiKey: apiKeyAuth }, "aaa-key-login"),
			name: "Key Login",
		});
		const terminal = scriptedTerminal([]);
		assert.equal(await run(["nope\u001b[2J"], modelRuntime, terminal), 1);
		assert.equal(terminal.errors.length, 2);
		assert.equal(terminal.errors[0], 'Unknown provider "nope [2J".');
		assert.match(terminal.errors[1], /^Providers: aaa-key-login, /u);
		const listed = terminal.errors[1].slice("Providers: ".length).split(", ");
		assert.ok(listed.includes(PROVIDER_ID));
		assert.ok(!listed.includes("ambient-only"));
		assert.deepEqual(listed, [...listed].sort());
	});

	test("requires an interactive terminal after checking the arguments", async () => {
		const { modelRuntime } = await setup(bothMethods);
		const terminal = scriptedTerminal([], false);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 1);
		assert.deepEqual(terminal.errors, [
			'"atomic auth login <provider> [--api-key] [--no-browser]" requires an interactive terminal',
		]);
	});

	test("signs in with an account in the browser without asking for a method", async () => {
		const { credentials, modelRuntime } = await setup(bothMethods);
		const refresh = vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal(["the-code"]);
		// Matches the provider name as well as the id.
		assert.equal(await run([" login TEST "], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.questions, ["Paste the code: "]);
		assert.deepEqual(terminal.opened, ["https://example.test/authorize"]);
		assert.deepEqual(terminal.lines, [
			"Open this URL to sign in:\n  https://example.test/authorize",
			"Finish in the browser",
			'To use "Sign in with device code" instead, run "atomic auth login login-test --no-browser"',
			`Logged in to Login Test. Credentials saved to ${getAuthPath()}`,
		]);
		assert.deepEqual(terminal.errors, []);
		assert.deepEqual(await stored(credentials), { type: "oauth", access: "access-the-code" });
		assert.equal(refresh.mock.calls.length, 1);
		const [options] = refresh.mock.calls[0];
		assert.deepEqual(options?.providers, [PROVIDER_ID]);
		assert.ok(options?.signal instanceof AbortSignal);
		assert.equal(options.signal.aborted, false);
	});

	test("lists several other sign-in methods", async () => {
		const { modelRuntime } = await setup(
			oauthLogin(async (interaction) => {
				await interaction.prompt({
					type: "select",
					message: "Sign in to Login Test:",
					options: [
						{ id: "browser", label: "Browser" },
						{ id: "device", label: "Device code" },
						{ id: "copy", label: "Copy code" },
					],
				});
				interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
				return oauthToken("access");
			}),
		);
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.lines.slice(0, 2), [
			"Open this URL to sign in:\n  https://example.test/authorize",
			'Other sign-in methods: "Device code", "Copy code". Run "atomic auth login login-test --no-browser" to choose one.',
		]);
	});

	test("offers no other sign-in methods when the provider has no method choice", async () => {
		const { credentials, modelRuntime } = await setup(
			oauthLogin(async (interaction) => {
				interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
				const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
				return oauthToken(`access-${code}`);
			}),
		);
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal(["the-code"]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.opened, ["https://example.test/authorize"]);
		assert.equal(
			terminal.lines.some((line) => line.includes("--no-browser")),
			false,
		);
		assert.deepEqual(await stored(credentials), { type: "oauth", access: "access-the-code" });
	});

	test("prints but never opens a sign-in URL that is not a web URL", async () => {
		const { modelRuntime } = await setup(
			oauthLogin(async (interaction) => {
				interaction.notify({ type: "auth_url", url: "file:///etc/passwd" });
				interaction.notify({ type: "auth_url", url: "not a url \u001b]8;;" });
				interaction.notify({ type: "device_code", userCode: "C0DE", verificationUri: "javascript:alert(1)" });
				return oauthToken("access");
			}),
		);
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.opened, []);
		assert.deepEqual(terminal.lines.slice(0, 4), [
			"Open this URL to sign in:\n  file:///etc/passwd",
			"Open this URL to sign in:\n  not a url  ]8;;",
			"Open javascript:alert(1) and enter code: C0DE",
			"Waiting for authentication...",
		]);
	});

	test("opens a device code page unless the provider asks to open it only on confirmation", async () => {
		const { modelRuntime } = await setup(
			oauthLogin(async (interaction) => {
				interaction.notify({ type: "device_code", userCode: "ONE", verificationUri: "https://example.test/one" });
				interaction.notify({
					type: "device_code",
					userCode: "TWO",
					verificationUri: "https://example.test/two",
					openBrowserOnConfirm: false,
				});
				return oauthToken("access");
			}),
		);
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.opened, ["https://example.test/one"]);
		assert.deepEqual(terminal.lines.slice(0, 4), [
			"Open https://example.test/one and enter code: ONE",
			"Waiting for authentication...",
			"Open https://example.test/two and enter code: TWO",
			"Waiting for authentication...",
		]);
	});

	test("prints provider info with its links and progress messages", async () => {
		const { modelRuntime } = await setup(
			oauthLogin(async (interaction) => {
				interaction.notify({
					type: "info",
					message: "Approve the request",
					links: [{ url: "https://example.test/approve", label: "Approve" }, { url: "https://example.test/help" }],
				});
				interaction.notify({ type: "info", message: "No links" });
				interaction.notify({ type: "progress", message: "Exchanging the code..." });
				return oauthToken("access");
			}),
		);
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.lines.slice(0, 5), [
			"Approve the request",
			"  Approve: https://example.test/approve",
			"  https://example.test/help",
			"No links",
			"Exchanging the code...",
		]);
		assert.deepEqual(terminal.opened, []);
	});

	test("--no-browser takes the only other sign-in method and opens nothing", async () => {
		const { credentials, modelRuntime } = await setup(bothMethods);
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID, "--no-browser"], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.questions, []);
		assert.deepEqual(terminal.lines.slice(0, 3), [
			"Sign in to Login Test: Sign in with device code",
			"Open https://example.test/device and enter code: ABCD-1234",
			"Waiting for authentication...",
		]);
		assert.deepEqual(terminal.opened, []);
		assert.equal(
			terminal.lines.some((line) => line.includes("--no-browser")),
			false,
		);
		assert.deepEqual(await stored(credentials), { type: "oauth", access: "access-device" });
	});

	test("--no-browser asks among several other sign-in methods and re-asks on an invalid selection", async () => {
		const { credentials, modelRuntime } = await setup(
			oauthLogin(async (interaction) => {
				const method = await interaction.prompt({
					type: "select",
					message: "Sign in to Login Test:",
					options: [
						{ id: "browser", label: "Browser" },
						{ id: "device", label: "Device code" },
						{ id: "copy", label: "Copy code" },
					],
				});
				return oauthToken(`access-${method}`);
			}),
		);
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal(["7", "0", "+2", "two", "1.0", " 2 "]);
		assert.equal(await run(["--no-browser", PROVIDER_ID], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.lines.slice(0, 3), ["Sign in to Login Test:", "  1. Device code", "  2. Copy code"]);
		assert.deepEqual(terminal.questions, Array(6).fill("Select 1-2: "));
		assert.deepEqual(terminal.lines.slice(3, 8), Array(5).fill("Enter a number from 1 to 2."));
		assert.deepEqual(await stored(credentials), { type: "oauth", access: "access-copy" });
	});

	test("--no-browser keeps a provider's only sign-in method without opening the browser", async () => {
		const { credentials, modelRuntime } = await setup(
			oauthLogin(async (interaction) => {
				const method = await interaction.prompt({
					type: "select",
					message: "Sign in to Login Test:",
					options: [{ id: "browser", label: "Browser" }],
				});
				interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
				return oauthToken(`access-${method}`);
			}),
		);
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID, "--no-browser"], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.questions, []);
		assert.deepEqual(terminal.opened, []);
		assert.deepEqual(await stored(credentials), { type: "oauth", access: "access-browser" });
	});

	test("asks for a method a provider offers without options in the terminal", async () => {
		const { credentials, modelRuntime } = await setup(
			oauthLogin(async (interaction) => {
				const method = await interaction.prompt({ type: "select", message: "Nothing to pick:", options: [] });
				return oauthToken(`access-${method}`);
			}),
		);
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 1);
		assert.deepEqual(terminal.questions, ["Select 1-0: "]);
		assert.deepEqual(terminal.lines, ["Nothing to pick:"]);
		assert.equal(await stored(credentials), undefined);
	});

	test("asks for selections during API key setup", async () => {
		const { credentials, modelRuntime } = await setup({
			apiKey: {
				...apiKeyAuth,
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({
						type: "select",
						message: "Choose credentials:",
						options: [
							{ id: "first", label: "First" },
							{ id: "second", label: "Second", description: "Other credentials" },
						],
					}),
				}),
			},
		});
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal(["2"]);
		assert.equal(await run([PROVIDER_ID, "--api-key"], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.questions, ["Select 1-2: "]);
		assert.deepEqual(terminal.lines.slice(0, 3), [
			"Choose credentials:",
			"  1. First",
			"  2. Second - Other credentials",
		]);
		assert.deepEqual(await stored(credentials), { type: "api_key", key: "second" });
	});

	test("cancels a pending prompt without cancelling the login when the browser callback wins", async () => {
		const promptController = new AbortController();
		const { credentials, modelRuntime } = await setup(
			oauthLogin(async (interaction) => {
				const pending = interaction.prompt({
					type: "manual_code",
					message: "Paste the code",
					placeholder: "redirect URL",
					signal: promptController.signal,
				});
				promptController.abort();
				await assert.rejects(pending, (error) => error === promptController.signal.reason);
				assert.equal(interaction.signal?.aborted, false);
				return oauthToken("callback");
			}),
		);
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal([]);
		const question = vi.fn(
			(_message: string, signal: AbortSignal) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		terminal.question = question;
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 0);
		assert.equal(question.mock.calls.length, 1);
		assert.equal(question.mock.calls[0][0], "Paste the code (redirect URL): ");
		assert.deepEqual(await stored(credentials), { type: "oauth", access: "callback" });
	});

	test("reports a committed login separately from a failed login", async () => {
		const { modelRuntime } = await setup(bothMethods);
		vi.spyOn(modelRuntime, "login").mockRejectedValue(
			new CredentialSynchronizationError(
				PROVIDER_ID,
				"login",
				{ type: "api_key", key: "saved" },
				{ cause: new Error("snapshot failed") },
			),
		);
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 1);
		assert.deepEqual(terminal.errors, [
			"Logged in to Login Test, but local model state could not be synchronized: Credential login committed for login-test, but local synchronization failed",
		]);
		assert.deepEqual(terminal.lines, []);
	});

	test("reports a failed login with the provider's error", async () => {
		const { credentials, modelRuntime } = await setup(
			oauthLogin(async () => {
				throw new Error("access_denied");
			}),
		);
		const refresh = vi.spyOn(modelRuntime, "refresh");
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 1);
		assert.deepEqual(terminal.errors, ["Failed to log in to Login Test: access_denied"]);
		assert.deepEqual(terminal.lines, []);
		assert.equal(refresh.mock.calls.length, 0);
		assert.equal(await stored(credentials), undefined);
	});

	test("reports a non-Error login failure as text", async () => {
		const { modelRuntime } = await setup(bothMethods);
		vi.spyOn(modelRuntime, "login").mockRejectedValue("store locked");
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 1);
		assert.deepEqual(terminal.errors, ["Failed to log in to Login Test: store locked"]);
	});

	test("--api-key saves an API key", async () => {
		const { credentials, modelRuntime } = await setup(bothMethods);
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal(["sk-test"]);
		assert.equal(await run([PROVIDER_ID, "--api-key"], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.secrets, ["Enter Login Test API key: "]);
		assert.deepEqual(terminal.questions, []);
		assert.deepEqual(await stored(credentials), { type: "api_key", key: "sk-test" });
		assert.deepEqual(terminal.lines, [`Saved API key for Login Test. Credentials saved to ${getAuthPath()}`]);
	});

	test("uses the API key login of providers without account sign-in", async () => {
		const { modelRuntime } = await setup({ apiKey: apiKeyAuth });
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal(["sk-test"]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.secrets, ["Enter Login Test API key: "]);
	});

	test("--api-key fails for providers without API key login", async () => {
		const { modelRuntime } = await setup({ oauth: oauthAuth });
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID, "--api-key"], modelRuntime, terminal), 1);
		assert.deepEqual(terminal.errors, ["Login Test has no API key login. Omit --api-key to sign in."]);
	});

	test("reports providers configured outside Atomic", async () => {
		const { modelRuntime } = await setup({ apiKey: { name: "AWS profile", resolve: async () => undefined } });
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 1);
		assert.deepEqual(terminal.errors, ["Login Test is configured outside atomic (AWS profile)."]);
	});

	test("--api-key on a provider configured outside Atomic names its credential source", async () => {
		const { modelRuntime } = await setup({ apiKey: { name: "AWS profile", resolve: async () => undefined } });
		const terminal = scriptedTerminal([]);
		assert.equal(await run([PROVIDER_ID, "--api-key"], modelRuntime, terminal), 1);
		assert.deepEqual(terminal.errors, ["Login Test is configured outside atomic (AWS profile)."]);
	});

	test("treats a provider without any sign-in method as configured outside Atomic and does not list it", async () => {
		const { modelRuntime } = await setup({}, "no-sign-in");
		const terminal = scriptedTerminal([]);
		assert.equal(await run(["no-sign-in"], modelRuntime, terminal), 1);
		assert.deepEqual(terminal.errors, ["Login Test is configured outside atomic (ambient credentials)."]);

		const unknown = scriptedTerminal([]);
		assert.equal(await run(["nope"], modelRuntime, unknown), 1);
		assert.ok(!unknown.errors[1].slice("Providers: ".length).split(", ").includes("no-sign-in"));
	});

	test("selects a numbered option above 9", async () => {
		const options = Array.from({ length: 11 }, (_, index) => ({ id: `key-${index + 1}`, label: `Key ${index + 1}` }));
		const { credentials, modelRuntime } = await setup({
			apiKey: {
				...apiKeyAuth,
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({ type: "select", message: "Choose a key:", options }),
				}),
			},
		});
		vi.spyOn(modelRuntime, "refresh").mockResolvedValue(refreshResult());
		const terminal = scriptedTerminal(["10"]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal), 0);
		assert.deepEqual(terminal.questions, ["Select 1-11: "]);
		assert.deepEqual(await stored(credentials), { type: "api_key", key: "key-10" });
	});

	test("reports cancellation without treating it as a failure", async () => {
		const { credentials, modelRuntime } = await setup({ apiKey: apiKeyAuth });
		const controller = new AbortController();
		controller.abort();
		const terminal = scriptedTerminal(["sk-test"]);
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal, controller.signal), 1);
		assert.deepEqual(terminal.errors, ["Login cancelled."]);
		assert.equal(await stored(credentials), undefined);
	});

	test("reports Ctrl+C during a prompt as cancellation", async () => {
		const { credentials, modelRuntime } = await setup({ apiKey: apiKeyAuth });
		const controller = new AbortController();
		const terminal = scriptedTerminal([]);
		terminal.secret = async (_message, signal) => {
			controller.abort();
			throw signal.reason;
		};
		assert.equal(await run([PROVIDER_ID], modelRuntime, terminal, controller.signal), 1);
		assert.deepEqual(terminal.errors, ["Login cancelled."]);
		assert.equal(await stored(credentials), undefined);
	});

	describe("model catalog refresh after logging in", () => {
		async function loginWithRefresh(refresh: (options: { signal?: AbortSignal }) => Promise<ModelsRefreshResult>) {
			const { credentials, modelRuntime } = await setup({ apiKey: apiKeyAuth });
			const controller = new AbortController();
			vi.spyOn(modelRuntime, "refresh").mockImplementation((options = {}) => refresh({ ...options }));
			const terminal = scriptedTerminal(["sk-test"]);
			const exitCode = await run([PROVIDER_ID], modelRuntime, terminal, controller.signal);
			return { credentials, terminal, exitCode, controller };
		}

		test("reports nothing more when the catalog refreshes", async () => {
			const { terminal, exitCode } = await loginWithRefresh(async () => refreshResult());
			assert.equal(exitCode, 0);
			assert.deepEqual(terminal.lines, [`Saved API key for Login Test. Credentials saved to ${getAuthPath()}`]);
		});

		test("Ctrl+C during the catalog refresh skips it and keeps the login", async () => {
			const { credentials, modelRuntime } = await setup({ apiKey: apiKeyAuth });
			const controller = new AbortController();
			// A refresh that only ends when aborted, interrupted as soon as it starts.
			vi.spyOn(modelRuntime, "refresh").mockImplementation(
				({ signal } = {}) =>
					new Promise((resolve) => {
						signal?.addEventListener("abort", () => resolve(refreshResult({ aborted: true })));
						controller.abort();
					}),
			);
			const terminal = scriptedTerminal(["sk-test"]);
			assert.equal(await run([PROVIDER_ID], modelRuntime, terminal, controller.signal), 0);
			assert.deepEqual(terminal.lines.slice(1), [
				"Skipped the Login Test model catalog refresh; atomic refreshes it on next start.",
			]);
			assert.deepEqual(await stored(credentials), { type: "api_key", key: "sk-test" });
		});

		test("Ctrl+C while a failing catalog refresh rejects skips it", async () => {
			const { credentials, modelRuntime } = await setup({ apiKey: apiKeyAuth });
			const controller = new AbortController();
			vi.spyOn(modelRuntime, "refresh").mockImplementation(async () => {
				controller.abort();
				throw new Error("socket closed");
			});
			const terminal = scriptedTerminal(["sk-test"]);
			assert.equal(await run([PROVIDER_ID], modelRuntime, terminal, controller.signal), 0);
			assert.deepEqual(terminal.lines.slice(1), [
				"Skipped the Login Test model catalog refresh; atomic refreshes it on next start.",
			]);
			assert.deepEqual(await stored(credentials), { type: "api_key", key: "sk-test" });
		});

		test("reports a timed out refresh", async () => {
			const { terminal, exitCode } = await loginWithRefresh(async () => refreshResult({ aborted: true }));
			assert.equal(exitCode, 0);
			assert.deepEqual(terminal.lines.slice(1), [
				"The Login Test model catalog refresh timed out; atomic refreshes it on next start.",
			]);
		});

		test("reports provider refresh errors", async () => {
			const { terminal, exitCode } = await loginWithRefresh(async () =>
				refreshResult({ errors: new Map([[PROVIDER_ID, new Error("HTTP 500")]]) }),
			);
			assert.equal(exitCode, 0);
			assert.deepEqual(terminal.lines.slice(1), [
				"The Login Test model catalog could not be refreshed; atomic retries on next start.",
			]);
		});

		test("reports a refresh that throws", async () => {
			const thrown = await loginWithRefresh(async () => {
				throw new Error("catalog unreachable");
			});
			assert.equal(thrown.exitCode, 0);
			assert.deepEqual(thrown.terminal.lines.slice(1), [
				"The Login Test model catalog could not be refreshed: catalog unreachable",
			]);

			const rejectedWithText = await loginWithRefresh(() => Promise.reject("offline"));
			assert.deepEqual(rejectedWithText.terminal.lines.slice(1), [
				"The Login Test model catalog could not be refreshed: offline",
			]);
		});
	});
});
