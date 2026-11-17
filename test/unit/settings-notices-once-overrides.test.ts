import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, type MockInstance, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.js";
import { runMigrations } from "../../packages/coding-agent/src/migrations.js";
import {
	clearDeprecationWarningsForTests,
	loadShownDeprecationNotices,
	saveShownDeprecationNotices,
} from "../../packages/coding-agent/src/utils/deprecation.js";
import { discoverAgents } from "../../packages/subagents/src/agents/agents.js";

const CONSTRAINTS = { allowedProviders: ["anthropic"] };

describe("override routing fields in settings files Atomic does not write are named once across starts", () => {
	let root: string;
	let home: string;
	let agentDir: string;
	let warn: MockInstance<typeof console.warn>;

	const notices = () =>
		warn.mock.calls.map((call) => String(call[0])).filter((line) => /modelConstraints|taskNeeds/.test(line));
	/** One Atomic start in `cwd`: the shown-notice record, the startup migrations, then subagent discovery. */
	const start = async (cwd: string) => {
		loadShownDeprecationNotices(agentDir);
		runMigrations(cwd, { projectTrusted: true });
		await discoverAgents(cwd, "both", { projectTrusted: true });
	};
	const nextProcess = () => {
		saveShownDeprecationNotices();
		clearDeprecationWarningsForTests();
		warn.mockClear();
	};
	const overrides = (worker: Record<string, unknown>) => JSON.stringify({ subagents: { agentOverrides: { worker } } });

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-override-notices-once-")));
		home = join(root, "home");
		agentDir = join(home, ".atomic", "agent");
		mkdirSync(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, undefined);
		vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
		clearDeprecationWarningsForTests();
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
		vi.unstubAllEnvs();
		clearDeprecationWarningsForTests();
		rmSync(root, { recursive: true, force: true });
	});

	it("from a parent directory's project settings when Atomic starts in a subdirectory", async () => {
		const project = join(root, "project");
		const cwd = join(project, "packages", "app");
		mkdirSync(join(project, ".atomic"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const parentSettings = join(project, ".atomic", "settings.json");
		const saved = overrides({ modelConstraints: CONSTRAINTS });
		writeFileSync(parentSettings, saved);

		await start(cwd);
		assert.equal(notices().length, 1, notices().join("\n"));
		nextProcess();
		await start(cwd);
		assert.deepEqual(notices(), [], "a later start shows nothing");
		assert.equal(readFileSync(parentSettings, "utf-8"), saved, "a file Atomic does not write stays as it is");

		writeFileSync(parentSettings, overrides({ modelConstraints: { allowedProviders: ["openai"] } }));
		nextProcess();
		await start(cwd);
		assert.equal(notices().length, 1, "a changed value is named again");
	});

	it("from the legacy agent directory's settings", async () => {
		const cwd = join(root, "elsewhere");
		mkdirSync(cwd, { recursive: true });
		const legacy = join(home, ".pi", "agent", "settings.json");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(legacy, overrides({ taskNeeds: { work: "coding" } }));

		await start(cwd);
		assert.equal(notices().length, 1, notices().join("\n"));
		nextProcess();
		await start(cwd);
		assert.deepEqual(notices(), []);
	});
});
