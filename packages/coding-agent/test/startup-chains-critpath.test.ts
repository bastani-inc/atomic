import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { hasProjectTrustInputs, hasProjectTrustInputsAsync } from "../src/core/trust-manager.ts";
import { shouldPrewarmInteractiveEngine } from "../src/modes/interactive-engine/engine-prewarm.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("startup serial chains and CLI spare-DB helpers", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-pr3-chains-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("shouldPrewarmInteractiveEngine keeps prewarming plain interactive launches including --no-approve", () => {
		const host = { stdinIsTTY: true, stdoutIsTTY: true, cpus: 8 };
		assert.equal(shouldPrewarmInteractiveEngine([], host), true);
		assert.equal(shouldPrewarmInteractiveEngine(["--approve"], host), true);
		assert.equal(shouldPrewarmInteractiveEngine(["--no-approve"], host), true);
		assert.equal(shouldPrewarmInteractiveEngine(["-na"], host), true);
		assert.equal(shouldPrewarmInteractiveEngine(["--offline", "--no-mcp", "--no-approve"], host), true);
		// Non-interactive launches still skip prewarm.
		assert.equal(shouldPrewarmInteractiveEngine(["-p", "hi"], host), false);
		assert.equal(shouldPrewarmInteractiveEngine(["--help"], host), false);
	});

	it("shouldStartSpareDatabaseThread matches main's mode and storage resolvers across JSON storage, session-dir, env, invalid modes, and subcommands", async () => {
		const mod = await import("../src/utils/startup-database-spare.ts");
		const tty = { stdinIsTTY: true, stdoutIsTTY: true };
		const pipe = { stdinIsTTY: false, stdoutIsTTY: false };
		const memoryStorageFile = join(tempDir, "storage-memory.json");
		const sqliteStorageFile = join(tempDir, "storage-sqlite.json");
		writeFileSync(memoryStorageFile, JSON.stringify({ memory: true }));
		writeFileSync(sqliteStorageFile, JSON.stringify({ path: join(tempDir, "custom.sqlite") }));

		// SQLite-backed runs start the spare thread.
		assert.equal(mod.shouldStartSpareDatabaseThread([], false, tty, {}, tempDir), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--offline", "--approve"], false, tty, {}, tempDir), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["-p", "hello"], false, pipe, {}, tempDir), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--print", "hello"], false, tty, {}, tempDir), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--mode", "rpc"], false, pipe, {}, tempDir), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--mode", "json", "hi"], false, pipe, {}, tempDir), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--mode", "text", "hi"], false, pipe, {}, tempDir), true);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "json", "--storage-file", sqliteStorageFile, "hi"],
				false,
				pipe,
				{},
				tempDir,
			),
			true,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["-p", "--storage", JSON.stringify({ path: join(tempDir, "explicit.sqlite") }), "hi"],
				false,
				pipe,
				{},
				tempDir,
			),
			true,
		);
		// Prewarmed engine obeys NO_DATABASE flag.
		assert.equal(mod.shouldStartSpareDatabaseThread(["--internal-engine-prewarm"], true, pipe, {}, tempDir), true);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--internal-engine-prewarm", "--internal-engine-prewarm-no-database"],
				true,
				pipe,
				{},
				tempDir,
			),
			false,
		);

		// Excluded: --no-session, metadata, subcommands (including uninstall alias).
		assert.equal(mod.shouldStartSpareDatabaseThread(["-p", "--no-session", "hi"], false, pipe, {}, tempDir), false);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(["--mode", "rpc", "--no-session"], false, pipe, {}, tempDir),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(["--mode", "json", "--no-session", "hi"], false, pipe, {}, tempDir),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(["--mode", "text", "--no-session", "hi"], false, pipe, {}, tempDir),
			false,
		);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--help"], false, tty, {}, tempDir), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--version"], false, tty, {}, tempDir), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--list-models"], false, tty, {}, tempDir), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--export", "s.jsonl"], false, tty, {}, tempDir), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["auth", "status"], false, tty, {}, tempDir), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["install", "npm:foo"], false, tty, {}, tempDir), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["uninstall", "-p"], false, tty, {}, tempDir), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["mcp", "list"], false, tty, {}, tempDir), false);

		// Excluded: real Atomic JSON storage selections (--storage, --storage-file, --session-dir).
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "json", "--storage", '{"memory":true}', "hi"],
				false,
				pipe,
				{},
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "text", "--storage", '{"memory":true}', "hi"],
				false,
				pipe,
				{},
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(["-p", "--storage", '{"memory":true}', "hi"], false, pipe, {}, tempDir),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "rpc", "--storage", '{"memory":true}'],
				false,
				pipe,
				{},
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "json", "--storage", '{"adapter":"@foo/pg"}', "hi"],
				false,
				pipe,
				{},
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "json", "--storage-file", memoryStorageFile, "hi"],
				false,
				pipe,
				{},
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "json", "--storage-file", join(tempDir, "missing.json"), "hi"],
				false,
				pipe,
				{},
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "json", "--session-dir", tempDir, "hi"],
				false,
				pipe,
				{},
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "text", "--session-dir", tempDir, "hi"],
				false,
				pipe,
				{},
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(["-p", "--session-dir", tempDir, "hi"], false, pipe, {}, tempDir),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(["--mode", "rpc", "--session-dir", tempDir], false, pipe, {}, tempDir),
			false,
		);

		// Excluded: real Atomic storage environment variables.
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "json", "hi"],
				false,
				pipe,
				{ ATOMIC_STORAGE: '{"memory":true}' },
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "text", "hi"],
				false,
				pipe,
				{ ATOMIC_SESSIONS_STORAGE: JSON.stringify({ dir: tempDir }) },
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "json", "hi"],
				false,
				pipe,
				{ ATOMIC_CODING_AGENT_SESSION_DIR: tempDir },
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "json", "hi"],
				false,
				pipe,
				{ ATOMIC_SESSION_DIR: tempDir },
				tempDir,
			),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(["--mode", "json", "hi"], false, pipe, { ATOMIC_PROFILE: "ci" }, tempDir),
			false,
		);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--mode", "json", "hi"],
				false,
				pipe,
				{ ATOMIC_PROFILE: "ci", ATOMIC_TEAM_URL: "file:///tmp/team.sqlite" },
				tempDir,
			),
			false,
		);

		// Excluded: invalid --mode values, --mode=json (not recognized by parseArgs), and --mode --no-session.
		assert.equal(mod.shouldStartSpareDatabaseThread(["--mode", "invalid"], false, pipe, {}, tempDir), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--mode", "--no-session"], false, pipe, {}, tempDir), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--mode=json"], false, pipe, {}, tempDir), false);
	});

	it("hasProjectTrustInputsAsync matches sync hasProjectTrustInputs across config, ancestor agent/context, home exclusion, and symlinks", async () => {
		const fakeHome = join(tempDir, "home");
		const project = join(fakeHome, "work", "nested", "leaf");
		mkdirSync(project, { recursive: true });
		vi.stubEnv("HOME", fakeHome);
		vi.stubEnv("USERPROFILE", fakeHome);

		// 1. Empty tree -> false
		assert.equal(await hasProjectTrustInputsAsync(project), false);
		assert.equal(hasProjectTrustInputs(project), false);

		// 2. Home dir's own .atomic/agents + .agents/skills must NOT count as project trust inputs
		mkdirSync(join(fakeHome, ".atomic", "agents"), { recursive: true });
		mkdirSync(join(fakeHome, ".agents", "skills"), { recursive: true });
		assert.equal(await hasProjectTrustInputsAsync(project), false);
		assert.equal(hasProjectTrustInputs(project), false);

		// 3. Ancestor context file -> true
		const ancestorAgentsMd = join(fakeHome, "work", "AGENTS.md");
		writeFileSync(ancestorAgentsMd, "# project instructions\n");
		assert.equal(await hasProjectTrustInputsAsync(project), true);
		assert.equal(hasProjectTrustInputs(project), true);
		rmSync(ancestorAgentsMd);
		assert.equal(await hasProjectTrustInputsAsync(project), false);

		// 4. Ancestor .atomic/agents (nearest project root != home) -> true
		mkdirSync(join(fakeHome, "work", ".atomic", "agents"), { recursive: true });
		assert.equal(await hasProjectTrustInputsAsync(project), true);
		assert.equal(hasProjectTrustInputs(project), true);

		// 5. Symlinked cwd resolves identically
		const linkPath = join(tempDir, "link-leaf");
		symlinkSync(project, linkPath, "junction");
		assert.equal(await hasProjectTrustInputsAsync(linkPath), true);
		assert.equal(hasProjectTrustInputs(linkPath), true);
	});

	it("DefaultResourceLoader parallel asset loading preserves deterministic diagnostics and loaded assets", async () => {
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "proj");
		mkdirSync(join(projectDir, ".atomic"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(projectDir, "AGENTS.md"), "# project context\n");
		writeFileSync(join(projectDir, ".atomic", "SYSTEM.md"), "Custom system prompt");
		writeFileSync(join(projectDir, ".atomic", "APPEND_SYSTEM.md"), "Custom append");
		const missingSkill = join(projectDir, "missing-skill.md");
		const missingPrompt = join(projectDir, "missing-prompt.md");
		const missingTheme = join(projectDir, "missing-theme.json");

		const loader = new DefaultResourceLoader({
			cwd: projectDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			builtinPackagePaths: [],
			noExtensions: true,
			additionalSkillPaths: [missingSkill],
			additionalPromptTemplatePaths: [missingPrompt],
			additionalThemePaths: [missingTheme],
		});
		await loader.reload();

		assert.equal(loader.getSystemPrompt(), "Custom system prompt");
		assert.deepEqual(loader.getAppendSystemPrompt(), ["Custom append"]);
		assert.equal(loader.getAgentsFiles().agentsFiles.length, 1);
		assert.ok(loader.getSkills().diagnostics.some((d) => d.path === missingSkill));
		assert.ok(loader.getPrompts().diagnostics.some((d) => d.path === missingPrompt));
		assert.ok(loader.getThemes().diagnostics.some((d) => d.path === missingTheme));
	});

	it("createAgentSessionServices overlaps ModelRuntime.create and SettingsManager.createAsync while preserving single-refresh marking", async () => {
		const agentDir = join(tempDir, "agent-overlap");
		const projectDir = join(tempDir, "proj-overlap");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		const origModelCreate = ModelRuntime.create.bind(ModelRuntime);
		const origSettingsCreate = SettingsManager.createAsync.bind(SettingsManager);
		let releaseModel!: () => void;
		let modelEntered = false;
		let settingsStartedWhileModelPending = false;

		const modelSpy = vi.spyOn(ModelRuntime, "create").mockImplementation(async (opts) => {
			modelEntered = true;
			await new Promise<void>((resolve) => {
				releaseModel = resolve;
			});
			return origModelCreate(opts);
		});
		const settingsSpy = vi.spyOn(SettingsManager, "createAsync").mockImplementation(async (cwd, dir) => {
			if (modelEntered) {
				settingsStartedWhileModelPending = true;
				releaseModel();
			}
			return origSettingsCreate(cwd, dir);
		});

		const services = await createAgentSessionServices({
			cwd: projectDir,
			agentDir,
			resourceLoaderOptions: {
				builtinPackagePaths: [],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		assert.equal(settingsStartedWhileModelPending, true);
		assert.equal(modelSpy.mock.calls.length, 1);
		assert.equal(modelSpy.mock.calls[0]?.[0]?.refreshOnCreate, false);
		assert.equal(settingsSpy.mock.calls.length, 1);
		assert.equal(ModelRuntime.consumeStartupCatalogRestored(services.modelRuntime), true);
		assert.equal(ModelRuntime.consumeStartupCatalogRestored(services.modelRuntime), false);
	});

	it("DefaultResourceLoader keeps override call order, deterministic error order, warning order, and zero post-rejection mutation under inverted I/O delays", async () => {
		const agentDir = join(tempDir, "agent-det");
		const projectDir = join(tempDir, "proj-det");
		mkdirSync(join(projectDir, ".atomic", "skills", "s1"), { recursive: true });
		mkdirSync(join(projectDir, ".atomic", "prompts"), { recursive: true });
		mkdirSync(join(projectDir, ".atomic", "themes"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(projectDir, ".atomic", "skills", "s1", "SKILL.md"),
			"---\nname: s1\ndescription: d1\n---\nbody\n",
		);
		writeFileSync(join(projectDir, ".atomic", "prompts", "p1.md"), "---\ndescription: p1\n---\nhello\n");
		writeFileSync(
			join(projectDir, ".atomic", "themes", "t1.json"),
			JSON.stringify({
				name: "t1",
				vars: { fg: "#ffffff", bg: "#000000" },
				colors: {
					accent: "fg",
					border: "fg",
					borderAccent: "fg",
					borderMuted: "fg",
					success: "fg",
					error: "fg",
					warning: "fg",
					muted: "fg",
					dim: "fg",
					text: "",
					thinkingText: "fg",
					selectedBg: "bg",
					userMessageBg: "bg",
					userMessageText: "",
					customMessageBg: "bg",
					customMessageText: "",
					customMessageLabel: "fg",
					toolPendingBg: "bg",
					toolSuccessBg: "bg",
					toolErrorBg: "bg",
					toolTitle: "fg",
					toolOutput: "fg",
					mdHeading: "fg",
					mdLink: "fg",
					mdLinkUrl: "fg",
					mdCode: "fg",
					mdCodeBlock: "fg",
					mdCodeBlockBorder: "fg",
					mdQuote: "fg",
					mdQuoteBorder: "fg",
					mdHr: "fg",
					mdListBullet: "fg",
					toolDiffAdded: "fg",
					toolDiffRemoved: "fg",
					toolDiffContext: "fg",
					syntaxComment: "fg",
					syntaxKeyword: "fg",
					syntaxFunction: "fg",
					syntaxVariable: "fg",
					syntaxString: "fg",
					syntaxNumber: "fg",
					syntaxType: "fg",
					syntaxOperator: "fg",
					syntaxPunctuation: "fg",
					thinkingOff: "fg",
					thinkingMinimal: "fg",
					thinkingLow: "fg",
					thinkingMedium: "fg",
					thinkingHigh: "fg",
					thinkingXhigh: "fg",
					bashMode: "fg",
				},
			}),
		);

		const origReadFile = fsp.readFile;

		// 1. Both completion orders call overrides in fixed main order: skills -> prompts -> themes -> context -> system -> append.
		for (const slowTarget of ["SKILL.md", "t1.json"] as const) {
			const order: string[] = [];
			vi.spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
				if (String(args[0]).includes(slowTarget)) await sleep(40);
				return origReadFile.apply(fsp, args);
			}) as typeof fsp.readFile);

			const sm = await SettingsManager.createAsync(projectDir, agentDir, { projectTrusted: true });
			const loader = new DefaultResourceLoader({
				cwd: projectDir,
				agentDir,
				settingsManager: sm,
				builtinPackagePaths: [],
				noExtensions: true,
				skillsOverride: (b) => {
					order.push("skills");
					return b;
				},
				promptsOverride: (b) => {
					order.push("prompts");
					return b;
				},
				themesOverride: (b) => {
					order.push("themes");
					return b;
				},
				agentsFilesOverride: (b) => {
					order.push("context");
					return b;
				},
				systemPromptOverride: (b) => {
					order.push("system");
					return b;
				},
				appendSystemPromptOverride: (b) => {
					order.push("append");
					return b;
				},
			});
			await loader.reload();
			assert.deepEqual(order, ["skills", "prompts", "themes", "context", "system", "append"]);
			vi.restoreAllMocks();
		}

		// 2. When skills is delayed and both skillsOverride and themesOverride throw, skills error wins deterministically.
		for (const slowTarget of ["SKILL.md", "t1.json"] as const) {
			vi.spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
				if (String(args[0]).includes(slowTarget)) await sleep(45);
				return origReadFile.apply(fsp, args);
			}) as typeof fsp.readFile);

			const sm = await SettingsManager.createAsync(projectDir, agentDir, { projectTrusted: true });
			const loader = new DefaultResourceLoader({
				cwd: projectDir,
				agentDir,
				settingsManager: sm,
				builtinPackagePaths: [],
				noExtensions: true,
				skillsOverride: () => {
					throw new Error("SKILLS_OVERRIDE_ERROR");
				},
				themesOverride: () => {
					throw new Error("THEMES_OVERRIDE_ERROR");
				},
			});
			await assert.rejects(() => loader.reload(), /SKILLS_OVERRIDE_ERROR/);
			vi.restoreAllMocks();
		}

		// 3. Post-rejection mutation check: themesOverride throws while skills I/O is delayed -> loader state stays empty immediately and 100ms later.
		vi.spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
			if (String(args[0]).includes("SKILL.md")) await sleep(50);
			return origReadFile.apply(fsp, args);
		}) as typeof fsp.readFile);
		const smReject = await SettingsManager.createAsync(projectDir, agentDir, { projectTrusted: true });
		const loaderReject = new DefaultResourceLoader({
			cwd: projectDir,
			agentDir,
			settingsManager: smReject,
			builtinPackagePaths: [],
			noExtensions: true,
			themesOverride: () => {
				throw new Error("THEMES_FAIL_FAST");
			},
		});
		await assert.rejects(() => loaderReject.reload(), /THEMES_FAIL_FAST/);
		assert.deepEqual(loaderReject.getSkills().skills, []);
		assert.deepEqual(loaderReject.getPrompts().prompts, []);
		assert.deepEqual(loaderReject.getThemes().themes, []);
		await sleep(100);
		assert.deepEqual(loaderReject.getSkills().skills, []);
		assert.deepEqual(loaderReject.getPrompts().prompts, []);
		assert.deepEqual(loaderReject.getThemes().themes, []);
		vi.restoreAllMocks();

		// 4. Unreadable SYSTEM.md (delayed) vs APPEND_SYSTEM.md warns in fixed order: system prompt before append system prompt.
		if (process.platform !== "win32") {
			const sysPath = join(projectDir, ".atomic", "SYSTEM.md");
			const appPath = join(projectDir, ".atomic", "APPEND_SYSTEM.md");
			writeFileSync(sysPath, "sys");
			writeFileSync(appPath, "app");
			chmodSync(sysPath, 0o000);
			chmodSync(appPath, 0o000);
			try {
				const warnings: string[] = [];
				vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
					warnings.push(args.map(String).join(" "));
				});
				vi.spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
					const target = String(args[0]);
					if (target.endsWith("SYSTEM.md") && !target.endsWith("APPEND_SYSTEM.md")) await sleep(45);
					return origReadFile.apply(fsp, args);
				}) as typeof fsp.readFile);
				const smWarn = await SettingsManager.createAsync(projectDir, agentDir, { projectTrusted: true });
				const loaderWarn = new DefaultResourceLoader({
					cwd: projectDir,
					agentDir,
					settingsManager: smWarn,
					builtinPackagePaths: [],
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				});
				await loaderWarn.reload();
				assert.equal(warnings.length, 2);
				assert.ok(
					warnings[0]!.includes("Could not read system prompt file"),
					`expected system first: ${warnings[0]}`,
				);
				assert.ok(
					warnings[1]!.includes("Could not read append system prompt file"),
					`expected append second: ${warnings[1]}`,
				);
			} finally {
				chmodSync(sysPath, 0o644);
				chmodSync(appPath, 0o644);
				vi.restoreAllMocks();
			}
		}

		// 5. resolvePackageResourcePaths deterministic error order: configured resolve() error wins over faster CLI/builtin failure.
		for (const slowFirst of [true, false]) {
			vi.spyOn(DefaultPackageManager.prototype, "resolve").mockImplementation(async () => {
				if (slowFirst) await sleep(45);
				throw new Error("CONFIGURED_RESOLVE_ERROR");
			});
			vi.spyOn(DefaultPackageManager.prototype, "resolveExtensionSources").mockImplementation(async () => {
				if (!slowFirst) await sleep(45);
				throw new Error("CLI_RESOLVE_ERROR");
			});
			const smPkg = await SettingsManager.createAsync(projectDir, agentDir, { projectTrusted: true });
			const loaderPkg = new DefaultResourceLoader({
				cwd: projectDir,
				agentDir,
				settingsManager: smPkg,
				builtinPackagePaths: [],
				additionalExtensionPaths: [join(projectDir, "fake-ext.ts")],
				noExtensions: true,
			});
			await assert.rejects(() => loaderPkg.reload(), /CONFIGURED_RESOLVE_ERROR/);
			vi.restoreAllMocks();
		}
	});
});
