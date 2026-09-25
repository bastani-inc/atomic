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
		"Desktop automation with Cua Driver",
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

// #3181: desktop CUA guidance routes to Cua Driver with telemetry off on every documented path.
test("computer-use guides route desktop CUA to Cua Driver and never to PyAutoGUI (#3181)", async () => {
	const computer = await readDoc("computer-use.md");
	const verification = await readDoc("workflows/verification.md");
	const authoring = await readDoc("workflows/authoring.md");
	const skills = await readDoc("skills.md");
	for (const [name, text] of [
		["computer-use.md", computer],
		["workflows/verification.md", verification],
		["workflows/authoring.md", authoring],
		["skills.md", skills],
	] as const) {
		assert.doesNotMatch(text, /PyAutoGUI|pyautogui/i, `${name} still names PyAutoGUI`);
		assert.doesNotMatch(text, /uv run --with pyautogui/, `${name} still runs pyautogui through uv`);
		assert.match(text, /cua-driver/, `${name} does not route desktop CUA to cua-driver`);
	}
	for (const [name, text] of [
		["computer-use.md", computer],
		["workflows/verification.md", verification],
	] as const) {
		assert.match(text, /Electron desktop app/, `${name} does not scope agent-browser by its skill`);
		assert.match(
			text,
			/agent-browser hits a limitation/,
			`${name} does not route agent-browser limitations to Cua Driver`,
		);
		assert.match(text, /native iOS app in the iOS Simulator/, `${name} does not route native iOS apps to Cua Driver`);
	}
	assert.match(
		verification,
		/gh pr create --title "Fix settings save" --body-file body\.md \\\n {2}--attach 'before\.png#Settings panel before saving'/,
	);
	assert.match(
		verification,
		/before\/after `screenshot_out_file` PNGs from `get_window_state`[\s\S]*`screenshot` PNGs and `record` recordings/,
	);
	assert.match(computer, /attach the before\/after PNGs to the PR body/);
	assert.match(computer, /Keep `screenshot` PNGs and `record` recordings from the verified flow/);
	for (const heading of ["### Install if missing", "### Turn telemetry off", "### Check readiness"]) {
		assert.ok(computer.includes(heading), `computer-use.md lacks ${heading}`);
	}
	assert.match(
		computer,
		/when a model chooses the next action, use the CLI; when TypeScript code owns the sequence and the postcondition, use the SDK/,
	);
	assert.match(computer, /\/bin\/bash -c "\$\(curl -fsSL https:\/\/cua\.ai\/driver\/install\.sh\)"/);
	assert.match(computer, /irm https:\/\/cua\.ai\/driver\/install\.ps1 \| iex/);
	assert.match(computer, /Do not run `cua-driver skills install`/);
	assert.match(computer, /`cua-driver skills update`/);
	assert.match(computer, /`clawhub install @cua\/driver`/);
	assert.match(computer, /`~\/\.agents\/skills\/cua-driver`/);
	assert.match(computer, /leave any existing user-level skill alone/);
	assert.match(computer, /telemetry[^.]*\*\*by default, from every face\*\*/);
	assert.match(computer, /CUA_DRIVER_RS_TELEMETRY_ENABLED=false/);
	assert.match(computer, /`cua-driver telemetry disable`/);
	assert.match(computer, /`cua-driver telemetry status --json`/);
	assert.match(computer, /CUA_DRIVER_RS_UPDATE_CHECK=false/);
	assert.match(computer, /`cua-driver config set update_check_enabled false`/);
	assert.match(computer, /open -n -g -a CuaDriver --args serve/);
	assert.match(computer, /`cua-driver update --apply` once/);
	assert.match(computer, /`CuaDriver\.connect\(\)`[\s\S]*`CuaDriver\.create\(\)`/);
	assert.match(computer, /\/workflows\/authoring#desktop-verification-with-cua-driver-in-ctx-tool/);
	assert.match(
		verification,
		/\| Native desktop app, native iOS app in the iOS Simulator, Android emulator, desktop Safari or another non-Chromium browser, or OS dialogs \| \*\*Cua Driver\*\*/,
	);
	assert.match(verification, /Mobile Safari in the iOS Simulator[^|]*\| \*\*agent-browser\*\*/);
	assert.match(computer, /### What agent-browser covers/);
	assert.match(computer, /agent-browser -p ios --device "iPhone 16 Pro" open <url>/);
	assert.match(computer, /agent-browser's iOS mode drives Mobile Safari only/);
	assert.match(verification, /`blocked`\/`needs_human`/);
	assert.match(verification, /ctx\.exit\(\{ status: "blocked", reason \}\)/);
	assert.match(verification, /structured window state plus screenshots, not a screenshot alone/);
	assert.ok(authoring.includes('<a id="desktop-verification-with-cua-driver-in-ctx-tool" />'));
	assert.match(authoring, /CUA_DRIVER_RS_TELEMETRY_ENABLED: "false"/);
	assert.match(authoring, /daemon \? await CuaDriver\.connect\(\) : CuaDriver\.create\(undefined\)/);
	assert.match(authoring, /ctx\.exit\(\{ status: "blocked", reason: preflight\.reason \}\)/);
	assert.match(authoring, /InputDeliveryMode\.Background/);
	assert.match(authoring, /timeoutMs: 5 \* 60_000/);
	assert.match(authoring, /uniffiDestroy/);
	for (const [name, text] of [
		["workflows/verification.md", verification],
		["workflows/authoring.md", authoring],
	] as const) {
		assert.match(text, /blocked author exit is terminal and not resumable/, `${name} must state the engine's rule`);
		assert.doesNotMatch(
			text,
			/`workflow resume` re-runs the preflight/,
			`${name} promises a resume the engine never does`,
		);
	}
	assert.match(skills, /cua-driver-rs-v0\.28\.2/);
	assert.match(skills, /MIT licensed, © 2025 Cua AI, Inc\./);
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
