import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { test } from "vitest";
import { createBashTool } from "../../packages/coding-agent/src/core/tools/bash.js";
import { defaultToolSelectionFor } from "../../packages/coding-agent/src/core/tools/index.js";
import { readText } from "../helpers/runtime.js";

const docsRoot = new URL("../../packages/coding-agent/docs/", import.meta.url);
const readDoc = (path: string) => readText(fileURLToPath(new URL(path, docsRoot)));

function assertInventory(text: string, powerShellAvailable: boolean) {
	const names = [...text.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
	const expected = defaultToolSelectionFor(powerShellAvailable);
	assert.deepEqual(names.filter((name) => name !== "powershell" || powerShellAvailable).sort(), [...expected].sort());
	assert.match(text, /native Windows.*when a PowerShell executable is available/);
}

// #2847 / PR #2971: reader inventories must follow the actual default-tool contract.
for (const powerShellAvailable of [false, true]) {
	test(`onboarding and CLI default inventories match runtime, PowerShell available: ${powerShellAvailable}`, async () => {
		const first = await readDoc("getting-started/first-session.md");
		const onboarding = first
			.split("By default, Atomic gives the model these tools:\n")[1]
			?.split("\nNormal coding sessions")[0];
		assert.ok(onboarding, "onboarding default-tool inventory exists");
		const cli = await readDoc("reference/cli.md");
		const reference = cli.match(/Default built-in tools: ([^\n]+?executable is available\.)/)?.[1];
		assert.ok(reference, "CLI default-tool inventory exists");
		for (const inventory of [onboarding, reference]) {
			assertInventory(inventory, powerShellAvailable);
			assert.throws(() => assertInventory(inventory.replace(/`kill`/g, "kill"), powerShellAvailable));
		}
	});
}

// #2847 / PR #2971: observation policy is not an execution-mode restriction.
test("CLI shell environment guidance agrees with foreground/background bash schema", async () => {
	const cli = await readDoc("reference/cli.md");
	const tool = createBashTool(process.cwd());
	for (const kind of ["foreground", "background"]) {
		assert.equal(Value.Check(tool.parameters, { command: "printf test", wait: { kind } }), true);
	}
	assert.match(tool.description, /foreground\/background observation/);
	assert.match(tool.description, /Observation never changes execution timeout/);
	assert.doesNotMatch(cli, /Every bash execution runs in the foreground/);
	assert.match(cli, /Every bash execution receives one execution-time snapshot/);
	assert.match(
		cli,
		/Foreground\/background observation controls how long the caller waits, not the command's execution timeout/,
	);
	assert.match(cli, /explicit background observation requires a supported task owner/);
	assert.match(cli, /Without one, foreground execution waits until completion/);
	assert.match(cli, /\/background-tasks#choose-how-long-to-wait/);
	assert.match(cli, /The snapshot is taken when the command executes, not when the tool is created/);
	for (const name of ["SESSION_ID", "PROVIDER", "MODEL", "REASONING_LEVEL"]) {
		assert.ok(cli.includes(`| \`ATOMIC_${name}\` | \`PI_${name}\` |`));
	}
	assert.doesNotMatch(cli, /ATOMIC_SESSION_FILE|PI_SESSION_FILE/);
});

// #2847: new upstream guidance remains discoverable through the migrated Learn path.
test("computer use and initialization troubleshooting have live learning-path destinations", async () => {
	const nav = await readDoc("docs.json");
	assert.match(nav, /"computer-use"/);
	assert.match(await readDoc("guides.md"), /\[Computer use\]\(\/computer-use\)/);
	const computer = await readDoc("computer-use.md");
	for (const heading of [
		"Application scripting and APIs",
		"Desktop automation with agent-desktop",
		"Browser automation with agent-browser",
		"Terminal automation with Herdr",
		"macOS",
		"Linux",
		"Windows",
	]) {
		assert.ok(computer.includes(`## ${heading}`));
	}
	assert.match(await readDoc("intercom.md"), /\/intercom\/operations#troubleshooting-initialization/);
	assert.match(await readDoc("intercom/operations.md"), /### Troubleshooting initialization/);
});

// #3181: desktop computer use routes to agent-desktop, never to PyAutoGUI, and every documented path checks readiness.
test("computer-use guides route desktop apps to agent-desktop and never to PyAutoGUI (#3181)", async () => {
	const computer = await readDoc("computer-use.md");
	const skills = await readDoc("skills.md");
	for (const [name, text] of [
		["computer-use.md", computer],
		["skills.md", skills],
	] as const) {
		assert.doesNotMatch(text, /PyAutoGUI|pyautogui/i, `${name} still names PyAutoGUI`);
		assert.doesNotMatch(text, /uv run --with pyautogui/, `${name} still runs pyautogui through uv`);
		assert.match(text, /agent-desktop/, `${name} does not route desktop apps to agent-desktop`);
		assert.doesNotMatch(text, /cua-driver|trycua|CUA_DRIVER|CuaDriver/, `${name} still routes to Cua Driver`);
		assert.match(text, /agent-desktop permissions --guide/, `${name} does not say how to grant macOS permission`);
	}
	assert.match(computer, /Electron desktop app/);
	assert.match(computer, /agent-browser hits a limitation/);
	assert.match(computer, /native iOS app/i);
	assert.match(computer, /attach the before and after PNGs to the PR body/);
	assert.match(computer, /Keep `screenshot` PNGs and `record` recordings from the verified flow/);
	for (const heading of ["### Install if missing", "### Check readiness", "### Coverage and limits"]) {
		assert.ok(computer.includes(heading), `computer-use.md lacks ${heading}`);
	}
	assert.match(
		computer,
		/When a model chooses the next action, use the skill and one-shot commands\. When a script owns the sequence, call the CLI from the script\./,
	);
	assert.match(computer, /npm install -g agent-desktop/);
	assert.match(computer, /npm install-scripts approve agent-desktop/);
	assert.match(computer, /agent-desktop status/);
	assert.match(computer, /agent-desktop skills get desktop/);
	assert.match(computer, /agent-desktop skills get platform/);
	assert.match(computer, /You do not need `npx skills add` for it/);
	assert.match(computer, /leave any existing user-level skill alone/);
	assert.match(computer, /\*\*No pixel matching\.\*\*/);
	assert.match(computer, /\*\*No native iOS or Android support\.\*\*/);
	assert.match(computer, /### What agent-browser covers/);
	assert.match(computer, /agent-browser -p ios --device "iPhone 16 Pro" open <url>/);
	assert.match(computer, /agent-browser's iOS mode drives Mobile Safari only/);
	assert.match(
		computer,
		/Stop and report a missing macOS permission, an absent Linux accessibility bus, or a missing install/,
	);
	assert.match(skills, /vercel-labs\/agent-desktop\/tree\/v1\.3\.1\/skills\/agent-desktop/);
	assert.match(skills, /Apache-2\.0 licensed/);
});
