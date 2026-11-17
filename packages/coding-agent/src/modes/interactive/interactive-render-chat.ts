import type { AssistantMessage, Usage } from "@bastani/atomic-ai/compat";
import type { TUI } from "@bastani/atomic-tui";
import { CONFIG_DIR_NAME } from "../../config.js";
import { collectCacheMisses, createCacheMissModelSource, formatCacheMissNotice } from "../../core/cache-stats.ts";
import { markEventLoopStartupComplete } from "../../core/event-loop-monitor.ts";
import { markLifecycleTiming } from "../../core/lifecycle-timings.ts";
import { isVerbatimCompactionMessage, stripVerbatimCompactionPrefix } from "../../core/messages.ts";
import { serviceTierWarnings } from "../../core/service-tier-warnings.ts";
import type { CustomEntry } from "../../core/session-manager.ts";
import { buildContextEntries, type SessionEntry, sessionEntryToContextMessages } from "../../core/session-manager.ts";
import { yieldToEventLoop } from "../../utils/event-loop.ts";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import { RemoteCustomMessageComponent, RemoteToolExecutionComponent } from "../interactive-engine/remote-renderer.ts";
import { appendBoundedStderr } from "../rpc/rpc-client-process.js";
import { messageComponents, statusComponents } from "./chat-message-count.ts";
import { CustomEntryComponent } from "./components/custom-entry.ts";
import type { NewMessageCounter } from "./components/jump-to-latest.ts";
import { createMarkdownTransform } from "./components/markdown-transform.ts";
import { createMermaidMarkdownTransformer } from "./components/mermaid.ts";
import { ThemedText } from "./components/themed-text.js";
import { appendNewChildrenBeforeAttachedChild } from "./interactive-child-ordering.ts";
import { countChatMessages, InteractiveModeBase, isChatMessageComponent } from "./interactive-mode-base.ts";
import {
	type AgentMessage,
	APP_NAME,
	AssistantMessageComponent,
	addChatTranscriptEntry,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	type ChatMessageEntry,
	type ChatMessageRenderOptions,
	CompactionBoundaryMessageComponent,
	type Component,
	Container,
	CustomMessageComponent,
	chatEntriesFromAgentMessages,
	getChangelogPath,
	hasTrustRequiringProjectResourcesAsync,
	Markdown,
	type Message,
	type PersistedMessageMeta,
	parseSkillBlock,
	preloadChangelog,
	recordTimeSinceReset,
	renderChatMessageEntry,
	type SessionContext,
	SkillInvocationMessageComponent,
	Spacer,
	Text,
	ToolExecutionComponent,
	type TruncationResult,
	theme,
	UserMessageComponent,
	type VerbatimCompactionResult,
} from "./interactive-mode-deps.ts";
import { StartupChatContainer, trackChatHistoryBuild } from "./interactive-startup-chat-container.ts";
import type { InteractiveSubmission } from "./interactive-submission.ts";
import { refreshInteractiveTasks } from "./interactive-task-projection.js";

function countDroppedThinkingBlocks(message: AssistantMessage): number {
	return (message.diagnostics ?? []).reduce((count, diagnostic) => {
		if (diagnostic.type !== "anthropic_input_transformations") return count;
		const dropped = diagnostic.details?.droppedBlockCount;
		return count + (typeof dropped === "number" && dropped > 0 ? dropped : 0);
	}, 0);
}

function addServiceTierWarnings(mode: InteractiveModeBase, message: AssistantMessage): void {
	for (const warning of serviceTierWarnings(message)) {
		mode.chatContainer.addChild(new Spacer(1));
		mode.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warning}`), 1, 0));
	}
}

InteractiveModeBase.prototype.maybeShowAssistantDiagnostics = function (
	this: InteractiveModeBase,
	message: AssistantMessage,
): void {
	addServiceTierWarnings(this, message);
	if (!this.settingsManager.getShowCacheMissNotices()) return;

	const count = countDroppedThinkingBlocks(message);
	if (count === 0) return;
	let previousCount = 0;
	// The live message_end notification precedes persistence of this response.
	const branch = this.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			previousCount = countDroppedThinkingBlocks(entry.message);
			break;
		}
	}
	if (count <= previousCount) return;
	const noun = count === 1 ? "thinking block" : "thinking blocks";
	this.chatContainer.addChild(new Spacer(1));
	this.chatContainer.addChild(
		new Text(theme.fg("warning", `Anthropic dropped ${count} ${noun} (details in session)`), 1, 0),
	);
};

// Weak keys leave cleared/rebuilt transcripts collectible without separate lifecycle state.
// Only persistent diagnostic statuses participate; ordinary chat/status is never evicted.
const diagnosticStatuses = new WeakMap<Component, { spacer: Spacer; bytes: number }>();
const MAX_DIAGNOSTIC_STATUSES = 64;
const MAX_DIAGNOSTIC_HISTORY_BYTES = 256 * 1024;

InteractiveModeBase.prototype.showStatus = function (
	this: InteractiveModeBase,
	message: string,
	persist = false,
): void {
	const children = this.chatContainer.children;
	const last = children.length > 0 ? children[children.length - 1] : undefined;
	const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

	if (!persist && last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
		this.lastStatusText.setText(theme.fg("dim", message));
		this.ui.requestRender();
		return;
	}

	if (persist) message = appendBoundedStderr("", message);
	const spacer = new Spacer(1);
	const text = new Text(theme.fg("dim", message), 1, 0);
	statusComponents.add(text);
	this.chatContainer.addChild(spacer);
	this.chatContainer.addChild(text);
	this.lastStatusSpacer = persist ? undefined : spacer;
	this.lastStatusText = persist ? undefined : text;
	if (persist) {
		diagnosticStatuses.set(text, { spacer, bytes: Buffer.byteLength(message) });
		let count = 0;
		let bytes = 0;
		for (const child of [...children].reverse()) {
			const diagnostic = diagnosticStatuses.get(child);
			if (!diagnostic) continue;
			count++;
			bytes += diagnostic.bytes;
			if (count > MAX_DIAGNOSTIC_STATUSES || bytes > MAX_DIAGNOSTIC_HISTORY_BYTES) {
				this.chatContainer.removeChild(child);
				this.chatContainer.removeChild(diagnostic.spacer);
			}
		}
	}
	this.ui.requestRender();
};

const echoReadEpochs = new WeakMap<Component[], number>();

InteractiveModeBase.prototype.renderDeferredUserInput = function (this: InteractiveModeBase, text: string): void {
	this.deferredRenderedUserInputs.push(text);
	const startIndex = this.chatContainer.children.length;
	this.addMessageToChat({ role: "user", content: text } as AgentMessage);
	const renderedComponents = this.chatContainer.children.slice(startIndex);
	const epoch = (this.ui as AltScreenMessageCounterHost).newMessages?.epoch;
	if (epoch !== undefined) echoReadEpochs.set(renderedComponents, epoch);
	const trackedComponents = this.deferredRenderedUserInputComponents.get(text) ?? [];
	trackedComponents.push(renderedComponents);
	this.deferredRenderedUserInputComponents.set(text, trackedComponents);
	this.updatePendingMessagesDisplay();
	this.ui.requestRender();
};

InteractiveModeBase.prototype.consumeDeferredRenderedUserInput = function (
	this: InteractiveModeBase,
	text: string,
): boolean {
	const index = this.deferredRenderedUserInputs.indexOf(text);
	if (index === -1) return false;
	this.deferredRenderedUserInputs.splice(index, 1);
	if (this.startedDeferredUserInput === text) this.startedDeferredUserInput = undefined;
	const trackedComponents = this.deferredRenderedUserInputComponents.get(text);
	trackedComponents?.shift();
	if (trackedComponents && trackedComponents.length === 0) {
		this.deferredRenderedUserInputComponents.delete(text);
	}
	return true;
};

function forgetDeferredEcho(mode: InteractiveModeBase, text: string): Component[] | undefined {
	const index = mode.deferredRenderedUserInputs.indexOf(text);
	if (index !== -1) {
		mode.deferredRenderedUserInputs.splice(index, 1);
		if (mode.startedDeferredUserInput === text) mode.startedDeferredUserInput = undefined;
	}
	const trackedComponents = mode.deferredRenderedUserInputComponents.get(text);
	const components = trackedComponents?.shift();
	if (trackedComponents && trackedComponents.length === 0) {
		mode.deferredRenderedUserInputComponents.delete(text);
	}
	return components;
}

function takeDeferredEchoes(mode: InteractiveModeBase): Array<{ text: string; epoch: number | undefined }> {
	const occurrences = new Map<string, number>();
	const echoes = mode.deferredRenderedUserInputs.map((text) => {
		const occurrence = occurrences.get(text) ?? 0;
		occurrences.set(text, occurrence + 1);
		const components = mode.deferredRenderedUserInputComponents.get(text)?.[occurrence];
		return { text, epoch: components ? echoReadEpochs.get(components) : undefined };
	});
	mode.deferredRenderedUserInputs = [];
	mode.deferredRenderedUserInputComponents.clear();
	return echoes;
}

function restoreDeferredEchoes(
	mode: InteractiveModeBase,
	echoes: ReadonlyArray<{ text: string; epoch: number | undefined }>,
): void {
	for (const { text, epoch } of echoes) {
		mode.renderDeferredUserInput(text);
		const tracked = mode.deferredRenderedUserInputComponents.get(text);
		const components = tracked?.[tracked.length - 1];
		if (components && epoch !== undefined) echoReadEpochs.set(components, epoch);
	}
}

InteractiveModeBase.prototype.discardDeferredRenderedUserInput = function (
	this: InteractiveModeBase,
	text: string,
): void {
	const componentsToRemove = forgetDeferredEcho(this, text);
	if (!componentsToRemove) return;
	const renderer = this.ui as AltScreenMessageCounterHost;
	const following = renderer.isFollowingOutput !== false;
	const countedBefore = countChatMessages(this.chatContainer);
	if (!following) renderer.newMessages?.observe(false, countedBefore);
	for (const component of componentsToRemove) this.chatContainer.removeChild(component);
	const counted = countChatMessages(this.chatContainer);
	const counter = renderer.newMessages;
	if (!following && counter && echoReadEpochs.get(componentsToRemove) === counter.epoch) {
		counter.retract(countedBefore - counted);
	}
	counter?.observe(following, counted);
	this.updatePendingMessagesDisplay();
	this.ui.requestRender();
};

/**
 * The session started a run for a submission this host echoed as `text`. The run begins with the submission's message,
 * as sent: an `input` hook may have rewritten it, so its `message_start` need not match the echo (#4277). An engine's
 * answer can reach the host after that `message_start`, which the session then showed itself (#4272): if it showed any
 * message of its own since `shownBefore`, the echo goes. Otherwise the session's next message that matches no echo
 * takes the echo's place. A run starts only after the one before it showed its message, so an earlier run still
 * waiting here never got to show it, and its echo stays as it is.
 */
InteractiveModeBase.prototype.expectStartedUserInput = function (
	this: InteractiveModeBase,
	text: string,
	shownBefore: number,
): void {
	if (!this.deferredRenderedUserInputs.includes(text)) return;
	if (this.userMessagesShownBySession !== shownBefore) this.discardDeferredRenderedUserInput(text);
	else this.startedDeferredUserInput = text;
};

/** Show a user message from the session: in place of its echo, or of the echo of the run it started, or as new. */
InteractiveModeBase.prototype.showSessionUserMessage = function (this: InteractiveModeBase, message: Message): void {
	if (this.consumeDeferredRenderedUserInput(this.getUserMessageText(message))) return;
	const started = this.startedDeferredUserInput;
	if (started !== undefined) {
		const renderer = this.ui as AltScreenMessageCounterHost;
		const following = renderer.isFollowingOutput !== false;
		const countedBefore = countChatMessages(this.chatContainer);
		renderer.newMessages?.observe(following, countedBefore);
		const echo = forgetDeferredEcho(this, started);
		appendNewChildrenBeforeAttachedChild(this.chatContainer, echo?.[0], () => this.addMessageToChat(message));
		for (const component of echo ?? []) this.chatContainer.removeChild(component);
		const counted = countChatMessages(this.chatContainer);
		const counter = renderer.newMessages;
		if (!following && counter && echo && echoReadEpochs.get(echo) === counter.epoch) {
			counter.retract(countedBefore - counted);
		}
		counter?.replaced(counted);
		this.updatePendingMessagesDisplay();
		this.ui.requestRender();
		return;
	}
	this.userMessagesShownBySession += 1;
	this.addMessageToChat(message);
};

InteractiveModeBase.prototype.getMarkdownTransformers = function (this: InteractiveModeBase) {
	const mode = this.settingsManager.getMermaidRenderingMode();
	if (this.mermaidMarkdownTransformerMode !== mode) {
		this.mermaidMarkdownTransformerMode = mode;
		this.mermaidMarkdownTransformer = createMermaidMarkdownTransformer({
			getMode: () => this.settingsManager.getMermaidRenderingMode(),
			theme,
		});
	}
	const extensionTransformers =
		this.runtimeHost instanceof IsolatedInteractiveRuntime
			? []
			: this.session.extensionRunner.getMarkdownTransformers();
	return [this.mermaidMarkdownTransformer, ...extensionTransformers];
};

/**
 * Markdown of a changelog that runs the Markdown transformers registered for the `changelog` type. Transformers are
 * looked up on each render, so a notice shown before deferred extensions load uses them once it is invalidated.
 */
InteractiveModeBase.prototype.createChangelogMarkdown = function (
	this: InteractiveModeBase,
	markdown: string,
	paddingX: number,
	paddingY: number,
): Markdown {
	return new Markdown(markdown, paddingX, paddingY, this.getMarkdownThemeWithSettings(), undefined, {
		transform: (text, width) =>
			createMarkdownTransform("changelog", () => false, this.getMarkdownTransformers())(text, width),
	});
};

InteractiveModeBase.prototype.chatMessageRenderOptions = function (
	this: InteractiveModeBase,
): ChatMessageRenderOptions {
	const isolated = this.runtimeHost instanceof IsolatedInteractiveRuntime;
	return {
		ui: this.ui,
		cwd: this.sessionManager.getCwd(),
		markdownTheme: this.getMarkdownThemeWithSettings(),
		hideThinkingBlock: this.hideThinkingBlock,
		hiddenThinkingLabel: this.hiddenThinkingLabel,
		toolOutputExpanded: this.toolOutputExpanded,
		showImages: this.settingsManager.getShowImages(),
		imageWidthCells: this.settingsManager.getImageWidthCells(),
		outputPad: this.outputPad,
		renderLatex: this.settingsManager.getLatexRenderingEnabled(),
		markdownTransformers: this.getMarkdownTransformers(),
		getToolDefinition: isolated ? undefined : (toolName) => this.getRegisteredToolDefinition(toolName),
		getCustomMessageRenderer: isolated
			? undefined
			: (customType) => this.session.extensionRunner.getMessageRenderer(customType),
		createToolComponent: isolated
			? (entry) => {
					const component = new RemoteToolExecutionComponent(
						entry.toolName,
						entry.toolCallId,
						entry.args,
						{
							showImages: this.settingsManager.getShowImages(),
							imageWidthCells: this.settingsManager.getImageWidthCells(),
							outputPad: this.outputPad,
						},
						this.runtimeHost as IsolatedInteractiveRuntime,
						() => this.ui.requestRender(),
					);
					component.setExpanded(this.toolOutputExpanded);
					if (entry.result) component.updateResult(entry.result, entry.isPartial ?? false);
					return component;
				}
			: undefined,
		createCustomMessageComponent: isolated
			? (message) => {
					const component = new RemoteCustomMessageComponent(
						message,
						this.runtimeHost as IsolatedInteractiveRuntime,
						() => this.ui.requestRender(),
						this.outputPad,
					);
					component.setExpanded(this.toolOutputExpanded);
					return component;
				}
			: undefined,
	};
};

InteractiveModeBase.prototype.addRenderedChatEntry = function (
	this: InteractiveModeBase,
	entry: ChatMessageEntry,
): Component {
	const component = renderChatMessageEntry(entry, this.chatMessageRenderOptions());
	if (entry.kind !== "system" && !(entry.kind === "custom" && isVerbatimCompactionMessage(entry.message))) {
		messageComponents.add(component);
	}
	addChatTranscriptEntry(this.chatContainer, component, entry.role);
	return component;
};

InteractiveModeBase.prototype.addCompactionBoundaryToChat = function (
	this: InteractiveModeBase,
	result: VerbatimCompactionResult,
): void {
	this.chatContainer.addChild(new Spacer(1));
	const component = new CompactionBoundaryMessageComponent(result, this.outputPad);
	component.setExpanded(this.toolOutputExpanded);
	this.chatContainer.addChild(component);
};

InteractiveModeBase.prototype.addCompactionCostNotice = function (
	this: InteractiveModeBase,
	kind: "compaction" | "branch_summary",
	usage: Usage,
): void {
	if (!this.settingsManager.getShowCacheMissNotices()) return;
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : "";
	const label = kind === "compaction" ? "Compaction" : "Branch summary";
	this.chatContainer.addChild(new Spacer(1));
	this.chatContainer.addChild(
		new Text(theme.fg("warning", `${label}: ${tokens.toLocaleString()} tokens billed${cost}`), 1, 0),
	);
};

InteractiveModeBase.prototype.addCustomEntryToChat = function (this: InteractiveModeBase, entry: CustomEntry): void {
	const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
	if (!renderer) return;
	const runner = this.session.extensionRunner;
	const component = new CustomEntryComponent(
		entry,
		(...args) => runner.renderEntry(entry.customType, ...args),
		this.outputPad,
	);
	component.setExpanded(this.toolOutputExpanded);
	if (!component.hasContent()) return;
	messageComponents.add(component);
	const streamingIndex = this.streamingComponent ? this.chatContainer.children.indexOf(this.streamingComponent) : -1;
	if (streamingIndex >= 0) this.chatContainer.children.splice(streamingIndex, 0, component);
	else this.chatContainer.addChild(component);
};

type AltScreenMessageCounterHost = TUI & {
	isFollowingOutput?: boolean;
	newMessages?: NewMessageCounter;
};

InteractiveModeBase.prototype.addMessageToChat = function (
	this: InteractiveModeBase,
	message: AgentMessage,
	options?: { populateHistory?: boolean },
): void {
	const markdownTransformers = this.getMarkdownTransformers();
	switch (message.role) {
		case "bashExecution": {
			const component = new BashExecutionComponent(
				message.command,
				this.ui,
				message.excludeFromContext,
				this.outputPad,
			);
			if (message.output) {
				component.appendOutput(message.output);
			}
			component.setComplete(
				message.exitCode,
				message.cancelled,
				message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
				message.fullOutputPath,
			);
			messageComponents.add(component);
			this.chatContainer.addChild(component);
			break;
		}
		case "custom": {
			if (message.display) {
				const component =
					this.runtimeHost instanceof IsolatedInteractiveRuntime
						? new RemoteCustomMessageComponent(
								message,
								this.runtimeHost,
								() => this.ui.requestRender(),
								this.outputPad,
							)
						: new CustomMessageComponent(
								message,
								this.session.extensionRunner.getMessageRenderer(message.customType),
								this.getMarkdownThemeWithSettings(),
								this.outputPad,
								this.settingsManager.getLatexRenderingEnabled(),
								markdownTransformers,
							);
				component.setExpanded(this.toolOutputExpanded);
				messageComponents.add(component);
				this.chatContainer.addChild(component);
			}
			break;
		}
		case "branchSummary": {
			this.chatContainer.addChild(new Spacer(1));
			const component = new BranchSummaryMessageComponent(
				message,
				this.getMarkdownThemeWithSettings(),
				this.settingsManager.getLatexRenderingEnabled(),
				this.outputPad,
				markdownTransformers,
			);
			component.setExpanded(this.toolOutputExpanded);
			messageComponents.add(component);
			this.chatContainer.addChild(component);
			break;
		}
		case "user": {
			const textContent = this.getUserMessageText(message);
			if (textContent) {
				if (this.chatContainer.children.length > 0) {
					this.chatContainer.addChild(new Spacer(1));
				}
				const skillBlock = parseSkillBlock(textContent);
				if (skillBlock) {
					// Render skill block (collapsible)
					const component = new SkillInvocationMessageComponent(
						skillBlock,
						this.getMarkdownThemeWithSettings(),
						this.settingsManager.getLatexRenderingEnabled(),
						this.outputPad,
						markdownTransformers,
					);
					component.setExpanded(this.toolOutputExpanded);
					if (!skillBlock.userMessage) messageComponents.add(component);
					this.chatContainer.addChild(component);
					// Render user message separately if present
					if (skillBlock.userMessage) {
						const userComponent = new UserMessageComponent(
							skillBlock.userMessage,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
							markdownTransformers,
							this.settingsManager.getLatexRenderingEnabled(),
						);
						messageComponents.add(userComponent);
						this.chatContainer.addChild(userComponent);
					}
				} else {
					const userComponent = new UserMessageComponent(
						textContent,
						this.getMarkdownThemeWithSettings(),
						this.outputPad,
						markdownTransformers,
						this.settingsManager.getLatexRenderingEnabled(),
					);
					messageComponents.add(userComponent);
					this.chatContainer.addChild(userComponent);
				}
				if (options?.populateHistory) {
					this.editor.addToHistory?.(textContent);
				}
			}
			break;
		}
		case "assistant": {
			const assistantComponent = new AssistantMessageComponent(
				message,
				this.hideThinkingBlock,
				this.getMarkdownThemeWithSettings(),
				this.hiddenThinkingLabel,
				this.outputPad,
				markdownTransformers,
				false,
				this.settingsManager.getLatexRenderingEnabled(),
			);
			messageComponents.add(assistantComponent);
			this.chatContainer.addChild(assistantComponent);
			break;
		}
		case "toolResult": {
			// Tool results are rendered inline with tool calls, handled separately
			break;
		}
		default:
			break;
	}
};

InteractiveModeBase.prototype.renderSessionContext = function (
	this: InteractiveModeBase,
	sessionContext: SessionContext,
	options: { updateFooter?: boolean; populateHistory?: boolean } = {},
): void {
	this.pendingTools.clear();
	const pendingEchoes = takeDeferredEchoes(this);

	if (options.updateFooter) {
		this.footer.invalidate();
		this.updateEditorBorderColor();
	}

	const entries = chatEntriesFromAgentMessages(sessionContext.messages);
	for (const entry of entries) {
		const component = this.addRenderedChatEntry(entry);
		if (entry.kind === "tool" && entry.isPartial !== false && component instanceof ToolExecutionComponent) {
			this.pendingTools.set(entry.toolCallId, component);
		}
		if (options.populateHistory && entry.kind === "user") {
			this.editor.addToHistory?.(entry.text);
		}
	}

	restoreDeferredEchoes(this, pendingEchoes);

	this.ui.requestRender();
};

/** One addition a session's entries make to the chat, in order. */
type TranscriptStep =
	| { readonly kind: "entry"; readonly entry: ChatMessageEntry }
	| { readonly kind: "custom"; readonly entry: CustomEntry }
	| { readonly kind: "cost"; readonly type: "compaction" | "branch_summary"; readonly usage: Usage };

/** Steps of a long session's end built at once: more than a terminal shows, so its first frame is full. */
const TAIL_STEPS = 128;
/** How long building the history before a session's end may run before it yields the event loop. */
const HISTORY_SLICE_BUDGET_MS = 8;
/** At most this many steps of that history are built in one slice, however fast each is. */
const HISTORY_SLICE_STEPS = 24;

/** The chat's additions for `sessionEntries`, in order; adds user prompts to the editor history when asked. */
function planTranscript(
	mode: InteractiveModeBase,
	sessionEntries: SessionEntry[],
	options: { populateHistory?: boolean; suppressCompactionBoundary?: VerbatimCompactionResult },
): TranscriptStep[] {
	const steps: TranscriptStep[] = [];
	let messageBuffer: AgentMessage[] = [];
	const messageMeta = new Map<AgentMessage, PersistedMessageMeta>();
	let firstMessage = true;
	const flushMessages = (): void => {
		if (
			options.suppressCompactionBoundary &&
			firstMessage &&
			isSynthesizedCompactionBoundary(messageBuffer[0], options.suppressCompactionBoundary)
		) {
			messageBuffer = messageBuffer.slice(1);
		}
		firstMessage = false;
		for (const entry of chatEntriesFromAgentMessages(messageBuffer, messageMeta)) {
			steps.push({ kind: "entry", entry });
			if (options.populateHistory && entry.kind === "user") mode.editor.addToHistory?.(entry.text);
		}
		messageBuffer = [];
	};
	for (const entry of sessionEntries) {
		if (entry.type === "custom") {
			// An unrendered record between a tool call and its result must not split them into two cards.
			if (!mode.session.extensionRunner.getEntryRenderer(entry.customType)) continue;
			flushMessages();
			steps.push({ kind: "custom", entry });
		} else {
			const messages = sessionEntryToContextMessages(entry);
			for (const message of messages) messageMeta.set(message, { id: entry.id, timestamp: entry.timestamp });
			messageBuffer.push(...messages);
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
				flushMessages();
				const suppressedLiveBoundary =
					entry.type === "compaction" &&
					options.suppressCompactionBoundary !== undefined &&
					entry.summary === options.suppressCompactionBoundary.compactedText &&
					entry.tokensBefore === options.suppressCompactionBoundary.tokensBefore;
				if (!suppressedLiveBoundary) steps.push({ kind: "cost", type: entry.type, usage: entry.usage });
			}
		}
	}
	flushMessages();
	return steps;
}

/** Adds one step's components to the end of `mode.chatContainer`. */
function addTranscriptStep(mode: InteractiveModeBase, step: TranscriptStep): void {
	if (step.kind === "custom") {
		mode.addCustomEntryToChat(step.entry);
		return;
	}
	if (step.kind === "cost") {
		mode.addCompactionCostNotice(step.type, step.usage);
		return;
	}
	const { entry } = step;
	const component = mode.addRenderedChatEntry(entry);
	if (entry.kind === "assistant") addServiceTierWarnings(mode, entry.message);
	if (entry.kind === "tool" && entry.isPartial !== false && component instanceof ToolExecutionComponent) {
		mode.pendingTools.set(entry.toolCallId, component);
	}
}

/**
 * Builds the history before a session's end into the chat, before `end`, a bounded slice per event-loop turn and
 * newest first, so a long session's end shows at once and its history fills in behind it. Ends early when the chat is
 * cleared. The chat is built exactly as all at once: every step follows other chat content, so each takes the spacing
 * it would there.
 */
function buildHistoryInSlices(mode: InteractiveModeBase, history: readonly TranscriptStep[], end: Component): void {
	const chat = mode.chatContainer;
	let remaining = history.length;
	let before = end;
	/** Builds up to `maxSteps` steps within `budgetMs`; whether steps remain. */
	const build = (budgetMs: number, maxSteps: number): boolean => {
		const at = chat.children.indexOf(before);
		if (at < 0 || remaining === 0) return false;
		const deadline = performance.now() + budgetMs;
		const built: Component[][] = [];
		const preceding = new Spacer(0);
		const scratch = new Container();
		// The step functions add to the chat; for this synchronous slice they add to a scratch container that, like
		// the chat at this point, already holds content.
		mode.chatContainer = scratch;
		try {
			for (let steps = 0; remaining > 0 && steps < maxSteps; steps++) {
				scratch.children = [preceding];
				addTranscriptStep(mode, history[--remaining]!);
				built.push(scratch.children.slice(1));
				if (performance.now() >= deadline) break;
			}
		} finally {
			mode.chatContainer = chat;
		}
		const components = built.reverse().flat();
		if (components.length > 0) {
			if (chat instanceof StartupChatContainer) chat.insertChildren(at, components);
			else chat.children.splice(at, 0, ...components);
			before = components[0]!;
			const messages = components.filter(isChatMessageComponent).length;
			if (messages > 0) (mode.ui as AltScreenMessageCounterHost).newMessages?.historyPrepended(messages);
			mode.ui.requestRender();
		}
		if (remaining > 0) return true;
		chat.removeChild(end);
		return false;
	};
	const tracked = trackChatHistoryBuild(chat, () => {
		build(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
		tracked.done();
	});
	const slice = (): void => {
		if (build(HISTORY_SLICE_BUDGET_MS, HISTORY_SLICE_STEPS)) setImmediate(slice);
		else tracked.done();
	};
	setImmediate(slice);
}

InteractiveModeBase.prototype.renderSessionEntries = function (
	this: InteractiveModeBase,
	sessionEntries: SessionEntry[],
	options: {
		updateFooter?: boolean;
		populateHistory?: boolean;
		suppressCompactionBoundary?: VerbatimCompactionResult;
	} = {},
): void {
	this.resetTranscriptSelection();
	this.pendingTools.clear();
	const pendingEchoes = takeDeferredEchoes(this);
	if (options.updateFooter) {
		this.footer.invalidate();
		this.updateEditorBorderColor();
	}
	const steps = planTranscript(this, sessionEntries, options);
	// The fullscreen transcript shows a long session's end built now, and its history as it is built behind it, so
	// resuming never blocks on the history. The main-screen renderer prints the transcript in order, so it is built
	// at once.
	const tailStart = this.ui.mode === "fullscreen" ? Math.max(0, steps.length - TAIL_STEPS) : 0;
	if (tailStart > 0) {
		const historyEnd = new Spacer(0);
		this.chatContainer.addChild(historyEnd);
		buildHistoryInSlices(this, steps.slice(0, tailStart), historyEnd);
	}
	for (let index = tailStart; index < steps.length; index++) addTranscriptStep(this, steps[index]!);
	if (this.settingsManager.getShowCacheMissNotices()) {
		for (const miss of collectCacheMisses(
			sessionEntries,
			createCacheMissModelSource(this.session.modelRuntime),
		).values()) {
			this.chatContainer.addChild(new Text(theme.fg("warning", formatCacheMissNotice(miss)), 1, 0));
		}
	}
	restoreDeferredEchoes(this, pendingEchoes);
	this.ui.requestRender();
};

InteractiveModeBase.prototype.attachStartupNoticesContainer = function (
	this: InteractiveModeBase,
	options: { resetDetached?: boolean } = {},
): void {
	const disclosureIndex = this.chatContainer.children.indexOf(this.resourceDisclosureContainer);
	const noticesIndex = this.chatContainer.children.indexOf(this.startupNoticesContainer);
	if (disclosureIndex >= 0 && noticesIndex >= 0) return;
	if (disclosureIndex < 0) {
		if (options.resetDetached) this.resourceDisclosureContainer.clear();
		if (noticesIndex >= 0) this.chatContainer.children.splice(noticesIndex, 0, this.resourceDisclosureContainer);
		else this.chatContainer.addChild(this.resourceDisclosureContainer);
	}
	if (noticesIndex < 0) {
		if (options.resetDetached) this.startupNoticesContainer.clear();
		this.chatContainer.addChild(this.startupNoticesContainer);
	}
};

const renderedSessionIds = new WeakMap<InteractiveModeBase, string>();

export function clearChatForRerender(mode: InteractiveModeBase): void {
	const renderer = mode.ui as AltScreenMessageCounterHost;
	if (mode.chatContainer.children.length > 0) {
		renderer.newMessages?.observe(renderer.isFollowingOutput !== false, countChatMessages(mode.chatContainer));
	}
	mode.chatContainer.clear();
}

InteractiveModeBase.prototype.renderInitialMessages = function (this: InteractiveModeBase): void {
	const sessionId = this.sessionManager.getSessionId();
	const previousSessionId = renderedSessionIds.get(this);
	renderedSessionIds.set(this, sessionId);
	const renderer = this.ui as AltScreenMessageCounterHost;
	if (previousSessionId !== sessionId) renderer.newMessages?.reset();
	this.attachStartupNoticesContainer({ resetDetached: true });
	const entries = buildContextEntries(this.sessionManager.getEntries(), this.sessionManager.getLeafId());
	this.renderSessionEntries(entries, { updateFooter: true, populateHistory: true });
	renderProjectTrustWarningIfNeeded(this);
	refreshInteractiveTasks(this);
	if (previousSessionId === sessionId) {
		renderer.newMessages?.replaced(countChatMessages(this.chatContainer));
	}
};

/**
 * Warns that this untrusted project's resources are ignored, when it has resources that need trust. Finding them walks
 * the file system, so the warning's place in the chat is kept and filled once the walk answers.
 */
function renderProjectTrustWarningIfNeeded(mode: InteractiveModeBase): void {
	if (mode.settingsManager.isProjectTrusted()) {
		return;
	}
	const chat = mode.chatContainer;
	const separated = chat.children.length > 0;
	const slot = new Container();
	chat.addChild(slot);
	const settle = (requiresTrust: boolean) => {
		// A chat rebuilt meanwhile was given its own warning.
		if (!chat.children.includes(slot)) return;
		if (!requiresTrust) {
			chat.removeChild(slot);
			return;
		}
		if (separated) {
			slot.addChild(new Spacer(1));
		}
		slot.addChild(
			new ThemedText(
				() =>
					theme.fg(
						"warning",
						`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart ${APP_NAME}.`,
					),
				1,
				0,
			),
		);
		mode.ui.requestRender();
	};
	void hasTrustRequiringProjectResourcesAsync(mode.sessionManager.getCwd()).then(settle, () => settle(false));
}

InteractiveModeBase.prototype.getUserInput = async function (
	this: InteractiveModeBase,
): Promise<InteractiveSubmission> {
	while (true) {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		if (this.startupReplayActiveInput) {
			await this.drainStartupReplayCommands();
			continue;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (submission: InteractiveSubmission) => {
				this.onInputCallback = undefined;
				resolve(submission);
			};
			if (!this.inputHandlerReadyRecorded) {
				this.inputHandlerReadyRecorded = true;
				recordTimeSinceReset("interactive-input-handler-ready");
				markLifecycleTiming("interactive-input-handler-ready");
				void (async () => {
					await yieldToEventLoop();
					this.footerDataProvider.startGitWatcher();
					// pi parity: the changelog/first-run notices need nothing from
					// extensions — render them right after the input handler is ready
					// instead of gating them behind the deferred extension reload (or,
					// when the user types immediately, behind the whole agent turn).
					// Deferred startup gets here before it has read the changelog.
					await preloadChangelog(getChangelogPath());
					this.showStartupNoticesIfNeeded(this.startupNoticesContainer);
					if (this.deferredStartupPending) {
						await this.ensureDeferredStartupComplete();
					}
					markEventLoopStartupComplete();
				})().catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					console.error(`Deferred input-readiness startup task failed: ${message}`);
				});
			}
		});
	}
};

InteractiveModeBase.prototype.rebuildChatFromMessages = function (
	this: InteractiveModeBase,
	options: {
		suppressCompactionBoundary?: VerbatimCompactionResult;
		resetStartupDisclosure?: boolean;
	} = {},
): void {
	// Generic rebuilds keep the same session: pending fd/rg callbacks still own
	// this transcript. Full session replacements invalidate their generation in
	// renderCurrentSessionState() before rebuilding the replacement transcript.
	const renderer = this.ui as AltScreenMessageCounterHost;
	this.managedToolStatusStarted = false;
	this.lastStatusSpacer = undefined;
	this.lastStatusText = undefined;
	clearChatForRerender(this);
	if (options.resetStartupDisclosure) this.resourceDisclosureContainer.clear();
	this.attachStartupNoticesContainer();
	const entries = buildContextEntries(this.sessionManager.getEntries(), this.sessionManager.getLeafId());
	this.renderSessionEntries(entries, { suppressCompactionBoundary: options.suppressCompactionBoundary });
	renderer.newMessages?.replaced(countChatMessages(this.chatContainer));
};

function isSynthesizedCompactionBoundary(message: AgentMessage | undefined, result: VerbatimCompactionResult): boolean {
	if (message?.role !== "custom" || message.customType !== "compaction" || !message.display) return false;
	const details = message.details as { strategy?: string } | undefined;
	if (details?.strategy !== "verbatim-lines") return false;
	const content = Array.isArray(message.content)
		? message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
		: message.content;
	return stripVerbatimCompactionPrefix(content) === result.compactedText;
}
