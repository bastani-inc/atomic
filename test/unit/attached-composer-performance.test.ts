import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

const COMPOSER_PROCESS_TIMEOUT_MS = 15_000;
const COMPOSER_TEST_TIMEOUT_MS = COMPOSER_PROCESS_TIMEOUT_MS + 10_000;
const composerPath = fileURLToPath(
	new URL("../../packages/coding-agent/src/modes/interactive/components/input-label.ts", import.meta.url),
);

function renderInProcess(scenario: "application-commands" | "trailing-spaces"): void {
	const result = spawnSyncCollect(
		[
			process.execPath,
			"--input-type=module",
			"-e",
			`
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const { applyAttachedComposer } = await createJiti(import.meta.url).import(${JSON.stringify(composerPath)});
const style = { accent: text => text, text: text => text, dim: text => text };
const line = ${JSON.stringify(scenario)} === "application-commands"
	? "\\x1b_".repeat(400_000)
	: "❯" + " ".repeat(400_000) + "\\x1b[0K";
const rendered = applyAttachedComposer(style, undefined, "hint", ["─".repeat(80), line, "─".repeat(80)]);
assert.equal(rendered[1], ${JSON.stringify(scenario)} === "application-commands" ? line : line + " hint");
`,
		],
		{ timeout: COMPOSER_PROCESS_TIMEOUT_MS },
	);
	assert.equal(result.exitCode, 0, `${scenario}: ${result.stderr.toString()} ${result.signalCode ?? ""}`);
}

test(
	"an attached composer handles unterminated application commands without blocking input (#5245)",
	() => renderInProcess("application-commands"),
	COMPOSER_TEST_TIMEOUT_MS,
);

test(
	"an attached composer handles padding before a non-SGR escape without blocking input (#5245)",
	() => renderInProcess("trailing-spaces"),
	COMPOSER_TEST_TIMEOUT_MS,
);
