import { randomUUID } from "node:crypto";
import type { AgentSessionInternalSurface } from "../../core/agent-session-methods.ts";
import { tryExecuteSessionSlashCommand } from "../../core/agent-session-prompt.ts";
import { yieldToEventLoop } from "../../utils/event-loop.ts";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import { takeSubmittedExtensionCommandHold } from "./extension-command-hold.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { restoreFailedSubmissionDraft, restoreRefusedSubmission } from "./interactive-prompt-restore.ts";
import {
	followStartedRunEcho,
	noteDeferredEchoOrigin,
	noteDeferredEchoShownBaseline,
	type StartedRunEchoFollower,
	taggedUserMessagesShownCount,
} from "./interactive-render-chat.ts";
import { type InteractiveSubmission, toInteractiveSubmission } from "./interactive-submission.ts";
import { beginPostStartupPromptTurn } from "./post-startup-highlight.ts";

InteractiveModeBase.prototype.runUserPromptTurn = async function (
	this: InteractiveModeBase,
	input: InteractiveSubmission | string,
): Promise<void> {
	const endPostStartupPromptTurn = beginPostStartupPromptTurn(this);
	const { text: userInput, draft, echo: submittedEcho } = toInteractiveSubmission(input);
	const originSendId = randomUUID();
	if (submittedEcho !== undefined) noteDeferredEchoOrigin(this, userInput, submittedEcho, originSendId);
	// An extension command's hold of the prompt's slot ends with the turn at the latest.
	const extensionCommandHold = typeof input === "string" ? undefined : takeSubmittedExtensionCommandHold(input);
	const turn = this.promptTurn ?? { dispatched: false };
	this.promptTurn = turn;
	const settleDispatch = (): void => {
		if (turn.dispatched) return;
		turn.dispatched = true;
		if (this.compactionQueuedMessages.length > 0 && !this.compactionActive) {
			void this.flushCompactionQueue({ afterPrompt: true });
		}
	};
	// Show the working spinner immediately on submit so there is no visible gap
	// while prompt preflight runs before the agent emits `agent_start`. The
	// ownership flag keeps deferred startup from tearing it down mid-way.
	if (!this.session.isStreaming) {
		this.workingRunMeter.stop();
	}
	this.promptTurnWorkingLoaderActive = true;
	this.showWorkingLoaderNow();
	const deferredStartupNeedsPromptGate = this.deferredStartupPending || this.deferredStartupPromise !== undefined;
	// Yield once so the freshly-mounted spinner paints before synchronous
	// preflight work can block the event loop.
	await yieldToEventLoop();
	// A submission that never reaches an agent turn stays user-owned, so track
	// whether the turn actually started before deciding to restore the draft.
	let turnStarted = false;
	let refused = false;
	// The session answered that it started a run for this prompt, and the prompt call returned.
	let runStarted = false;
	const unsubscribeTurnStart = this.session.subscribe((event) => {
		if (event.type === "agent_start") turnStarted = true;
	});
	let echo: StartedRunEchoFollower | undefined;
	try {
		if (deferredStartupNeedsPromptGate) {
			await this.ensureDeferredStartupComplete();
		}
		const handledSlashCommand =
			!(this.runtimeHost instanceof IsolatedInteractiveRuntime) &&
			(await tryExecuteSessionSlashCommand(
				this.session as typeof this.session & Pick<AgentSessionInternalSurface, "_tryExecuteExtensionCommand">,
				userInput,
			));
		if (!handledSlashCommand) {
			if (!(this.runtimeHost instanceof IsolatedInteractiveRuntime) || !this.isExtensionCommand(userInput)) {
				await this.session.resumeQueuedMessages();
			}
			const shownBefore = this.userMessagesShownBySession;
			if (submittedEcho !== undefined)
				noteDeferredEchoShownBaseline(this, submittedEcho, taggedUserMessagesShownCount(this));
			const startedEcho = followStartedRunEcho(this, userInput, {
				sendShowsWorkingRow: true,
				echo: submittedEcho,
				originSendId,
			});
			echo = startedEcho;
			let started = false;
			await this.session.prompt(userInput, {
				streamingBehavior: "steer",
				originSendId,
				preflightResult: (success, disposition) => {
					refused = !success;
					// A queued message is listed as queued, and one an `input` hook handled is not sent at all (#4285).
					if (success && (disposition === "queued" || disposition === "handled"))
						this.discardDeferredRenderedUserInput(userInput, submittedEcho);
					if (success && disposition === "started") {
						started = true;
						this.expectStartedUserInput(userInput, shownBefore, submittedEcho);
					}
					// The run's own events decide its echo (#5135), however they and this answer are ordered.
					if (success) startedEcho.answer(disposition === "started");
					if (success) settleDispatch();
				},
			});
			runStarted = started;
		}
	} catch (error) {
		echo?.close();
		this.discardDeferredRenderedUserInput(userInput, submittedEcho);
		if (refused && !turnStarted) {
			restoreRefusedSubmission(this, error, draft);
			return;
		}
		const restored = restoreFailedSubmissionDraft(this, error, draft, { turnStarted });
		// A restored draft already tells the user the submission did not land, and
		// the recovery status explains why. A red transport error beside it is noise.
		if (!restored) {
			this.showError(error instanceof Error ? error.message : "Unknown error occurred");
		}
	} finally {
		extensionCommandHold?.settle();
		unsubscribeTurnStart();
		echo?.close();
		if (this.promptTurn === turn) this.promptTurn = undefined;
		if (!refused || turnStarted) settleDispatch();
		this.promptTurnWorkingLoaderActive = false;
		// A submission that resolves without starting an agent turn (e.g. a
		// handled slash command) never emits `agent_end`, so clear the pre-shown
		// spinner here when idle to avoid a lingering indicator. A run the session
		// answered as started, whose events have not arrived yet, takes the spinner
		// over at its `agent_start` and ends it at its `agent_end`.
		if (!turnStarted && !runStarted && !this.session.isStreaming && this.workingRunMeter.snapshot() === undefined) {
			this.workingRunMeter.stop();
			this.stopWorkingLoader();
		}
		endPostStartupPromptTurn();
	}
};
