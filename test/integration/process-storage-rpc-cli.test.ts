import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import {
	bunExecutable,
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	readText,
	spawnSyncCollect,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

/**
 * Structural: two real source CLI children each load every builtin extension and persist a conversation, followed by four more children that must fail during startup.
 */
const REAL_RPC_CHILDREN_TIMEOUT_MS = 240_000;
/** Per-step deadline once a child answers. */
const STEP_TIMEOUT_MS = 60_000;
/**
 * The first request goes out as soon as a child is spawned, so it also waits for the child's cold start: the source CLI
 * under Bun loading every builtin extension, two children at once. A loaded Windows runner stretched that past the
 * client's default 30 s (the whole test takes 9 s there otherwise). Well inside REAL_RPC_CHILDREN_TIMEOUT_MS, which also
 * covers the children's later steps.
 */
const COLD_CLI_START_REQUEST_TIMEOUT_MS = 60_000;

const repositoryRoot = join(moduleDir(import.meta.url), "../..");
const cliPath = join(repositoryRoot, "packages/coding-agent/src/cli.ts");
const adapterPath = join(repositoryRoot, "test/fixtures/storage-adapter.ts");
const SECRET = "issue-3783-secret-value";

/** Inherited storage selections would decide the outcome instead of the scenario. */
const CLEARED_STORAGE_ENV = {
	ATOMIC_STORAGE: "",
	ATOMIC_SESSIONS_STORAGE: "",
	ATOMIC_WORKFLOWS_JOURNAL: "",
	ATOMIC_WORKFLOW_JOURNAL_PATH: "",
	ATOMIC_CODING_AGENT_SESSION_DIR: "",
};

interface ChildEvidence {
	readonly sessionId: string;
	readonly listedSessions: readonly string[];
}

async function driveChild(client: RpcClient, label: string): Promise<ChildEvidence> {
	await client.start();
	await client.setSessionName(`${label} conversation`);
	const { sessionId } = await client.getState();
	await client.promptAndWait("Say hello");
	const listedSessions = (await client.listSessions()).map((session) => session.id);
	return { sessionId, listedSessions };
}

async function storedSessions(project: string, path: string): Promise<string[]> {
	const store = await resolveSessionStore(project, { sessionStore: { kind: "sqlite", path } });
	try {
		return (await SessionManager.list(project, store)).map((session) => session.id);
	} finally {
		await store.close();
	}
}

test(
	"an RPC child keeps sessions in its ATOMIC_STORAGE adapter while a sibling keeps its settings (#3783)",
	async () => {
		const root = makeTempDirectory("process-storage-rpc-");
		const atomicHome = join(root, "atomic");
		const agentDir = join(atomicHome, "agent");
		const project = join(root, "project");
		const settingsPath = join(agentDir, "settings.json");
		const selectedStore = join(root, "selected", "process-store.sqlite");
		const settingsStore = join(agentDir, "settings-store.sqlite");
		await writeFileEnsuringDir(
			settingsPath,
			`${JSON.stringify({ onboardedVersion: "0.0.0", storage: { path: "settings-store.sqlite" } }, null, 2)}\n`,
		);
		await writeFileEnsuringDir(
			join(project, ".atomic/extensions/issue-3783-provider.ts"),
			[
				'import { createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";',
				"export default function (pi) {",
				'  pi.registerProvider("issue-3783-fixture", {',
				'    api: "issue-3783-fixture",',
				'    apiKey: "fixture-only",',
				'    baseUrl: "http://127.0.0.1:1/unused",',
				'    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],',
				"    streamSimple(model) {",
				"      const stream = createAssistantMessageEventStream();",
				"      const message = {",
				'        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),',
				'        content: [{ type: "text", text: "hello" }], stopReason: "stop",',
				"        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },",
				"      };",
				'      queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });',
				"      return stream;",
				"    },",
				"  });",
				"}",
			].join("\n"),
		);
		const settingsBefore = await readText(settingsPath);
		const childOptions = (env: Record<string, string>) =>
			new RpcClient({
				cliPath,
				cwd: project,
				runtimeExecutable: bunExecutable(),
				requestTimeoutMs: COLD_CLI_START_REQUEST_TIMEOUT_MS,
				args: ["--approve", "--offline", "--provider", "issue-3783-fixture", "--model", "fixture"],
				env: {
					...CLEARED_STORAGE_ENV,
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ANTHROPIC_API_KEY: "test-only-no-requests",
					...env,
				},
			});
		const selected = childOptions({
			ATOMIC_STORAGE: JSON.stringify({
				adapter: adapterPath,
				options: { path: selectedStore },
				secrets: { marker: { env: "ISSUE_3783_SECRET" } },
			}),
			ISSUE_3783_SECRET: SECRET,
		});
		const unselected = childOptions({});
		try {
			const [fromEnv, fromSettings] = await Promise.all([
				driveChild(selected, "env-selected"),
				driveChild(unselected, "settings-selected"),
			]);
			assert.notEqual(fromEnv.sessionId, fromSettings.sessionId);
			assert.deepEqual(fromEnv.listedSessions, [fromEnv.sessionId]);
			assert.deepEqual(fromSettings.listedSessions, [fromSettings.sessionId]);
			await Promise.all([selected.stop(), unselected.stop()]);

			assert.deepEqual(await storedSessions(project, selectedStore), [fromEnv.sessionId]);
			assert.deepEqual(await storedSessions(project, settingsStore), [fromSettings.sessionId]);
			const database = await openNodeSqliteDatabase(selectedStore);
			try {
				// The account's one Intercom broker opens the same adapter for multi-node routing (domain "intercom")
				// when the selected child is the one that started it; it is a separate process, not a child domain.
				const probes = await database.all("SELECT options FROM adapter_probe WHERE domain <> 'intercom'");
				assert.equal(probes.length, 1, "sessions use the selected adapter database");
				assert.ok(String(probes[0]?.options).includes(SECRET), "the { env } secret reached the adapter");
			} finally {
				await database.close();
			}
			assert.equal(fileExistsSync(join(agentDir, "workflows", "journal.sqlite")), false);
			assert.equal(fileExistsSync(join(agentDir, "storage.sqlite")), false);
			assert.equal(await readText(settingsPath), settingsBefore);
		} finally {
			await Promise.all([selected.stop(), unselected.stop()]);
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	REAL_RPC_CHILDREN_TIMEOUT_MS,
);

test(
	"an RPC child with an invalid ATOMIC_STORAGE, even one outranked by --storage or --no-session, or an unreadable --storage-file fails at startup naming it (#3783)",
	async () => {
		const root = makeTempDirectory("process-storage-rpc-invalid-");
		const agentDir = join(root, "agent");
		await writeFileEnsuringDir(join(agentDir, "settings.json"), JSON.stringify({ onboardedVersion: "0.0.0" }));
		try {
			for (const [label, args, env, field] of [
				[
					"env",
					[],
					{ ATOMIC_STORAGE: `{"adapter":"x","options":{"token":"${SECRET}"` },
					"ATOMIC_STORAGE (invalid-json)",
				],
				["file", ["--storage-file", "missing-selection.json"], {}, "--storage-file (unreadable-file)"],
				[
					"env outranked by --storage",
					["--storage", '{"memory":true}'],
					{ ATOMIC_STORAGE: `{"adapter":"x","options":{"token":"${SECRET}"` },
					"ATOMIC_STORAGE (invalid-json)",
				],
				[
					"session env outranked by --no-session",
					["--no-session"],
					{ ATOMIC_SESSIONS_STORAGE: `{"adapter":"x","options":{"token":"${SECRET}"` },
					"ATOMIC_SESSIONS_STORAGE (invalid-json)",
				],
			] as const) {
				const result = spawnSyncCollect([bunExecutable(), cliPath, "--mode", "rpc", "--offline", ...args], {
					cwd: root,
					env: { ...process.env, ...CLEARED_STORAGE_ENV, ATOMIC_CODING_AGENT_DIR: agentDir, ...env },
					timeout: STEP_TIMEOUT_MS,
				});
				const stderr = result.stderr.toString();
				assert.notEqual(result.exitCode, 0, `${label}: ${stderr}`);
				assert.ok(stderr.includes(`Invalid storage configuration: ${field}`), `${label}: ${stderr}`);
				assert.equal(stderr.includes(SECRET), false, `${label} leaked the selection value`);
			}
			assert.equal(fileExistsSync(join(agentDir, "workflows", "journal.sqlite")), false);
			assert.equal(fileExistsSync(join(root, "workflows", "journal.sqlite")), false);
		} finally {
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	REAL_RPC_CHILDREN_TIMEOUT_MS,
);
