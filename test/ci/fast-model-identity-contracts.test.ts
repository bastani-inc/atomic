import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
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
	"DEFAULT_STRUCTURED_OUTPUT_TIMEOUT_MS",
	// pi-agent-core 0.87.0 replaced the inherited stop hook with finishTurn.
	"shouldStopAfterTurn",
	// PR #3114: the former TypeSafe environment variable is no longer recognized.
	"TYPESAFE_AI_API_KEY",
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
	// #3089: routerModel is a settings.json field, not a package-root export.
	"routerModel",
	// The session tool name is distinct from its exported SDK functions.
	"structured_output",
	// PowerShell installer prose: the .NET ZipFile API and the Expand-Archive cmdlet.
	"ZipFile",
	"Expand-Archive",
	// #3089: workflow routing's inline sentinel is a wire value, not an export.
	"none",
	// PR #3143: the auto-routing state fields sent to the router are wire names, not exports.
	"model_selection_guide",
	"evals",
	// PR #2998 names bundled web-access tools and their parameters, not package-root exports.
	"code_search",
	"web_search",
	"repoName",
	"query",
	// PR #3082: Herdr's installed Pi integration reports the agent identity `pi`, not a package-root export.
	"pi",
	// Subagent tool/action names and targeting fields are not package-root exports.
	"subagent",
	"interrupt",
	"kill",
	"runId",
	"enabled",
	"inheritEnv",
	"bash",
	"powershell",
	// PR #2982: PostgreSQL command and Windows executable-search environment variable, not exports.
	"pg_ctl",
	"PATH",
	// Managed PostgreSQL port configuration is an environment variable, not a package-root export.
	"ATOMIC_POSTGRES_PORT",
	// PR #3114: the replacement TypeSafe environment variable is configuration, not an export.
	"TYPESAFE_API_KEY",
	// PR #3167: the Meta Model API key environment variable is configuration, not an export.
	"META_API_KEY",
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
	// PR #2858: the Codex originator and reasoning efforts are wire values, not exports.
	"codex_cli_rs",
	"low",
	"max",
	"fast",
	"medium",
	// Prompt-cache warming modes in settings, not package-root exports.
	"streaming",
	"idle",
	"off",
	// Transitive pi runtime package name, not a package-root export.
	"chord",
	// Bundled skill name and its engine environment variable, not package-root exports.
	"impeccable",
	"IMPECCABLE_BIN",
	// PR #3185: Goal stage status values a desktop-verification stage reports, not package-root exports.
	"blocked",
	"needs_human",
	// Extension event names, not package-root exports.
	"compaction_start",
	"session_before_compact",
	"enabledModels",
	"buildBaseOptions",
	"supportsMidConvoEffort",
	// `Model`/`SimpleStreamOptions` request field, never a package export.
	"maxTokens",
	"timeoutMs",
	"AbortSignal",
	"tsgo",
	"write",
	"edit",
	// PR #2920 names the question tool in prompt guidance, not a package-root export.
	"ask_user_question",
	// `/tasks` cancellation key, not a package-root export.
	"x",
	// Terminal UI copy, not a symbol: the interactive working-status label.
	"Working",
	// `FileMutationConflict` reason values. They are the strings a conflict message carries,
	// members of a union type rather than symbols a consumer imports.
	"no_prior_observation",
	"changed_since_observation",
	"target_exists",
	// The POSIX open flag the exclusive-create path uses, named as the concept rather than as a
	// symbol this package exports.
	"O_EXCL",
	// The literal `FILE_MUTATION_CONFLICT_CODE` holds, which is what appears in the message text.
	"FILE_MUTATION_CONFLICT",
	// `WriteOperations` members, defined by an implementation, never exported on their own.
	"readFile",
	"writeFile",
	// pi 0.87.0 sync: agent-core hook names, extension event names, boundary event fields,
	// session entry type names, and settings/tool names, none of which are package-root exports.
	"finishTurn",
	"prepareNextTurnWithContext",
	"agent_before_settle",
	"agent_settled",
	"agent_start",
	"agent_end",
	"before_agent_start",
	"turn_start",
	"turn_end",
	"message_start",
	"message_end",
	"context",
	"context_with_system",
	"context_edit",
	"custom",
	"custom_message",
	"compaction",
	"entries",
	"continue",
	"outcome",
	"messageEntryId",
	"toolResultEntryIds",
	"read",
	"GIF",
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

function assertChangelogIdentifiersResolve(block: string, isExported: (name: string) => boolean): void {
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
}

interface SyntaxNode {
	[key: string]: SyntaxValue | undefined;
	type?: string;
	name?: string;
	value?: string;
}

type SyntaxValue = string | number | boolean | null | SyntaxNode | SyntaxValue[];

function syntaxNode(value: SyntaxValue | undefined): SyntaxNode | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function identifierName(value: SyntaxValue | undefined): string | undefined {
	const node = syntaxNode(value);
	if (!node) return undefined;
	return typeof node.name === "string" ? node.name : typeof node.value === "string" ? node.value : undefined;
}

function addDeclarationNames(names: Set<string>, declaration: SyntaxNode | undefined): void {
	if (!declaration) return;
	if (declaration.type === "VariableDeclaration" && Array.isArray(declaration.declarations)) {
		for (const item of declaration.declarations) {
			const name = identifierName(syntaxNode(item)?.id);
			if (name) names.add(name);
		}
		return;
	}
	const name = identifierName(declaration.id);
	if (name) names.add(name);
}

function parseBarrelExports(
	sourcePath: string,
	source = readFileSync(sourcePath, "utf8"),
): { names: Set<string>; exportAllSpecifiers: string[] } {
	const names = new Set<string>();
	const exportAllSpecifiers: string[] = [];
	const ast = parse(source, { sourceType: "module", plugins: ["typescript"] }) as object as SyntaxNode;
	const body = syntaxNode(ast.program)?.body;
	if (!Array.isArray(body)) return { names, exportAllSpecifiers };
	for (const item of body) {
		const statement = syntaxNode(item);
		if (!statement) continue;
		if (statement.type === "ExportNamedDeclaration") {
			addDeclarationNames(names, syntaxNode(statement.declaration));
			if (!Array.isArray(statement.specifiers)) continue;
			for (const item of statement.specifiers) {
				const name = identifierName(syntaxNode(item)?.exported);
				if (name) names.add(name);
			}
			continue;
		}
		if (statement.type !== "ExportAllDeclaration") continue;
		const exportedName = identifierName(statement.exported);
		if (exportedName) {
			names.add(exportedName);
			continue;
		}
		const specifier = syntaxNode(statement.source)?.value;
		if (typeof specifier === "string") exportAllSpecifiers.push(specifier);
	}
	return { names, exportAllSpecifiers };
}

function resolveLocalExport(sourcePath: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const resolved = resolve(dirname(sourcePath), specifier);
	const extension = extname(resolved);
	const stem = extension ? resolved.slice(0, -extension.length) : resolved;
	const candidates = extension
		? [`${stem}.ts`, `${stem}.tsx`, resolved]
		: [`${resolved}.ts`, `${resolved}.tsx`, join(resolved, "index.ts")];
	return candidates.find((candidate) => existsSync(candidate));
}

function collectBarrelExports(sourcePath: string, visited = new Set<string>()): Set<string> {
	if (visited.has(sourcePath)) return new Set();
	visited.add(sourcePath);
	const parsed = parseBarrelExports(sourcePath);
	for (const specifier of parsed.exportAllSpecifiers) {
		const exportedPath = resolveLocalExport(sourcePath, specifier);
		if (!exportedPath) continue;
		for (const name of collectBarrelExports(exportedPath, visited)) parsed.names.add(name);
	}
	return parsed.names;
}

test("barrel export scanning ignores comments and imports", () => {
	const probe = join(root, "test/ci/fixtures/fast-model-identity-export-probe.ts");
	const source =
		'// export type { CommentOnly }\nimport type { ImportedOnly } from "./types.js";\nexport type { RealExport } from "./types.js";';
	assert.deepEqual([...parseBarrelExports(probe, source).names], ["RealExport"]);
});

// #3074: a documented configuration variable is not a package-root API export.
test("changelog environment-variable prose does not exempt unknown or removed exports", () => {
	assert.doesNotThrow(() => assertChangelogIdentifiersResolve("Supports `ATOMIC_POSTGRES_PORT`.", () => false));
	for (const name of ["ATOMIC_POSTGRES_PORT_TYPO", "resolveUpstreamRequestModel"]) {
		assert.throws(
			() => assertChangelogIdentifiersResolve(`Added \`${name}\`.`, () => false),
			/not exported from the package root/u,
		);
	}
	assert.throws(
		() => assertChangelogIdentifiersResolve(`Removed \`${deletedEnvName()}\`.`, () => true),
		/still named in the package root exports/u,
	);
});

// PR #3114: a renamed environment variable remains documented without becoming a root export.
test("TypeSafe environment-variable migration preserves removed and unknown identifier checks", () => {
	const block = "Renamed `TYPESAFE_AI_API_KEY` to `TYPESAFE_API_KEY`.";
	assert.doesNotThrow(() => assertChangelogIdentifiersResolve(block, () => false));
	assert.throws(
		() => assertChangelogIdentifiersResolve(block, (name) => name === "TYPESAFE_AI_API_KEY"),
		/still named in the package root exports/u,
	);
	assert.throws(
		() => assertChangelogIdentifiersResolve("Supports `TYPESAFE_API_KEY_TYPO`.", () => false),
		/not exported from the package root/u,
	);
});

test("structured decision timeout migration names removed exports and caller-owned cancellation (#3157)", () => {
	const block = "Removed `timeoutMs` and `DEFAULT_STRUCTURED_OUTPUT_TIMEOUT_MS`; use an `AbortSignal`.";
	assert.doesNotThrow(() => assertChangelogIdentifiersResolve(block, () => false));
	assert.throws(
		() => assertChangelogIdentifiersResolve(block, (name) => name === "DEFAULT_STRUCTURED_OUTPUT_TIMEOUT_MS"),
		/still named in the package root exports/u,
	);
	assert.throws(
		() => assertChangelogIdentifiersResolve("Use `DEFAULT_STRUCTURED_OUTPUT_TIMEOUT_TYPO`.", () => false),
		/not exported from the package root/u,
	);
});

test("every identifier the coding-agent [Unreleased] changelog names resolves", async () => {
	const rootExports = await import("../../packages/coding-agent/src/index.ts");
	const runtimeExports = new Set(Object.keys(rootExports));
	const barrelExports = collectBarrelExports(join(root, "packages/coding-agent/src/index.ts"));
	const isExported = (name: string): boolean => runtimeExports.has(name) || barrelExports.has(name);
	assertChangelogIdentifiersResolve(unreleasedBlock("packages/coding-agent/CHANGELOG.md"), isExported);
});

test("backticked pi in Herdr changelog prose is not required to be a root export", () => {
	assertChangelogIdentifiersResolve(
		"the installed asset reports itself as `pi`, so the pane ended up mislabelled",
		() => false,
	);
});

test("a genuine exported identifier in changelog prose resolves", () => {
	assertChangelogIdentifiersResolve("`AgentSession` is the session type", (name) => name === "AgentSession");
});

test("a removed identifier is accepted only while absent from exports", () => {
	const block = "the toggle named `fastMode` is gone";
	assertChangelogIdentifiersResolve(block, () => false);
	assert.throws(
		() => assertChangelogIdentifiersResolve(block, () => true),
		/the changelog says fastMode was removed, but it is still named in the package root exports/u,
	);
});

test("a nonexistent API identifier is still rejected alongside pi", () => {
	assert.throws(
		() =>
			assertChangelogIdentifiersResolve(
				"the installed asset reports itself as `pi` and names `notARealExport`",
				() => false,
			),
		/the changelog names `notARealExport`, which is not exported from the package root/u,
	);
});
