import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { test } from "vitest";
import { createBashTool } from "../../packages/coding-agent/src/core/tools/bash.js";
import { getDefaultToolNames } from "../../packages/coding-agent/src/core/tools/index.js";
import { readText } from "../helpers/runtime.js";

const docsRoot = new URL("../../packages/coding-agent/docs/", import.meta.url);
const readDoc = (path: string) => readText(fileURLToPath(new URL(path, docsRoot)));

function assertInventory(text: string, powerShellAvailable: boolean) {
	const names = [...text.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
	const expected = getDefaultToolNames({ powerShellAvailable });
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
	for (const name of ["SESSION_ID", "SESSION_FILE", "PROVIDER", "MODEL", "REASONING_LEVEL"]) {
		assert.ok(cli.includes(`| \`ATOMIC_${name}\` | \`PI_${name}\` |`));
	}
});

// #2847: new upstream guidance remains discoverable through the migrated Learn path.
test("computer use and initialization troubleshooting have live learning-path destinations", async () => {
	const nav = await readDoc("docs.json");
	assert.match(nav, /"computer-use"/);
	assert.match(await readDoc("guides.md"), /\[Computer use\]\(\/computer-use\)/);
	const computer = await readDoc("computer-use.md");
	for (const heading of [
		"Application scripting and APIs",
		"Desktop automation with PyAutoGUI and uv",
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

// #2847: upstream wording changes must not break previously published fragments.
test("updated workflow headings retain exact legacy fragment aliases", async () => {
	for (const [path, aliases] of [
		["workflows/reliable-design.md", ["8-interrupt-stale-or-wrong-work"]],
		[
			"workflows/verification.md",
			[
				"select-the-verification-environment",
				"terminal-contracts",
				"reproduce-stage-skill-terminal-evidence",
				"desktop-safety",
			],
		],
	] as const) {
		const text = await readDoc(path);
		for (const id of aliases) assert.equal(text.split(`<a id="${id}" />`).length, 2, `${path}#${id}`);
	}
});
