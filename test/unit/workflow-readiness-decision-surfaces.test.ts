import assert from "node:assert/strict";
import { test } from "vitest";
import { decisionSettingScopes } from "../../packages/coding-agent/src/modes/interactive/components/settings-selector.ts";

test("/settings saves the decision model where the project already sets it, otherwise globally", () => {
	assert.equal(decisionSettingScopes({}).decisionModelScope, "global");
	assert.equal(decisionSettingScopes({ decisionModel: "" }).decisionModelScope, "project");
});
