import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "vitest";
import {
	RETURN_PATH_MESSAGE_LIMIT,
	RETURN_PATH_WINDOW_MS,
	returnPathClosedReason,
} from "../../packages/intercom/group.js";
import { moduleDir, readText } from "../helpers/runtime.js";

const skillPath = resolve(moduleDir(import.meta.url), "../../packages/intercom/skills/intercom/SKILL.md");

async function readSkill(): Promise<string> {
	return (await readText(skillPath)).replaceAll("\r\n", "\n");
}

describe("bundled intercom skill", () => {
	test("teaches the return path to a sender outside the session's groups with the broker's own limits", async () => {
		const skill = await readSkill();
		const minutes = Math.round(RETURN_PATH_WINDOW_MS / 60_000);
		assert.ok(
			skill.includes(`up to ${RETURN_PATH_MESSAGE_LIMIT} messages within ${minutes} minutes`),
			"the skill must state the return path's message limit and window",
		);
		const refusal = returnPathClosedReason("<sender>").split(":")[0];
		assert.ok(skill.includes(refusal), `the skill must name the refusal the broker sends: ${refusal}`);
		assert.doesNotMatch(
			skill,
			/only authorized `contact_supervisor` traffic crosses group boundaries/u,
			"answers to a sender outside the groups also cross them",
		);
	});

	test("does not describe Intercom as limited to one machine", async () => {
		const skill = await readSkill();
		assert.doesNotMatch(skill, /same-machine only/u);
		assert.match(skill, /machines that share (?:a )?storage/u);
	});
});
