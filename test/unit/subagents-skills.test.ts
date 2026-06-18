import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    buildSkillInjection,
    clearSkillCache,
    resolveSkills,
} from "../../packages/subagents/src/agents/skills.js";

const repoRoot = resolve(import.meta.dir, "../..");
const builtinSubagentsSkillsRoot = join(
    repoRoot,
    "packages",
    "subagents",
    "skills",
);

let previousAtomicAgentDir: string | undefined;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let isolatedAgentDir: string;
const cleanupPaths = new Set<string>();

beforeEach(() => {
    previousAtomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    isolatedAgentDir = mkdtempSync(
        join(tmpdir(), "atomic-subagents-skills-agent-"),
    );
    cleanupPaths.add(isolatedAgentDir);
    process.env.ATOMIC_CODING_AGENT_DIR = isolatedAgentDir;
    process.env.HOME = isolatedAgentDir;
    process.env.USERPROFILE = isolatedAgentDir;
    clearSkillCache();
});

afterEach(() => {
    if (previousAtomicAgentDir === undefined)
        delete process.env.ATOMIC_CODING_AGENT_DIR;
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

        const resolvedByName = new Map(
            result.resolved.map((skill) => [skill.name, skill]),
        );

        assert.deepEqual(result.missing, []);
        assert.deepEqual([...resolvedByName.keys()].sort(), ["playwright-cli", "tdd"]);
        assert.equal(resolvedByName.get("tdd")?.source, "builtin");
        assert.equal(
            resolvedByName.get("tdd")?.path,
            join(builtinSubagentsSkillsRoot, "tdd", "SKILL.md"),
        );
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
        assert.doesNotMatch(
            injection,
            /<skill name="playwright-cli">\n---\nname: playwright-cli/,
        );
    });

    test("prefers a project tdd skill over the builtin tdd skill", () => {
        const cwd = mkdtempSync(
            join(tmpdir(), "atomic-subagents-skills-project-"),
        );
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

    test("does not resolve the builtin subagent orchestration skill for child injection", () => {
        const result = resolveSkills(["subagent"], repoRoot);

        assert.deepEqual(result.resolved, []);
        assert.deepEqual(result.missing, ["subagent"]);
    });
});
