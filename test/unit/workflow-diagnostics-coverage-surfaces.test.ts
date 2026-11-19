import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripHintMarkers } from "@bastani/atomic-tui";
import { describe, it } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import factory, { type ExtensionAPI } from "../../packages/workflows/src/extension/index.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	registerLifecycleNoticeRenderer,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { PiCommandContext, PiMessageRenderer } from "../../packages/workflows/src/extension/public-types.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import type {
	PiCustomComponent,
	PiCustomOverlayFactoryTui,
} from "../../packages/workflows/src/extension/ui-surface.js";
import { registerWorkflowSlashCommand } from "../../packages/workflows/src/extension/workflow-command-registration.js";
import type { WorkflowCommandHandler } from "../../packages/workflows/src/extension/workflow-command-utils.js";
import { formatInvalidDefinitionDetails } from "../../packages/workflows/src/extension/workflow-open-run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore, store as globalStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { inertDisplayLine, inertDisplayText } from "../../packages/workflows/src/tui/display-text.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";
import { stageFailureLogLines } from "../../packages/workflows/src/tui/stage-failure-detail.js";
import { renderSwitcher } from "../../packages/workflows/src/tui/switcher.js";
import {
	invalidDefinitionsFromDiagnostics,
	workflowsListingItems,
} from "../../packages/workflows/src/tui/workflows-listing.js";
import { stripVTControlCharacters as stripAnsi } from "../helpers/visible-text.ts";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { defaultTheme, makeStage } from "./overlay-graph-helpers.js";

const ESC = "\x1b";
const EVIL = "a\x1b]52;c;YQ==\x07b\x1b[2Jc\u202ed\u2066e";
const RAW_UNSAFE = /\x1b\]52|\x1b\[2J|[\u202a-\u202e\u2066-\u2069\u0007]/;

type PickerRegistration = (
	tui: PiCustomOverlayFactoryTui,
	theme: undefined,
	keybindings: undefined,
	done: (result: undefined) => void,
) => PiCustomComponent;

describe("workflow diagnostic surfaces, text safety, and listing wiring (#5224)", () => {
	it("renders node card titles, child workflow badges, and blocked-by upstream stage names inert (#5224)", () => {
		const runningStage: StageSnapshot = {
			...makeStage("s"),
			name: `node-${EVIL}`,
			status: "running",
		};
		const runningRows = renderNodeCard(runningStage, { theme: defaultTheme, width: 40 });
		assert.doesNotMatch(runningRows.join("\n"), RAW_UNSAFE);

		const childStage: StageSnapshot = {
			...makeStage("child"),
			status: "running",
			workflowChildRun: { alias: "sub", workflow: `wf-${EVIL}`, runId: "child-run-1" },
		};
		const childRows = renderNodeCard(childStage, { theme: defaultTheme, width: 40 });
		assert.doesNotMatch(childRows.join("\n"), RAW_UNSAFE);

		const otherStage: StageSnapshot = { ...makeStage("other"), name: "unrelated-stage" };
		const upstreamStage: StageSnapshot = { ...makeStage("up"), name: `up-${EVIL}` };
		const blockedStage: StageSnapshot = {
			...makeStage("blocked"),
			status: "blocked",
			blockedByStageId: "up",
		};
		const blockedRows = renderNodeCard(blockedStage, {
			theme: defaultTheme,
			width: 60,
			stages: [otherStage, upstreamStage, blockedStage],
		});
		const blockedText = stripAnsi(blockedRows.join("\n"));
		assert.doesNotMatch(blockedRows.join("\n"), RAW_UNSAFE);
		assert.match(blockedText, /↑ blocked by up-/);
		assert.doesNotMatch(blockedText, /unrelated-stage/);

		const fallbackRows = renderNodeCard(blockedStage, { theme: defaultTheme, width: 60 });
		assert.match(stripAnsi(fallbackRows.join("\n")), /↑ blocked by up/);
	});

	it("renders switcher selected and unselected stage names inert and truncates long names with an ellipsis (#5224)", () => {
		const stages: StageSnapshot[] = [
			{ ...makeStage("a"), name: `first-${EVIL}-${"x".repeat(40)}` },
			{ ...makeStage("b"), name: `second-${EVIL}-${"y".repeat(40)}` },
		];
		const rows = renderSwitcher(stages, { query: "", selectedIndex: 1 }, { width: 44, theme: defaultTheme });
		// The hint row's click markers are the renderer's own and never reach the terminal.
		const joined = stripHintMarkers(rows.join("\n"));
		assert.doesNotMatch(joined, RAW_UNSAFE);
		const plainRows = rows.map((row) => stripAnsi(row));
		const firstRow = plainRows.find((row) => row.includes("first-"));
		const secondRow = plainRows.find((row) => row.includes("second-"));
		assert.ok(firstRow?.includes("…"));
		assert.ok(secondRow?.includes("…"));
	});

	it("renders tool error cards inert, formats singular and plural hidden stack frame counts, and handles missing options (#5224)", () => {
		const noFramesCard = renderResult(null, { errorText: `Deploy failed ${EVIL}`, width: 100, plain: true });
		assert.doesNotMatch(noFramesCard, RAW_UNSAFE);
		assert.match(noFramesCard, /WORKFLOW ERROR/);
		assert.match(noFramesCard, /<U\+202E>/);
		assert.doesNotMatch(noFramesCard, /stack frame/);

		const oneFrameCard = renderResult(null, {
			errorText: "First line\nSecond line\n\n    at deployStep (/repo/wf.ts:9:3)",
			width: 100,
			plain: true,
		});
		assert.match(oneFrameCard, /First line/);
		assert.match(oneFrameCard, /Second line/);
		assert.match(oneFrameCard, /\(1 stack frame hidden\)/);
		assert.doesNotMatch(oneFrameCard, /at deployStep/);

		const twoFramesCard = renderResult(null, {
			errorText: "Boom\n    at a (/repo/a.ts:1:1)\n    at b (/repo/b.ts:2:2)",
			width: 100,
			plain: true,
		});
		assert.match(twoFramesCard, /\(2 stack frames hidden\)/);

		const defaultNotice = stripAnsi(renderResult(null));
		assert.match(defaultNotice, /WORKFLOW/);
		assert.match(defaultNotice, /no result/);
	});

	it("keeps run row descriptions and invalid definition sources inert and filters only error-level load diagnostics (#5224)", () => {
		const failedRun: RunSnapshot = {
			id: "aaaaaaaa",
			name: "wf",
			status: "failed",
			inputs: {},
			stages: [],
			toolNodes: [],
			startedAt: 0,
			endedAt: 5_000,
			error: `bad ${EVIL}`,
		};
		const [runItem] = workflowsListingItems([failedRun], 10_000);
		assert.ok(runItem);
		assert.doesNotMatch(runItem.description ?? "", RAW_UNSAFE);
		assert.match(runItem.description ?? "", /<U\+202E>/);

		const repeatedDiagnostics = [
			{ level: "error", code: "INVALID_DEFINITION", source: "/repo/release.ts", message: "Error: publish bad" },
			{ level: "error", code: "INVALID_DEFINITION", source: "/repo/release.ts", message: "Error: verify bad" },
		];
		const repeatedItems = workflowsListingItems([], 10_000, invalidDefinitionsFromDiagnostics(repeatedDiagnostics));
		assert.equal(new Set(repeatedItems.map((item) => item.id)).size, 2);

		const hostileDiagnostics = invalidDefinitionsFromDiagnostics([
			{ level: "error", code: "IMPORT_FAILED", source: `/repo/${EVIL}.ts`, message: "Error: x" },
		]);
		assert.equal(hostileDiagnostics.length, 1);
		assert.doesNotMatch(`${hostileDiagnostics[0]!.source ?? ""}${hostileDiagnostics[0]!.name}`, RAW_UNSAFE);
		assert.match(hostileDiagnostics[0]!.source ?? "", /<U\+202E>/);

		const pathNotFound = invalidDefinitionsFromDiagnostics([
			{ level: "error", code: "PATH_NOT_FOUND", source: "/repo/gone.ts", message: "no such file" },
		]);
		assert.equal(pathNotFound.length, 1);
		assert.equal(pathNotFound[0]!.name, "gone");

		const sourceless = invalidDefinitionsFromDiagnostics([
			{ level: "error", code: "IMPORT_FAILED", message: "Error: missing path" },
			{ level: "error", code: "PATH_NOT_FOUND", source: "   ", message: "Error: blank path" },
		]);
		assert.equal(sourceless[0]!.name, "import_failed");
		assert.equal(sourceless[0]!.source, undefined);
		assert.equal(sourceless[1]!.name, "path_not_found");

		assert.equal(
			invalidDefinitionsFromDiagnostics([
				{ level: "warning", code: "INVALID_DEFINITION", source: "/repo/w.ts", message: "w" },
			]).length,
			0,
		);
		assert.equal(
			invalidDefinitionsFromDiagnostics([
				{ level: "error", code: "DUPLICATE_NAME", source: "/repo/d.ts", message: "d" },
			]).length,
			0,
		);
	});

	it("keeps stage failure log lines inert with control and bidi characters escaped (#5224)", () => {
		const lines = stageFailureLogLines({
			error: `bad\x1b[2Jthing\x07\u202e`,
		});
		assert.equal(lines.length, 1);
		assert.doesNotMatch(lines[0]!, RAW_UNSAFE);
		assert.doesNotMatch(lines[0]!, /\x1b/);
		assert.match(lines[0]!, /\\x07/);
		assert.match(lines[0]!, /<U\+202E>/);
		assert.equal(lines[0], "bad\\x1b[2Jthing\\x07<U+202E>");
	});

	it("caps invalid-definition detail lines at 8 lines and formats sourceless and single-frame diagnostics (#5224)", () => {
		const message = [
			'Failed to import "/repo/x.ts": Error: first',
			...Array.from({ length: 20 }, (_, index) => `detail line ${index}`),
			"    at load (/repo/x.ts:1:1)",
		].join("\n");
		const text = formatInvalidDefinitionDetails({
			name: "x",
			source: "/repo/x.ts",
			code: "IMPORT_FAILED",
			reason: "Error: first",
			message,
		});
		assert.equal(text.match(/detail line \d+/g)?.length, 8);
		assert.match(text, /file\s+\/repo\/x\.ts/);
		assert.match(text, /\(1 stack frame hidden\)/);
		assert.match(text, /Fix the file, then run \/reload to load it again\./);

		const noSourceText = formatInvalidDefinitionDetails({
			name: "x",
			code: "INVALID_DEFINITION",
			reason: "No stages",
			message: "Error: No stages",
		});
		assert.doesNotMatch(noSourceText, /^file\s+/m);
		assert.doesNotMatch(noSourceText, /stack frame/);
	});

	it("lists definitions discovery could not load through /workflows command registration and extension factory (#5224)", async () => {
		initTheme("dark");
		const pickers: PickerRegistration[] = [];
		const store = createStore();
		const backend = await createMemoryTestBackend();
		bindStoreDurableBackend(store, backend);
		const owner = {
			store,
			jobs: createJobTracker(),
			stageControlRegistry: createStageControlRegistry(),
			toolControlRegistry: createToolControlRegistry(),
			stageUiBroker: new StageUiBroker(store),
		};
		const handlers = new Map<string, WorkflowCommandHandler>();
		const overlay = { open() {}, toggle() {}, close() {} };
		const pi = {
			registerCommand() {},
			sendMessage() {},
		} as unknown as ExtensionAPI;

		registerWorkflowSlashCommand(pi, handlers, {
			overlay,
			owner,
			ensureWorkflowResourcesLoaded: async () => {},
			discoveryDiagnostics: () => [
				{
					level: "error",
					code: "IMPORT_FAILED",
					source: "/repo/.atomic/workflows/broken.ts",
					message: 'Failed to import "/repo/.atomic/workflows/broken.ts": ParseError: nope',
				},
			],
		});

		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				custom: (componentFactory: PickerRegistration) =>
					new Promise<undefined>((resolve) => {
						pickers.push((tui, theme, keybindings, done) =>
							componentFactory(tui, theme, keybindings, (result) => {
								done(result);
								resolve(result);
							}),
						);
					}),
				notify() {},
			},
		} as unknown as PiCommandContext;

		const pending = handlers.get("workflows")!("", ctx);
		await Promise.resolve();
		assert.equal(pickers.length, 1);
		const component = pickers[0]!(
			{ requestRender() {}, terminal: { rows: 40, columns: 100 } },
			undefined,
			undefined,
			() => {},
		);
		try {
			const rendered = stripAnsi(component.render(100).join("\n"));
			assert.match(rendered, /broken/);
			assert.match(rendered, /failed to load/);
			component.handleInput?.(ESC);
			component.handleInput?.(ESC);
			await pending;
		} finally {
			component.dispose?.();
		}

		const originalCwd = process.cwd();
		const root = await mkdtemp(join(tmpdir(), "atomic-wf-diag-factory-"));
		try {
			const workflowsDir = join(root, ".atomic", "workflows");
			await mkdir(workflowsDir, { recursive: true });
			await writeFile(join(workflowsDir, "00-broken.ts"), "throw new Error('broken module load');\n");
			process.chdir(root);

			const factoryCommands = new Map<string, { handler: (args: string, c: PiCommandContext) => Promise<void> }>();
			const factoryPickers: PickerRegistration[] = [];
			const factoryPi: ExtensionAPI = {
				registerCommand: (name, options) => {
					factoryCommands.set(name, options as { handler: (args: string, c: PiCommandContext) => Promise<void> });
				},
				registerTool: () => undefined,
				registerMessageRenderer: () => undefined,
				registerFlag: () => undefined,
				registerShortcut: () => undefined,
				sendMessage: () => undefined,
				on: () => undefined,
				ui: { setWidget: () => undefined },
				getResourceLoaderInheritanceSnapshot: () => ({ projectTrusted: true }),
			};
			factory(factoryPi);
			const factoryCtx = {
				hasUI: true,
				cwd: root,
				isProjectTrusted: () => true,
				ui: {
					custom: (componentFactory: PickerRegistration) =>
						new Promise<undefined>((resolve) => {
							factoryPickers.push((tui, theme, keybindings, done) =>
								componentFactory(tui, theme, keybindings, (result) => {
									done(result);
									resolve(result);
								}),
							);
						}),
					notify() {},
				},
			} as unknown as PiCommandContext;

			const factoryPending = factoryCommands.get("workflows")!.handler("", factoryCtx);
			for (let tick = 0; tick < 50 && factoryPickers.length === 0; tick++) {
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(factoryPickers.length, 1);
			const factoryComponent = factoryPickers[0]!(
				{ requestRender() {}, terminal: { rows: 40, columns: 100 } },
				undefined,
				undefined,
				() => {},
			);
			try {
				const factoryRendered = stripAnsi(factoryComponent.render(100).join("\n"));
				assert.match(factoryRendered, /00-broken/);
				assert.match(factoryRendered, /failed to load/);
				factoryComponent.handleInput?.(ESC);
				factoryComponent.handleInput?.(ESC);
				await factoryPending;
			} finally {
				factoryComponent.dispose?.();
			}
		} finally {
			process.chdir(originalCwd);
			globalStore.clear();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("transforms control-only and bidi-only strings and replaces single-line breaks with spaces (#5224)", () => {
		assert.equal(inertDisplayText("plain text"), "plain text");
		assert.equal(inertDisplayLine("plain line"), "plain line");
		assert.equal(inertDisplayText("\u0007"), "\\x07");
		assert.equal(inertDisplayText("\u202e"), "<U+202E>");
		assert.equal(inertDisplayText("\u2066\u2069"), "<U+2066><U+2069>");
		assert.equal(inertDisplayLine("\n"), " ");
		assert.equal(inertDisplayLine("alpha\nbeta"), "alpha beta");
		assert.equal(inertDisplayLine("alpha\r\nbeta"), "alpha beta");
	});

	it("renders lifecycle notice cards for blocked runs, single artifacts without +more, and completed runs without outputs (#5224)", async () => {
		initTheme("dark");
		const store = createStore();
		const sent: Array<{ details?: WorkflowLifecycleNoticeDetails }> = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: true, notifyOn: ["completed", "failed", "blocked"] },
			state: createWorkflowLifecycleNotificationState(),
			sendMessage(message) {
				sent.push(message as { details?: WorkflowLifecycleNoticeDetails });
			},
		});
		let renderer: PiMessageRenderer | undefined;
		registerLifecycleNoticeRenderer({
			rendererHost: {},
			registerMessageRenderer(_event, registered) {
				renderer = registered;
			},
		});
		const renderCard = (details: WorkflowLifecycleNoticeDetails, width = 100): string => {
			const component = renderer?.({ details }, { expanded: true });
			assert.ok(component && typeof component !== "string");
			return component.render(width).map(stripAnsi).join("\n");
		};

		store.recordRunStart({
			id: "run-single-art",
			name: "ralph",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [
				{
					id: "s1",
					name: "collect",
					status: "completed",
					parentIds: [],
					toolEvents: [],
					artifacts: [{ kind: "output", path: "/repo/out/only.md" }],
				},
			],
			startedAt: 1,
		});
		store.recordRunEnd("run-single-art", "completed", {});
		await Promise.resolve();
		const singleArtNotice = sent.find((message) => message.details?.runId === "run-single-art");
		assert.ok(singleArtNotice?.details);
		const singleArtText = renderCard(singleArtNotice.details);
		assert.match(singleArtText, /artifact\s+output \/repo\/out\/only\.md/);
		assert.doesNotMatch(singleArtText, /\+\d+ more/);
		assert.doesNotMatch(singleArtText, /\boutputs\b/);
		assert.doesNotMatch(singleArtText, /\berror\b/);

		store.recordRunStart({
			id: "run-blocked",
			name: "ralph",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [{ id: "s1", name: "gate", status: "completed", parentIds: [], toolEvents: [] }],
			startedAt: 1,
		});
		store.recordRunEnd("run-blocked", "completed", {
			status: "needs_human",
			summary: "Needs manual security sign-off\n    at check (/repo/sec.ts:1:1)",
		});
		await Promise.resolve();
		const blockedNotice = sent.find((message) => message.details?.runId === "run-blocked");
		assert.ok(blockedNotice?.details);
		assert.equal(blockedNotice.details.kind, "blocked");
		const blockedCardText = renderCard(blockedNotice.details);
		assert.match(blockedCardText, /reason\s+Needs manual security sign-off/);
		assert.doesNotMatch(blockedCardText, /at check/);
		assert.match(blockedCardText, /full log: \/workflows run-blocked, then o and l/);
		assert.doesNotMatch(blockedCardText, /\boutputs\b/);
		assert.doesNotMatch(blockedCardText, /\bartifacts\b/);

		const fallbackErrorCardText = renderCard({
			...blockedNotice.details,
			reason: undefined,
			error: "Error: fallback error text\n    at step (/repo/sec.ts:1:1)",
		});
		assert.match(fallbackErrorCardText, /reason\s+fallback error text/);
		assert.doesNotMatch(fallbackErrorCardText, /at step/);
	});
});
