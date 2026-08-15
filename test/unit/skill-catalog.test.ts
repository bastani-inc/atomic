import assert from "node:assert/strict";
import { test } from "vitest";
import type { ResourceLoader } from "../../packages/coding-agent/src/core/resource-loader-types.ts";
import { getSkillCatalog } from "../../packages/coding-agent/src/core/skill-catalog.ts";
import type { Skill } from "../../packages/coding-agent/src/core/skills.ts";
import type { SourceInfo } from "../../packages/coding-agent/src/core/source-info.ts";

function makeSkill(name: string, filePath: string, scope: "user" | "project" | "temporary", source = "local"): Skill {
	const sourceInfo: SourceInfo = {
		path: filePath,
		source,
		scope,
		origin: "top-level",
		baseDir: filePath.replace(/\/SKILL\.md$/, ""),
	};
	return {
		name,
		description: `Skill ${name} from ${scope}`,
		filePath,
		baseDir: sourceInfo.baseDir!,
		sourceInfo,
		disableModelInvocation: false,
	};
}

function makeLoader(skills: Skill[], shadowedSkills: Skill[]): ResourceLoader {
	return {
		getExtensions: () => ({
			extensions: [],
			errors: [],
			runtime: { on: () => {}, off: () => {}, emit: () => {} } as never,
		}),
		getSkills: () => ({ skills, shadowedSkills, diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => Promise.resolve(),
		reload: () => Promise.resolve(),
	};
}

test("bare selector resolves to the winner when there is no collision", () => {
	const skill = makeSkill("tdd", "/home/user/skills/tdd/SKILL.md", "user");
	const loader = makeLoader([skill], []);
	const catalog = getSkillCatalog(loader);

	const result = catalog.resolve("tdd");
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.candidate.skill.filePath, "/home/user/skills/tdd/SKILL.md");
		assert.equal(result.candidate.selector, "tdd");
	}
});

test("bare selector resolves to the winner in a collision group", () => {
	const userSkill = makeSkill("tdd", "/home/user/skills/tdd/SKILL.md", "user");
	const builtinSkill = makeSkill("tdd", "/app/skills/tdd/SKILL.md", "temporary", "builtin");
	const loader = makeLoader([userSkill], [builtinSkill]);
	const catalog = getSkillCatalog(loader);

	const result = catalog.resolve("tdd");
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.candidate.skill.filePath, "/home/user/skills/tdd/SKILL.md");
		assert.equal(result.candidate.selector, "tdd");
	}
});

test("qualified selector resolves to the shadowed builtin candidate", () => {
	const userSkill = makeSkill("tdd", "/home/user/skills/tdd/SKILL.md", "user");
	const builtinSkill = makeSkill("tdd", "/app/skills/tdd/SKILL.md", "temporary", "builtin");
	const loader = makeLoader([userSkill], [builtinSkill]);
	const catalog = getSkillCatalog(loader);

	const result = catalog.resolve("tdd@builtin");
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.candidate.skill.filePath, "/app/skills/tdd/SKILL.md");
		assert.equal(result.candidate.sourceLabel, "builtin");
	}
});

test("qualified selector resolves to the shadowed project candidate", () => {
	const userSkill = makeSkill("review", "/home/user/skills/review/SKILL.md", "user");
	const projectSkill = makeSkill("review", "/project/.atomic/skills/review/SKILL.md", "project");
	const loader = makeLoader([userSkill], [projectSkill]);
	const catalog = getSkillCatalog(loader);

	const result = catalog.resolve("review@project");
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.candidate.skill.filePath, "/project/.atomic/skills/review/SKILL.md");
		assert.equal(result.candidate.sourceLabel, "project");
	}
});

test("unknown qualified selector does not fall back to the winner", () => {
	const userSkill = makeSkill("tdd", "/home/user/skills/tdd/SKILL.md", "user");
	const builtinSkill = makeSkill("tdd", "/app/skills/tdd/SKILL.md", "temporary", "builtin");
	const loader = makeLoader([userSkill], [builtinSkill]);
	const catalog = getSkillCatalog(loader);

	const result = catalog.resolve("tdd@nonexistent");
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.ok(result.message.includes("available"));
		assert.ok(result.message.includes("tdd"));
		assert.ok(result.message.includes("tdd@builtin"));
	}
});

test("commands include both bare winner and qualified shadowed candidates", () => {
	const userSkill = makeSkill("tdd", "/home/user/skills/tdd/SKILL.md", "user");
	const builtinSkill = makeSkill("tdd", "/app/skills/tdd/SKILL.md", "temporary", "builtin");
	const loader = makeLoader([userSkill], [builtinSkill]);
	const catalog = getSkillCatalog(loader);

	const names = catalog.commands.map((c) => c.name);
	assert.ok(names.includes("tdd"));
	assert.ok(names.includes("tdd@builtin"));
});

test("commands do not include qualified names when there is no collision", () => {
	const skill = makeSkill("tdd", "/home/user/skills/tdd/SKILL.md", "user");
	const loader = makeLoader([skill], []);
	const catalog = getSkillCatalog(loader);

	const names = catalog.commands.map((c) => c.name);
	assert.deepEqual(names, ["tdd"]);
});

test("three-way collision: user, project, and builtin all stay selectable", () => {
	const userSkill = makeSkill("impeccable", "/home/user/skills/impeccable/SKILL.md", "user");
	const projectSkill = makeSkill("impeccable", "/project/.atomic/skills/impeccable/SKILL.md", "project");
	const builtinSkill = makeSkill("impeccable", "/app/skills/impeccable/SKILL.md", "temporary", "builtin");
	const loader = makeLoader([userSkill], [projectSkill, builtinSkill]);
	const catalog = getSkillCatalog(loader);

	const bareResult = catalog.resolve("impeccable");
	assert.equal(bareResult.ok, true);
	if (bareResult.ok) assert.equal(bareResult.candidate.skill.filePath, "/home/user/skills/impeccable/SKILL.md");

	const projectResult = catalog.resolve("impeccable@project");
	assert.equal(projectResult.ok, true);
	if (projectResult.ok)
		assert.equal(projectResult.candidate.skill.filePath, "/project/.atomic/skills/impeccable/SKILL.md");

	const builtinResult = catalog.resolve("impeccable@builtin");
	assert.equal(builtinResult.ok, true);
	if (builtinResult.ok) assert.equal(builtinResult.candidate.skill.filePath, "/app/skills/impeccable/SKILL.md");

	const names = catalog.commands.map((c) => c.name);
	assert.ok(names.includes("impeccable"));
	assert.ok(names.includes("impeccable@project"));
	assert.ok(names.includes("impeccable@builtin"));
});

test("ambiguous source label is disambiguated with path-derived label", () => {
	const user1Skill = makeSkill("tdd", "/alpha/skills/tdd/SKILL.md", "user");
	const user2Skill = makeSkill("tdd", "/beta/skills/tdd/SKILL.md", "user");
	const loader = makeLoader([user1Skill], [user2Skill]);
	const catalog = getSkillCatalog(loader);

	// Both have scope "user", so the second one must be disambiguated
	const result = catalog.resolve("tdd@user");
	// Since "user" appears twice, it should be ambiguous or resolved to a disambiguated label
	// The catalog should NOT silently pick one
	if (result.ok) {
		// If it resolved, the sourceLabel should be unique
		assert.notEqual(result.candidate.skill.filePath, user1Skill.filePath);
	} else {
		// If ambiguous, the message should list available selectors
		assert.ok(result.message.includes("available"));
	}
});

test("unknown bare selector returns error, not the winner", () => {
	const skill = makeSkill("tdd", "/home/user/skills/tdd/SKILL.md", "user");
	const loader = makeLoader([skill], []);
	const catalog = getSkillCatalog(loader);

	const result = catalog.resolve("nonexistent");
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.ok(result.message.includes("nonexistent"));
	}
});

test("candidate ID is stable and includes the source label", () => {
	const userSkill = makeSkill("tdd", "/home/user/skills/tdd/SKILL.md", "user");
	const builtinSkill = makeSkill("tdd", "/app/skills/tdd/SKILL.md", "temporary", "builtin");
	const loader = makeLoader([userSkill], [builtinSkill]);
	const catalog = getSkillCatalog(loader);

	const userResult = catalog.resolve("tdd");
	const builtinResult = catalog.resolve("tdd@builtin");
	assert.equal(userResult.ok, true);
	assert.equal(builtinResult.ok, true);
	if (userResult.ok && builtinResult.ok) {
		assert.equal(userResult.candidate.id, "tdd@user");
		assert.equal(builtinResult.candidate.id, "tdd@builtin");
		assert.notEqual(userResult.candidate.id, builtinResult.candidate.id);
	}
});

test("catalog with no skills produces empty commands and resolves nothing", () => {
	const loader = makeLoader([], []);
	const catalog = getSkillCatalog(loader);

	assert.equal(catalog.commands.length, 0);
	assert.equal(catalog.allCandidates.length, 0);
	const result = catalog.resolve("anything");
	assert.equal(result.ok, false);
});
