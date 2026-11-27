import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@bastani/atomic-ai/compat";
import { describe, test, vi } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../packages/coding-agent/src/core/agent-session-runtime.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { type SessionEntry, SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { runPrintMode } from "../../packages/coding-agent/src/modes/print-mode.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import {
	postgresTestUsesTls,
	proxiedUrl,
	startPostgresProxy,
	writeProxyCertificates,
} from "../helpers/postgres-proxy.js";
import { makeTempDirectory, removeTempDirectory, sleep, spawnSyncCollect } from "../helpers/runtime.js";

/** The reported restart lasts longer than one SQL call's roughly four-second retry budget. */
const OUTAGE_MS = 5_500;
const LONG_OUTAGE_MS = 30_000;
/** Running the headless host and loading the real shipped subagents extension has a cold-start cost. */
const LIVE_SESSION_TEST_TIMEOUT_MS = LONG_OUTAGE_MS + 60_000;
const PROVIDER = "faux-pg-recovery";
const CHILD_MODEL = "child";
const CHILD_ANSWER = "child saved after reconnect";
const FIRST_ANSWER = "parent saved after reconnect";
const SECOND_ANSWER = "parent still running";
const PEER_WRITE = "another process resumed this session";

function includesMessage(entry: SessionEntry, text: string): boolean {
	return (
		entry.type === "message" && "content" in entry.message && JSON.stringify(entry.message.content).includes(text)
	);
}

function takeover(url: string, sessionId: string): void {
	const result = spawnSyncCollect(
		[
			process.execPath,
			"--input-type=module",
			"--eval",
			`
			import { SessionManager, SqlSessionStore } from "@bastani/atomic";
			import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";
			const [url, sessionId, content] = process.argv.slice(1);
			const db = await openPostgresDatabase({ url, password: process.env.ATOMIC_TEST_POSTGRES_PASSWORD });
			const store = await SqlSessionStore.open(db);
			const writer = await SessionManager.open(store, sessionId);
			await writer.appendMessage({ role: "user", content, timestamp: Date.now() });
			await store.close();
			await db.close();
		`,
			url,
			sessionId,
			PEER_WRITE,
		],
		{ timeout: 15_000 },
	);
	assert.equal(result.exitCode, 0, result.stderr.toString());
}

describe.skipIf(postgresSkipReason !== undefined)("live PostgreSQL session recovery (#6752)", () => {
	test.each([
		{
			name: "a short cut preserves the JSON run's messages and live subagent records once",
			outageMs: OUTAGE_MS,
			action: "recover",
		},
		{
			name: "a long cut reports waiting and recovery and still preserves each write once",
			outageMs: LONG_OUTAGE_MS,
			action: "recover",
		},
		{
			name: "a peer writer during the cut stops the old JSON writer and its pending prompts",
			outageMs: OUTAGE_MS,
			action: "takeover",
		},
		{
			name: "aborting the live turn cancels its pending recovery without reconnecting",
			outageMs: OUTAGE_MS,
			action: "abort",
		},
	])(
		"$name (#6752)",
		async ({ outageMs, action }) => {
			await withPostgresDatabase(async ({ open, url }) => {
				const cwd = makeTempDirectory("atomic-pg-live-session-");
				const certificate = postgresTestUsesTls() ? writeProxyCertificates(cwd) : undefined;
				const sockets = new Set<Duplex>();
				let offline = false;
				const proxy = await startPostgresProxy(certificate, (client, upstream, first) => {
					if (offline) {
						client.destroy();
						return;
					}
					sockets.add(client);
					client.once("close", () => sockets.delete(client));
					upstream.write(first);
					client.pipe(upstream).pipe(client);
				});
				const parentResponding = Promise.withResolvers<void>();
				const childResponding = Promise.withResolvers<void>();
				const respond = Promise.withResolvers<void>();
				const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: "parent" }, { id: CHILD_MODEL }] });
				// Under NODE_ENV=test, a child runs a scripted stand-in session instead of its model.
				vi.stubEnv("NODE_ENV", "production");
				try {
					const direct = await SqlSessionStore.open(await open());
					const store = await SqlSessionStore.open(
						await open({ url: proxiedUrl(url, proxy.port, certificate?.ca), listenUrl: url }),
					);
					const manager = await SessionManager.create(store, cwd);
					const sessionId = manager.getSessionId();
					mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
					writeFileSync(
						join(cwd, ".atomic", "agents", "recovery-helper.md"),
						`---\nname: recovery-helper\ndescription: Answers\ntools: read\nmodel: ${PROVIDER}/${CHILD_MODEL}\n---\n\nAnswer the task.\n`,
					);
					const authStorage = AuthStorage.inMemory();
					await authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "faux-key" }));
					const modelRuntime = await ModelRuntime.create({
						credentials: authStorage,
						modelsPath: null,
						modelsStore: new InMemoryCodingAgentModelsStore(),
					});
					modelRuntime.registerProvider(PROVIDER, {
						baseUrl: faux.getModel().baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: faux.models,
					});
					const settingsManager = SettingsManager.inMemory({
						compaction: { enabled: false },
						retry: { enabled: false },
						sessionSummary: { enabled: false },
					});
					const runtime = await createAgentSessionRuntime(
						async (options) => {
							const services = await createAgentSessionServices({ ...options, modelRuntime, settingsManager });
							const created = await createAgentSessionFromServices({
								services,
								sessionManager: options.sessionManager,
								model: faux.getModel("parent"),
								builtins: { subagents: true, mcp: false, intercom: false, "web-access": false },
							});
							return { ...created, services, diagnostics: services.diagnostics };
						},
						{ cwd, agentDir: cwd, sessionManager: manager },
					);
					const records = async () =>
						(await direct.load(sessionId)).entries.flatMap((entry) =>
							entry.type === "custom" && entry.customType === "subagent-child"
								? [entry.data as { state: string; terminalStatus?: string; childSessionId?: string }]
								: [],
						);
					const reply: FauxResponseFactory = async (context, _options, _state, model) => {
						if (model.id === CHILD_MODEL) {
							childResponding.resolve();
							await respond.promise;
							return fauxAssistantMessage(CHILD_ANSWER);
						}
						const last = context.messages.at(-1);
						if (last?.role === "toolResult") {
							parentResponding.resolve();
							await respond.promise;
							return fauxAssistantMessage(FIRST_ANSWER);
						}
						if (last?.role !== "user" || !JSON.stringify(last.content).includes("Continue."))
							return fauxAssistantMessage("completion acknowledged");
						await vi.waitFor(
							async () => {
								assert.ok((await records()).some((record) => record.state === "terminal"));
							},
							{ timeout: 15_000, interval: 50 },
						);
						return fauxAssistantMessage(SECOND_ANSWER);
					};
					faux.setResponses([
						fauxAssistantMessage(fauxToolCall("subagent", { agent: "recovery-helper", task: "Answer." }), {
							stopReason: "toolUse",
						}),
						...Array.from({ length: 6 }, () => reply),
					]);
					const stdout = vi
						.spyOn(process.stdout, "write")
						.mockImplementation(
							(
								_chunk: string | Uint8Array,
								encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
								callback?: (error?: Error | null) => void,
							) => {
								if (typeof encodingOrCallback === "function") encodingOrCallback();
								else callback?.();
								return true;
							},
						);
					const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
					const printed = runPrintMode(runtime, {
						mode: "json",
						initialMessage: "Delegate the answer.",
						messages: action === "abort" ? [] : ["Continue."],
					});
					try {
						await Promise.race([
							Promise.all([parentResponding.promise, childResponding.promise]),
							printed.then((code) => assert.fail(`headless session ended early: ${code}`)),
						]);
						assert.ok((await records()).some((record) => record.state === "running"));
						offline = true;
						for (const socket of sockets) socket.destroy();
						respond.resolve();
						const elapsed = sleep(outageMs);
						if (action === "takeover") takeover(url, sessionId);
						await elapsed;
						if (action === "abort") {
							await runtime.session.abort();
							assert.equal(await printed, 1, "the stopped run finishes without the connection returning");
							return;
						}
						offline = false;
						const exit = await printed;
						const errors = stderr.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
						const saved = (await direct.load(sessionId)).entries;
						if (action === "takeover") {
							assert.equal(exit, 1, errors);
							assert.match(errors, /Another process wrote to session/);
							assert.equal(saved.filter((entry) => includesMessage(entry, PEER_WRITE)).length, 1);
							assert.doesNotMatch(JSON.stringify(saved), /parent saved after reconnect|Continue\./);
							return;
						}
						assert.equal(exit, 0, errors);
						if (outageMs === LONG_OUTAGE_MS) {
							assert.match(errors, /Waiting for PostgreSQL to reconnect to save this session \(\d+s elapsed\)/);
							assert.match(errors, /PostgreSQL reconnected after \d+s; session changes saved/);
						}
						for (const text of ["Delegate the answer.", FIRST_ANSWER, "Continue.", SECOND_ANSWER])
							assert.equal(saved.filter((entry) => includesMessage(entry, text)).length, 1, text);
						const terminal = (await records()).filter((record) => record.state === "terminal");
						assert.equal(terminal.length, 1);
						assert.equal(terminal[0]?.terminalStatus, "ok");
						assert.ok(terminal[0]?.childSessionId);
						const child = (await direct.load(terminal[0].childSessionId)).entries;
						assert.equal(child.filter((entry) => includesMessage(entry, CHILD_ANSWER)).length, 1);
					} finally {
						offline = false;
						respond.resolve();
						try {
							await runtime.dispose();
							await printed.catch(() => {});
						} finally {
							stdout.mockRestore();
							stderr.mockRestore();
						}
					}
				} finally {
					vi.unstubAllEnvs();
					faux.unregister();
					await proxy.close();
					removeTempDirectory(cwd);
				}
			});
		},
		LIVE_SESSION_TEST_TIMEOUT_MS,
	);
});
