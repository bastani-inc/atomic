import { isProxy } from "node:util/types";
import type { AssistantMessage, Usage } from "@bastani/atomic-ai/compat";
import type { HistoryLeaf, TUI } from "@bastani/atomic-tui";
import { CONFIG_DIR_NAME } from "../../config.js";
import { collectCacheMisses, createCacheMissModelSource, formatCacheMissNotice } from "../../core/cache-stats.ts";
import { markLifecycleTiming } from "../../core/lifecycle-timings.ts";
import { isVerbatimCompactionMessage, stripVerbatimCompactionPrefix } from "../../core/messages.ts";
import { projectTrustWarningVisible } from "../../core/project-trust-state.ts";
import { serviceTierWarnings } from "../../core/service-tier-warnings.ts";
import type { CustomEntry } from "../../core/session-manager.ts";
import { buildContextEntries, type SessionEntry } from "../../core/session-manager.ts";
import { sessionEntryToDisplayMessages } from "../../core/session-manager-history.ts";
import { getOwnerTaskStore } from "../../core/tasks/owner-store.js";
import { ReopenedCompletionHeaders } from "../../core/tasks/reopened-completion.js";
import { taskTranscriptSource } from "../../core/tasks/supervisor.js";
import { readTaskCompletionHistory } from "../../core/tasks/task-completion-history.js";
import {
	carryRowSource,
	noteRowSource,
	noteSavedSeq,
	savedRowKey,
	savedSeqOf,
} from "../../core/tasks/transcript-origin.js";
import { yieldToEventLoop } from "../../utils/event-loop.ts";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import {
	disposeRemoteRenderers,
	RemoteCustomMessageComponent,
	RemoteToolExecutionComponent,
} from "../interactive-engine/remote-renderer.ts";
import { appendBoundedStderr } from "../rpc/rpc-client-process.js";
import { messageComponents, statusComponents } from "./chat-message-count.ts";
import {
	applyToolEntryState,
	callsAwaitingLaterResults,
	isResultWithoutCall,
} from "./components/chat-message-renderer.ts";
import { CustomEntryComponent } from "./components/custom-entry.ts";
import type { NewMessageCounter } from "./components/jump-to-latest.ts";
import { createMarkdownTransform } from "./components/markdown-transform.ts";
import { createMermaidMarkdownTransformer } from "./components/mermaid.ts";
import { ThemedText } from "./components/themed-text.js";
import type { ToolGroupRole } from "./components/tool-block.ts";
import { assistantCallBreaks, type ToolGroupMemberState, ToolGroupTracker } from "./components/tool-group-tracker.ts";
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
import {
	holdCompactionWidgets,
	installSavedChatHistory,
	noteShownContext,
	type ParkedViewport,
	parkViewport,
	releaseSavedChatHistory,
	type SavedRendererInstances,
	storedWidget,
	widgetKey,
} from "./interactive-saved-chat-history.js";
import { followChosenExpansion, SavedPageCallsBuilder } from "./interactive-saved-tool-calls.ts";
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

interface GroupedToolComponent {
	setGroupRole(role: ToolGroupRole): void;
}
interface MainToolGrouping {
	readonly tracker: ToolGroupTracker;
	readonly starts: Map<string, number>;
	lastMember: Component | undefined;
	carriedBreak: boolean;
}
const mainToolGroupings = new WeakMap<InteractiveModeBase, MainToolGrouping>();

function mainToolGrouping(mode: InteractiveModeBase): MainToolGrouping {
	let grouping = mainToolGroupings.get(mode);
	if (grouping === undefined) {
		grouping = {
			tracker: new ToolGroupTracker({ groupBash: false }),
			starts: new Map(),
			lastMember: undefined,
			carriedBreak: false,
		};
		mainToolGroupings.set(mode, grouping);
	}
	return grouping;
}

function isGroupedToolComponent(component: Component): component is Component & GroupedToolComponent {
	return "setGroupRole" in component && typeof component.setGroupRole === "function";
}

function hasRowsSinceLastMember(
	container: Component & { children: Component[] },
	last: Component,
	current: Component,
): boolean {
	for (let index = container.children.length - 1; index >= 0; index -= 1) {
		const child = container.children[index];
		if (child === last) return false;
		if (child !== current && !(child instanceof AssistantMessageComponent)) return true;
	}
	return true;
}

export function breakMainToolGroup(mode: InteractiveModeBase): void {
	const grouping = mainToolGrouping(mode);
	grouping.tracker.break();
	grouping.lastMember = undefined;
	grouping.carriedBreak = false;
}

function resetMainToolGroup(mode: InteractiveModeBase): void {
	const grouping = mainToolGrouping(mode);
	grouping.tracker.reset();
	grouping.lastMember = undefined;
	grouping.carriedBreak = false;
}

export function endMainToolTurn(mode: InteractiveModeBase): void {
	resetMainToolGroup(mode);
	mainToolGrouping(mode).starts.clear();
}

export function mainToolCallBreaks(mode: InteractiveModeBase, message: AssistantMessage): ReadonlySet<string> {
	return assistantCallBreaks(message.content, mainToolGrouping(mode).carriedBreak).breakBefore;
}

export function endMainAssistantMessage(mode: InteractiveModeBase, message: AssistantMessage): void {
	const grouping = mainToolGrouping(mode);
	grouping.carriedBreak = assistantCallBreaks(message.content, grouping.carriedBreak).trailing;
}

export function trackMainToolComponent(
	mode: InteractiveModeBase,
	toolCallId: string,
	toolName: string,
	component: Component & GroupedToolComponent,
	breakBefore = false,
): void {
	const grouping = mainToolGrouping(mode);
	if (
		breakBefore ||
		(grouping.lastMember !== undefined && hasRowsSinceLastMember(mode.chatContainer, grouping.lastMember, component))
	)
		grouping.tracker.break();
	grouping.tracker.append(toolCallId, toolName, "pending", (role) => component.setGroupRole(role));
	grouping.lastMember = component;
}

export function settleMainTool(mode: InteractiveModeBase, toolCallId: string, state: ToolGroupMemberState): void {
	const grouping = mainToolGrouping(mode);
	grouping.tracker.settle(toolCallId, state);
	if (state !== "pending") grouping.starts.delete(toolCallId);
}

export function observeMainToolStart(mode: InteractiveModeBase, toolCallId: string): number {
	const starts = mainToolGrouping(mode).starts;
	const startedAt = starts.get(toolCallId) ?? Date.now();
	starts.set(toolCallId, startedAt);
	return startedAt;
}

function renderGroupedChatEntries(
	mode: InteractiveModeBase,
	entries: readonly ChatMessageEntry[],
	onEntry: (entry: ChatMessageEntry, component: Component) => void,
): void {
	const grouping = mainToolGrouping(mode);
	for (const entry of entries) {
		if (entry.kind === "tool" && entry.isPartial !== false) {
			const startedAt = grouping.starts.get(entry.toolCallId);
			if (startedAt !== undefined) {
				entry.executionStarted = true;
				entry.startedAt = startedAt;
				entry.argsComplete = true;
			}
		}
		if (entry.kind === "assistant")
			grouping.carriedBreak = assistantCallBreaks(entry.message.content, grouping.carriedBreak).trailing;
		else if (entry.kind !== "tool") grouping.carriedBreak = false;
		const component = mode.addRenderedChatEntry(entry);
		if (entry.kind === "tool" && isGroupedToolComponent(component)) {
			grouping.tracker.bind(entry.toolCallId, (role) => {
				entry.groupRole = role;
				component.setGroupRole(role);
			});
			grouping.lastMember = component;
		}
		onEntry(entry, component);
	}
}

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
	const text = this.getUserMessageText(message);
	const echo = this.deferredRenderedUserInputComponents.get(text)?.[0];
	if (this.consumeDeferredRenderedUserInput(text)) {
		// The echo stays as the session's message: its rows are that message's rows.
		for (const component of echo ?? []) noteRowSource(component, { message, part: 0 });
		return;
	}
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
	const withheld =
		this.runtimeHost instanceof IsolatedInteractiveRuntime &&
		this.runtimeHost.isProjectTrustPending() &&
		!this.settingsManager.isProjectTrusted();
	if (this.mermaidMarkdownTransformerMode !== mode || withheld !== (this.mermaidTransformerWithheldProject === true)) {
		this.mermaidMarkdownTransformerMode = mode;
		this.mermaidTransformerWithheldProject = withheld;
		const edit = this.mermaidUserEdit;
		this.mermaidMarkdownTransformer = createMermaidMarkdownTransformer({
			// Invalidating a message for a redraw isn't permission to replace a mounted diagram with source text.
			// The user's own subsequent rendering choice, unlike approval, still applies to visible messages.
			getMode: () =>
				withheld && edit === this.mermaidUserEdit ? mode : this.settingsManager.getMermaidRenderingMode(),
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
		getTaskRecord: isolated ? undefined : (taskId) => getOwnerTaskStore(this.session)?.getTask(taskId),
		hasTaskTranscript: isolated
			? undefined
			: (taskId) => {
					const lease = getOwnerTaskStore(this.session)?.resolveTask(taskId);
					return lease?.ok ? taskTranscriptSource(lease.value).ok : false;
				},
		loadTaskTranscript: isolated
			? undefined
			: async (taskId, options) => {
					const lease = getOwnerTaskStore(this.session)?.resolveTask(taskId);
					return lease?.ok ? readTaskCompletionHistory(lease.value, options?.signal) : undefined;
				},
		getCustomMessageRenderer: isolated
			? undefined
			: (customType) => this.session.extensionRunner.getMessageRenderer(customType),
		createToolComponent: isolated
			? (entry, context) => {
					const component = new RemoteToolExecutionComponent(
						entry.toolName,
						entry.toolCallId,
						entry.args,
						{
							showImages: context?.showImages ?? this.settingsManager.getShowImages(),
							imageWidthCells: context?.imageWidthCells ?? this.settingsManager.getImageWidthCells(),
							outputPad: context?.outputPad ?? this.outputPad,
							rendererTaskId: entry.rendererTaskId,
						},
						this.runtimeHost as IsolatedInteractiveRuntime,
						context?.requestRender ?? (() => this.ui.requestRender()),
					);
					applyToolEntryState(component, entry, context?.expanded ?? this.toolOutputExpanded);
					return component;
				}
			: undefined,
		createCustomMessageComponent: isolated
			? (message, context) => {
					const component = new RemoteCustomMessageComponent(
						message,
						this.runtimeHost as IsolatedInteractiveRuntime,
						context?.requestRender ?? (() => this.ui.requestRender()),
						context?.outputPad ?? this.outputPad,
					);
					component.setExpanded(context?.expanded ?? this.toolOutputExpanded);
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
	carryRowSource(entry, component);
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
	const seq = this.sessionManager.getEntrySeq?.(entry.id);
	if (seq !== undefined) noteSavedSeq(entry, seq);
	noteRowSource(component, { message: entry, part: 0 });
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
			noteRowSource(component, { message, part: 0 });
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
								undefined,
								undefined,
								{
									hasTranscript: (taskId) => {
										const lease = getOwnerTaskStore(this.session)?.resolveTask(taskId);
										return lease?.ok ? taskTranscriptSource(lease.value).ok : false;
									},
									loadTranscript: async (taskId, options) => {
										const lease = getOwnerTaskStore(this.session)?.resolveTask(taskId);
										return lease?.ok ? readTaskCompletionHistory(lease.value, options?.signal) : undefined;
									},
									getToolDefinition: (toolName) => this.getRegisteredToolDefinition(toolName),
									cwd: this.sessionManager.getCwd(),
									requestRender: () => this.ui.requestRender(),
								},
							);
				component.setExpanded(this.toolOutputExpanded);
				messageComponents.add(component);
				noteRowSource(component, { message, part: 0 });
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
			noteRowSource(component, { message, part: 0 });
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
					noteRowSource(component, { message, part: 0 });
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
						noteRowSource(userComponent, { message, part: 0 });
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
					noteRowSource(userComponent, { message, part: 0 });
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
			noteRowSource(assistantComponent, { message, part: 0 });
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

	const grouping = mainToolGrouping(this);
	resetMainToolGroup(this);
	const entries = chatEntriesFromAgentMessages(sessionContext.messages, undefined, { tracker: grouping.tracker });
	renderGroupedChatEntries(this, entries, (entry, component) => {
		if (entry.kind === "tool" && entry.isPartial !== false && component instanceof ToolExecutionComponent) {
			this.pendingTools.set(entry.toolCallId, component);
		}
		if (options.populateHistory && entry.kind === "user") {
			this.editor.addToHistory?.(entry.text);
		}
	});

	restoreDeferredEchoes(this, pendingEchoes);

	this.ui.requestRender();
};

type TranscriptStep =
	| { readonly kind: "entry"; readonly entry: ChatMessageEntry }
	| { readonly kind: "custom"; readonly entry: CustomEntry }
	| {
			readonly kind: "cost";
			readonly type: "compaction" | "branch_summary";
			readonly usage: Usage;
			/** The saved entry whose cost this is, on a saved page. */
			readonly seq?: number;
	  };

const TAIL_STEPS = 128;
const HISTORY_SLICE_BUDGET_MS = 8;
const HISTORY_SLICE_STEPS = 24;

function planTranscript(
	mode: InteractiveModeBase,
	sessionEntries: SessionEntry[],
	options: {
		populateHistory?: boolean;
		suppressCompactionBoundary?: VerbatimCompactionResult;
		saved?: { seqs: Map<SessionEntry, number>; owners: WeakMap<object, string> };
	},
): TranscriptStep[] {
	const steps: TranscriptStep[] = [];
	const grouping: MainToolGrouping = options.saved
		? {
				tracker: new ToolGroupTracker({ groupBash: false }),
				starts: new Map(),
				lastMember: undefined,
				carriedBreak: false,
			}
		: mainToolGrouping(mode);
	if (!options.saved) resetMainToolGroup(mode);
	let messageBuffer: AgentMessage[] = [];
	const messageMeta = new Map<AgentMessage, PersistedMessageMeta>();
	const messageSeq = options.saved ? new Map<AgentMessage, number>() : undefined;
	let firstMessage = true;
	const flushMessages = (): void => {
		if (options.suppressCompactionBoundary && firstMessage) {
			// A boundary replays after the system prompt it recorded, so the boundary is the first non-system message.
			const boundaryIndex = messageBuffer.findIndex((message) => message.role !== "system");
			if (isSynthesizedCompactionBoundary(messageBuffer[boundaryIndex], options.suppressCompactionBoundary)) {
				messageBuffer = messageBuffer.filter((_, index) => index !== boundaryIndex);
			}
		}
		firstMessage = false;
		if (options.saved) grouping.tracker.break();
		else breakMainToolGroup(mode);
		const saved = options.saved;
		for (const entry of chatEntriesFromAgentMessages(messageBuffer, messageMeta, {
			tracker: grouping.tracker,
			...(saved && messageSeq
				? {
						onSourceRow: (e: ChatMessageEntry, message: AgentMessage, block: number) =>
							saved.owners.set(e, `${messageSeq.get(message)}:${block}`),
					}
				: {}),
		})) {
			if (entry.kind === "tool" && entry.isPartial !== false) {
				const startedAt = grouping.starts.get(entry.toolCallId);
				if (startedAt !== undefined) {
					entry.executionStarted = true;
					entry.startedAt = startedAt;
					entry.argsComplete = true;
				}
			}
			if (entry.kind === "assistant")
				grouping.carriedBreak = assistantCallBreaks(entry.message.content, grouping.carriedBreak).trailing;
			else if (entry.kind !== "tool") grouping.carriedBreak = false;
			steps.push({ kind: "entry", entry });
			if (options.populateHistory && entry.kind === "user") mode.editor.addToHistory?.(entry.text);
		}
		messageBuffer = [];
	};
	const headers = new ReopenedCompletionHeaders(
		() => ({
			entries: mode.sessionManager.getBranch(),
			recovery: mode.sessionManager.getSessionRecoveryState(),
		}),
		isProxy,
	);
	for (const entry of sessionEntries) {
		if (entry.type === "custom") {
			// An unrendered record between a tool call and its result must not split them into two cards.
			if (!mode.session.extensionRunner.getEntryRenderer(entry.customType)) continue;
			const seq = options.saved ? options.saved.seqs.get(entry) : mode.sessionManager?.getEntrySeq?.(entry.id);
			if (seq !== undefined) noteSavedSeq(entry, seq);
			flushMessages();
			if (options.saved) options.saved.owners.set(entry, `${options.saved.seqs.get(entry)}:entry`);
			steps.push({ kind: "custom", entry });
		} else {
			const messages = sessionEntryToDisplayMessages(entry, headers);
			const seq = options.saved ? options.saved.seqs.get(entry) : mode.sessionManager?.getEntrySeq?.(entry.id);
			for (const message of messages) {
				messageMeta.set(message, { id: entry.id, timestamp: entry.timestamp });
				if (seq !== undefined) noteSavedSeq(message, seq);
				if (options.saved) messageSeq?.set(message, options.saved.seqs.get(entry)!);
			}
			messageBuffer.push(...messages);
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
				flushMessages();
				const suppressedLiveBoundary =
					entry.type === "compaction" &&
					options.suppressCompactionBoundary !== undefined &&
					entry.summary === options.suppressCompactionBoundary.compactedText &&
					entry.tokensBefore === options.suppressCompactionBoundary.tokensBefore;
				const seq = options.saved?.seqs.get(entry);
				if (!suppressedLiveBoundary)
					steps.push({
						kind: "cost",
						type: entry.type,
						usage: entry.usage,
						...(seq === undefined ? {} : { seq }),
					});
			}
		}
	}
	flushMessages();
	return steps;
}

/** The rows a parked reader sees of entries a new context keeps, while that context is being drawn. */
const adoptions = new WeakMap<InteractiveModeBase, ParkedViewport & { inserted: boolean }>();

function stepKey(step: TranscriptStep): string | undefined {
	if (step.kind === "entry") return savedRowKey(step.entry);
	// A custom entry draws one row, from the entry itself.
	const seq = step.kind === "custom" ? savedSeqOf(step.entry) : undefined;
	return seq === undefined ? undefined : `${seq}:0`;
}

/** A kept entry the reader sees keeps its drawn rows: the first such step puts them all where it belongs. */
function adoptStep(mode: InteractiveModeBase, step: TranscriptStep): Component | undefined {
	const adoption = adoptions.get(mode);
	const key = adoption && stepKey(step);
	const component = key === undefined ? undefined : adoption?.keys.get(key);
	if (!adoption || !component) return undefined;
	if (!adoption.inserted) {
		for (const row of adoption.adopted) mode.chatContainer.addChild(row);
		adoption.inserted = true;
	}
	return component;
}

function addTranscriptStep(mode: InteractiveModeBase, step: TranscriptStep, latest = true, saved = false): void {
	const adopted = saved ? undefined : adoptStep(mode, step);
	if (step.kind === "custom") {
		if (!adopted) {
			const seq = savedSeqOf(step.entry);
			const kept = saved || seq === undefined ? undefined : storedWidget(mode, `${seq}:entry`);
			if (kept) mode.chatContainer.addChild(kept);
			else mode.addCustomEntryToChat(step.entry);
		}
		return;
	}
	if (step.kind === "cost") {
		mode.addCompactionCostNotice(step.type, step.usage);
		return;
	}
	const { entry } = step;
	const kept = saved || adopted ? undefined : storedWidget(mode, widgetKey(entry));
	if (kept) addChatTranscriptEntry(mode.chatContainer, kept, entry.role);
	const component = adopted ?? kept ?? mode.addRenderedChatEntry(entry);
	if (!saved && entry.kind === "tool" && isGroupedToolComponent(component)) {
		const grouping = mainToolGrouping(mode);
		grouping.tracker.bind(entry.toolCallId, (role) => {
			entry.groupRole = role;
			component.setGroupRole(role);
		});
		if (latest) grouping.lastMember = component;
	}
	if (entry.kind === "assistant" && !adopted) addServiceTierWarnings(mode, entry.message);
	if (!saved && entry.kind === "tool" && entry.isPartial !== false && component instanceof ToolExecutionComponent) {
		mode.pendingTools.set(entry.toolCallId, component);
	}
}

/** A cost notice follows every row of its saved entry. */
const COST_BLOCK = Number.MAX_SAFE_INTEGER;

/**
 * Render an archived page on its own. Never register historical tools as pending in the live turn. When a later page
 * follows (`adjacent.newer`), calls the page ends with wait for it: their results start that page.
 *
 * With `record`, the rows are drawn for a copy, not mounted: each row's saved position is noted there instead of
 * keeping its renderer, a kept instance is reused as it is, and the page joins no mounted page.
 */
function savedChatComponents(
	mode: InteractiveModeBase,
	entries: SessionEntry[],
	seqs: number[],
	exceptions: SavedRendererInstances,
	adjacent: { readonly older?: string; readonly newer?: string } | undefined,
	record?: Map<Component, HistoryLeaf>,
): Component[] {
	const scratch = new Container();
	// Each page draws after earlier rows, as the whole transcript does: its first message keeps its spacing.
	scratch.addChild(new Spacer(0));
	const chat = mode.chatContainer;
	try {
		mode.chatContainer = scratch;
		const saved = { seqs: new Map(entries.map((e, i) => [e, seqs[i]!])), owners: new WeakMap<object, string>() };
		const steps = planTranscript(mode, entries, { saved });
		const held = new Set(
			adjacent?.newer
				? callsAwaitingLaterResults(steps.flatMap((step) => (step.kind === "entry" ? [step.entry] : [])))
				: [],
		);
		const calls = new SavedPageCallsBuilder(mode, chat, seqs, exceptions);
		for (const step of steps) {
			const key =
				step.kind !== "cost"
					? saved.owners.get(step.entry)
					: step.seq === undefined
						? undefined
						: `${step.seq}:cost`;
			if (step.kind === "entry" && step.entry.kind === "tool" && held.has(step.entry)) {
				scratch.addChild(calls.hold(step.entry, key));
				continue;
			}
			const index = scratch.children.length;
			const kept = key && (record ? exceptions.peek(key) : exceptions.get(key));
			if (kept) for (const component of kept) scratch.addChild(component);
			else addTranscriptStep(mode, step, false, true);
			const drawn = scratch.children.slice(index);
			if (key) {
				const [seq, block] = key.split(":");
				const position = {
					seq: Number(seq),
					block: block === "entry" ? 0 : block === "cost" ? COST_BLOCK : Number(block),
				};
				if (record)
					for (let part = 0; part < drawn.length; part++)
						record.set(drawn[part]!, { source: exceptions.source, ...position, part });
				else if (!kept) exceptions.remember(key, drawn, position);
			}
			if (key) followChosenExpansion(mode, exceptions, key, drawn);
			if (step.kind !== "entry") continue;
			if (key && step.entry.kind === "tool" && isResultWithoutCall(step.entry))
				calls.drewResult(step.entry, drawn, key);
			calls.drew(step.entry);
		}
		const page = scratch.children.slice(1);
		if (page.length > 0 && !record) page.unshift(calls.finish(mode.sessionManager, adjacent));
		return page;
	} finally {
		mode.chatContainer = chat;
	}
}

function buildHistoryInSlices(mode: InteractiveModeBase, history: readonly TranscriptStep[], end: Component): void {
	const chat = mode.chatContainer;
	let remaining = history.length;
	let before = end;
	const build = (budgetMs: number, maxSteps: number): boolean => {
		const at = chat.children.indexOf(before);
		if (at < 0 || remaining === 0) return false;
		const deadline = performance.now() + budgetMs;
		const built: Component[][] = [];
		const preceding = new Spacer(0);
		const scratch = new Container();
		mode.chatContainer = scratch;
		try {
			for (let steps = 0; remaining > 0 && steps < maxSteps; steps++) {
				scratch.children = [preceding];
				addTranscriptStep(mode, history[--remaining]!, false);
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
		preserveViewportInput?: boolean;
		suppressCompactionBoundary?: VerbatimCompactionResult;
		/** @internal The rows a reader parked above the end sees, taken out of the chat this replaces. */
		parked?: ParkedViewport;
	} = {},
): void {
	if (!options.preserveViewportInput && !options.parked) this.resetTranscriptSelection();
	this.pendingTools.clear();
	const pendingEchoes = takeDeferredEchoes(this);
	if (options.updateFooter) {
		this.footer.invalidate();
		this.updateEditorBorderColor();
	}
	const parked = options.parked;
	installSavedChatHistory(this, sessionEntries, savedChatComponents, parked?.parked);
	noteShownContext(this, sessionEntries);
	const steps = planTranscript(this, sessionEntries, options);
	let tailStart = this.ui.mode === "fullscreen" ? Math.max(0, steps.length - TAIL_STEPS) : 0;
	if (parked?.keys.size) {
		// The reader's kept rows are drawn now, in place, so the first frame shows them where they were.
		const adopted = steps.findIndex((step) => {
			const key = stepKey(step);
			return key !== undefined && parked.keys.has(key);
		});
		if (adopted >= 0) {
			tailStart = Math.min(tailStart, adopted);
			adoptions.set(this, { ...parked, inserted: false });
		}
	}
	if (tailStart > 0) {
		const historyEnd = new Spacer(0);
		this.chatContainer.addChild(historyEnd);
		buildHistoryInSlices(this, steps.slice(0, tailStart), historyEnd);
	}
	try {
		for (let index = tailStart; index < steps.length; index++) addTranscriptStep(this, steps[index]!);
	} finally {
		const adoption = adoptions.get(this);
		adoptions.delete(this);
		const unused = [...(adoption?.inserted ? [] : (parked?.adopted ?? [])), ...(parked?.parked?.rows ?? [])].filter(
			(row) => !this.chatContainer.children.includes(row),
		);
		disposeRemoteRenderers(unused);
	}
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
const nativeHistoryHints = new WeakMap<Container, Component>();

/** The terminal owns scrollback in regular mode: a resumed window cannot paint rows it never printed. */
function showNativeHistoryHint(mode: InteractiveModeBase): void {
	const notices = mode.startupNoticesContainer;
	const previous = nativeHistoryHints.get(notices);
	if (mode.ui.mode !== "regular" || !mode.sessionManager.getOmittedHistoryTotals?.()?.totalMessages) {
		if (previous) notices.removeChild(previous);
		return;
	}
	const hint =
		previous ??
		new ThemedText(
			() =>
				theme.fg(
					"dim",
					"Older messages: use terminal scrollback, ask the agent to read history://, or use /export.",
				),
			1,
			0,
		);
	if (!previous) nativeHistoryHints.set(notices, hint);
	if (!notices.children.includes(hint)) notices.addChild(hint);
}

export function clearChatForRerender(mode: InteractiveModeBase): void {
	releaseSavedChatHistory(mode);
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
	showNativeHistoryHint(this);
	const entries = buildContextEntries(this.sessionManager.getEntries(), this.sessionManager.getLeafId());
	this.renderSessionEntries(entries, { updateFooter: true, populateHistory: true });
	renderProjectTrustWarningIfNeeded(this);
	refreshInteractiveTasks(this);
	if (previousSessionId === sessionId) {
		renderer.newMessages?.replaced(countChatMessages(this.chatContainer));
	}
};

/**
 * Says that the session's project is untrusted, for as long as it is. It reads the trust when the chat paints: an
 * isolated interactive host learns its engine's decision after the chat was drawn, and a decision that is still to be
 * made is neither trusted nor untrusted.
 */
class ProjectTrustWarning implements Component {
	private readonly visible: () => boolean;
	private readonly lines: Component[];

	constructor(visible: () => boolean, separated: boolean) {
		this.visible = visible;
		const text = new ThemedText(
			() =>
				theme.fg(
					"warning",
					`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart ${APP_NAME}.`,
				),
			1,
			0,
		);
		this.lines = separated ? [new Spacer(1), text] : [text];
	}

	render(width: number): string[] {
		return this.visible() ? this.lines.flatMap((line) => line.render(width)) : [];
	}

	invalidate(): void {
		for (const line of this.lines) line.invalidate();
	}
}

/** The chat slot of the warning a mode last drew, while the chat still holds it. */
const projectTrustWarningSlots = new WeakMap<InteractiveModeBase, Container>();

function projectTrustWarningShows(mode: InteractiveModeBase, requiresTrust: boolean): boolean {
	return projectTrustWarningVisible({
		trusted: mode.settingsManager.isProjectTrusted(),
		pending: mode.runtimeHost?.isProjectTrustPending?.() === true,
		requiresTrust,
	});
}

/**
 * Adds the warning at the end of the chat when the session's project is untrusted and has resources that need trust.
 * A trusted session, or one whose decision is still to be made, gets none here: refreshProjectTrustWarning adds it if
 * the decision turns out untrusted.
 */
function renderProjectTrustWarningIfNeeded(mode: InteractiveModeBase): void {
	if (!projectTrustWarningShows(mode, true)) return;
	const chat = mode.chatContainer;
	const separated = chat.children.length > 0;
	const slot = new Container();
	chat.addChild(slot);
	projectTrustWarningSlots.set(mode, slot);
	const settle = (requiresTrust: boolean) => {
		if (!chat.children.includes(slot)) return;
		if (!requiresTrust) {
			chat.removeChild(slot);
			return;
		}
		slot.addChild(new ProjectTrustWarning(() => projectTrustWarningShows(mode, true), separated));
		mode.ui.requestRender();
	};
	void hasTrustRequiringProjectResourcesAsync(mode.sessionManager.getCwd()).then(settle, () => settle(false));
}

InteractiveModeBase.prototype.appendProjectTrustWarning = function (this: InteractiveModeBase): void {
	renderProjectTrustWarningIfNeeded(this);
};

InteractiveModeBase.prototype.refreshProjectTrustWarning = function (this: InteractiveModeBase): void {
	// Before the chat shows this session, its own drawing adds the warning.
	if (renderedSessionIds.get(this) !== this.sessionManager.getSessionId()) return;
	const slot = projectTrustWarningSlots.get(this);
	if (slot && this.chatContainer.children.includes(slot)) {
		// The warning in the chat reads the trust when it paints.
		this.chatContainer.invalidate();
	} else {
		renderProjectTrustWarningIfNeeded(this);
	}
	this.ui.requestRender();
};

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
					await preloadChangelog(getChangelogPath());
					this.showStartupNoticesIfNeeded(this.startupNoticesContainer);
					if (this.deferredStartupPending) {
						await this.ensureDeferredStartupComplete();
					}
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
		preserveViewportInput?: boolean;
	} = {},
): void {
	// Generic rebuilds keep the same session: pending fd/rg callbacks still own
	// this transcript. Full session replacements invalidate their generation in
	// renderCurrentSessionState() before rebuilding the replacement transcript.
	const renderer = this.ui as AltScreenMessageCounterHost;
	this.managedToolStatusStarted = false;
	this.lastStatusSpacer = undefined;
	this.lastStatusText = undefined;
	const entries = buildContextEntries(this.sessionManager.getEntries(), this.sessionManager.getLeafId());
	// Count what arrived unread before the rows the reader sees leave the chat with the rest.
	if (this.chatContainer.children.length > 0) {
		renderer.newMessages?.observe(renderer.isFollowingOutput !== false, countChatMessages(this.chatContainer));
	}
	// A compaction while the reader is above the end keeps what they see, their selection and their place.
	const parked = parkViewport(this, entries);
	holdCompactionWidgets(this, entries, parked);
	clearChatForRerender(this);
	if (options.resetStartupDisclosure) this.resourceDisclosureContainer.clear();
	this.attachStartupNoticesContainer();
	showNativeHistoryHint(this);
	this.renderSessionEntries(entries, parked ? { ...options, parked } : options);
	// A caller that suppresses the persisted boundary appends the live one, then the warning (appendProjectTrustWarning).
	if (!options.suppressCompactionBoundary) renderProjectTrustWarningIfNeeded(this);
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
