import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import { bunExecutable, readStreamText, type SpawnedProcess, spawnProcess } from "../../../../test/helpers/runtime.js";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { createMcpAuthProvider, McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";

// Each multi-process case runs real Bun child processes that import the TypeScript source.
const CHILD_PROCESS_TEST_TIMEOUT_MS = 120_000;
const READER_PROCESSES = 32;
const TOKEN_CALLS_PER_READER = 200;
const SERVER_URL = "https://mcp.example.com/mcp";
const AUTH_MODULE = fileURLToPath(new URL("../../src/core/auth-storage.ts", import.meta.url));
const OAUTH_MODULE = fileURLToPath(new URL("../../src/extensions/mcp/oauth.ts", import.meta.url));

let sandbox: string;
let authPath: string;
const children: SpawnedProcess[] = [];

function seedTokens(path: string): void {
	const backend = new FileAuthStorageBackend(path);
	const store = new McpOAuthCredentialStore(backend, sandbox);
	store.forServer("work", SERVER_URL).save({
		serverUrl: SERVER_URL,
		tokens: { access_token: "work-token", token_type: "Bearer" },
	});
}

function provider(path: string) {
	return createMcpAuthProvider({
		serverUrl: SERVER_URL,
		store: new McpOAuthCredentialStore(new FileAuthStorageBackend(path), sandbox).forServer("work", SERVER_URL),
		settings: () => ({}),
		onChallenge: () => {},
	});
}

/** Asks for the access token `TOKEN_CALLS_PER_READER` times, as before each request to the server, counting failures. */
function readerScript(): string {
	return `
		import { FileAuthStorageBackend } from ${JSON.stringify(AUTH_MODULE)};
		import { createMcpAuthProvider, McpOAuthCredentialStore } from ${JSON.stringify(OAUTH_MODULE)};
		const store = new McpOAuthCredentialStore(new FileAuthStorageBackend(${JSON.stringify(authPath)}), ${JSON.stringify(sandbox)});
		const auth = createMcpAuthProvider({
			serverUrl: ${JSON.stringify(SERVER_URL)},
			store: store.forServer("work", ${JSON.stringify(SERVER_URL)}),
			settings: () => ({}),
			onChallenge: () => {},
		});
		const errors = [];
		let wrong = 0;
		for (let i = 0; i < ${TOKEN_CALLS_PER_READER}; i++) {
			try {
				if ((await auth.token()) !== "work-token") wrong++;
			} catch (error) {
				errors.push(String(error?.code ?? error?.message ?? error));
			}
		}
		console.log(JSON.stringify({ errors, wrong }));
	`;
}

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-mcp-auth-reads-")));
	authPath = join(sandbox, "mcp-auth.json");
	seedTokens(authPath);
});

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	rmSync(sandbox, { recursive: true, force: true });
});

describe("MCP OAuth token reads under concurrent sessions (#4952)", () => {
	it(
		"never fails when 32 processes each read the token 200 times (#4952)",
		async () => {
			const readers = Array.from({ length: READER_PROCESSES }, () => {
				const child = spawnProcess([bunExecutable(), "--eval", readerScript()], { stdout: "pipe", stderr: "pipe" });
				children.push(child);
				return child;
			});
			const reports = await Promise.all(
				readers.map(async (reader) => {
					const [stdout, stderr, exitCode] = await Promise.all([
						readStreamText(reader.stdout),
						readStreamText(reader.stderr),
						reader.exited,
					]);
					assert.equal(exitCode, 0, `reader failed: ${stderr}`);
					return JSON.parse(stdout.trim()) as { errors: string[]; wrong: number };
				}),
			);

			assert.deepEqual(
				reports.flatMap((report) => report.errors),
				[],
			);
			assert.equal(
				reports.reduce((sum, report) => sum + report.wrong, 0),
				0,
			);
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);

	it("reads the token while a lock left by a dead process is still on mcp-auth.json (#4952)", async () => {
		mkdirSync(`${authPath}.lock`);

		assert.equal(await provider(authPath).token(), "work-token");
	});

	it("reads the token without the lock when legacy state is already taken over (#4952)", async () => {
		const legacy = { serverUrl: SERVER_URL, tokens: { access_token: "legacy", token_type: "Bearer" } };
		const stored = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, object>;
		writeFileSync(authPath, JSON.stringify({ ...stored, [SERVER_URL]: legacy }));
		mkdirSync(`${authPath}.lock`);

		assert.equal(await provider(authPath).token(), "work-token");
	});

	it("reads through the lock for a backend without a lock-free read (#4952)", () => {
		const backend = new FileAuthStorageBackend(authPath);
		let locked = 0;
		const lockOnly: AuthStorageBackend = {
			withLock: (fn) => {
				locked++;
				return backend.withLock(fn);
			},
			withLockAsync: (fn) => backend.withLockAsync(fn),
		};

		assert.equal(
			new McpOAuthCredentialStore(lockOnly, sandbox).tokens("work", SERVER_URL)?.access_token,
			"work-token",
		);
		assert.equal(locked, 1);
	});

	it("still moves credentials stored by URL alone to the server that reads them (#4952)", async () => {
		writeFileSync(
			authPath,
			JSON.stringify({
				[SERVER_URL]: { serverUrl: SERVER_URL, tokens: { access_token: "legacy", token_type: "Bearer" } },
			}),
		);

		assert.equal(await provider(authPath).token(), "legacy");
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(authPath, "utf8"))), [`mcp__work|${SERVER_URL}`]);
	});
});
