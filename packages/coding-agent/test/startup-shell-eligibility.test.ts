import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { planStartupShell } from "../src/modes/interactive/startup-shell-eligibility.ts";

let root: string;
let project: string;
const savedAgentDir = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-early-editor-plan-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), "{}");
	process.env[ENV_AGENT_DIR] = agentDir;
	// A folder with context of its own, whose trust has not been decided: a session there asks first.
	project = join(root, "project");
	mkdirSync(project);
	writeFileSync(join(project, "AGENTS.md"), "# project\n");
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
	rmSync(root, { recursive: true, force: true });
});

test("the early editor waits for a trust question it cannot rule out, and starts when the arguments decide trust", () => {
	assert.equal(planStartupShell([], project), undefined);
	for (const args of [["--approve"], ["-a"], ["--no-approve"], ["-na"], ["--offline", "-a", "--no-mcp"]]) {
		assert.ok(planStartupShell(args, project), `starts with ${args.join(" ")}`);
	}
});

test("the early editor does not start with an argument that may show something before the editor", () => {
	assert.equal(planStartupShell(["-a", "--name", "work"], project), undefined);
	assert.equal(planStartupShell(["-a", "--continue"], project), undefined);
});
