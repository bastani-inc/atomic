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

/**
 * The type-level export contract names the removed symbols on purpose, so the compiler can prove
 * they are absent from the root export map. Scanning it would flag exactly the assertion it makes.
 */
const removedNameContractPath = "packages/coding-agent/test/types/fast-model-root-exports.ts";

function scanPath(file: string): boolean {
	if (file === guardPath || file === removedNameContractPath) return false;
	if (file.startsWith("specs/") || file.startsWith("research/")) return false;
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

/**
 * Keep the `[Unreleased]` changelog prose honest about the export surface.
 *
 * The block once named `resolveUpstreamRequestModel`, which had been renamed to
 * `resolveUpstreamModelId` before release, and nothing caught it: the type-level contract in
 * `packages/coding-agent/test/types/fast-model-root-exports.ts` pins the names it lists, but a
 * *changelog* that names something else is invisible to the compiler. This closes that direction.
 *
 * Only backticked bare identifiers are considered, which excludes settings keys
 * (`codexFastMode.chat`), model IDs (`openai-codex/gpt-5.6-sol-fast`), file paths
 * (`core/fast-model-routing.ts`), and method calls (`ModelRuntime.getWarning()`).
 */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/** Named in the removal bullets, so they must not resolve — that is the point of naming them. */
const removedNames = new Set([
	"ATOMIC_CODEX_FAST_MODE",
	"ENV_CODEX_FAST_MODE",
	"CODEX_FAST_MODE_SERVICE_TIER",
	"CODEX_FAST_MODE_ORIGINATOR",
	"CODEX_FAST_MODE_ROUTING_HEADER",
	"CodexFastModeResolvedSettings",
	"CodexFastModeScope",
	"formatCodexFastModeModelLabel",
	"getCodexFastModeScope",
	"hasSupportedCodexFastModeModel",
	"isCodexFastModeCandidateModelId",
	"isCodexFastModeEnabledForScope",
	"isCodexFastModeSupportedModel",
	"isCodexFastModeSupportedProvider",
	"shouldApplyCodexFastMode",
	"shouldApplyCodexFastModeForScope",
	"withCodexFastModeHeaders",
	"getCodexFastModeSettings",
	"setCodexFastModeSettings",
	"codexFastMode",
	"fastMode",
]);

/**
 * English words, provider IDs, API IDs, wire fields, and option names that legitimately appear in
 * backticks. Anything else must resolve to a real export or be listed as removed.
 */
const proseNames = new Set([
	"openai",
	"anthropic",
	// Parameter and request-field names, never exports.
	"enabled",
	"openrouter",
	"flex",
	"undefined",
	"auth",
	"login",
	"stream",
	"streamSimple",
	"complete",
	"completeSimple",
	"getModels",
	"model",
	"models",
	"modelId",
	"fallbackModels",
	"modelOverrides",
	"fastRoute",
	"provider",
	"priority",
	"default",
	"service_tier",
	"serviceTier",
	"originator",
	"fast",
	"medium",
	"enabledModels",
	"buildBaseOptions",
	"tsgo",
	"edit",
]);

function unreleasedBlock(changelogPath: string): string {
	const source = readFileSync(join(root, changelogPath), "utf8");
	const start = source.indexOf("## [Unreleased]");
	assert.notEqual(start, -1, `${changelogPath} has no [Unreleased] section`);
	const next = source.indexOf("\n## [", start + "## [Unreleased]".length);
	return source.slice(start, next < 0 ? source.length : next);
}

function backtickedIdentifiers(block: string): string[] {
	const names = new Set<string>();
	for (const match of block.matchAll(/`([^`\n]+)`/gu)) {
		const token = match[1]?.trim();
		if (token && IDENTIFIER_PATTERN.test(token)) names.add(token);
	}
	return [...names];
}

test("every identifier the coding-agent [Unreleased] changelog names resolves", async () => {
	const rootExports = await import("../../packages/coding-agent/src/index.ts");
	const runtimeExports = new Set(Object.keys(rootExports));
	// `src/index.ts` is an export barrel, so a word match there covers type-only exports, which never
	// appear in the runtime module namespace.
	const barrel = readFileSync(join(root, "packages/coding-agent/src/index.ts"), "utf8");
	const isExported = (name: string): boolean =>
		runtimeExports.has(name) || new RegExp(`\\b${name}\\b`, "u").test(barrel);
	const block = unreleasedBlock("packages/coding-agent/CHANGELOG.md");

	for (const name of backtickedIdentifiers(block)) {
		if (proseNames.has(name)) continue;
		if (removedNames.has(name)) {
			assert.equal(
				isExported(name),
				false,
				`the changelog says ${name} was removed, but it is still named in the package root exports`,
			);
			continue;
		}
		assert.equal(
			isExported(name),
			true,
			`the changelog names \`${name}\`, which is not exported from the package root. Rename the ` +
				`changelog entry to the shipped symbol, add it to the removed list, or add it to proseNames ` +
				`if it is ordinary prose.`,
		);
	}
});
