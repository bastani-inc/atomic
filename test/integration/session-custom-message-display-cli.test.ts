import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { makeTempDirectory, moduleDir, readStreamText, spawnProcess } from "../helpers/runtime.js";
import { messageText, startScriptedChatServer } from "../helpers/scripted-chat-server.js";

const CLI = join(moduleDir(import.meta.url), "../../packages/coding-agent/dist/cli.js");
// Each print run is a real CLI start that loads the bundled extensions under Node.
const CLI_START_TIMEOUT_MS = 60_000;
const SESSION_ID = "019a0000-0000-7000-8000-000000006097";
const CREATED_AT = "2026-11-01T00:00:00.000Z";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

type Storage = "jsonl" | "sqlite";

async function profile(storage: Storage) {
	const root = makeTempDirectory("custom-message-display-");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const sessions = join(root, "sessions");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	mkdirSync(sessions);
	const requests: string[][] = [];
	const server = await startScriptedChatServer(({ messages }) => {
		requests.push(messages.filter((message) => message.role === "user").map(messageText));
		return { label: String(requests.length), text: `reply ${requests.length}`, chunks: 1, chunkDelayMs: 0 };
	});
	cleanups.push(async () => {
		try {
			await server.close();
		} finally {
			await removeTempRootReleasingBroker(root, agentDir);
		}
	});
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				scripted: {
					api: "openai-completions",
					apiKey: "fixture",
					baseUrl: server.baseUrl,
					models: [{ id: "local" }],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ sessionSummary: { enabled: false }, onboardedVersion: "0.0.0" }),
	);
	const env: Record<string, string> = {};
	for (const key of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	const database = join(sessions, "sessions.db");
	const store = storage === "jsonl" ? ["--session-dir", sessions] : ["--session-store", database];
	return {
		cwd,
		sessions,
		database,
		requests,
		async run(...args: string[]) {
			const child = spawnProcess(
				[process.execPath, CLI, "--offline", "--provider", "scripted", "--model", "local", ...store, ...args],
				{
					cwd,
					env: {
						...env,
						HOME: root,
						USERPROFILE: root,
						ATOMIC_CODING_AGENT_DIR: agentDir,
						ATOMIC_CODING_AGENT_SESSION_DIR: "",
						ATOMIC_STORAGE: "",
						ATOMIC_SESSIONS_STORAGE: "",
						ATOMIC_INTERCOM_SESSION_ID: "",
						ATOMIC_TELEMETRY: "0",
					},
					stdout: "pipe",
					stderr: "pipe",
					timeout: CLI_START_TIMEOUT_MS,
				},
			);
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				readStreamText(child.stdout),
				readStreamText(child.stderr),
			]);
			return { code, stdout: stdout.trim(), stderr };
		},
	};
}

type Profile = Awaited<ReturnType<typeof profile>>;

/** The stored lines or rows of the session, as text, in append order. */
async function storedEntries(storage: Storage, p: Profile): Promise<string[]> {
	if (storage === "jsonl") {
		for (const name of readdirSync(p.sessions).filter((file) => file.endsWith(".jsonl"))) {
			const [first, ...entries] = readFileSync(join(p.sessions, name), "utf8").trim().split("\n");
			if ((JSON.parse(first!) as { id: string }).id === SESSION_ID) return entries;
		}
		assert.fail(`no session file for ${SESSION_ID}`);
	}
	const database = await openNodeSqliteDatabase(p.database);
	try {
		return (
			await database.all<{ entry_json: string }>(
				"SELECT entry_json FROM session_entries WHERE session_id = ? ORDER BY seq",
				SESSION_ID,
			)
		).map((row) => row.entry_json);
	} finally {
		await database.close();
	}
}

/** Save a conversation the way releases before the fix did: a `/curator` notice with `display: "tool"`. */
async function saveLegacySession(storage: Storage, p: Profile): Promise<void> {
	const header = { id: SESSION_ID, version: 4 as const, createdAt: CREATED_AT, cwd: p.cwd };
	const entries = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: CREATED_AT,
			message: { role: "user", content: "earlier question", timestamp: 1 },
		},
		{
			type: "custom_message",
			id: "c1",
			parentId: "u1",
			timestamp: CREATED_AT,
			customType: "curator-config",
			content: [{ type: "text", text: "Curator disabled" }],
			display: "tool",
			details: { workflow: "none" },
		},
	] as unknown as SessionEntry[];
	if (storage === "jsonl") {
		writeFileSync(
			join(p.sessions, `${CREATED_AT.replace(/[:.]/g, "-")}_${SESSION_ID}.jsonl`),
			`${[{ type: "session", ...header }, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		return;
	}
	const database = await openNodeSqliteDatabase(p.database);
	const store = await SqlSessionStore.open(database);
	try {
		await store.create(header, entries);
	} finally {
		await store.close();
		await database.close();
	}
}

for (const storage of ["jsonl", "sqlite"] as const) {
	describe(`${storage === "jsonl" ? "a JSONL" : "a SQLite"} session`, () => {
		test(
			'saved with a custom message display of "tool" continues with --session -p (#6097)',
			async () => {
				const p = await profile(storage);
				await saveLegacySession(storage, p);
				const before = await storedEntries(storage, p);
				const result = await p.run("--session", SESSION_ID, "-p", "next question");
				assert.equal(result.code, 0, result.stderr);
				assert.equal(result.stdout, "reply 1");
				assert.deepEqual(p.requests, [["earlier question", "Curator disabled", "next question"]]);
				assert.deepEqual((await storedEntries(storage, p)).slice(0, before.length), before);
			},
			2 * CLI_START_TIMEOUT_MS,
		);

		test(
			"with /curator and /google-account notices reopens with --session -p (#6097)",
			async () => {
				const p = await profile(storage);
				const steps = [
					["--session-id", SESSION_ID, "-p", "first question"],
					["--session", SESSION_ID, "-p", "/curator off"],
					["--session", SESSION_ID, "-p", "/google-account"],
					["--session", SESSION_ID, "-p", "last question"],
				];
				let last = "";
				for (const step of steps) {
					const result = await p.run(...step);
					assert.equal(result.code, 0, `${step.join(" ")}\n${result.stderr}`);
					last = result.stdout;
				}
				assert.equal(last, `reply ${p.requests.length}`);
				assert.deepEqual(p.requests.at(-1), [
					"first question",
					"Curator disabled — web_search will return raw results",
					"Gemini Web browser cookie access is disabled. Set allowBrowserCookies: true in ~/.atomic/web-search.json to enable it.",
					"last question",
				]);
				const notices = (await storedEntries(storage, p))
					.map((text) => JSON.parse(text) as { type: string; customType?: string; display?: unknown })
					.filter((entry) => entry.type === "custom_message")
					.map((entry) => [entry.customType, entry.display]);
				assert.deepEqual(notices, [
					["curator-config", true],
					["google-account", true],
				]);
			},
			5 * CLI_START_TIMEOUT_MS,
		);
	});
}
