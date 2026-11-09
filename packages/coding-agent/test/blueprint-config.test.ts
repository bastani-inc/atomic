import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "vitest";
import {
	BLUEPRINT_FILE_NAME,
	CONFIG_DIR_NAME,
	getBlueprintActionsDir,
	getGlobalBlueprintPath,
	getProjectBlueprintPath,
} from "../src/config.ts";

describe("blueprint paths come from the config helpers (#4588)", () => {
	test("the global blueprint sits in the agent directory (#4588)", () => {
		assert.equal(BLUEPRINT_FILE_NAME, "blueprint.yaml");
		assert.equal(
			getGlobalBlueprintPath(join("/home", "me", ".atomic", "agent")),
			join("/home", "me", ".atomic", "agent", "blueprint.yaml"),
		);
	});

	test("a repository or workspace blueprint sits in its .atomic directory and never in .devin (#4588)", () => {
		assert.equal(CONFIG_DIR_NAME, ".atomic");
		assert.equal(getProjectBlueprintPath(join("/repo")), join("/repo", ".atomic", "blueprint.yaml"));
		assert.equal(
			getProjectBlueprintPath(join("/repo", "services", "api")),
			join("/repo", "services", "api", ".atomic", "blueprint.yaml"),
		);
		assert.ok(!getProjectBlueprintPath("/repo").includes(".devin"));
	});

	test("fetched actions are cached under the agent directory (#4588)", () => {
		assert.equal(getBlueprintActionsDir(join("/agent")), join("/agent", "blueprint-actions"));
	});
});
