import assert from "node:assert/strict";
import { test } from "vitest";
import { parseSkillBlock } from "../../packages/coding-agent/src/core/agent-session-skill-block.ts";

test("parseSkillBlock extracts candidate attribute when present", () => {
	const block = `<skill name="tdd@builtin" location="/app/skills/tdd/SKILL.md" candidate="tdd@builtin">\nReferences are relative to /app/skills/tdd.\n\nSkill body here.\n</skill>`;
	const parsed = parseSkillBlock(block);
	assert.ok(parsed);
	assert.equal(parsed!.name, "tdd@builtin");
	assert.equal(parsed!.location, "/app/skills/tdd/SKILL.md");
	assert.equal(parsed!.candidateId, "tdd@builtin");
	assert.equal(parsed!.content, "References are relative to /app/skills/tdd.\n\nSkill body here.");
});

test("parseSkillBlock works without candidate attribute (backward compat)", () => {
	const block = `<skill name="tdd" location="/home/user/skills/tdd/SKILL.md">\nReferences are relative to /home/user/skills/tdd.\n\nSkill body.\n</skill>`;
	const parsed = parseSkillBlock(block);
	assert.ok(parsed);
	assert.equal(parsed!.name, "tdd");
	assert.equal(parsed!.location, "/home/user/skills/tdd/SKILL.md");
	assert.equal(parsed!.candidateId, undefined);
	assert.equal(parsed!.content, "References are relative to /home/user/skills/tdd.\n\nSkill body.");
});

test("parseSkillBlock with candidate and user message", () => {
	const block = `<skill name="review@project" location="/p/.atomic/skills/review/SKILL.md" candidate="review@project">\nBody.\n</skill>\n\nFix the tests`;
	const parsed = parseSkillBlock(block);
	assert.ok(parsed);
	assert.equal(parsed!.name, "review@project");
	assert.equal(parsed!.candidateId, "review@project");
	assert.equal(parsed!.userMessage, "Fix the tests");
});
