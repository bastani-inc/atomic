import { Container, getKeybindings, setKeybindings, Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createVerbatimCompactionMessage, VERBATIM_COMPACTION_PREFIX } from "../src/core/messages.ts";
import { CompactionBoundaryMessageComponent } from "../src/modes/interactive/components/compaction-boundary-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const previousKeybindings = getKeybindings();

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterAll(() => setKeybindings(previousKeybindings));

const result: VerbatimCompactionResult = {
	compactedText: "[User]: retained\n(filtered 1 lines)",
	firstKeptEntryId: "m2",
	tokensBefore: 100,
	parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" },
	promptVersion: 3,
	rung: "planned",
	stats: {
		linesBefore: 4,
		linesDeleted: 1,
		linesKept: 3,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
};

const persistedBoundary = createVerbatimCompactionMessage(
	result.compactedText,
	result.tokensBefore,
	new Date(1).toISOString(),
	{
		strategy: "verbatim-lines",
		parameters: result.parameters,
		promptVersion: result.promptVersion,
		rung: result.rung,
		stats: result.stats,
	},
) as AgentMessage;

type CompactionStartEvent = {
	type: "compaction_start";
	reason: "manual" | "threshold" | "overflow";
	midTurn?: boolean;
};

type CompactionEndEvent = {
	type: "compaction_end";
	reason: "manual" | "threshold" | "overflow";
	result?: VerbatimCompactionResult;
	aborted: boolean;
	willRetry: boolean;
	errorMessage?: string;
	midTurn?: boolean;
};
type AgentEndEvent = { type: "agent_end" };

const persistedContextMessages = [
	persistedBoundary,
	{ role: "user", content: "retained context message", timestamp: 0 } as AgentMessage,
];

function makeMode(messages: AgentMessage[] = persistedContextMessages) {
	const workingLoaders: Array<Text & { stop: ReturnType<typeof vi.fn> }> = [];
	const chatContainer = new Container();
	const startupNoticesContainer = new Container();
	startupNoticesContainer.addChild(new Text("startup notice", 0, 0));
	const mode = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		autoCompactionEscapeHandler: undefined,
		autoCompactionLoader: undefined,
		loadingAnimation: undefined,
		workingVisible: true,
		defaultEditor: { onEscape: vi.fn() },
		statusContainer: new Container(),
		chatContainer,
		startupNoticesContainer,
		pendingTools: new Map(),
		compactionQueuedMessages: [],
		deferredRenderedUserInputs: [],
		deferredRenderedUserInputComponents: new Map(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "thinking",
		outputPad: 0,
		sessionManager: {
			getCwd: () => process.cwd(),
			buildSessionContext: () => ({ messages, thinkingLevel: "off", model: null }),
		},
		session: { abortCompaction: vi.fn(), extensionRunner: { getMessageRenderer: () => undefined } },
		settingsManager: {
			getShowTerminalProgress: () => false,
			getShowImages: () => false,
			getImageWidthCells: () => 80,
		},
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getRegisteredToolDefinition: () => undefined,
		updateEditorBorderColor: vi.fn(),
		flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
		checkShutdownRequested: vi.fn().mockResolvedValue(undefined),
		showError: vi.fn(),
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		createWorkingLoader: vi.fn(() => {
			const loader = Object.assign(new Text("Working...", 0, 0), { stop: vi.fn() });
			workingLoaders.push(loader);
			return loader;
		}),
		stopWorkingLoader: Reflect.get(InteractiveMode.prototype, "stopWorkingLoader"),
		showWorkingLoaderNow: Reflect.get(InteractiveMode.prototype, "showWorkingLoaderNow"),
		attachStartupNoticesContainer: Reflect.get(InteractiveMode.prototype, "attachStartupNoticesContainer"),
		renderSessionContext: vi.fn(Reflect.get(InteractiveMode.prototype, "renderSessionContext")),
		addRenderedChatEntry: Reflect.get(InteractiveMode.prototype, "addRenderedChatEntry"),
		chatMessageRenderOptions: Reflect.get(InteractiveMode.prototype, "chatMessageRenderOptions"),
		renderDeferredUserInput: Reflect.get(InteractiveMode.prototype, "renderDeferredUserInput"),
		rebuildChatFromMessages: Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages"),
		addCompactionBoundaryToChat: vi.fn(Reflect.get(InteractiveMode.prototype, "addCompactionBoundaryToChat")),
	};
	return { mode, chatContainer, workingLoaders };
}

async function emit(mode: object, event: CompactionStartEvent | CompactionEndEvent | AgentEndEvent): Promise<void> {
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: object,
		event: CompactionStartEvent | CompactionEndEvent | AgentEndEvent,
	) => Promise<void>;
	await handleEvent.call(mode, event);
}

function visibleBoundaries(container: Container): CompactionBoundaryMessageComponent[] {
	return container.children.filter(
		(child): child is CompactionBoundaryMessageComponent => child instanceof CompactionBoundaryMessageComponent,
	);
}

function renderedText(container: Container): string {
	return stripVTControlCharacters(container.render(200).join("\n"));
}

describe("InteractiveMode compaction events", () => {
	for (const reason of ["manual", "threshold", "overflow"] as const) {
		it(`renders exactly one live boundary after successful ${reason} compaction`, async () => {
			const { mode, chatContainer } = makeMode();

			await emit(mode, { type: "compaction_end", reason, result, aborted: false, willRetry: false });
			expect(mode.addCompactionBoundaryToChat).toHaveBeenCalledOnce();
			expect(mode.addCompactionBoundaryToChat).toHaveBeenCalledWith(result);

			expect(visibleBoundaries(chatContainer)).toHaveLength(1);
			expect(renderedText(chatContainer).match(/✻ Context compacted/g)).toHaveLength(1);
			expect(renderedText(chatContainer)).toContain("startup notice");
			expect(renderedText(chatContainer)).toContain("retained context message");
		});
	}

	it("does not render a boundary for aborted or failed compaction", async () => {
		for (const event of [
			{ type: "compaction_end", reason: "manual", result, aborted: true, willRetry: false },
			{ type: "compaction_end", reason: "overflow", result, aborted: false, willRetry: false, errorMessage: "failed" },
		] satisfies CompactionEndEvent[]) {
			const { mode, chatContainer } = makeMode([]);

			await emit(mode, event);
			expect(visibleBoundaries(chatContainer)).toHaveLength(0);
			expect(mode.addCompactionBoundaryToChat).not.toHaveBeenCalled();
			expect(renderedText(chatContainer)).not.toContain("✻ Context compacted");
		}
	});

	it("does not flush queued input as a separate prompt during mid-turn compaction", async () => {
		const { mode } = makeMode();

		await emit(mode, {
			type: "compaction_end",
			reason: "threshold",
			result,
			aborted: false,
			willRetry: false,
			midTurn: true,
		});

		expect(mode.flushCompactionQueue).not.toHaveBeenCalled();
	});

	it("restores the working spinner after successful mid-turn compaction without user input", async () => {
		const { mode, workingLoaders } = makeMode();
		mode.showWorkingLoaderNow.call(mode);
		expect(renderedText(mode.statusContainer)).toContain("Working...");

		await emit(mode, { type: "compaction_start", reason: "threshold", midTurn: true });
		expect(workingLoaders[0]?.stop).toHaveBeenCalledOnce();
		expect(renderedText(mode.statusContainer)).toContain("Auto-compacting...");

		await emit(mode, {
			type: "compaction_end",
			reason: "threshold",
			result,
			aborted: false,
			willRetry: false,
			midTurn: true,
		});

		expect(mode.createWorkingLoader).toHaveBeenCalledTimes(2);
		expect(renderedText(mode.statusContainer)).toContain("Working...");

		await emit(mode, { type: "agent_end" });
		expect(workingLoaders[1]?.stop).toHaveBeenCalledOnce();
		expect(renderedText(mode.statusContainer)).not.toContain("Working...");
	});

	it("does not restore the working spinner when mid-turn compaction cannot continue", async () => {
		for (const event of [
			{ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false, midTurn: true },
			{
				type: "compaction_end",
				reason: "threshold",
				result,
				aborted: false,
				willRetry: false,
				midTurn: true,
				errorMessage: "failed",
			},
		] satisfies CompactionEndEvent[]) {
			const { mode } = makeMode([]);

			await emit(mode, event);

			expect(mode.createWorkingLoader).not.toHaveBeenCalled();
			expect(renderedText(mode.statusContainer)).not.toContain("Working...");
		}
	});
	it("suppresses the synthesized leading boundary without removing a retained same-name custom message", async () => {
		const retainedAlias = {
			role: "custom",
			customType: "compaction",
			content: [{ type: "text", text: `${VERBATIM_COMPACTION_PREFIX}extension-owned state` }],
			display: true,
			details: { strategy: "verbatim-lines", rung: result.rung, stats: result.stats },
			timestamp: 2,
		} as AgentMessage;
		const hiddenAlias = {
			role: "custom",
			customType: "compaction",
			content: "hidden extension-owned state",
			display: false,
			timestamp: 3,
		} as AgentMessage;
		const { mode, chatContainer } = makeMode([persistedBoundary, retainedAlias, hiddenAlias]);

		await emit(mode, { type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: false });

		const renderedContext = mode.renderSessionContext.mock.calls[0]?.[0];
		expect(renderedContext?.messages).toEqual([retainedAlias, hiddenAlias]);
		expect(visibleBoundaries(chatContainer)).toHaveLength(1);
		expect(renderedText(chatContainer).match(/✻ Context compacted/g)).toHaveLength(1);
		expect(renderedText(chatContainer)).toContain("extension-owned state");
	});

	it("renders one persisted boundary during a normal resume rebuild", () => {
		const { mode, chatContainer } = makeMode();
		const rebuild = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (this: object) => void;

		rebuild.call(mode);

		expect(visibleBoundaries(chatContainer)).toHaveLength(1);
		expect(renderedText(chatContainer).match(/✻ Context compacted/g)).toHaveLength(1);
	});

	it("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;
		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});

describe("compaction boundary component", () => {
	it("matches pi's collapsed style and expands the verbatim marker text", () => {
		const component = new CompactionBoundaryMessageComponent(result);
		const collapsedRaw = component.render(200).join("\n");
		const collapsed = stripVTControlCharacters(collapsedRaw);
		expect(collapsedRaw).toContain(theme.fg("customMessageLabel", theme.bold("✻ Context compacted")));
		expect(collapsed).toContain("✻ Context compacted");
		expect(collapsed).toContain("Compacted from 100 tokens (");
		expect(collapsed).toContain(" to expand)");
		expect(collapsed).not.toContain("retained");
		expect(collapsed).not.toContain("planned");

		component.setExpanded(true);
		const expandedRaw = component.render(200).join("\n");
		const expanded = stripVTControlCharacters(expandedRaw).split("\n").map((line) => line.trimEnd()).join("\n");
		expect(expanded).toContain("✻ Context compacted");
		expect(expanded).toContain("Compacted from 100 tokens");
		expect(expanded).toContain("[User]: retained\n (filtered 1 lines)");
		expect(expandedRaw).toContain(theme.fg("dim", "(filtered 1 lines)"));
	});
});
