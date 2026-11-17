import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, it, type MockInstance, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { runMigrations } from "../src/migrations.js";
import { clearDeprecationWarningsForTests, setDeprecationWarningSink } from "../src/utils/deprecation.js";
import { runCliProcess } from "./cli-test-helpers.js";

/** A real CLI process transpiles the CLI graph before it reads any settings. */
const REAL_CLI_PROCESS_TIMEOUT_MS = 120_000;

const ROUTING = { allowedProviders: ["anthropic"], excludedModels: ["*-mini"] };
const REMOVED_GLOBAL =
	'Removed the "modelRouting" setting from global settings: automatic model routing was removed, so "auto" runs your default model and its provider and model restrictions no longer limit "auto" or any fallback model.';

describe("startup removes a saved modelRouting setting from the settings file once", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let warn: MockInstance<typeof console.warn>;

	const globalPath = () => join(agentDir, "settings.json");
	const projectPath = () => join(cwd, ".atomic", "settings.json");
	const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf-8"));
	const notices = () => warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("modelRouting"));
	/** A later Atomic start: a new process has shown no notices yet. */
	const nextProcess = () => {
		clearDeprecationWarningsForTests();
		warn.mockClear();
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-removed-model-routing-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		clearDeprecationWarningsForTests();
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
		vi.unstubAllEnvs();
		clearDeprecationWarningsForTests();
		rmSync(root, { recursive: true, force: true });
	});

	it("deletes the key from global and trusted project settings, keeping every other key, and says so once", () => {
		const globalSaved = { theme: "dark", modelRouting: ROUTING, retry: { maxDelayMs: 5000 }, queueMode: "all" };
		const projectSaved = { modelRouting: ["not-an-object"], defaultThinkingLevel: "high" };
		writeFileSync(globalPath(), JSON.stringify(globalSaved));
		mkdirSync(join(cwd, ".atomic"));
		writeFileSync(projectPath(), JSON.stringify(projectSaved));

		runMigrations(cwd, { projectTrusted: true });

		const { modelRouting: _global, ...globalKept } = globalSaved;
		const { modelRouting: _project, ...projectKept } = projectSaved;
		assert.deepEqual(readJson(globalPath()), globalKept, "only modelRouting left the global file");
		assert.deepEqual(readJson(projectPath()), projectKept, "only modelRouting left the project file");
		const shown = notices();
		assert.equal(shown.length, 2, shown.join("\n"));
		assert.ok(shown.some((line) => line.includes(REMOVED_GLOBAL)));
		assert.ok(shown.some((line) => line.includes('Removed the "modelRouting" setting from project settings')));

		nextProcess();
		runMigrations(cwd, { projectTrusted: true });
		const later = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		assert.deepEqual(notices(), [], "a later start shows nothing");
		assert.equal(later.getSettings().theme, "dark");
		assert.deepEqual(later.drainErrors(), []);
	});

	it("leaves an untrusted project's file unchanged until the project is trusted", () => {
		mkdirSync(join(cwd, ".atomic"));
		const content = JSON.stringify({ modelRouting: ROUTING, theme: "light" });
		writeFileSync(projectPath(), content);

		runMigrations(cwd, { projectTrusted: false });
		assert.equal(readFileSync(projectPath(), "utf-8"), content);
		assert.deepEqual(notices(), []);

		runMigrations(cwd, { projectTrusted: true });
		assert.deepEqual(readJson(projectPath()), { theme: "light" }, "trusting the project removes it");
		assert.equal(notices().length, 1, notices().join("\n"));
	});

	it("creates no settings file where there was none", () => {
		runMigrations(cwd, { projectTrusted: true });

		assert.equal(existsSync(join(cwd, ".atomic")), false);
		assert.equal(existsSync(globalPath()), false);
	});

	it("keeps the file and starts when it cannot be written, and the key is reported as ignored once", () => {
		const content = JSON.stringify({ theme: "dark", modelRouting: ROUTING });
		writeFileSync(globalPath(), content);
		const release = lockfile.lockSync(globalPath(), { realpath: false, stale: 60_000 });
		try {
			runMigrations(cwd, { projectTrusted: true });
			const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
			SettingsManager.create(cwd, agentDir, { projectTrusted: true });

			assert.equal(readFileSync(globalPath(), "utf-8"), content);
			assert.equal(manager.getSettings().theme, "dark");
			assert.deepEqual(manager.drainErrors(), []);
			const shown = notices();
			assert.equal(shown.length, 1, shown.join("\n"));
			assert.match(shown[0]!, /Ignored removed setting "modelRouting"/);
		} finally {
			release();
		}
	});

	it("shows a removal made before the UI starts in the UI once it owns the terminal", () => {
		writeFileSync(globalPath(), JSON.stringify({ theme: "dark", modelRouting: ROUTING }));

		runMigrations(cwd, { projectTrusted: false });
		const shown: string[] = [];
		setDeprecationWarningSink((message) => shown.push(message))();
		setDeprecationWarningSink((message) => shown.push(message))();

		assert.deepEqual(shown, [REMOVED_GLOBAL]);
	});
});

describe("atomic -p with a saved modelRouting setting", () => {
	it(
		"says once that it removed the key on the first start, and nothing on the next",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-removed-model-routing-cli-"));
			try {
				const agentDir = join(root, "agent");
				const cwd = join(root, "project");
				mkdirSync(agentDir, { recursive: true });
				mkdirSync(cwd, { recursive: true });
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", modelRouting: ROUTING }));
				const start = async () => {
					const result = await runCliProcess(["-p", "hi", "--no-session", "--no-extensions", "--no-skills"], {
						cwd,
						timeoutMs: REAL_CLI_PROCESS_TIMEOUT_MS,
						env: {
							...process.env,
							[ENV_AGENT_DIR]: agentDir,
							ATOMIC_OFFLINE: "1",
							ATOMIC_SKIP_VERSION_CHECK: "1",
							ATOMIC_INTERACTIVE_ENGINE_CHILD: undefined,
							ATOMIC_INTERCOM_GROUP: undefined,
							PI_INTERCOM_GROUP: undefined,
							NO_COLOR: "1",
						},
					});
					assert.equal(result.timedOut, false, result.stderr);
					return result.stderr.split("\n").filter((line) => line.includes('"modelRouting"'));
				};

				const first = await start();
				assert.equal(first.length, 1, first.join("\n"));
				assert.match(first[0]!, /Removed the "modelRouting" setting from global settings/);
				assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")), { theme: "dark" });
				assert.deepEqual(await start(), [], "the next start says nothing");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		REAL_CLI_PROCESS_TIMEOUT_MS * 2,
	);
});
