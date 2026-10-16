import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import * as storage from "../src/core/session-manager-storage.ts";
import { removeTempDirs, runCliProcess } from "./cli-test-helpers.ts";

const tempDirs: string[] = [];

afterEach(() => {
	removeTempDirs(tempDirs);
	vi.restoreAllMocks();
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-session-id-readonly-"));
	tempDirs.push(dir);
	return dir;
}

function hasSessionWithId(root: string, sessionId: string): boolean {
	if (!existsSync(root)) return false;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory() && hasSessionWithId(path, sessionId)) return true;
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

		try {
			const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
			const header = JSON.parse(firstLine) as { type?: string; id?: string };
			if (header.type === "session" && header.id === sessionId) return true;
		} catch {
			// Ignore malformed session files.
		}
	}
	return false;
}

interface CliDirs {
	agentDir: string;
	projectDir: string;
	sessionDir: string;
}

async function runCli(
	args: string[] | ((dirs: CliDirs) => string[]),
	setup?: (dirs: CliDirs) => void,
): Promise<{ code: number | null; agentDir: string; stderr: string }> {
	const tempRoot = createTempDir();
	const dirs: CliDirs = {
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		sessionDir: join(tempRoot, "sessions"),
	};
	mkdirSync(dirs.agentDir, { recursive: true });
	mkdirSync(dirs.projectDir, { recursive: true });
	setup?.(dirs);
	const resolvedArgs = typeof args === "function" ? args(dirs) : args;

	const result = await runCliProcess(resolvedArgs, {
		cwd: dirs.projectDir,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: dirs.agentDir,
			ATOMIC_OFFLINE: "1",
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
	});
	return { code: result.code, agentDir: dirs.agentDir, stderr: result.stderr };
}

function writeSession(sessionDir: string, cwd: string, id: string): void {
	writeFileSync(
		join(sessionDir, `${id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 4, id, createdAt: new Date().toISOString(), cwd: realpathSync(cwd) })}\n`,
	);
}

describe("--session-id read-only commands", () => {
	it("does not reserve a session for --help", async () => {
		const result = await runCli(["--session-id", "read-only-help", "--help"]);

		expect(result.code).toBe(0);
		expect(hasSessionWithId(join(result.agentDir, "sessions"), "read-only-help")).toBe(false);
	});

	it("does not reserve a session for --list-models", async () => {
		const result = await runCli(["--session-id", "read-only-models", "--list-models"]);

		expect(result.code).toBe(0);
		expect(hasSessionWithId(join(result.agentDir, "sessions"), "read-only-models")).toBe(false);
	});

	it("rejects an existing fork target session id", async () => {
		const result = await runCli(
			(dirs) => ["--session-dir", dirs.sessionDir, "--fork", "source-id", "--session-id", "existing-id", "-p", "hi"],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeSession(dirs.sessionDir, dirs.projectDir, "source-id");
				writeSession(dirs.sessionDir, dirs.projectDir, "existing-id");
			},
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Session already exists with id 'existing-id'");
	});

	it("warns when an exact session id is missing and a new session is created", async () => {
		const result = await runCli((dirs) => [
			"--session-dir",
			dirs.sessionDir,
			"--session-id",
			"missing-id",
			"-p",
			"hi",
		]);

		expect(result.stderr).toContain("No session found with id 'missing-id'; creating a new session");
	});

	it("does not warn when an exact session id exists", async () => {
		const result = await runCli(
			(dirs) => ["--session-dir", dirs.sessionDir, "--session-id", "existing-id", "-p", "hi"],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeSession(dirs.sessionDir, dirs.projectDir, "existing-id");
			},
		);

		expect(result.stderr).not.toContain("No session found with id 'existing-id'");
	});
});

describe("--session-id validation", () => {
	it("rejects ids invalid under SessionManager rules without stack traces", async () => {
		for (const id of ["-bad", "bad id"]) {
			const result = await runCli(["--session-id", id, "-p", "hi"]);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Session id must be non-empty");
			expect(result.stderr).not.toContain("SessionManager.create");
		}
	});
});

describe("exact session header discovery", () => {
	it("finds header IDs in renamed files without listing or loading transcripts", async () => {
		const dir = createTempDir();
		const file = join(dir, "renamed.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 4, createdAt: new Date().toISOString(), id: "exact-id", cwd: dir })}\n${"not-json\n".repeat(100_000)}`,
		);
		const before = readFileSync(file);
		const list = vi.spyOn(SessionManager, "list").mockRejectedValue(new Error("must not list"));
		const load = vi.spyOn(storage, "loadEntriesFromFile").mockImplementation(() => {
			throw new Error("must not load transcript");
		});
		expect(await SessionManager.findById(dir, "exact-id", dir)).toBe(file);
		expect(await SessionManager.findById(dir, "exact", dir)).toBeUndefined();
		expect(await SessionManager.findById(dir, " exact-id", dir)).toBeUndefined();
		expect(list).not.toHaveBeenCalled();
		expect(load).not.toHaveBeenCalled();
		expect(readFileSync(file)).toEqual(before);
	});

	it("filters shared-directory cwd and internal workflow headers while ignoring malformed entries", async () => {
		const dir = createTempDir();
		const file = join(dir, "session.jsonl");
		writeFileSync(join(dir, "malformed.jsonl"), "not-json\n");
		writeFileSync(join(dir, "wrong-type.jsonl"), JSON.stringify({ type: "message", id: "exact-id", cwd: dir }));
		writeFileSync(join(dir, "ignored.txt"), JSON.stringify({ type: "session", id: "exact-id", cwd: dir }));
		mkdirSync(join(dir, "directory.jsonl"));
		for (const cwd of [undefined, "", join(dir, "other")]) {
			writeFileSync(file, JSON.stringify({ type: "session", id: "exact-id", cwd }));
			expect(await SessionManager.findById(dir, "exact-id", dir)).toBeUndefined();
		}
		writeFileSync(
			file,
			JSON.stringify({
				type: "session",
				version: 4,
				createdAt: new Date().toISOString(),
				id: "exact-id",
				cwd: dir,
				internal: true,
				workflow: { runId: "run", stageId: "stage", stageName: "name" },
			}),
		);
		expect(await SessionManager.findById(dir, "exact-id", dir)).toBeUndefined();
		// Incomplete ownership markers stay visible, matching Atomic's list policy.
		writeFileSync(
			file,
			JSON.stringify({
				type: "session",
				version: 4,
				createdAt: new Date().toISOString(),
				id: "exact-id",
				cwd: dir,
				internal: true,
			}),
		);
		expect(await SessionManager.findById(dir, "exact-id", dir)).toBe(file);
		expect(await SessionManager.findById(dir, "exact-id", join(dir, "missing"))).toBeUndefined();
	});
});
