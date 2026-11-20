import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { ImageContent, TextContent } from "@bastani/atomic-ai/compat";
import { processImage } from "../utils/image-process.ts";
import { AgentSessionBusyError } from "./agent-session-busy-error.ts";
import { holdsTurnsForDetachedResults } from "./agent-session-detached-tools.ts";
import {
	earlierHeldInputs,
	finishHeldInput,
	type HeldInput,
	hasHeldInput,
	registerHeldInput,
	stopWaiting,
} from "./agent-session-held-input.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { clearPersistenceFailure } from "./agent-session-persistence-failures.ts";
import {
	isProtectedStreamingCustomMessage,
	queueHeldCustomMessages,
} from "./agent-session-persistent-custom-messages.ts";
import { retryIsCurrent } from "./agent-session-retry.ts";
import { settleTurnPause } from "./agent-session-turn-pause.ts";
import type {
	PromptDisposition,
	PromptOptions,
	QueuedInputDisposition,
	UserMessageWithRawText,
} from "./agent-session-types.js";
import { formatNoModelSelectedMessage, formatUnresolvedModelMessage } from "./auth-guidance.ts";
import { runCallback } from "./callback-activity.ts";
import type { CustomMessage } from "./messages.ts";
import { expandPromptTemplate } from "./prompt-templates.ts";
import {
	isInsideInputHook,
	type QueuedInputAdmission,
	reserveQueuedInputAdmission,
	runInputHook,
	UNORDERED_ADMISSION,
} from "./queued-input-admission.ts";
import { currentResourceAdmission, withOwnResourceAdmission } from "./resource-admission-scope.ts";
import {
	assertSessionOpen,
	sessionGenerationClosing,
	sessionLifetime,
	sessionQuitSignal,
	trackSessionWork,
} from "./session-lifecycle-work.ts";
import { expandSkillCommand, getSkillCatalog } from "./skill-catalog.ts";
import { parseSlashCommand } from "./slash-commands.js";
import { ToolDetachmentError } from "./tool-detachment-errors.ts";

const customPreparations = new WeakMap<AgentSession, Promise<void>>();
const openRuns = new WeakMap<AgentSession, number>();
const messageAdmissionHolds = new WeakMap<AgentSession, Set<object>>();

function holdSubagentMessageAdmission(session: AgentSession): () => void {
	if (session._subagentMessageAdmission === undefined) return () => {};
	const holds = messageAdmissionHolds.get(session) ?? new Set<object>();
	messageAdmissionHolds.set(session, holds);
	const hold = {};
	holds.add(hold);
	return () => {
		if (!holds.delete(hold)) return;
		if (holds.size === 0) messageAdmissionHolds.delete(session);
	};
}

function openRun(session: AgentSession): void {
	openRuns.set(session, (openRuns.get(session) ?? 0) + 1);
}

/** Whether a run is open: its turn streams or waits to retry, or it has not settled after its turn. */
export function hasOpenRun(session: AgentSession): boolean {
	return openRuns.has(session);
}

function closeRun(session: AgentSession): void {
	const open = openRuns.get(session) ?? 0;
	if (open > 1) openRuns.set(session, open - 1);
	else openRuns.delete(session);
}

export async function waitForCustomMessagePreparation(session: AgentSession): Promise<void> {
	await customPreparations.get(session);
}

function assistantHasRecoverableOutput(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	return message.content.some((block) => {
		if (block.type === "text") return block.text.length > 0;
		if (block.type === "thinking") return block.thinking.length > 0;
		return true;
	});
}

/** Dispatch registered extension slash commands without changing the raw queue pause gate. */
export async function tryExecuteSessionSlashCommand(
	session: Pick<AgentSession, "_tryExecuteExtensionCommand">,
	text: string,
): Promise<boolean> {
	if (!text.startsWith("/")) return false;
	return session._tryExecuteExtensionCommand(text);
}

async function _normalizePromptImages(
	this: AgentSession,
	images: ImageContent[] | undefined,
): Promise<{ images: ImageContent[]; hints: string[] }> {
	if (!images) return { images: [], hints: [] };

	const normalizedImages: ImageContent[] = [];
	const hints: string[] = [];
	for (const image of images) {
		const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			resizeOptions: this.model?.inputLimits?.images?.resize,
		});
		if (!processed.ok) {
			hints.push(processed.message);
			continue;
		}
		normalizedImages.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		hints.push(...processed.hints);
	}
	return { images: normalizedImages, hints };
}

/** Queued user messages whose images are normalized when they are delivered. */
const queuedMessagesWithImages = new WeakSet<AgentMessage>();

/** Marks a queued steering or follow-up message whose images are normalized when it is delivered. */
export function markQueuedMessageImages(message: AgentMessage): void {
	queuedMessagesWithImages.add(message);
}

/**
 * Normalizes a delivered queued message's images in place, with the same resize as idle prompts and the current
 * model's limits, before events and persistence see the message (pi #11738). Hints go after its text.
 */
export async function normalizeQueuedMessageImages(session: AgentSession, message: AgentMessage): Promise<void> {
	if (!queuedMessagesWithImages.delete(message) || message.role !== "user" || typeof message.content === "string")
		return;
	const [first, ...rest] = message.content;
	if (first?.type !== "text") return;
	const images = rest.filter((block): block is ImageContent => block.type === "image");
	const normalized = await _normalizePromptImages.call(session, images);
	const text = normalized.hints.length > 0 ? `${first.text}\n\n${normalized.hints.join("\n")}` : first.text;
	// The admitted message is matched by its text when its reply is recovered.
	if (session._admittedQueuedMessageAwaitingReply === session._getUserMessageText(message))
		session._admittedQueuedMessageAwaitingReply = text;
	if (text !== first.text) (message as UserMessageWithRawText).rawText ??= first.text;
	message.content = [{ type: "text", text }, ...rest.filter((block) => block.type !== "image"), ...normalized.images];
}

export async function prompt(this: AgentSession, text: string, options?: PromptOptions): Promise<void> {
	if (this._disposed || sessionGenerationClosing.has(this))
		throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
	if (subagentExecutionEnded(this)) throw subagentExecutionEndedError();
	if (this._isEmittingAgentSettled && !queuesDuringAgentSettled(this, options)) {
		// A run started by an agent_settled handler waits until every settled handler completes.
		deferSettledAction(this, async () => await this.prompt(text, options));
		return;
	}
	return trackSessionWork(this, () => admittedPrompt.call(this, text, options));
}

/**
 * Defer `action` until the settling run has settled. It runs under the resource admission its requester ran under,
 * not the settling run's: a turn a delivered message requests keeps the receiving session's own admission.
 */
function deferSettledAction(session: AgentSession, action: () => Promise<void>): void {
	const admission = currentResourceAdmission();
	session._deferredSettledActions.push(() => withOwnResourceAdmission(admission, action));
}

function queuesDuringAgentSettled(session: AgentSession, options: PromptOptions | undefined): boolean {
	return session._isEmittingAgentSettled && options?.streamingBehavior !== undefined && options.source !== "extension";
}

function queuesBehindOpenRun(session: AgentSession, options: PromptOptions | undefined): boolean {
	return openRuns.has(session) && options?.streamingBehavior !== undefined && options.source !== "extension";
}

function compactionSettlement(session: AgentSession): Promise<unknown> | undefined {
	const pending = [
		session._manualCompactionPromise,
		session._autoCompactionCompletion,
		session._branchSummaryCompletion,
	].filter((settlement) => settlement !== undefined);
	return pending.length === 0 ? undefined : Promise.allSettled(pending);
}

function untilSessionEnds(work: Promise<unknown>, lifetime: AbortSignal): Promise<void> {
	if (lifetime.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const finish = () => {
			lifetime.removeEventListener("abort", finish);
			resolve();
		};
		lifetime.addEventListener("abort", finish, { once: true });
		void work.then(finish, finish);
	});
}

/**
 * Hold input that reaches the session while it compacts (#4251): a turn started now would send the transcript
 * that compaction is rewriting. The input is registered on entry, so it keeps its arrival order across senders.
 * Extension commands still run at once and are never registered.
 */
function registerInputForCompaction(
	session: AgentSession,
	text: string,
	options: PromptOptions | undefined,
	expandPromptTemplates: boolean,
): HeldInput | undefined {
	if (!session.isCompacting && !hasHeldInput(session)) return undefined;
	if (expandPromptTemplates && isExtensionCommand(session, text)) return undefined;
	return registerHeldInput(
		session,
		text,
		options?.images,
		options?.streamingBehavior ?? "steer",
		!isInsideInputHook(),
	);
}

/**
 * Wait until every input held before this one has started its turn, queued, or failed, and no compaction runs,
 * or until `clearQueue()` cancels this input or the session ends.
 */
async function waitForHeldTurn(session: AgentSession, held: HeldInput, lifetime: AbortSignal): Promise<void> {
	const until = (work: Promise<unknown>) =>
		untilSessionEnds(Promise.race([work, held.cancellation.promise]), lifetime);
	const earlier = earlierHeldInputs(session, held);
	if (earlier.length > 0) await until(Promise.all(earlier.map((entry) => entry.admitted.promise)));
	for (
		let settlement = compactionSettlement(session);
		session.isCompacting && settlement !== undefined && !held.cancelled && !lifetime.aborted;
		settlement = compactionSettlement(session)
	) {
		await until(settlement);
	}
	stopWaiting(session, held);
}

async function admittedPrompt(this: AgentSession, text: string, options?: PromptOptions): Promise<void> {
	const fresh = this._activePromptCount === 0 && !this.isStreaming;
	if (fresh) {
		this._agentRunAbortRequested = false;
		// #5135: a command may save again, but what the stopped run could not save stays reported until a run starts.
		this.sessionManager.resumeAppends();
	}
	this._activePromptCount += 1;
	try {
		await promptInternal.call(this, text, options, fresh);
		const boundary = this._subagentMessageAdmission;
		if (
			!this._disposed &&
			!sessionGenerationClosing.has(this) &&
			this._activePromptCount === 1 &&
			!this.isStreaming &&
			!this._queuedMessagesPaused &&
			(this._priorityInterruptPending || boundary?.hasMessageDeliveries())
		) {
			// A command/input hook may consume the original prompt during preflight.
			// Its owner still owes independently admitted priority input a reply; drain
			// that input without replaying preflight or starting another task prompt.
			await this._continueQueuedAgentMessages();
			if (this._subagentMessageAdmission) await settleSubagentMessages(this);
		}
	} finally {
		this._activePromptCount -= 1;
		if (this._activePromptCount === 0) this._subagentPolicy?.onTurnDrained?.();
	}
}

function isSessionClosed(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "SessionClosed";
}

function isExtensionCommand(session: AgentSession, text: string): boolean {
	if (!text.startsWith("/")) return false;
	const commandName = parseSlashCommand(text).name;
	return session._extensionRunner?.getCommand(commandName) !== undefined;
}

/** Extension commands and extension-delivered messages run immediately rather than in submission order. */
function reserveAdmissionForQueuedPrompt(
	session: AgentSession,
	text: string,
	options: PromptOptions | undefined,
): QueuedInputAdmission {
	const lane = options?.streamingBehavior;
	if (lane === undefined || options?.source === "extension") return UNORDERED_ADMISSION;
	if ((options?.expandPromptTemplates ?? true) && isExtensionCommand(session, text)) return UNORDERED_ADMISSION;
	return reserveQueuedInputAdmission(session, lane, sessionLifetime(session));
}

async function promptInternal(this: AgentSession, text: string, options?: PromptOptions, fresh = false): Promise<void> {
	const lifetime = sessionLifetime(this);
	const assertCurrent = () => {
		if (this._disposed || lifetime.aborted || sessionGenerationClosing.has(this))
			throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
	};
	const expandPromptTemplates = options?.expandPromptTemplates ?? true;
	let preflightReported = false;
	// Reported once: input held while the session compacts is accepted as queued before it is admitted.
	const preflightResult = (success: boolean, disposition?: PromptDisposition): void => {
		if (preflightReported) return;
		preflightReported = true;
		options?.preflightResult?.(success, disposition);
	};
	let messages: AgentMessage[] | undefined;
	let preparingRun = false;
	let fallbackGeneration: number | undefined;
	const admission = reserveAdmissionForQueuedPrompt(this, text, options);
	const held = registerInputForCompaction(this, text, options, expandPromptTemplates);
	// The sender learns at once that the session took the input, so an interactive host can stop
	// showing its own copy: the session lists the input as queued from here on.
	const acceptedWhileHeld = held !== undefined && this.isCompacting;
	if (acceptedWhileHeld) preflightResult(true, "queued");
	// Input accepted while held must not vanish if a later check fails: it stays queued for the next turn.
	let keptText = text;
	let keptImages = options?.images;
	let keptRawText: string | undefined;
	const keepAcceptedInput = async (error: unknown): Promise<void> => {
		if (!acceptedWhileHeld || held.cancelled || isSessionClosed(error)) return;
		if (this._disposed || lifetime.aborted || sessionGenerationClosing.has(this)) return;
		if (held.lane === "followUp") await this._queueFollowUp(keptText, keptImages, text, keptRawText);
		else await this._queueSteer(keptText, keptImages, text, keptRawText);
	};

	// Reserves the context through async input hooks and auth checks, so tree navigation cannot start
	// before `_isPreparingRun` marks the run (pi #9154).
	let reservedPreflight = false;
	const releasePreflight = () => {
		if (!reservedPreflight) return;
		reservedPreflight = false;
		this._promptPreflightCount--;
	};
	const releaseMessageAdmission = holdSubagentMessageAdmission(this);
	try {
		// Registered slash commands execute without releasing ordinary queued work.
		// Unknown slash input continues through the normal paused admission path.
		if (expandPromptTemplates && (await tryExecuteSessionSlashCommand(this, text))) {
			preflightResult?.(true, "handled");
			return;
		}
		assertCurrent();
		this._promptPreflightCount++;
		reservedPreflight = true;
		// Real user input is on its way in, so a summary describing the previous turn is about
		// to be stale; stop paying for it. Deliberately after the authorization boundary and
		// the slash-command path, both of which must observe an untouched session. The
		// generation discards itself via its token/anchor checks either way.
		this.abortSessionSummary();
		// A controlled pause is an admission gate, including the idle gap after
		// abort settles. Queue the payload as input hooks leave it, without
		// compaction or a provider turn; explicit resume makes it eligible again.
		if (this._queuedMessagesPaused) {
			const delivery = options?.streamingBehavior === "followUp" ? "followUp" : "steer";
			let pausedText = text;
			let pausedImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await runInputHook(() =>
					this._extensionRunner.emitInput(
						text,
						pausedImages,
						options?.source ?? "interactive",
						this.isStreaming ? options?.streamingBehavior : undefined,
					),
				);
				assertCurrent();
				if (inputResult.action === "handled") {
					preflightResult?.(true, "handled");
					return;
				}
				if (inputResult.action === "transform") {
					pausedText = inputResult.text;
					pausedImages = inputResult.images ?? pausedImages;
				}
			}
			const earlierAdmissions = admission.waitForTurn();
			if (earlierAdmissions) await earlierAdmissions;
			assertCurrent();
			// clearQueue() gave held input back to its sender, so it is not queued again.
			if (held?.cancelled) {
				preflightResult?.(true, "handled");
				return;
			}
			if (held) stopWaiting(this, held);
			if (delivery === "followUp") await this._queueFollowUp(pausedText, pausedImages, text);
			else await this._queueSteer(pausedText, pausedImages, text);
			preflightResult?.(true, "queued");
			return;
		}

		// Emit input event for extension interception (before skill/template expansion)
		let currentText = text;
		let currentImages = options?.images;
		if (this._extensionRunner.hasHandlers("input")) {
			const inputResult = await runInputHook(() =>
				this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				),
			);
			assertCurrent();
			if (inputResult.action === "handled") {
				preflightResult?.(true, "handled");
				return;
			}
			if (inputResult.action === "transform") {
				currentText = inputResult.text;
				currentImages = inputResult.images ?? currentImages;
			}
		}

		// Expand skill commands (/skill:name args) and prompt templates (/template args)
		let expandedText = currentText;
		if (expandPromptTemplates) {
			expandedText = await this._expandSkillCommand(expandedText);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		}
		keptText = expandedText;
		keptImages = currentImages;
		keptRawText = currentText;

		const earlierAdmissions = admission.waitForTurn();
		if (earlierAdmissions) await earlierAdmissions;
		assertCurrent();

		let delivery = options;
		let waited = false;
		if (held) {
			const startsTurn =
				!(this.isStreaming || this._isPreparingRun || this._isBeforeSettle) &&
				!queuesDuringAgentSettled(this, options) &&
				!queuesBehindOpenRun(this, options);
			if (earlierHeldInputs(this, held).length > 0 || (this.isCompacting && startsTurn)) {
				await waitForHeldTurn(this, held, lifetime);
				waited = true;
				// The sender found the session idle. If held input ahead of this one started a turn
				// meanwhile, this input queues behind it instead of being refused as a second prompt.
				delivery = { ...options, streamingBehavior: held.lane };
			} else {
				stopWaiting(this, held);
			}
			// clearQueue() gave the text back, so the input is not sent.
			if (held.cancelled) {
				preflightResult?.(true, "handled");
				return;
			}
			assertCurrent();
			// The queue may have been paused while the input waited. Keep it with the paused
			// input instead of letting an abort that followed the pause drop it.
			if (this._queuedMessagesPaused) {
				if (held.lane === "followUp") await this._queueFollowUp(expandedText, currentImages, text, currentText);
				else await this._queueSteer(expandedText, currentImages, text, currentText);
				preflightResult?.(true, "queued");
				return;
			}
		}

		// If streaming, queue via steer() or followUp() based on option. The run is still
		// open while agent_before_settle handlers decide on its continuation, so input sent
		// from that boundary queues for the continuation instead of starting a second run.
		const busy = this.isStreaming || this._isPreparingRun || this._isBeforeSettle;
		// Held input from every sender queues behind a run that is still open, as earlier held input
		// with a lane did, so the agent delivers all of it in arrival order.
		const settling =
			(waited && (this._isEmittingAgentSettled || openRuns.has(this))) ||
			queuesDuringAgentSettled(this, delivery) ||
			(!busy && queuesBehindOpenRun(this, delivery));
		if (busy || settling) {
			if (!delivery?.streamingBehavior) {
				throw new AgentSessionBusyError();
			}
			const queued =
				delivery.streamingBehavior === "followUp"
					? this._queueFollowUp(expandedText, currentImages, text, currentText)
					: this._queueSteer(expandedText, currentImages, text, currentText);
			if (settling) deliverQueuedInputIfIdle(this, { userSubmission: true });
			await queued;
			preflightResult?.(true, "queued");
			return;
		}
		admission.release();
		// #4226: a new prompt saves again after an earlier run stopped on a message it could not save.
		if (fresh) clearPersistenceFailure(this);

		// Close the completed fallback lifecycle before validating credentials for
		// the next idle prompt. The selected fallback remains the session model.
		if (typeof this._settleFallbackModelScope === "function") await this._settleFallbackModelScope();
		assertCurrent();
		// Flush context-only messages deferred until the previous turn's tool results were appended.
		await this._flushPendingBashMessages();
		await this._flushPendingCustomMessages();

		// Validate model
		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		// Defensive guard: a model that never resolved to a real provider
		// (for example an unknown/unresolved model id that reached this path
		// as a bare string) has no `provider`, which would otherwise fail deep
		// in auth resolution as the confusing "No API key found for undefined".
		// Surface a clear, accurate "unknown model" error instead.
		const resolvedProvider = (this.model as { provider?: unknown }).provider;
		if (typeof resolvedProvider !== "string" || resolvedProvider.length === 0) {
			throw new Error(formatUnresolvedModelMessage(this.model));
		}

		if (!this._modelRuntime.hasConfiguredAuth(this.model.provider)) {
			// A failed credential-store load (for example auth.json briefly locked
			// by a concurrent process, or invalid JSON) leaves an empty in-memory
			// credential set. That would otherwise be misreported here as
			// "No API key found" even though the credentials exist on disk. Surface
			// the real load failure instead so configured providers are not falsely
			// reported as unauthenticated (issue #1431).
			const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
			if (isOAuth && this._fallbackModels.length === 0) {
				throw new Error(
					`Authentication failed for "${this.model.provider}". ` +
						`Credentials may have expired or network is unavailable. ` +
						`Run '/login ${this.model.provider}' to re-authenticate.`,
				);
			}
			fallbackGeneration = this._retryGeneration;
			await this._selectModelWithCredentials();
			assertCurrent();
			if (!retryIsCurrent(this, fallbackGeneration)) {
				preflightResult(true, "handled");
				return;
			}
		}

		this._isPreparingRun = "user";
		releasePreflight();
		preparingRun = true;
		// Check if we need to compact before sending (catches aborted responses)
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) {
			await this._checkCompaction(lastAssistant, false);
			assertCurrent();
		}

		// Emit before_agent_start before normalizing images so extension-driven model
		// selection determines the resize profile used for the request and history.
		const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools ?? [];
		const emitted = await this._extensionRunner.emitBeforeAgentStart(
			expandedText,
			currentImages,
			this._baseSystemPromptOptions,
		);
		const result = emitted ?? { systemPromptOptions: this._baseSystemPromptOptions };
		assertCurrent();
		const nextTools = result.systemPromptOptions.selectedTools ?? selectedToolsBefore;
		const handlerEditedTools =
			nextTools.length !== selectedToolsBefore.length ||
			nextTools.some((name, index) => name !== selectedToolsBefore[index]);
		if (!handlerEditedTools && typeof this.getActiveToolNames === "function") {
			result.systemPromptOptions.selectedTools = this.getActiveToolNames();
		}

		const normalized = await _normalizePromptImages.call(this, currentImages);
		assertCurrent();
		const userText = normalized.hints.length > 0 ? `${expandedText}\n\n${normalized.hints.join("\n")}` : expandedText;

		// Build messages only after hooks and image normalization have completed.
		messages = [];
		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: userText }];
		userContent.push(...normalized.images);
		const userMessage: UserMessageWithRawText = {
			role: "user",
			content: userContent,
			...(currentText !== userText ? { rawText: currentText } : {}),
			timestamp: Date.now(),
		};
		messages.push(userMessage);

		// Inject any pending "nextTurn" messages as context alongside the user message
		for (const msg of this._pendingNextTurnMessages) {
			messages.push(msg);
		}

		// Add all custom messages from extensions
		if (result?.messages) {
			for (const msg of result.messages) {
				messages.push({
					role: "custom",
					customType: msg.customType,
					content: msg.content ?? [],
					display: msg.display,
					details: msg.details,
					timestamp: Date.now(),
				});
			}
		}
		const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
		this._runSystemPromptOptions = result.systemPromptOptions;
		if (updateMessage) messages.unshift(updateMessage);
	} catch (error) {
		if (preparingRun) this._isPreparingRun = false;
		preflightResult?.(false);
		await keepAcceptedInput(error);
		throw error;
	} finally {
		releasePreflight();
		admission.release();
		releaseMessageAdmission();
		// A started run is now preparing, so held input admitted next queues behind it.
		if (held) finishHeldInput(this, held);
	}

	assertCurrent();
	let dispatched = false;
	const reportDispatch = (disposition: PromptDisposition) => {
		if (dispatched) return;
		dispatched = true;
		preflightResult?.(true, disposition);
	};
	const turn = this._runAgentPrompt(messages, undefined, reportDispatch, true, undefined, fallbackGeneration);
	try {
		await turn;
	} catch (error) {
		if (!dispatched) {
			dispatched = true;
			preflightResult?.(false);
			await keepAcceptedInput(error);
		}
		throw error;
	}
}

export async function _runAgentPrompt(
	this: AgentSession,
	messages: AgentMessage | AgentMessage[],
	promptStarted?: () => void,
	reportDispatch?: (disposition: PromptDisposition) => void,
	prepared = false,
	customStarter?: CustomMessage,
	fallbackGeneration?: number,
): Promise<void> {
	const lifetime = sessionLifetime(this);
	if (this._isEmittingAgentSettled) {
		deferSettledAction(this, () =>
			this._runAgentPrompt(messages, promptStarted, reportDispatch, prepared, customStarter, fallbackGeneration),
		);
		return;
	}
	if (this._activePromptCount === 0 && !this.isStreaming) {
		this._agentRunAbortRequested = false;
		clearPersistenceFailure(this);
	}
	const startingMessages = Array.isArray(messages) ? messages : [messages];
	const customMessage = !prepared
		? (customStarter ?? startingMessages.find((message) => message.role === "custom"))
		: undefined;
	const ownsPreparation = prepared || customMessage !== undefined;
	const preparation = customMessage ? Promise.withResolvers<void>() : undefined;
	if (preparation) {
		customPreparations.set(this, preparation.promise);
		this._isPreparingRun = "custom";
	}
	const releasePreparation = () => {
		if (preparation && customPreparations.get(this) === preparation.promise) {
			customPreparations.delete(this);
			this._isPreparingRun = false;
			preparation.resolve();
		}
	};
	const releaseMessageAdmission = holdSubagentMessageAdmission(this);
	this._activePromptCount += 1;
	openRun(this);
	try {
		if (this._subagentMessageAdmission) {
			await this._subagentMessageAdmission.waitForPendingDeliveries();
			if (!this._subagentMessageAdmission.isOpen()) {
				reportDispatch?.("handled");
				return;
			}
		}
		releaseMessageAdmission();
		const pendingPriority = preparePriorityContinuation(this, true);
		if (pendingPriority) await pendingPriority;
		if (this._agentRunAbortRequested) {
			if (this.agent.state.isStreaming || this._queuedMessagesPaused) {
				reportDispatch?.("handled");
				return;
			}
			if (!this._isPreparingRun) this._agentRunAbortRequested = false;
		}
		// An explicit stop may win during input preflight or priority preparation.
		// Preserve the prepared input without opening a native turn past that gate.
		if (this._queuedMessagesPaused) {
			const items = Array.isArray(messages) ? messages : [messages];
			for (const message of items) this._queueAgentMessage(message, "steer");
			reportDispatch?.("queued");
			return;
		}
		// A delivery that starts a turn now would move the transcript past a detached call that has no result yet
		// (#4580). It joins the turn the hand-back continues, as input does for a paused queue.
		if (!prepared && holdsTurnsForDetachedResults(this)) {
			const items = Array.isArray(messages) ? messages : [messages];
			await holdForDetachedResults(this, items);
			return;
		}
		if (customMessage?.role === "custom") {
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) await this._checkCompaction(lastAssistant, false);
			const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools ?? [];
			const result = await this._extensionRunner.emitBeforeAgentStart(
				"",
				undefined,
				this._baseSystemPromptOptions,
				customMessage,
			);
			const nextTools = result.systemPromptOptions.selectedTools;
			const handlerEditedTools =
				nextTools.length !== selectedToolsBefore.length ||
				nextTools.some((name, index) => name !== selectedToolsBefore[index]);
			if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolNames();
			messages = [
				...startingMessages,
				...this._pendingNextTurnMessages,
				...result.messages.map((message) => ({
					...message,
					role: "custom" as const,
					content: message.content ?? [],
					timestamp: Date.now(),
				})),
			];
			const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
			this._runSystemPromptOptions = result.systemPromptOptions;
			if (updateMessage) messages.unshift(updateMessage);
		}
		if (this._queuedMessagesPaused) {
			const items = Array.isArray(messages) ? messages : [messages];
			for (const message of items) this._queueAgentMessage(message, "steer");
			reportDispatch?.("queued");
			return;
		}
		if (ownsPreparation) {
			await this._flushPendingBashMessages();
			await this._flushPendingCustomMessages();
			const thinkingLevelWrite = this._recordThinkingLevel();
			if (thinkingLevelWrite) await thinkingLevelWrite;
			this._isPreparingRun = false;
		}
		if (this._disposed || lifetime.aborted || sessionGenerationClosing.has(this))
			throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
		if (fallbackGeneration !== undefined && !retryIsCurrent(this, fallbackGeneration)) {
			reportDispatch?.("handled");
			return;
		}
		this._pendingToolNames.clear();
		reportDispatch?.("started");
		const turn = this.agent.prompt(messages);
		releasePreparation();
		if (this.isStreaming) promptStarted?.();
		await turn;
		await this.waitForRetry();
		if (lifetime.aborted || sessionGenerationClosing.has(this)) return;
		if (
			this._agentRunAbortRequested &&
			!this._queuedMessagesPaused &&
			this._protectedStreamingCustomMessages?.some((entry) => entry.phase === "queued")
		) {
			this._agentRunAbortRequested = false;
		}
		// Abort still has to answer a queued message already in the transcript.
		// `_continueQueuedAgentMessages` skips remaining queue drains while abort
		// is requested; skipping it entirely reintroduces issue #2362.
		await this._continueQueuedAgentMessages();
		if (this._agentRunAbortRequested) return;
		await this._awaitPendingPostCompactionContinuation();
		await runBeforeSettleContinuations(this);
	} finally {
		releasePreparation();
		if (ownsPreparation && !preparation) this._isPreparingRun = false;
		this._runSystemPromptOptions = undefined;
		releaseMessageAdmission();
		await settleAgentRun(this);
	}
}

async function holdForDetachedResults(session: AgentSession, messages: AgentMessage[]): Promise<void> {
	let custom: CustomMessage[] = [];
	for (const message of messages) {
		if (message.role === "custom" && !isProtectedStreamingCustomMessage(session, message)) {
			custom.push(message);
			continue;
		}
		if (custom.length > 0) await queueHeldCustomMessages(session, custom, "steer");
		custom = [];
		session._queueAgentMessage(message, "steer");
	}
	if (custom.length > 0) await queueHeldCustomMessages(session, custom, "steer");
}

async function settleAgentRun(session: AgentSession, keepMessageAdmissionOpen = false): Promise<void> {
	session._cacheWarmer?.onAgentSettled();
	try {
		await session._agentEventQueue;
		// #4254: once the run stopped on an unsaved message, settling neither saves again nor rethrows its error.
		await session._flushPendingCustomMessages(true);
	} finally {
		// A failed event or flush must still close and settle the run; otherwise the open-run
		// marker and active prompt count leak and later interactive messages stay queued forever.
		await finishAgentRun(session, keepMessageAdmissionOpen);
	}
}

async function finishAgentRun(session: AgentSession, keepMessageAdmissionOpen = false): Promise<void> {
	closeRun(session);
	try {
		session._isEmittingAgentSettled = true;
		try {
			const aborted = session._agentRunAbortRequested === true;
			if (typeof session._extensionRunner?.emit === "function") {
				await session._extensionRunner.emit({ type: "agent_settled", aborted });
			}
			session._emit?.({ type: "agent_settled", aborted });
		} finally {
			session._isEmittingAgentSettled = false;
		}
		if (session._subagentMessageAdmission) await settleSubagentMessages(session, keepMessageAdmissionOpen);
	} finally {
		session._abortPreparedRunAtStart = false;
		session._activePromptCount -= 1;
		// Runs deferred by agent_settled handlers start only after every settled handler completed.
		// Guarded because prompt-handshake suites drive this function on a synthetic session.
		const deferred = session._deferredSettledActions?.splice(0) ?? [];
		const releaseMessageAdmission = deferred.length > 0 ? holdSubagentMessageAdmission(session) : () => {};
		try {
			for (const [index, action] of deferred.entries()) {
				if (index === deferred.length - 1) releaseMessageAdmission();
				await action();
			}
		} finally {
			releaseMessageAdmission();
			if (session._activePromptCount === 0) session._subagentPolicy?.onTurnDrained?.();
		}
	}
}

/**
 * Give `agent_before_settle` handlers a chance to append entries and request one explicit
 * continuation before the run settles. Each continuation is followed by the same queued
 * and post-compaction drains as the initial run, then the boundary is offered again.
 */
async function runBeforeSettleContinuations(session: AgentSession): Promise<void> {
	// Guarded because prompt-handshake suites drive this function on a synthetic session.
	if (typeof session._extensionRunner?.hasHandlers !== "function") return;
	if (typeof session._runBeforeSettleBoundary !== "function") return;
	while (!session._agentRunAbortRequested) {
		await session._agentEventQueue?.catch(() => {});
		// #4226: a run that could not save a message is not continued.
		if (session._persistenceFailure !== undefined) return;
		if (!(await session._runBeforeSettleBoundary())) return;
		// An explicit stop or a paused queue keeps the requested continuation pending.
		if (session._agentRunAbortRequested || session._queuedMessagesPaused || session._stopAfterTurnBlockedContinuation)
			return;
		await session._runAgentContinue();
		if (session._agentRunAbortRequested) return;
		await session._awaitPendingPostCompactionContinuation();
	}
}

async function settleSubagentMessages(session: AgentSession, keepMessageAdmissionOpen = false): Promise<void> {
	const admission = session._subagentMessageAdmission!;
	// A host-requested stop is terminal for a child, like cancellation. Retain
	// protected input for persistence without restarting work or spinning on it.
	if (session._stopAfterTurnBlockedContinuation) session.pauseQueuedMessages();
	// Keep receiving while admitted input is answered. Seal synchronously only
	// after both producer commits and native continuations have drained.
	do {
		await admission.waitForPendingDeliveries();
		await session._continueQueuedAgentMessages();
		if (session._stopAfterTurnBlockedContinuation) session.pauseQueuedMessages();
	} while (
		admission.hasPendingDeliveries() ||
		// #4226: a child that could not save a message stops; its queued input waits for its next prompt.
		(!session._queuedMessagesPaused && session._persistenceFailure === undefined && session.agent.hasQueuedMessages())
	);
	// #5224: a turn the user interrupted from the child's chat is not the child's end. Its admission stays open for the
	// next message, which starts a turn; the child's execution ending seals it.
	if (session._turnInterruptedByUser || session._awaitingStartAfterInterrupt) {
		session._turnInterruptedByUser = false;
		session._awaitingStartAfterInterrupt = true;
		session._awaitingMessageAfterInterrupt = true;
		settleTurnPause(session);
		return;
	}
	// A turn that settles before the child's execution gave it its task, such as one an extension's interrupt started
	// while the task was still being sent, leaves admission open for that task.
	if (
		!keepMessageAdmissionOpen &&
		session._subagentPolicy?.taskPending?.() !== true &&
		(session._deferredSettledActions?.length ?? 0) === 0 &&
		!messageAdmissionHolds.has(session)
	)
		admission.seal();
}

function subagentExecutionEnded(session: AgentSession): boolean {
	const admission = session._subagentMessageAdmission;
	return (
		admission !== undefined &&
		!admission.isOpen() &&
		!session._queuedMessagesPaused &&
		!session._agentRunAbortRequested
	);
}

/** `code` lets a caller tell this refusal, which a finished subagent's resume can answer, from any other. */
function subagentExecutionEndedError(): Error {
	return Object.assign(new Error("Subagent execution is terminal and cannot accept messages"), {
		code: "SubagentExecutionEnded",
	});
}

function awaitsSubagentAnswer(
	session: AgentSession,
	admission: NonNullable<AgentSession["_subagentMessageAdmission"]>,
): boolean {
	if (
		session._queuedMessagesPaused ||
		session._persistenceFailure !== undefined ||
		session._stopAfterTurnBlockedContinuation ||
		session._disposed ||
		sessionGenerationClosing.has(session) ||
		sessionLifetime(session).aborted ||
		holdsTurnsForDetachedResults(session)
	)
		return false;
	return admission.hasPendingDeliveries() || session._priorityInterruptPending || session.agent.hasQueuedMessages();
}

export function _sealMessageAdmissionIfDrained(this: AgentSession): boolean {
	if (
		this.isStreaming ||
		this._activePromptCount > 0 ||
		this._pendingInterruptDeliveries > 0 ||
		messageAdmissionHolds.has(this)
	)
		return false;
	const admission = this._subagentMessageAdmission;
	if (admission === undefined || !admission.isOpen() || holdsTurnsForDetachedResults(this)) return true;
	if (awaitsSubagentAnswer(this, admission)) {
		void this._runAgentContinuation(async () => {}, "settle").catch(() => {});
		return false;
	}
	admission.seal();
	return true;
}

export async function _runAgentContinue(this: AgentSession): Promise<void> {
	if (this._agentRunAbortRequested || sessionGenerationClosing.has(this) || sessionLifetime(this).aborted) return;
	// Nothing continues past a detached call that has no result yet; the hand-back continues the turn (#4580).
	if (holdsTurnsForDetachedResults(this)) return;
	await this._continueAgentAfterCompactionCheck();
	await this.waitForRetry();
	await this._continueQueuedAgentMessages();
}

function sessionClosedForDetachedTurn(session: AgentSession): ToolDetachmentError {
	return new ToolDetachmentError("session-closed", { sessionId: session.sessionManager.getSessionId() });
}

/**
 * Run one continuation of the transcript as its own run: `beforeContinue` records what the turn continues from (the
 * results of detached tool calls), then the loop continues without a new user message, with the same queue drains
 * and settlement as a prompt. The caller has already refused a closed session, so nothing is recorded on one.
 */
export async function _runAgentContinuation(
	this: AgentSession,
	beforeContinue: () => Promise<void>,
	mode: "continue" | "recovery" | "settle" = "continue",
): Promise<void> {
	const lifetime = sessionLifetime(this);
	return trackSessionWork(this, async () => {
		if (mode !== "settle") {
			this._agentRunAbortRequested = false;
			clearPersistenceFailure(this);
			this._stopAfterTurnBlockedContinuation = false;
		}
		this._activePromptCount += 1;
		openRun(this);
		try {
			await beforeContinue();
			if (this._disposed || lifetime.aborted || sessionGenerationClosing.has(this))
				throw sessionClosedForDetachedTurn(this);
			if (mode === "recovery") await this._continueQueuedAgentMessages();
			else if (mode === "continue") await this._continueAgentAfterCompactionCheck();
			await this.waitForRetry();
			if (lifetime.aborted || sessionGenerationClosing.has(this)) return;
			await this._continueQueuedAgentMessages();
			if (this._agentRunAbortRequested) return;
			await this._awaitPendingPostCompactionContinuation();
			await runBeforeSettleContinuations(this);
		} finally {
			this._runSystemPromptOptions = undefined;
			await settleAgentRun(this, mode === "recovery");
		}
	});
}

/**
 * Restore priority input the moment the native loop can poll it again. `startsOwnTurn` marks a prompt run's own
 * start, which skips the wait when its message delivery started it and awaits it.
 */
function preparePriorityContinuation(session: AgentSession, startsOwnTurn = false): Promise<void> | undefined {
	const boundary = session._subagentMessageAdmission;
	// Explicit SDK interrupts own a native turn and the shared hold. An admitted
	// receiver's task must join that owner before checking its priority input;
	// otherwise it can settle before the interrupt finalizer restores the queue.
	if (boundary && session._pendingInterruptDeliveries > 0) {
		return session._interruptDeliveryQueue.then(() => preparePriorityContinuation(session, startsOwnTurn));
	}
	const restore = (): void => {
		if (!session._priorityInterruptPending) return;
		session._priorityInterruptPending = false;
		session._abortPreparedRunAtStart = false;
		session._restoreAndClearActiveInterruptQueueHold();
	};
	// Keep the idle prompt start synchronous unless a producer commit is still in flight. A turn its own delivery
	// started and awaits skips the wait: that delivery is the one in flight, and the rest are queued behind it.
	if (!boundary?.hasMessageDeliveries() || (startsOwnTurn && boundary.startsAwaitedTurn())) {
		restore();
		return undefined;
	}
	// A producer can enqueue an explicit SDK interrupt while this await yields.
	// Recheck its ownership before restoring the shared hold.
	return boundary.waitForMessageDeliveries().then(() => preparePriorityContinuation(session, startsOwnTurn));
}

export async function _continueQueuedAgentMessages(this: AgentSession): Promise<void> {
	const lifetime = sessionLifetime(this);
	const closing = () => this._disposed || lifetime.aborted || sessionGenerationClosing.has(this);
	// #4226: nothing continues on top of a message the last run could not save.
	const stopped = () => this._stopAfterTurnBlockedContinuation || this._persistenceFailure !== undefined;
	if (closing()) return;
	await this._agentEventQueue;
	if (closing()) return;
	await preparePriorityContinuation(this);
	if (closing()) return;

	if (!this._agentRunAbortRequested && !stopped() && !this._queuedMessagesPaused && this.agent.hasQueuedMessages()) {
		while (
			!this._agentRunAbortRequested &&
			!closing() &&
			!stopped() &&
			// Nor on a call that detached and has no result yet: its hand-back continues the turn (#4580).
			!holdsTurnsForDetachedResults(this) &&
			!this._queuedMessagesPaused &&
			this.agent.hasQueuedMessages()
		) {
			await this._continueAgentAfterCompactionCheck();
			await this.waitForRetry();
			await this._agentEventQueue;
			await preparePriorityContinuation(this);
		}
	}
	if (stopped()) return;
	if (closing()) return;

	await answerAdmittedQueuedMessage(this);
}

/**
 * Answer a queued message the agent loop already admitted into the transcript but
 * never replied to.
 *
 * `pauseQueuedMessages()` can only hold entries still sitting in the agent's own
 * steering/follow-up queues. Once the loop has polled a message it lives inside the
 * loop, is pushed into the transcript on the next iteration, and an interrupt at that
 * moment leaves it with a contentless aborted assistant reply. The message is no
 * longer queued and no longer held, so neither the pause release nor the queued
 * continuation above schedules the turn it is waiting for (issue #2362).
 *
 * This is deliberately disjoint from the paused-hold contract: a *held* message is
 * still released without starting a turn, while an *admitted* one gets its reply.
 */
async function answerAdmittedQueuedMessage(session: AgentSession): Promise<void> {
	const admitted = session._admittedQueuedMessageAwaitingReply;
	// One attempt per admission: clear before continuing so an interrupt of the
	// recovery turn ends the sequence instead of restarting it.
	session._admittedQueuedMessageAwaitingReply = undefined;
	if (admitted === undefined || session._disposed) return;
	// Esc in a subagent's chat paused it (`pauseTurn`): nothing answers until the reader's next message, which continues
	// the turn with this message already in its context. Asking the model again now would send it twice. The main chat's
	// Esc takes no turn pause, so it still answers the message.
	if (session._turnPause !== undefined) return;
	// An interrupt delivery already in flight aborts this reply and then starts its
	// own turn, so continuing concurrently would reject the caller's prompt() with
	// "Agent is already processing." Wait for it on the same boundary the resume
	// path uses, then let the checks below re-read the transcript: a delivery that
	// started its own turn changes the tail so they decline, while one that only
	// joined a paused hold leaves the admitted message still waiting for its reply.
	if (session._pendingInterruptDeliveries > 0) {
		await session._interruptDeliveryQueue;
		if (session._disposed) return;
	}

	const messages = session.agent.state.messages;
	let replyIndex = messages.length - 1;
	while (replyIndex >= 0 && messages[replyIndex]?.role === "system") replyIndex--;
	const reply = messages[replyIndex];
	// Only an interrupt that produced nothing is recoverable. A partially streamed
	// reply already answered the message; restarting it would duplicate output.
	if (reply?.role !== "assistant" || reply.stopReason !== "aborted" || assistantHasRecoverableOutput(reply)) return;
	const message = messages[replyIndex - 1];
	if (message?.role !== "user" || session._getUserMessageText(message) !== admitted) return;

	// Omit the empty aborted reply from the model projection so `continue()` resumes
	// from the admitted user message. Raw session history keeps it, as the retry paths do.
	await session._omitRecoveryAttempt(reply);
	// Publish this turn before it starts. It begins after the pause abort boundary
	// resolves, so a submission that only waited for that boundary would race it
	// and be rejected by the streaming guard while the queue is still paused.
	const recovery = Promise.resolve().then(async () => {
		await session.agent.continue();
		await session.waitForRetry();
		await session._agentEventQueue;
	});
	const settled = recovery.catch(() => undefined);
	session._admittedRecoveryTurn = settled;
	try {
		await recovery;
	} finally {
		if (session._admittedRecoveryTurn === settled) session._admittedRecoveryTurn = undefined;
	}
}

/**
 * Try to execute an extension command. Returns true if command was found and executed.
 */

export async function _tryExecuteExtensionCommand(this: AgentSession, text: string): Promise<boolean> {
	// Parse command name and args
	const { name: commandName, args } = parseSlashCommand(text);

	const quitSignal = sessionQuitSignal(this);
	const command = this._extensionRunner.getCommand(commandName, quitSignal);
	if (!command) return false;

	// Get command context from extension runner (includes session control methods)
	const ctx = this._extensionRunner.createCommandContext();

	try {
		await runCallback(
			{ kind: "extension.hook", name: `command:${commandName}`, sourcePath: command.sourceInfo.path },
			() => command.handler(args, ctx),
		);
		return true;
	} catch (err) {
		if (quitSignal.aborted) return true;
		// Emit error via extension runner
		this._extensionRunner.emitError({
			extensionPath: `command:${commandName}`,
			event: "command",
			error: err instanceof Error ? err.message : String(err),
		});
		return true;
	}
}

/**
 * Expand skill commands (/skill:name args) to their full content.
 * Returns the expanded text, or the original text if not a skill command or skill not found.
 * Emits errors via extension runner if file read fails.
 */

export function _expandSkillCommand(this: AgentSession, text: string): Promise<string> {
	return expandSkillCommand(getSkillCatalog(this.resourceLoader), text, (error) =>
		this._extensionRunner.emitError({ extensionPath: error.path, event: "skill_expansion", error: error.message }),
	);
}

async function queueUserInput(
	session: AgentSession,
	text: string,
	images: ImageContent[] | undefined,
	behavior: "steer" | "followUp",
	source: NonNullable<PromptOptions["source"]>,
	expandPromptTemplates = true,
): Promise<QueuedInputDisposition> {
	assertSessionOpen(session);
	const queue = () =>
		trackSessionWork(session, () =>
			admittedQueueUserInput(session, text, images, behavior, source, expandPromptTemplates),
		);
	const boundary = session._subagentMessageAdmission;
	if (boundary === undefined || session._queuedMessagesPaused) return queue();
	if (!boundary.isOpen()) throw subagentExecutionEndedError();
	const releaseMessageAdmission = holdSubagentMessageAdmission(session);
	try {
		return await queue();
	} finally {
		releaseMessageAdmission();
		if (session._activePromptCount === 0 && !messageAdmissionHolds.has(session))
			session._subagentPolicy?.onTurnDrained?.();
	}
}

async function admittedQueueUserInput(
	session: AgentSession,
	text: string,
	images: ImageContent[] | undefined,
	behavior: "steer" | "followUp",
	source: NonNullable<PromptOptions["source"]>,
	expandPromptTemplates: boolean,
): Promise<QueuedInputDisposition> {
	const lifetime = sessionLifetime(session);
	// Literal text is never a command, so it is never refused for looking like one.
	if (expandPromptTemplates && text.startsWith("/")) session._throwIfExtensionCommand(text);
	const admission =
		source === "extension" ? UNORDERED_ADMISSION : reserveQueuedInputAdmission(session, behavior, lifetime);
	const typed = text;
	try {
		if (session._extensionRunner?.hasHandlers("input")) {
			const result = await runInputHook(() =>
				session._extensionRunner.emitInput(text, images, source, session.isStreaming ? behavior : undefined),
			);
			assertSessionOpen(session);
			if (lifetime.aborted) throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
			if (result.action === "handled") return "handled";
			if (result.action === "transform") {
				text = result.text;
				images = result.images ?? images;
			}
		}
		const expandedText = expandPromptTemplates
			? expandPromptTemplate(await session._expandSkillCommand(text), [...session.promptTemplates])
			: text;
		const earlierAdmissions = admission.waitForTurn();
		if (earlierAdmissions) await earlierAdmissions;
		assertSessionOpen(session);
		if (lifetime.aborted) throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
		if (behavior === "steer") await session._queueSteer(expandedText, images, typed, text);
		else await session._queueFollowUp(expandedText, images, typed, text);
		if (!session.isStreaming) deliverQueuedInputIfIdle(session);
		return "queued";
	} finally {
		admission.release();
	}
}

function canContinueQueuedInput(session: AgentSession): boolean {
	return !(
		session.isStreaming ||
		session.isCompacting ||
		session._isPreparingRun ||
		session._isBeforeSettle ||
		session._isEmittingAgentSettled ||
		session._queuedMessagesPaused ||
		session._pendingInterruptDeliveries > 0 ||
		session._subagentMessageAdmission !== undefined
	);
}

function canStartQueuedInputRun(session: AgentSession): boolean {
	return (
		canContinueQueuedInput(session) &&
		!session._agentRunAbortRequested &&
		!session._stopAfterTurnBlockedContinuation &&
		!holdsTurnsForDetachedResults(session) &&
		session.agent.hasQueuedMessages() &&
		session.agent.state.messages.some((message) => message.role !== "system")
	);
}

async function runQueuedInput(session: AgentSession): Promise<void> {
	// A failed event was already reported by the run that produced it; it must not drop this delivery.
	await session._agentEventQueue.catch(() => {});
	await preparePriorityContinuation(session);
	if (!canStartQueuedInputRun(session)) return;
	const cleared = await session._compactBeforeContinuation();
	if (!canStartQueuedInputRun(session)) return;
	// After a clear the context ends with the boundary message, so the queued input is the next request's prompt.
	const run = cleared ? session.agent.promptQueuedMessages().then(() => {}) : session.agent.continue();
	if (!session.agent.state.isStreaming) return run;
	session._activePromptCount += 1;
	openRun(session);
	try {
		await run;
		await session.waitForRetry();
		await session._continueQueuedAgentMessages();
		if (session._agentRunAbortRequested) return;
		await session._awaitPendingPostCompactionContinuation();
		await runBeforeSettleContinuations(session);
	} finally {
		await settleAgentRun(session);
	}
}

/** Drain input queued after the run's last drain, deferring until an open run settles. */
export function deliverQueuedInputIfIdle(session: AgentSession, options?: { userSubmission?: boolean }): void {
	const deliver = async (): Promise<void> => {
		if (options?.userSubmission && !session.isStreaming && !session._queuedMessagesPaused) {
			session._agentRunAbortRequested = false;
		}
		await runQueuedInput(session).catch(() => {});
	};
	if (session._isEmittingAgentSettled || openRuns.has(session)) deferSettledAction(session, deliver);
	else if (session._activePromptCount === 0) void deliver();
}

/**
 * Queue a steering message while the agent is running.
 * Delivered after the current assistant turn finishes executing its tool calls,
 * before the next LLM call.
 * Expands skill commands and prompt templates. Errors on extension commands.
 * With `expandPromptTemplates: false` the text is queued literally and never refused as a command.
 * @param images Optional image attachments to include with the message
 * @throws Error if text is an extension command
 */

export async function steer(
	this: AgentSession,
	text: string,
	images?: ImageContent[],
	options?: Pick<PromptOptions, "source" | "expandPromptTemplates">,
): Promise<QueuedInputDisposition> {
	return queueUserInput(
		this,
		text,
		images,
		"steer",
		options?.source ?? "interactive",
		options?.expandPromptTemplates ?? true,
	);
}

/**
 * Queue a follow-up message to be processed after the agent finishes.
 * Delivered only when agent has no more tool calls or steering messages.
 * Expands skill commands and prompt templates. Errors on extension commands.
 * With `expandPromptTemplates: false` the text is queued literally and never refused as a command.
 * @param images Optional image attachments to include with the message
 * @throws Error if text is an extension command
 */

export async function followUp(
	this: AgentSession,
	text: string,
	images?: ImageContent[],
	options?: Pick<PromptOptions, "source" | "expandPromptTemplates">,
): Promise<QueuedInputDisposition> {
	return queueUserInput(
		this,
		text,
		images,
		"followUp",
		options?.source ?? "interactive",
		options?.expandPromptTemplates ?? true,
	);
}

/**
 * Send a user message and trigger a turn.
 *
 * By default the text is delivered literally: extension commands are not
 * dispatched and skill commands / prompt templates are not expanded. Set
 * `expandPromptTemplates: true` to dispatch a registered extension or skill
 * command (or expand a prompt template) instead of sending the raw text —
 * with that option the message may DISPATCH a command rather than be sent.
 *
 * @param content User message content (string or content array)
 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
 */
export async function sendUserMessage(
	this: AgentSession,
	content: string | (TextContent | ImageContent)[],
	options?: {
		deliverAs?: "steer" | "followUp";
		expandPromptTemplates?: boolean;
	},
): Promise<void> {
	// Normalize content to text string + optional images
	let text: string;
	let images: ImageContent[] | undefined;

	if (typeof content === "string") {
		text = content;
	} else {
		const textParts: string[] = [];
		images = [];
		for (const part of content) {
			if (part.type === "text") {
				textParts.push(part.text);
			} else {
				images.push(part);
			}
		}
		text = textParts.join("\n");
		if (images.length === 0) images = undefined;
	}

	// prompt() owns command dispatch and template expansion. Start the turn under its own resource admission.
	await withOwnResourceAdmission(this._resourceAdmission, () =>
		this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		}),
	);
}

/**
 * Clear all queued messages and return them.
 * Useful for restoring to editor when user aborts.
 * @returns Object with steering and followUp arrays
 */

export const agentSessionPromptMethods = {
	prompt,
	_runAgentPrompt,
	_runAgentContinue,
	_runAgentContinuation,
	_continueQueuedAgentMessages,
	_sealMessageAdmissionIfDrained,
	_tryExecuteExtensionCommand,
	_expandSkillCommand,
	steer,
	followUp,
	sendUserMessage,
};
