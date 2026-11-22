import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { hasProjectTrustInputs, hasProjectTrustInputsAsync } from "../src/core/trust-manager.ts";
import { shouldPrewarmInteractiveEngine } from "../src/modes/interactive-engine/engine-prewarm.ts";

describe("PR 3 startup serial chains and CLI prewarm/spare-DB helpers", () => {
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

	it("shouldPrewarmInteractiveEngine skips spawning a doomed engine on unpinned --no-approve while keeping pinned or overridden runs", () => {
		const host = { stdinIsTTY: true, stdoutIsTTY: true, cpus: 8 };
		// Clear storage-pinning env vars so test is isolated from shell env.
		for (const key of [
			"ATOMIC_SESSION_DIR",
			"PI_SESSION_DIR",
			"ATOMIC_STORAGE",
			"PI_STORAGE",
			"ATOMIC_SESSIONS_STORAGE",
			"PI_SESSIONS_STORAGE",
		]) {
			vi.stubEnv(key, "");
		}

		// Unpinned --no-approve / -na guarantees in-process mode -> must NOT prewarm.
		assert.equal(shouldPrewarmInteractiveEngine(["--no-approve"], host), false);
		assert.equal(shouldPrewarmInteractiveEngine(["-na"], host), false);
		assert.equal(shouldPrewarmInteractiveEngine(["--offline", "--no-mcp", "--no-approve"], host), false);

		// Last trust flag wins: --no-approve followed by --approve still prewarms.
		assert.equal(shouldPrewarmInteractiveEngine(["--no-approve", "--approve"], host), true);
		assert.equal(shouldPrewarmInteractiveEngine(["-na", "-a"], host), true);
		// Value-taking flag whose value is "--no-approve" must NOT be mistaken for a trust flag.
		assert.equal(shouldPrewarmInteractiveEngine(["--name", "--no-approve"], host), true);

		// Storage pinned via CLI flag or env still allows isolation -> still prewarms.
		assert.equal(shouldPrewarmInteractiveEngine(["--no-approve", "--no-session"], host), true);
		assert.equal(shouldPrewarmInteractiveEngine(["--no-approve", "--session-dir", tempDir], host), true);
		assert.equal(shouldPrewarmInteractiveEngine(["--no-approve", `--session-dir=${tempDir}`], host), true);
		assert.equal(shouldPrewarmInteractiveEngine(["--no-approve", "--storage", "sqlite"], host), true);
		vi.stubEnv("ATOMIC_SESSION_DIR", tempDir);
		assert.equal(shouldPrewarmInteractiveEngine(["--no-approve"], host), true);
	});

	it("shouldStartSpareDatabaseThread covers -p and plain --mode rpc while excluding metadata, subcommands, --no-session, and non-sqlite storage", async () => {
		const mod = await import("../src/utils/startup-database-spare.ts");
		const tty = { stdinIsTTY: true, stdoutIsTTY: true };
		const pipe = { stdinIsTTY: false, stdoutIsTTY: false };

		// Interactive, print (-p/--print), and standalone --mode rpc/json start spare thread.
		assert.equal(mod.shouldStartSpareDatabaseThread([], false, tty, {}), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--offline", "--approve"], false, tty, {}), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["-p", "hello"], false, pipe, {}), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--print", "hello"], false, tty, {}), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--mode", "rpc"], false, pipe, {}), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--mode=rpc", "--offline"], false, pipe, {}), true);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--mode", "json", "hi"], false, pipe, {}), true);
		// Prewarmed engine obeys NO_DATABASE flag.
		assert.equal(mod.shouldStartSpareDatabaseThread(["--internal-engine-prewarm"], true, pipe, {}), true);
		assert.equal(
			mod.shouldStartSpareDatabaseThread(
				["--internal-engine-prewarm", "--internal-engine-prewarm-no-database"],
				true,
				pipe,
				{},
			),
			false,
		);

		// Excluded: --no-session, metadata, subcommands, non-sqlite storage.
		assert.equal(mod.shouldStartSpareDatabaseThread(["-p", "--no-session", "hi"], false, pipe, {}), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--mode", "rpc", "--no-session"], false, pipe, {}), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--help"], false, tty, {}), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--version"], false, tty, {}), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--list-models"], false, tty, {}), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["--export", "s.jsonl"], false, tty, {}), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["auth", "status"], false, tty, {}), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["install", "npm:foo"], false, tty, {}), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["mcp", "list"], false, tty, {}), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["-p", "--storage", "memory", "hi"], false, pipe, {}), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["-p", "--storage=jsonl", "hi"], false, pipe, {}), false);
		assert.equal(mod.shouldStartSpareDatabaseThread(["-p", "hi"], false, pipe, { ATOMIC_STORAGE: "memory" }), false);
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
});
