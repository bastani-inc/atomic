import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { planStartupShell } from "../src/modes/interactive/startup-shell-eligibility.ts";

let root: string;
let project: string;
const savedEnv = { agentDir: process.env[ENV_AGENT_DIR], ci: process.env.CI, term: process.env.TERM };
const ttyDescriptors = {
	stdin: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
	stdout: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
};

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function restoreTty(stream: NodeJS.ReadStream | NodeJS.WriteStream, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
	else delete (stream as { isTTY?: boolean }).isTTY;
}

beforeEach(() => {
	// A session started at a terminal, outside CI.
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	delete process.env.CI;
	process.env.TERM = "xterm-256color";
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
	restoreEnv(ENV_AGENT_DIR, savedEnv.agentDir);
	restoreEnv("CI", savedEnv.ci);
	restoreEnv("TERM", savedEnv.term);
	restoreTty(process.stdin, ttyDescriptors.stdin);
	restoreTty(process.stdout, ttyDescriptors.stdout);
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

test("the early editor does not start where the session would not use the alternate screen", () => {
	process.env.CI = "buildkite";
	assert.equal(planStartupShell(["-a"], project), undefined, "in CI, even at a terminal");
	delete process.env.CI;
	process.env.TERM = "dumb";
	assert.equal(planStartupShell(["-a"], project), undefined, "with TERM=dumb");
});
