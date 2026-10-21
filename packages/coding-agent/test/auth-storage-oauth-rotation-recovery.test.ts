import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, test, vi } from "vitest";
import {
	type ByteStream,
	bunExecutable,
	decodeStream,
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	sleep,
	spawnProcess,
	writeTextSync,
} from "../../../test/helpers/runtime.ts";
import {
	OAUTH_REFRESH_TIMEOUT_MS,
	OAUTH_SHUTDOWN_DRAIN_MS,
	refreshStoredOAuthCredential,
	requestAuthTimeoutMessage,
} from "../../ai/src/auth/resolve.ts";
import type { OAuthAuth, OAuthCredential } from "../../ai/src/auth/types.ts";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { LockResult } from "../src/core/auth-storage-backends.ts";
import { cliPath } from "./cli-test-helpers.ts";

/** Every child here is a real Bun process taking the real cross-process provider lock. */
const CROSS_PROCESS_LOCK_TEST_TIMEOUT_MS = 60_000;

/** A lock holder whose process was suspended (or whose event loop was blocked) for this long. */
const SUSPENDED_HOLDER_MS = 60 * 60_000;

/** A real `atomic` CLI process: Bun transpiles the CLI graph and builtin extensions, then waits out request auth. */
const ATOMIC_PROCESS_TEST_TIMEOUT_MS = 120_000;

/** The provider answers a rotation this long after the agent is asked to shut down, well inside the drain bound. */
const ROTATION_RESPONSE_AFTER_SHUTDOWN_MS = OAUTH_SHUTDOWN_DRAIN_MS / 3;

/**
 * Extra time a loaded machine gets, beyond the drain bound, to finish shutting down. An exchange nothing bounds keeps
 * the process alive for at least OAUTH_REFRESH_LOCK_HOLD_MS, which is far longer.
 */
const EXIT_HEADROOM_MS = 15_000;

/** A later process sees the rotated login as expired after this long, so it refreshes it again. */
const LATER_PROCESS_CLOCK_AHEAD_MS = 2 * 60 * 60_000;

const PROVIDER = "openai-1";
const FIRST_REFRESH_TOKEN = "fake-refresh-1";

type TokenPresentation = { token: string; outcome: "rotated" | "invalid_grant" };

/**
 * Fake OAuth token endpoint that rotates refresh tokens: every refresh invalidates the token it was given. A rotation
 * happens on receipt; its response is sent once `respondToRotation` settles.
 */
async function startRotatingTokenServer(respondToRotation: () => Promise<void> = async () => {}) {
	let generation = 1;
	const presentations: TokenPresentation[] = [];
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", async () => {
			const { refresh_token: token } = JSON.parse(body) as { refresh_token: string };
			response.setHeader("content-type", "application/json");
			if (token !== `fake-refresh-${generation}`) {
				presentations.push({ token, outcome: "invalid_grant" });
				response.statusCode = 400;
				response.end(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found" }));
				return;
			}
			const rotatedTo = ++generation;
			presentations.push({ token, outcome: "rotated" });
			await respondToRotation();
			response.end(
				JSON.stringify({
					access_token: `fake-access-${rotatedTo}`,
					refresh_token: `fake-refresh-${rotatedTo}`,
					expires_in: 3600,
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/token`,
		presentations,
		currentRefreshToken: () => `fake-refresh-${generation}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

async function exchangeRefreshToken(url: string, credential: OAuthCredential, signal: AbortSignal) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ refresh_token: credential.refresh }),
		signal,
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`fake token refresh failed (${response.status}): ${text}`);
	const token = JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number };
	return {
		type: "oauth" as const,
		access: token.access_token,
		refresh: token.refresh_token,
		expires: Date.now() + token.expires_in * 1000,
	};
}

function fakeOAuth(refresh: OAuthAuth["refresh"]): OAuthAuth {
	return {
		name: "Fake rotating OAuth",
		login: async () => {
			throw new Error("login is not part of this test");
		},
		refresh,
		toAuth: async (credential) => ({ apiKey: credential.access }),
	};
}

const expired = (credential: OAuthCredential) => Date.now() >= credential.expires;

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

type ChildEvent =
	| { event: "provider-lock-held" | "provider-lock-free" }
	| { event: "result"; refresh?: string; error?: string };

/**
 * Another Atomic process refreshing the same login. Its clock runs `clockAheadMs` ahead, which is how
 * a holder whose lock heartbeat is late by that much looks to it. Before taking the provider lock it
 * reports whether that lock is still valid under the stale window the backend requested.
 */
function spawnContender(authPath: string, tokenUrl: string, clockAheadMs: number) {
	const source = `
		const lockfile = (await import(${JSON.stringify(createRequire(import.meta.url).resolve("proper-lockfile"))})).default;
		const realNow = Date.now;
		Date.now = () => realNow() + ${clockAheadMs};
		const realLock = lockfile.lock;
		lockfile.lock = async (file, options) => {
			if (!file.endsWith("auth.json")) {
				const held = await lockfile.check(file, { realpath: false, stale: options.stale });
				console.log(JSON.stringify({ event: held ? "provider-lock-held" : "provider-lock-free" }));
			}
			return realLock(file, options);
		};
		const { AuthStorage } = await import(${JSON.stringify(fileURLToPath(new URL("../src/core/auth-storage.ts", import.meta.url)))});
		const { refreshStoredOAuthCredential } = await import(${JSON.stringify(fileURLToPath(new URL("../../ai/src/auth/resolve.ts", import.meta.url)))});
		const oauth = {
			name: "Fake rotating OAuth",
			login: async () => { throw new Error("login is not part of this test"); },
			toAuth: async (credential) => ({ apiKey: credential.access }),
			refresh: async (credential, signal) => {
				const response = await fetch(${JSON.stringify(tokenUrl)}, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ refresh_token: credential.refresh }),
					signal,
				});
				const text = await response.text();
				if (!response.ok) throw new Error("fake token refresh failed (" + response.status + "): " + text);
				const token = JSON.parse(text);
				return { type: "oauth", access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000 };
			},
		};
		try {
			const credential = await refreshStoredOAuthCredential(
				AuthStorage.create(${JSON.stringify(authPath)}),
				${JSON.stringify(PROVIDER)},
				oauth,
				(current) => Date.now() >= current.expires,
				new AbortController().signal,
			);
			console.log(JSON.stringify({ event: "result", refresh: credential?.refresh }));
		} catch (error) {
			console.log(JSON.stringify({ event: "result", error: error instanceof Error ? error.message : String(error) }));
		}
	`;
	const child = spawnProcess([bunExecutable(), "--eval", source], { stdout: "pipe", stderr: "pipe" });
	const events: ChildEvent[] = [];
	const listeners = new Set<() => void>();
	const stdout = (async () => {
		const reader = child.stdout!.getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line.startsWith("{")) events.push(JSON.parse(line) as ChildEvent);
				for (const listener of listeners) listener();
			}
		}
	})();
	const stderr = readStreamText(child.stderr);
	return {
		events,
		firstLockProbe: new Promise<ChildEvent["event"]>((resolve) => {
			const listener = () => {
				const probe = events.find((event) => event.event !== "result");
				if (probe) resolve(probe.event);
			};
			listeners.add(listener);
		}),
		finished: (async () => {
			const exitCode = await child.exited;
			await stdout;
			assert.equal(exitCode, 0, await stderr);
			const result = events.find((event) => event.event === "result");
			assert.ok(result?.event === "result", "contender reported no result");
			return result;
		})(),
	};
}

function seedExpiredLogin(authPath: string) {
	const storage = AuthStorage.create(authPath);
	return storage.modify(PROVIDER, async () => ({
		type: "oauth",
		access: "fake-access-1",
		refresh: FIRST_REFRESH_TOKEN,
		expires: 0,
	}));
}

async function storedRefreshToken(authPath: string): Promise<string | undefined> {
	const credential = await AuthStorage.create(authPath).read(PROVIDER);
	return credential?.type === "oauth" ? credential.refresh : undefined;
}

afterEach(() => {
	vi.restoreAllMocks();
});

test(
	"a process waiting for the provider lock does not reuse a refresh token while a lagging holder's rotation is in flight",
	async () => {
		const directory = makeTempDirectory("oauth-lagging-holder-");
		const authPath = `${directory}/auth.json`;
		const server = await startRotatingTokenServer();
		const rotated = gate();
		const finishRotation = gate();
		let holder: Promise<OAuthCredential | undefined> | undefined;
		try {
			await seedExpiredLogin(authPath);
			holder = refreshStoredOAuthCredential(
				AuthStorage.create(authPath),
				PROVIDER,
				fakeOAuth(async (credential, signal) => {
					const next = await exchangeRefreshToken(server.url, credential, signal);
					rotated.release();
					await finishRotation.promise;
					return next;
				}),
				expired,
				new AbortController().signal,
			);
			await rotated.promise;

			const contender = spawnContender(authPath, server.url, OAUTH_REFRESH_TIMEOUT_MS);
			const probe = await Promise.race([contender.firstLockProbe, contender.finished.then(() => "finished")]);
			if (probe !== "provider-lock-held") await contender.finished;
			finishRotation.release();
			const holderCredential = await holder;
			const contenderResult = await contender.finished;

			assert.deepEqual(
				server.presentations.filter(({ outcome }) => outcome === "invalid_grant"),
				[],
				"a rotated refresh token was presented again",
			);
			assert.equal(holderCredential?.refresh, server.currentRefreshToken());
			assert.deepEqual(contenderResult, { event: "result", refresh: server.currentRefreshToken() });
			assert.equal(await storedRefreshToken(authPath), server.currentRefreshToken());
		} finally {
			finishRotation.release();
			await holder?.catch(() => undefined);
			await server.close();
			removeTempDirectory(directory);
		}
	},
	CROSS_PROCESS_LOCK_TEST_TIMEOUT_MS,
);

test(
	"a completed rotation is persisted after another process takes over the holder's provider lock",
	async () => {
		const directory = makeTempDirectory("oauth-taken-over-holder-");
		const authPath = `${directory}/auth.json`;
		const server = await startRotatingTokenServer();
		const rotated = gate();
		const finishRotation = gate();
		const lockTakenOver = gate();
		const realLock = lockfile.lock;
		vi.spyOn(lockfile, "lock").mockImplementation((file, options) =>
			realLock(file, {
				...options,
				onCompromised: (error) => {
					lockTakenOver.release();
					options?.onCompromised?.(error);
				},
			}),
		);
		let holder: Promise<OAuthCredential | undefined> | undefined;
		try {
			await seedExpiredLogin(authPath);
			holder = refreshStoredOAuthCredential(
				AuthStorage.create(authPath),
				PROVIDER,
				fakeOAuth(async (credential, signal) => {
					const next = await exchangeRefreshToken(server.url, credential, signal);
					rotated.release();
					await finishRotation.promise;
					return next;
				}),
				expired,
				new AbortController().signal,
			);
			await rotated.promise;

			await spawnContender(authPath, server.url, SUSPENDED_HOLDER_MS).finished;
			await lockTakenOver.promise;
			finishRotation.release();

			assert.equal((await holder)?.refresh, server.currentRefreshToken());
			assert.equal(await storedRefreshToken(authPath), server.currentRefreshToken());
		} finally {
			finishRotation.release();
			await holder?.catch(() => undefined);
			await server.close();
			removeTempDirectory(directory);
		}
	},
	CROSS_PROCESS_LOCK_TEST_TIMEOUT_MS,
);

test("a rejected refresh uses the newer login another process saved instead of failing", async () => {
	const directory = makeTempDirectory("oauth-newer-login-");
	const authPath = `${directory}/auth.json`;
	const newer = {
		type: "oauth" as const,
		access: "fake-access-2",
		refresh: "fake-refresh-2",
		expires: Date.now() + 3_600_000,
	};
	try {
		await seedExpiredLogin(authPath);
		const otherProcessBackend = new FileAuthStorageBackend(authPath);
		const credential = await refreshStoredOAuthCredential(
			AuthStorage.create(authPath),
			PROVIDER,
			fakeOAuth(async () => {
				await otherProcessBackend.withLockAsync(async (content) => {
					const next = JSON.stringify({ ...JSON.parse(content ?? "{}"), [PROVIDER]: newer });
					return { result: undefined, next };
				});
				throw new Error('fake token refresh failed (400): {"error":"invalid_grant"}');
			}),
			expired,
			new AbortController().signal,
		);

		assert.deepEqual(credential, newer);
		assert.equal(await storedRefreshToken(authPath), newer.refresh);
	} finally {
		removeTempDirectory(directory);
	}
});

test("a completed rotation is persisted when the auth file lock is lost during the commit", async () => {
	const directory = makeTempDirectory("oauth-commit-lock-lost-");
	const authPath = `${directory}/auth.json`;
	class CommitLockLostOnceBackend extends FileAuthStorageBackend {
		lost = false;
		override async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
			if (!this.lost) {
				this.lost = true;
				throw Object.assign(new Error("Unable to update lock within the stale threshold"), {
					code: "ECOMPROMISED",
				});
			}
			return super.withLockAsync(fn);
		}
	}
	const rotatedCredential = {
		type: "oauth" as const,
		access: "fake-access-2",
		refresh: "fake-refresh-2",
		expires: Date.now() + 3_600_000,
	};
	try {
		await seedExpiredLogin(authPath);
		const credential = await refreshStoredOAuthCredential(
			AuthStorage.fromStorage(new CommitLockLostOnceBackend(authPath)),
			PROVIDER,
			fakeOAuth(async () => rotatedCredential),
			expired,
			new AbortController().signal,
		);

		assert.deepEqual(credential, rotatedCredential);
		assert.equal(await storedRefreshToken(authPath), rotatedCredential.refresh);
	} finally {
		removeTempDirectory(directory);
	}
});

/** An extension provider whose OAuth refresh exchanges tokens with the fake server, as a provider extension would. */
function writeOAuthProviderExtension(directory: string, tokenUrl: string): string {
	const path = `${directory}/fake-oauth-provider.ts`;
	writeTextSync(
		path,
		`export default async function (pi) {
	await pi.registerProvider(${JSON.stringify(PROVIDER)}, {
		baseUrl: "http://127.0.0.1:9/v1",
		api: "openai-completions",
		models: [{ id: "fake-model", name: "Fake model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000 }],
		oauth: {
			name: "Fake rotating OAuth",
			async login() { throw new Error("login is not part of this test"); },
			async refreshToken(credentials, signal) {
				const response = await fetch(${JSON.stringify(tokenUrl)}, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ refresh_token: credentials.refresh }),
					signal,
				});
				const text = await response.text();
				if (!response.ok) throw new Error("fake token refresh failed (" + response.status + "): " + text);
				const token = JSON.parse(text);
				return { access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000 };
			},
			getApiKey: (credentials) => credentials.access,
		},
	});
}
`,
	);
	return path;
}

/** A real `atomic` process using the fake provider, with its own agent directory. */
function spawnAtomic(mode: string[], directory: string, extensionPath: string, stdin: "pipe" | "ignore") {
	const agentDir = `${directory}/agent`;
	const child = spawnProcess(
		[
			bunExecutable(),
			cliPath,
			...mode,
			"--provider",
			PROVIDER,
			"--model",
			"fake-model",
			"-e",
			extensionPath,
			"--no-session",
		],
		{
			cwd: directory,
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_OFFLINE: "1",
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_INTERACTIVE_ENGINE_CHILD: undefined,
				ATOMIC_INTERACTIVE_ENGINE_API_KEY: undefined,
				NO_COLOR: "1",
			},
			stdin,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	let output = "";
	const listeners = new Set<() => void>();
	const collect = async (stream: ByteStream | null) => {
		if (!stream) return;
		const reader = decodeStream(stream).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			output += value;
			for (const listener of listeners) listener();
		}
	};
	const collected = Promise.all([collect(child.stdout), collect(child.stderr)]);
	const exited = child.exited.then(async (code) => {
		await collected;
		return code;
	});
	return {
		child,
		exited,
		output: () => output,
		/** Resolves once the process printed `text`; rejects if it exits without doing so. */
		printed: (text: string) =>
			new Promise<void>((resolve, reject) => {
				const check = () => {
					if (!output.includes(text)) return false;
					listeners.delete(check);
					resolve();
					return true;
				};
				if (check()) return;
				listeners.add(check);
				void exited.then((code) => {
					if (!check()) reject(new Error(`atomic exited (${code}) without printing "${text}":\n${output}`));
				});
			}),
	};
}

test(
	"a graceful shutdown keeps a rotation the provider completed after its caller timed out",
	async () => {
		const directory = makeTempDirectory("oauth-shutdown-drain-");
		const authPath = `${directory}/agent/auth.json`;
		const respond = gate();
		const server = await startRotatingTokenServer(() => respond.promise);
		let agent: ReturnType<typeof spawnAtomic> | undefined;
		try {
			await seedExpiredLogin(authPath);
			agent = spawnAtomic(["--mode", "rpc"], directory, writeOAuthProviderExtension(directory, server.url), "pipe");
			agent.child.stdin?.write(`${JSON.stringify({ type: "prompt", message: "hi" })}\n`);
			await agent.printed(requestAuthTimeoutMessage(PROVIDER));

			// Closing stdin is how an RPC client (the interactive host, a subagent runner) ends the agent.
			agent.child.stdin?.end();
			await sleep(ROTATION_RESPONSE_AFTER_SHUTDOWN_MS);
			respond.release();

			assert.equal(await agent.exited, 0, agent.output());
			assert.deepEqual(server.presentations, [{ token: FIRST_REFRESH_TOKEN, outcome: "rotated" }]);
			assert.equal(await storedRefreshToken(authPath), server.currentRefreshToken());
			const later = await spawnContender(authPath, server.url, LATER_PROCESS_CLOCK_AHEAD_MS).finished;
			assert.deepEqual(later, { event: "result", refresh: server.currentRefreshToken() });
			assert.deepEqual(
				server.presentations.filter(({ outcome }) => outcome === "invalid_grant"),
				[],
				"a later process presented the refresh token the provider had already rotated",
			);
		} finally {
			respond.release();
			agent?.child.kill("SIGKILL");
			await agent?.exited.catch(() => undefined);
			await server.close();
			removeTempDirectory(directory);
		}
	},
	ATOMIC_PROCESS_TEST_TIMEOUT_MS,
);

test(
	"a hung token exchange delays exit by at most the shutdown drain",
	async () => {
		const directory = makeTempDirectory("oauth-shutdown-hung-");
		const authPath = `${directory}/agent/auth.json`;
		const server = await startRotatingTokenServer(() => new Promise<void>(() => {}));
		let agent: ReturnType<typeof spawnAtomic> | undefined;
		try {
			await seedExpiredLogin(authPath);
			agent = spawnAtomic(["-p", "hi"], directory, writeOAuthProviderExtension(directory, server.url), "ignore");
			await agent.printed(requestAuthTimeoutMessage(PROVIDER));

			const exitBoundMs = OAUTH_SHUTDOWN_DRAIN_MS + EXIT_HEADROOM_MS;
			const exitCode = await Promise.race([agent.exited, sleep(exitBoundMs).then(() => "still running")]);

			assert.equal(
				exitCode,
				1,
				`atomic was ${exitCode} ${exitBoundMs} ms after its request failed:\n${agent.output()}`,
			);
			assert.equal(await storedRefreshToken(authPath), FIRST_REFRESH_TOKEN);
		} finally {
			agent?.child.kill("SIGKILL");
			await agent?.exited.catch(() => undefined);
			await server.close();
			removeTempDirectory(directory);
		}
	},
	ATOMIC_PROCESS_TEST_TIMEOUT_MS,
);
