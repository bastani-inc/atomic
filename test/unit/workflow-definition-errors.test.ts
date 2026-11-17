import assert from "node:assert/strict";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { SelectorState } from "@bastani/atomic";
import { afterAll, describe, it } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { type DiscoveryDiagnostic, discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import type { PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import type {
	PiCustomComponent,
	PiCustomOverlayFactory,
	PiCustomOverlayFactoryTui,
} from "../../packages/workflows/src/extension/wiring.js";
import {
	formatInvalidDefinitionDetails,
	handleWorkflowsCommand,
	type WorkflowsCommandDeps,
} from "../../packages/workflows/src/extension/workflow-open-run.js";
import {
	invalidDefinitionsFromDiagnostics,
	type WorkflowsListingDefinition,
	workflowsListingItems,
} from "../../packages/workflows/src/tui/workflows-listing.js";
import { cleanupDiscoveryTempDirs, join, makeTempDir, mkdirSync, writeFileSync } from "./discovery-helpers.js";
import * as h from "./overlay-graph-helpers.js";

afterAll(cleanupDiscoveryTempDirs);

const PARSE_ERROR = [
	"Error: Workflow file failed to import: Unexpected token ')' (12:4)",
	"    at importWorkflow (/atomic/discovery.ts:88:9)",
	"    at async discover (/atomic/discovery.ts:120:3)",
].join("\n");

const DIAGNOSTICS: readonly DiscoveryDiagnostic[] = [
	{ level: "error", code: "IMPORT_FAILED", source: "/repo/.atomic/workflows/greet.ts", message: PARSE_ERROR },
	{ level: "error", code: "INVALID_DEFINITION", source: "deploy", message: "Definition has no stages" },
	{ level: "warn", code: "DUPLICATE_NAME", source: "ralph", message: "Skipped a duplicate" },
	{ level: "warn", code: "ZERO_STAGES", source: "lint", message: "No stage call sites found" },
];

type PickerFactory = (
	tui: PiCustomOverlayFactoryTui,
	theme: Parameters<PiCustomOverlayFactory>[1] | undefined,
	keys: Parameters<PiCustomOverlayFactory>[2] | undefined,
	done: (result: undefined) => void,
) => PiCustomComponent;

function harness(
	definitions: readonly WorkflowsListingDefinition[] = [],
	invalid: readonly DiscoveryDiagnostic[] = DIAGNOSTICS,
) {
	const opened: string[] = [];
	const messages = { info: [] as string[], error: [] as string[] };
	const pickers: PickerFactory[] = [];
	const started: string[] = [];
	const ctx: PiCommandContext = {
		hasUI: true,
		ui: {
			custom: (factory) => {
				pickers.push(factory as PickerFactory);
				return new Promise<undefined>(() => {});
			},
			notify() {},
		},
	};
	const deps: WorkflowsCommandDeps = {
		overlay: {
			open: (runId) => {
				assert.ok(runId);
				opened.push(runId);
			},
			toggle() {},
			close() {},
		},
		store: h.makeStore({ runs: [], notices: [], version: 1 }),
		definitions: () => definitions,
		invalidDefinitions: () => invalidDefinitionsFromDiagnostics(invalid),
		startDefinition: async (name) => {
			started.push(name);
		},
	};
	const reporter = {
		info: (m: string) => {
			messages.info.push(m);
		},
		error: (m: string) => {
			messages.error.push(m);
		},
	};
	return { opened, messages, pickers, started, ctx, deps, reporter };
}

describe("workflow definition errors before launch (#5224)", () => {
	it("keeps only the diagnostics that stopped a definition from loading, named by workflow", () => {
		const invalid = invalidDefinitionsFromDiagnostics(DIAGNOSTICS);
		assert.deepEqual(
			invalid.map((entry) => [entry.name, entry.reason]),
			[
				["greet", "Workflow file failed to import: Unexpected token ')' (12:4)"],
				["deploy", "Definition has no stages"],
			],
		);
	});

	it("lists a definition that failed to load as ✗ with its one-line reason; Enter explains it instead of starting it", async () => {
		initTheme("dark");
		const t = harness([{ normalizedName: "ralph", description: "iterate a fix", inputs: {} }]);
		const pending = handleWorkflowsCommand("", t.ctx, t.reporter, t.deps);
		await Promise.resolve();
		assert.equal(t.pickers.length, 1);
		const component = t.pickers[0]!({ requestRender() {} }, undefined, undefined, () => {});
		const text = stripAnsi(component.render(120).join("\n"));
		assert.match(text, /greet/);
		assert.match(text, /failed to load · Workflow file failed to import: Unexpected token '\)' \(12:4\)/);
		assert.match(text, /✗/);
		assert.doesNotMatch(text, /at importWorkflow/);
		component.handleInput?.("\x1b[B");
		component.render(120);
		component.handleInput?.("\r");
		await pending;
		assert.deepEqual(t.started, [], "a broken definition never starts");
		assert.deepEqual(t.messages.error, [], "the ✗ line says it failed; no extra Error: prefix");
		const shown = t.messages.info.join("\n");
		assert.match(shown, /✗ Workflow "greet" could not be loaded/);
		assert.match(shown, /file\s+\/repo\/\.atomic\/workflows\/greet\.ts/);
		assert.match(shown, /reason\s+Workflow file failed to import: Unexpected token '\)' \(12:4\)/);
		assert.match(shown, /Fix the file, then run \/reload to load it again\./);
		assert.doesNotMatch(shown, /at importWorkflow/, "no stack frame, even in the details");
		assert.match(shown, /2 stack frames hidden/);
		assert.equal(shown.match(/Unexpected token/g)?.length, 1, "the reason is shown once");
	});

	it('drops discovery\'s `Failed to import "<file>":` prefix from the reason, since the row names the file', () => {
		const [entry] = invalidDefinitionsFromDiagnostics([
			{
				level: "error",
				code: "IMPORT_FAILED",
				source: "/p/greet.ts",
				message: 'Failed to import "/p/greet.ts": ParseError: Unexpected token, expected ","\n  /p/greet.ts:8:36',
			},
		]);
		assert.equal(entry?.reason, 'ParseError: Unexpected token, expected ","');

		const [tabEntry] = invalidDefinitionsFromDiagnostics([
			{
				level: "error",
				code: "IMPORT_FAILED",
				source: "/p/greet\tname.ts",
				message: 'Failed to import "/p/greet\tname.ts": ParseError: Unexpected token',
			},
		]);
		assert.equal(tabEntry?.reason, "ParseError: Unexpected token");
	});

	it("opens the sheet when the only definitions are broken, instead of saying there are no workflows", async () => {
		initTheme("dark");
		const t = harness([]);
		const pending = handleWorkflowsCommand("", t.ctx, t.reporter, t.deps);
		await Promise.resolve();
		assert.equal(t.pickers.length, 1);
		assert.deepEqual(t.messages.info, []);
		const component = t.pickers[0]!({ requestRender() {} }, undefined, undefined, () => {});
		component.handleInput?.("\x1b");
		await pending;
	});

	it("a workflow tool error card shows the message without its stack frames", () => {
		const card = stripAnsi(renderResult(null, { errorText: PARSE_ERROR, width: 100 }));
		assert.match(card, /Workflow file failed to import: Unexpected token '\)' \(12:4\)/);
		assert.doesNotMatch(card, /at importWorkflow/);
		assert.match(card, /2 stack frames hidden/);
	});

	it("a broken definition's name, reason and details are inert, never live escape sequences (#5224)", () => {
		const evil = "a\x1b]52;c;aGk=\x07b\x1b[2Jc\u202ed";
		const [definition] = invalidDefinitionsFromDiagnostics([
			{
				level: "error",
				code: "IMPORT_FAILED",
				source: `/repo/${evil}.ts`,
				message: `Error: bad ${evil}\nmore ${evil}`,
			},
		]);
		assert.ok(definition);
		const shown = [definition.name, definition.reason, formatInvalidDefinitionDetails(definition)].join("\n");
		assert.doesNotMatch(shown, /\x1b/);
		assert.doesNotMatch(shown, /\u202e/);
		assert.match(shown, /<U\+202E>/);
	});

	it("a broken definition's row keeps its id when other diagnostics or earlier repeats for the same file come and go (#5224)", () => {
		const greet = DIAGNOSTICS[0]!;
		const deploy = DIAGNOSTICS[1]!;
		const idOf = (diagnostics: readonly DiscoveryDiagnostic[], name: string) =>
			workflowsListingItems([], [], 0, invalidDefinitionsFromDiagnostics(diagnostics)).find(
				(item) => item.label === name,
			)?.id;
		assert.equal(idOf([greet, deploy], "deploy"), idOf([deploy], "deploy"));
		assert.equal(idOf([deploy, greet], "greet"), idOf([greet], "greet"));

		const exportDiag = (exportKey: string): DiscoveryDiagnostic => ({
			level: "error",
			code: "INVALID_DEFINITION",
			source: "/repo/.atomic/workflows/release.ts",
			message: `workflow export "${exportKey}" rejected: missing run()`,
		});
		const idsFor = (diagnostics: readonly DiscoveryDiagnostic[]) =>
			workflowsListingItems([], [], 0, invalidDefinitionsFromDiagnostics(diagnostics)).map((item) => [
				item.id,
				item.value.kind === "invalid-definition" ? item.value.definition.message : "",
			]);
		const both = idsFor([exportDiag("publish"), exportDiag("verify")]);
		const onlyVerify = idsFor([exportDiag("verify")]);
		const publishId = both.find(([, message]) => message.includes("publish"))?.[0];
		const verifyIdBefore = both.find(([, message]) => message.includes("verify"))?.[0];
		const verifyIdAfter = onlyVerify[0]?.[0];
		assert.ok(publishId);
		assert.ok(verifyIdBefore);
		assert.notEqual(publishId, verifyIdBefore);
		assert.equal(verifyIdAfter, verifyIdBefore);

		const verifyChanged = idsFor([
			{
				level: "error",
				code: "INVALID_DEFINITION",
				source: "/repo/.atomic/workflows/release.ts",
				message: 'workflow export "verify" rejected: name must be a non-empty string',
			},
		]);
		assert.equal(verifyChanged[0]?.[0], verifyIdBefore);

		const sourceless = workflowsListingItems([], [], 0, [
			{ name: "alpha", code: "INVALID_DEFINITION", reason: "bad", message: "bad" },
			{ name: "beta", code: "INVALID_DEFINITION", reason: "bad", message: "bad" },
		]);
		assert.notEqual(sourceless[0]?.id, sourceless[1]?.id);

		const singleImportFirst = workflowsListingItems(
			[],
			[],
			0,
			invalidDefinitionsFromDiagnostics([
				{ level: "error", code: "IMPORT_FAILED", source: "/w/a.ts", message: "first failure" },
			]),
		);
		const singleImportSecond = workflowsListingItems(
			[],
			[],
			0,
			invalidDefinitionsFromDiagnostics([
				{ level: "error", code: "IMPORT_FAILED", source: "/w/a.ts", message: "second failure" },
			]),
		);
		assert.equal(singleImportFirst[0]?.id, singleImportSecond[0]?.id);

		const replayCases: ReadonlyArray<{
			readonly name: string;
			readonly diagnostics: readonly DiscoveryDiagnostic[];
		}> = [
			{
				name: "same-source-different-message",
				diagnostics: [
					{ level: "error", code: "IMPORT_FAILED", source: "/w/a.ts", message: "first failure" },
					{ level: "error", code: "IMPORT_FAILED", source: "/w/a.ts", message: "second failure" },
				],
			},
			{
				name: "escaped-source",
				diagnostics: [
					{ level: "error", code: "IMPORT_FAILED", source: "/w/a\x07.ts", message: "first failure" },
					{ level: "error", code: "IMPORT_FAILED", source: "/w/a\\x07.ts", message: "second failure" },
				],
			},
			{
				name: "ansi-source",
				diagnostics: [
					{ level: "error", code: "IMPORT_FAILED", source: "/w/a\x1b[31m.ts", message: "first failure" },
					{ level: "error", code: "IMPORT_FAILED", source: "/w/a.ts", message: "second failure" },
				],
			},
		];
		for (const { name, diagnostics } of replayCases) {
			const before = workflowsListingItems([], [], 0, invalidDefinitionsFromDiagnostics(diagnostics));
			const after = workflowsListingItems([], [], 0, invalidDefinitionsFromDiagnostics(diagnostics.slice(1)));
			const original = before.find(
				(row) => row.value.kind === "invalid-definition" && row.value.definition.message === "second failure",
			);
			assert.ok(original, `${name}: expected second failure row`);
			assert.equal(original.id, after[0]?.id, `${name}: expected stable row id after removing first diagnostic`);
		}
	});

	it("keeps invalid-definition row ids collision-free when a file name ends in #1 (#5224)", () => {
		const diagnostics: readonly DiscoveryDiagnostic[] = [
			{
				level: "error",
				code: "INVALID_DEFINITION",
				message: "export publish: missing run()",
				source: "/w/release.ts",
			},
			{
				level: "error",
				code: "INVALID_DEFINITION",
				message: "export verify: missing run()",
				source: "/w/release.ts",
			},
			{ level: "error", code: "INVALID_DEFINITION", message: "missing run()", source: "/w/release.ts#1" },
		];
		const items = workflowsListingItems([], [], 0, invalidDefinitionsFromDiagnostics(diagnostics));
		assert.equal(items.length, 3);
		assert.equal(new Set(items.map((item) => item.id)).size, 3);
		const state = new SelectorState({ items });
		const targetIndex = items.findIndex(
			(item) => item.value.kind === "invalid-definition" && item.value.definition.source === "/w/release.ts#1",
		);
		while (state.getSelectedIndex() !== targetIndex) state.move(1);
		state.setItems(workflowsListingItems([], [], 1_000, invalidDefinitionsFromDiagnostics(diagnostics)));
		const selected = state.getSelected()?.value;
		assert.equal(selected?.kind, "invalid-definition");
		if (selected?.kind === "invalid-definition") {
			assert.equal(selected.definition.source, "/w/release.ts#1");
			assert.equal(selected.definition.message, "missing run()");
		}

		const duplicateItems = workflowsListingItems([], [], 0, [
			{ name: "a", source: "/w/a.ts", code: "INVALID_DEFINITION", reason: "rejected", message: "rejected" },
			{ name: "a", source: "/w/a.ts", code: "INVALID_DEFINITION", reason: "rejected", message: "rejected" },
			{ name: "a.ts#1", source: "/w/a.ts#1", code: "INVALID_DEFINITION", reason: "rejected", message: "rejected" },
		]);
		assert.equal(new Set(duplicateItems.map((item) => item.id)).size, 3);
	});

	it("does not list a loaded workflow file with a non-workflow named export as failed to load (#5224)", async () => {
		const cwd = makeTempDir("workflow-loaded-helper-export");
		const dir = join(cwd, ".atomic", "workflows");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "release.js"),
			[
				`import { workflow } from "@bastani/atomic/workflows";`,
				`export const DEFAULT_BRANCH = "main";`,
				`export default workflow({`,
				`  name: "release",`,
				`  description: "Cut a release",`,
				`  inputs: {},`,
				`  outputs: {},`,
				`  run: async (ctx) => { await ctx.task("t", { prompt: DEFAULT_BRANCH }); return {}; },`,
				`});`,
			].join("\n"),
			"utf-8",
		);
		const { registry, errors } = await discoverWorkflows({
			cwd,
			homeDir: makeTempDir("workflow-loaded-helper-empty"),
			includeBundled: false,
		});
		assert.equal(registry.has("release"), true);
		const invalid = invalidDefinitionsFromDiagnostics(errors);
		assert.deepEqual(invalid, []);
		const definitions = registry.all().map((d) => ({
			normalizedName: d.normalizedName,
			description: d.description,
			inputs: d.inputs ?? {},
		}));
		const items = workflowsListingItems([], definitions, 0, invalid);
		assert.equal(items.length, 1);
		assert.deepEqual(items[0]?.value, { kind: "definition", name: "release" });
	});

	it("shows +N more when broken definition details exceed 8 message lines (#5224)", () => {
		const message = [
			`Failed to import "/repo/.atomic/workflows/greet.ts": TransformError: 12 errors`,
			...Array.from({ length: 12 }, (_, index) => `greet.ts:${index + 1}:1: ERROR: problem ${index + 1}`),
		].join("\n");
		const [definition] = invalidDefinitionsFromDiagnostics([
			{ level: "error", code: "IMPORT_FAILED", source: "/repo/.atomic/workflows/greet.ts", message },
		]);
		assert.ok(definition);
		const details = formatInvalidDefinitionDetails(definition);
		assert.match(details, /problem 8$/m);
		assert.doesNotMatch(details, /problem 9/);
		assert.match(details, /^\s*\+4 more$/m);
	});

	it("normalizes CRLF in broken definition details without leaving literal \\x0d (#5224)", () => {
		const details = formatInvalidDefinitionDetails({
			name: "greet",
			source: "C:\\repo\\.atomic\\workflows\\greet.ts",
			code: "IMPORT_FAILED",
			reason: "ParseError: Unexpected token",
			message:
				'Failed to import "C:\\repo\\.atomic\\workflows\\greet.ts": ParseError: Unexpected token\r\n  C:\\repo\\.atomic\\workflows\\greet.ts:8:36\r\n  8 | export const x = (',
		});
		assert.doesNotMatch(details, /\\x0d|\r/);
		assert.match(details, /greet\.ts:8:36$/m);
	});
});
