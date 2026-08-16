import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { buildSkillCatalog } from "../../packages/coding-agent/src/core/skill-catalog.js";
import type { Skill } from "../../packages/coding-agent/src/core/skills.js";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.js";
import { skillsWarning } from "../../packages/subagents/src/agents/agent-management-helpers.js";
import {
	buildSkillInjection,
	clearSkillCache,
	resolveSkills,
	resolveSkillsFromCatalog,
} from "../../packages/subagents/src/agents/skills.js";
import { moduleDir } from "../helpers/runtime.js";

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const builtinSubagentsSkillsRoot = join(repoRoot, "packages", "subagents", "skills");
const builtinSubagentSkillPath = join(builtinSubagentsSkillsRoot, "subagent", "SKILL.md");

let previousAtomicAgentDir: string | undefined;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let isolatedAgentDir: string;
const cleanupPaths = new Set<string>();

beforeEach(() => {
	previousAtomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	previousHome = process.env.HOME;
	previousUserProfile = process.env.USERPROFILE;
	isolatedAgentDir = mkdtempSync(join(tmpdir(), "atomic-subagents-skills-agent-"));
	cleanupPaths.add(isolatedAgentDir);
	process.env.ATOMIC_CODING_AGENT_DIR = isolatedAgentDir;
	process.env.HOME = isolatedAgentDir;
	process.env.USERPROFILE = isolatedAgentDir;
	clearSkillCache();
});

afterEach(() => {
	if (previousAtomicAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAtomicAgentDir;
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousUserProfile;
	for (const cleanupPath of cleanupPaths) {
		rmSync(cleanupPath, { recursive: true, force: true });
	}
	cleanupPaths.clear();
	clearSkillCache();
});

describe("subagent skill resolution", () => {
	test("resolves builtin tdd and playwright-cli skills from the repo root", () => {
		const result = resolveSkills(["tdd", "playwright-cli"], repoRoot);

		const resolvedByName = new Map(result.resolved.map((skill) => [skill.name, skill]));

		assert.deepEqual(result.missing, []);
		assert.deepEqual([...resolvedByName.keys()].sort(), ["playwright-cli", "tdd"]);
		assert.equal(resolvedByName.get("tdd")?.source, "builtin");
		assert.equal(resolvedByName.get("tdd")?.path, join(builtinSubagentsSkillsRoot, "tdd", "SKILL.md"));
		assert.equal(resolvedByName.get("playwright-cli")?.source, "builtin");
		assert.equal(
			resolvedByName.get("playwright-cli")?.path,
			join(builtinSubagentsSkillsRoot, "playwright-cli", "SKILL.md"),
		);
	});

	test("builds skill injection for builtin skills without YAML frontmatter", () => {
		const result = resolveSkills(["tdd", "playwright-cli"], repoRoot);
		const injection = buildSkillInjection(result.resolved);

		assert.equal(result.missing.length, 0);
		assert.match(injection, /<skill name="tdd">/);
		assert.match(injection, /<skill name="playwright-cli">/);
		assert.doesNotMatch(injection, /<skill name="tdd">\n---\nname: tdd/);
		assert.doesNotMatch(injection, /<skill name="playwright-cli">\n---\nname: playwright-cli/);
	});

	test("prefers a project tdd skill over the builtin tdd skill", () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagents-skills-project-"));
		cleanupPaths.add(cwd);
		const projectTddDir = join(cwd, ".agents", "skills", "tdd");
		const projectTddPath = join(projectTddDir, "SKILL.md");
		mkdirSync(projectTddDir, { recursive: true });
		writeFileSync(
			projectTddPath,
			"---\nname: tdd\ndescription: Project override\n---\n\n# Project TDD\n\nUse the project-specific process.\n",
			"utf-8",
		);

		const result = resolveSkills(["tdd"], cwd);

		assert.deepEqual(result.missing, []);
		assert.equal(result.resolved[0]?.path, projectTddPath);
		assert.equal(result.resolved[0]?.source, "project");
		assert.match(result.resolved[0]?.content ?? "", /# Project TDD/);
	});

	test("resolves qualified selectors through the live loader catalog without bare-name fallback", () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagents-skills-catalog-"));
		cleanupPaths.add(cwd);
		const userPath = join(cwd, "user", "SKILL.md");
		const builtinPath = join(cwd, "builtin", "SKILL.md");
		mkdirSync(join(userPath, ".."), { recursive: true });
		mkdirSync(join(builtinPath, ".."), { recursive: true });
		writeFileSync(userPath, "---\nname: tdd\ndescription: User TDD\n---\n\nUser body\n", "utf-8");
		writeFileSync(builtinPath, "---\nname: tdd\ndescription: Builtin TDD\n---\n\nBuiltin body\n", "utf-8");
		const makeSkill = (filePath: string, bundled: boolean): Skill => ({
			name: "tdd",
			description: bundled ? "Builtin TDD" : "User TDD",
			filePath,
			baseDir: join(filePath, ".."),
			disableModelInvocation: false,
			sourceInfo: createSyntheticSourceInfo(filePath, {
				source: bundled ? "/packages/subagents" : "local",
				scope: bundled ? "temporary" : "user",
				configurationOrigin: bundled ? "bundled" : "atomic",
			}),
		});
		const user = makeSkill(userPath, false);
		const builtin = makeSkill(builtinPath, true);
		const catalog = buildSkillCatalog([user, builtin], [user]);

		const exact = resolveSkillsFromCatalog(["tdd@builtin"], catalog, cwd);
		const unknown = resolveSkillsFromCatalog(["tdd@missing"], catalog, cwd);

		assert.deepEqual(exact.missing, []);
		assert.equal(exact.resolved[0]?.name, "tdd@builtin");
		assert.equal(exact.resolved[0]?.path, builtinPath);
		assert.match(exact.resolved[0]?.content ?? "", /Builtin body/);
		assert.deepEqual(unknown.resolved, []);
		assert.deepEqual(unknown.missing, ["tdd@missing"]);
		assert.equal(skillsWarning(cwd, ["tdd@builtin"], catalog), undefined);
		assert.equal(skillsWarning(cwd, ["tdd@missing"], catalog), "Warning: skills not found: tdd@missing.");
	});

	test("does not resolve the builtin subagent orchestration skill for child injection", () => {
		const result = resolveSkills(["subagent"], repoRoot);

		assert.deepEqual(result.resolved, []);
		assert.deepEqual(result.missing, ["subagent"]);
	});

	test("does not inject qualified subagent orchestration selectors through the catalog", () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagents-skills-orchestration-"));
		cleanupPaths.add(cwd);
		const userPath = join(cwd, "user", "SKILL.md");
		const builtinPath = join(cwd, "builtin", "SKILL.md");
		mkdirSync(join(userPath, ".."), { recursive: true });
		mkdirSync(join(builtinPath, ".."), { recursive: true });
		writeFileSync(userPath, "---\nname: subagent\ndescription: User subagent\n---\n\nUser orchestration\n", "utf-8");
		writeFileSync(
			builtinPath,
			"---\nname: subagent\ndescription: Builtin subagent\n---\n\nBuiltin orchestration\n",
			"utf-8",
		);
		const makeSkill = (filePath: string, bundled: boolean): Skill => ({
			name: "subagent",
			description: bundled ? "Builtin subagent" : "User subagent",
			filePath,
			baseDir: join(filePath, ".."),
			disableModelInvocation: false,
			sourceInfo: createSyntheticSourceInfo(filePath, {
				source: bundled ? "/packages/subagents" : "local",
				scope: bundled ? "temporary" : "user",
				configurationOrigin: bundled ? "bundled" : "atomic",
			}),
		});
		const catalog = buildSkillCatalog(
			[makeSkill(userPath, false), makeSkill(builtinPath, true)],
			[makeSkill(userPath, false)],
		);

		const qualified = resolveSkillsFromCatalog(["subagent@builtin"], catalog, cwd);
		const filesystemQualified = resolveSkills(["subagent@builtin"], cwd);

		assert.deepEqual(qualified.resolved, []);
		assert.deepEqual(qualified.missing, ["subagent@builtin"]);
		assert.equal(catalog.resolve("subagent@builtin").ok, true);
		assert.deepEqual(filesystemQualified.resolved, []);
		assert.deepEqual(filesystemQualified.missing, ["subagent@builtin"]);
		assert.equal(skillsWarning(cwd, ["subagent@builtin"], catalog), "Warning: skills not found: subagent@builtin.");
	});

	test("documents the debugger model, skills, tools, and coordination", () => {
		const guidance = readFileSync(builtinSubagentSkillPath, "utf8");

		const debuggerRow = guidance.split("\n").find((line) => line.startsWith("| `debugger`"));
		assert.ok(debuggerRow, "missing debugger guidance row");
		assert.match(debuggerRow, /`openai-codex\/gpt-5\.6-sol:xhigh`/);
		for (const capability of ["intercom", "contact_supervisor", "todo"]) {
			assert.match(debuggerRow, new RegExp(`\\b${capability}\\b`));
		}
		assert.doesNotMatch(debuggerRow, /browser/);
		assert.match(guidance, /`tdd`, `playwright-cli`, and `tmux` skills/);
		assert.match(guidance, /debugger` and `worker` agents declare both `intercom` and `contact_supervisor`/);
		assert.doesNotMatch(guidance, /None of the builtin specialists carry the `intercom` tool/);
		assert.doesNotMatch(guidance, /Builtin specialists do not have `intercom`/);
	});
});
