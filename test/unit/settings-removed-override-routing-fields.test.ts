import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, it, type MockInstance, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.js";
import { runMigrations, runMigrationsAsync } from "../../packages/coding-agent/src/migrations.js";
import { clearDeprecationWarningsForTests } from "../../packages/coding-agent/src/utils/deprecation.js";
import { discoverAgents } from "../../packages/subagents/src/agents/agents.js";

const CONSTRAINTS = { allowedProviders: ["anthropic"], excludedModels: ["*-mini"] };
const NEEDS = { work: "coding", difficulty: "hard" };
const REMOVED_GLOBAL =
	'Removed the "modelConstraints" and "taskNeeds" settings from the subagent overrides for "worker" and "debugger" in global settings: automatic model routing was removed, so "auto" runs your default model and its provider and model restrictions no longer limit "auto" or any fallback model.';

describe("startup removes saved modelConstraints and taskNeeds from subagent overrides once", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let warn: MockInstance<typeof console.warn>;

	const globalPath = () => join(agentDir, "settings.json");
	const projectPath = () => join(cwd, ".atomic", "settings.json");
	const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf-8"));
	const notices = () =>
		warn.mock.calls.map((call) => String(call[0])).filter((line) => /modelConstraints|taskNeeds/.test(line));
	/** One Atomic start: its startup migrations, then the subagent discovery that reads the overrides. */
	const start = async (projectTrusted: boolean) => {
		runMigrations(cwd, { projectTrusted });
		await discoverAgents(cwd, "both", { projectTrusted });
	};
	/** A later Atomic start: a new process has shown no notices yet. */
	const nextProcess = () => {
		clearDeprecationWarningsForTests();
		warn.mockClear();
	};

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-removed-override-routing-")));
		const home = join(root, "home");
		agentDir = join(home, ".atomic", "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
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

	it("deletes the fields from global and trusted project settings, keeping every other key, and says so once", async () => {
		const globalSaved = {
			theme: "dark",
			subagents: {
				disableBuiltins: false,
				agentOverrides: {
					worker: { model: "anthropic/claude-sonnet-5", modelConstraints: CONSTRAINTS, thinking: "high" },
					debugger: { taskNeeds: NEEDS },
					reviewer: { model: "openai/gpt-6" },
				},
			},
		};
		const projectSaved = {
			defaultThinkingLevel: "high",
			subagents: { agentOverrides: { worker: { taskNeeds: NEEDS, tools: ["read"] } } },
		};
		writeFileSync(globalPath(), JSON.stringify(globalSaved));
		mkdirSync(join(cwd, ".atomic"));
		writeFileSync(projectPath(), JSON.stringify(projectSaved));

		await start(true);

		assert.deepEqual(readJson(globalPath()), {
			theme: "dark",
			subagents: {
				disableBuiltins: false,
				agentOverrides: {
					worker: { model: "anthropic/claude-sonnet-5", thinking: "high" },
					debugger: {},
					reviewer: { model: "openai/gpt-6" },
				},
			},
		});
		assert.deepEqual(readJson(projectPath()), {
			defaultThinkingLevel: "high",
			subagents: { agentOverrides: { worker: { tools: ["read"] } } },
		});
		const shown = notices();
		assert.equal(shown.length, 2, shown.join("\n"));
		assert.ok(
			shown.some((line) => line.includes(REMOVED_GLOBAL)),
			shown.join("\n"),
		);
		assert.ok(
			shown.some((line) =>
				line.includes(
					'Removed the "taskNeeds" setting from the subagent override for "worker" in project settings',
				),
			),
			shown.join("\n"),
		);

		nextProcess();
		await start(true);
		assert.deepEqual(notices(), [], "a later start shows nothing");
	});

	it("leaves an untrusted project's file unchanged until the project is trusted", async () => {
		mkdirSync(join(cwd, ".atomic"));
		const content = JSON.stringify({
			theme: "light",
			subagents: { agentOverrides: { worker: { taskNeeds: NEEDS } } },
		});
		writeFileSync(projectPath(), content);

		await start(false);
		assert.equal(readFileSync(projectPath(), "utf-8"), content);
		assert.deepEqual(notices(), []);

		nextProcess();
		await start(true);
		assert.deepEqual(readJson(projectPath()), { theme: "light", subagents: { agentOverrides: { worker: {} } } });
		const shown = notices();
		assert.equal(shown.length, 1, shown.join("\n"));
		assert.match(shown[0]!, /Removed the "taskNeeds" setting/);
	});

	it("removes them from a project trusted after startup with the asynchronous migrations, and says so once", async () => {
		mkdirSync(join(cwd, ".atomic"));
		const content = JSON.stringify({
			theme: "light",
			subagents: { agentOverrides: { worker: { taskNeeds: NEEDS, model: "openai/gpt-6" } } },
		});
		writeFileSync(projectPath(), content);
		await start(false);
		assert.equal(readFileSync(projectPath(), "utf-8"), content);

		await runMigrationsAsync(cwd, { projectTrusted: true });
		await discoverAgents(cwd, "both", { projectTrusted: true });
		assert.deepEqual(readJson(projectPath()), {
			theme: "light",
			subagents: { agentOverrides: { worker: { model: "openai/gpt-6" } } },
		});
		const shown = notices();
		assert.equal(shown.length, 1, shown.join("\n"));
		assert.match(
			shown[0]!,
			/Removed the "taskNeeds" setting from the subagent override for "worker" in project settings/,
		);

		nextProcess();
		await runMigrationsAsync(cwd, { projectTrusted: true });
		await discoverAgents(cwd, "both", { projectTrusted: true });
		assert.deepEqual(notices(), [], "a later start shows nothing");
	});

	it("keeps the file and starts when it cannot be written, and each field is reported as ignored once", async () => {
		const content = JSON.stringify({
			theme: "dark",
			subagents: { agentOverrides: { worker: { modelConstraints: CONSTRAINTS, taskNeeds: NEEDS } } },
		});
		writeFileSync(globalPath(), content);
		const release = lockfile.lockSync(globalPath(), { realpath: false, stale: 60_000 });
		try {
			await start(true);
			await discoverAgents(cwd, "both", { projectTrusted: true });

			assert.equal(readFileSync(globalPath(), "utf-8"), content);
			const shown = notices();
			assert.equal(shown.length, 2, shown.join("\n"));
			assert.ok(
				shown.some((line) => line.includes('"modelConstraints" is ignored')),
				shown.join("\n"),
			);
			assert.ok(
				shown.some((line) => line.includes('"taskNeeds" is ignored')),
				shown.join("\n"),
			);
		} finally {
			release();
		}
	});
});
