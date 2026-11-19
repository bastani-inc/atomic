import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

// #3111: cover shipped definitions, not SDK defaults that can mask narrow allowlists.
test("every shipped subagent declares Intercom", () => {
	const root = join(process.cwd(), "packages/subagents/agents");
	const agents = readdirSync(root).filter((file) => file.endsWith(".md"));
	assert.ok(agents.length >= 9);
	for (const agent of agents) {
		const tools = /^tools: (.+)$/m.exec(readFileSync(join(root, agent), "utf8"))?.[1]?.split(/,\s*/);
		assert.ok(tools?.includes("intercom"), agent);
	}
});
