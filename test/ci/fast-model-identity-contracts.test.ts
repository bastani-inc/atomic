import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

/**
 * Fast inference is selectable model identity now: an eligible fast model is the real canonical ID
 * `<provider>/<base-model-id>-fast`, and its behavior comes from explicit `Model.fastRoute` metadata.
 *
 * The `/fast` toggle it replaced is gone with no compatibility shim, so this guard proves the toggle's
 * command, settings, environment variable, selector UI, and redundant `fastMode` runtime/result state
 * stay absent from shipped source, docs, tests, and scripts.
 *
 * Changelogs are excluded: naming a removed symbol is exactly what release notes are for, and released
 * sections are immutable history. `specs/` and `research/` write-ups are excluded for the same reason —
 * they record the state of the world when they were authored.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const guardPath = "test/ci/fast-model-identity-contracts.test.ts";

/** Assembled at runtime so this guard file is not itself a match for its own scan. */
function deletedEnvName(): string {
	return ["ATOMIC", "CODEX", "FAST", "MODE"].join("_");
}

function deletedToggleNames(): readonly string[] {
	const codexFastMode = ["Codex", "Fast", "Mode"].join("");
	const fastMode = ["fast", "Mode"].join("");
	return [
		`ENV_${["CODEX", "FAST", "MODE"].join("_")}`,
		`codex${codexFastMode.slice(5)}`,
		`get${codexFastMode}Settings`,
		`set${codexFastMode}Settings`,
		`${codexFastMode}Settings`,
		`${codexFastMode}ResolvedSettings`,
		`${codexFastMode}Scope`,
		`shouldApply${codexFastMode}`,
		`isEnabledFor${codexFastMode}`,
		`format${codexFastMode}ModelLabel`,
		`hasSupported${codexFastMode}Model`,
		`is${codexFastMode}SupportedProvider`,
		`is${codexFastMode}CandidateModelId`,
		`show${["Fast", "Mode", "Selector"].join("")}`,
		`${["Fast", "Mode", "Selector"].join("")}Component`,
		`current${["Fast", "Mode"].join("")}`,
		`Workflow${["Fast", "Mode"].join("")}Settings`,
		`${fastMode}?:`,
		`${fastMode}:`,
	];
}

const deletedModulePaths = [
	"packages/coding-agent/src/core/codex-fast-mode.ts",
	"packages/coding-agent/src/core/codex-fast-mode-transport.ts",
	"packages/coding-agent/src/modes/interactive/components/fast-mode-selector.ts",
	"packages/subagents/src/shared/fast-mode.ts",
] as const;

function trackedFiles(): string[] {
	const result = spawnSyncCollect(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout
		.toString("utf8")
		.split("\0")
		.filter((file) => file.length > 0);
}

function isChangelogPath(file: string): boolean {
	return file.endsWith("CHANGELOG.md") || file.endsWith("/changelog.mdx");
}

function scanPath(file: string): boolean {
	if (file === guardPath || file.startsWith("specs/") || file.startsWith("research/")) return false;
	if (file.startsWith("packages/coding-agent/dist/") || isChangelogPath(file)) return false;
	return file.startsWith("packages/") || file.startsWith("test/") || file.startsWith("scripts/");
}

test("the removed /fast toggle, its settings, and its environment variable stay absent", () => {
	for (const relative of trackedFiles().filter(scanPath)) {
		assert.equal(existsSync(join(root, relative)), true, `${relative} listed by git but missing from disk`);
		const source = readFileSync(join(root, relative), "utf8");
		assert.equal(
			source.includes(deletedEnvName()),
			false,
			`${relative} reintroduced the deleted ${deletedEnvName()} environment variable`,
		);
		for (const name of deletedToggleNames()) {
			assert.equal(source.includes(name), false, `${relative} reintroduced the deleted fast-toggle symbol ${name}`);
		}
	}
});

test("the removed /fast slash command is not registered", () => {
	const source = readFileSync(join(root, "packages/coding-agent/src/core/slash-commands.ts"), "utf8");
	assert.equal(/\bname:\s*"fast"/u.test(source), false, "the /fast built-in slash command was reintroduced");
	const inputHandling = readFileSync(
		join(root, "packages/coding-agent/src/modes/interactive/interactive-input-handling.ts"),
		"utf8",
	);
	assert.equal(inputHandling.includes('"/fast"'), false, "the /fast submit branch was reintroduced");
});

test("the deleted toggle modules stay deleted", () => {
	for (const relative of deletedModulePaths) {
		assert.equal(existsSync(join(root, relative)), false, `${relative} was reintroduced`);
	}
});

test("fast semantics come from explicit route metadata, not the -fast suffix", () => {
	const variants = readFileSync(join(root, "packages/coding-agent/src/core/fast-model-variants.ts"), "utf8");
	assert.equal(variants.includes("fastRoute"), true, "the derivation layer must attach explicit route metadata");
	const routing = readFileSync(join(root, "packages/coding-agent/src/core/fast-model-routing.ts"), "utf8");
	// The routing module decides purely from `model.fastRoute`; it must never test the ID suffix.
	assert.equal(
		/endsWith\(\s*["'`]-fast/u.test(routing),
		false,
		"fast-model-routing.ts must not infer fast behavior from the -fast suffix",
	);
	const sdk = readFileSync(join(root, "packages/coding-agent/src/core/sdk.ts"), "utf8");
	assert.equal(
		/endsWith\(\s*["'`]-fast/u.test(sdk),
		false,
		"sdk.ts must not infer fast behavior from the -fast suffix",
	);
	const copilot = readFileSync(join(root, "packages/ai/src/providers/github-copilot.ts"), "utf8");
	assert.equal(
		/endsWith\(\s*["'`]-fast/u.test(copilot),
		false,
		"the GitHub Copilot provider must gate fast entries on route metadata, not the -fast suffix",
	);
});
