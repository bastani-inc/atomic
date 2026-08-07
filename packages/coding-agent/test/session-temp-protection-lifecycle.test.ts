/**
 * Protection of tool-output storage is a lease, not a permanent registration.
 *
 * A live session must keep its temp tree and `tool-results` directory out of the
 * sweeper's reach; a session that is gone must stop doing so, or the startup GC
 * can never collect the tree it exists to collect. Because a background writer
 * can outlive the session object that started it, the claim is refcounted.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createAsyncOutputAppender } from "../src/core/tools/bash-async-output.ts";
import {
	CLEANUP_MARKER_FILE,
	runSessionTempCleanup,
	SESSION_TEMP_CLEANUP_INTERVAL_MS,
} from "../src/core/tools/session-temp-cleanup.ts";
import {
	acquireProtectedPaths,
	getProtectedSessionTempDirs,
	getTempRootDir,
	resetSessionTempDirStateForTesting,
	resolveSessionTempDirPath,
} from "../src/core/tools/session-temp-dir.ts";
import { TOOL_RESULTS_SUBDIR } from "../src/core/tools/tool-limits.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const model = getModel("anthropic", "claude-sonnet-4-5")!;

const envKeys = ["TMPDIR", "TEMP", "TMP"] as const;
const savedEnv = new Map<string, string | undefined>();
let sandbox: string;
let controlRoot: string;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-temp-lease-")));
	controlRoot = join(sandbox, "control");
	for (const key of envKeys) {
		savedEnv.set(key, process.env[key]);
		process.env[key] = sandbox;
	}
	resetSessionTempDirStateForTesting();
});

afterEach(() => {
	for (const key of envKeys) {
		const saved = savedEnv.get(key);
		if (saved === undefined) delete process.env[key];
		else process.env[key] = saved;
	}
	resetSessionTempDirStateForTesting();
	rmSync(sandbox, { recursive: true, force: true });
});

/** A directory holding one file, both stamped `ageDays` old. */
function makeAgedTree(parent: string, name: string, ageDays: number): string {
	const dir = join(parent, name);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "output.log");
	writeFileSync(file, "output");
	const seconds = (NOW - ageDays * MS_PER_DAY) / 1000;
	utimesSync(file, seconds, seconds);
	utimesSync(dir, seconds, seconds);
	return dir;
}

/**
 * Age the temp root's throttle marker instead of advancing the clock. The marker
 * is read from its real mtime, so "now plus a day" arithmetic only holds while
 * the test is fast, and this suite must not depend on machine load.
 */
function expireCleanupMarker(tempRoot: string): void {
	const marker = join(tempRoot, CLEANUP_MARKER_FILE);
	if (!existsSync(marker)) return;
	const seconds = (NOW - SESSION_TEMP_CLEANUP_INTERVAL_MS - 1000) / 1000;
	utimesSync(marker, seconds, seconds);
}

function sweepTempRoot(tempRoot: string, phase: "initial" | "again" = "initial"): void {
	if (phase === "again") expireCleanupMarker(tempRoot);
	runSessionTempCleanup({ now: NOW, tempRoot, sessionsRoots: [], controlRoot });
}

describe("protected-path leases", () => {
	it("keeps a tree while the lease is held and releases it afterwards", () => {
		const tempRoot = join(sandbox, "temp-root");
		mkdirSync(tempRoot, { recursive: true });
		const tree = makeAgedTree(tempRoot, "old-session", 60);

		const lease = acquireProtectedPaths([tree]);
		sweepTempRoot(tempRoot);
		assert.equal(existsSync(tree), true, "a held lease keeps the tree");

		lease.release();
		sweepTempRoot(tempRoot, "again");
		assert.equal(existsSync(tree), false, "a released tree becomes reapable");
	});

	it("refcounts duplicate claims so one release cannot unprotect a tree in use", () => {
		const tempRoot = join(sandbox, "temp-root");
		mkdirSync(tempRoot, { recursive: true });
		const tree = makeAgedTree(tempRoot, "shared-session", 60);

		const first = acquireProtectedPaths([tree]);
		const second = acquireProtectedPaths([tree]);

		first.release();
		sweepTempRoot(tempRoot);
		assert.equal(existsSync(tree), true, "the second holder still needs it");

		second.release();
		sweepTempRoot(tempRoot, "again");
		assert.equal(existsSync(tree), false);
	});

	it("ignores a double release", () => {
		const tree = join(sandbox, "double-release");
		const lease = acquireProtectedPaths([tree]);
		const other = acquireProtectedPaths([tree]);

		lease.release();
		lease.release();

		assert.equal(getProtectedSessionTempDirs().has(tree), true, "the other holder's claim survives");
		other.release();
		assert.equal(getProtectedSessionTempDirs().has(tree), false);
	});

	it("keeps a tree an async spill writer is still using after its session let go", async () => {
		const sessionTempDir = resolveSessionTempDirPath("writer-session");
		mkdirSync(sessionTempDir, { recursive: true, mode: 0o700 });
		const sessionLease = acquireProtectedPaths([sessionTempDir]);

		const job: { output: string; fullOutputPath?: string } = { output: "" };
		const appender = createAsyncOutputAppender(job, { persistAfterBytes: 8, sessionTempDir });
		appender.append(Buffer.from("background output that spills\n", "utf8"));
		assert.ok(job.fullOutputPath, "the writer opened a spill file");

		// The session is disposed while the background job is still running.
		sessionLease.release();
		const ageTree = (): void => {
			const seconds = (NOW - 60 * MS_PER_DAY) / 1000;
			utimesSync(job.fullOutputPath!, seconds, seconds);
			utimesSync(sessionTempDir, seconds, seconds);
		};
		ageTree();

		sweepTempRoot(getTempRootDir());
		assert.equal(existsSync(job.fullOutputPath), true, "the writer's own lease keeps the tree alive");

		await appender.close();
		// Closing flushes, which refreshes the mtime; age it again so the sweep is
		// deciding on the lease rather than on freshness.
		ageTree();
		sweepTempRoot(getTempRootDir(), "again");
		assert.equal(existsSync(sessionTempDir), false, "once the writer closes, the stale tree is reaped");
	});
});

describe("AgentSession storage protection", () => {
	async function createSession(sessionDir?: string): Promise<AgentSession> {
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		return new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				streamFn: streamSimple,
				initialState: { model, systemPrompt: "You are a helpful assistant.", tools: [], thinkingLevel: "high" },
			}),
			sessionManager: sessionDir ? SessionManager.create(process.cwd(), sessionDir) : SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});
	}

	it("protects the session temp tree while live and releases it on dispose", async () => {
		const session = await createSession();
		const tempDir = resolveSessionTempDirPath(session.sessionManager.getSessionId());

		assert.equal(getProtectedSessionTempDirs().has(tempDir), true, "a live session protects its temp tree");

		session.dispose();

		assert.equal(getProtectedSessionTempDirs().has(tempDir), false, "a disposed session protects nothing");
	});

	it("protects a disk-backed session's tool-results directory until disposal", async () => {
		const sessionDir = join(sandbox, "disk-sessions");
		const session = await createSession(sessionDir);
		const toolResults = join(session.sessionManager.getSessionDir(), TOOL_RESULTS_SUBDIR);

		assert.equal(getProtectedSessionTempDirs().has(toolResults), true);

		session.dispose();

		assert.equal(getProtectedSessionTempDirs().has(toolResults), false);
	});

	it("keeps a replacement session's storage protected when the session it replaced is disposed", async () => {
		const sessionDir = join(sandbox, "replaced-sessions");
		const outgoing = await createSession(sessionDir);
		const incoming = await createSession(sessionDir);
		const toolResults = join(sessionDir, TOOL_RESULTS_SUBDIR);

		outgoing.dispose();

		assert.equal(
			getProtectedSessionTempDirs().has(toolResults),
			true,
			"the replacement still holds its own claim on the shared directory",
		);

		incoming.dispose();
		assert.equal(getProtectedSessionTempDirs().has(toolResults), false);
	});
});
