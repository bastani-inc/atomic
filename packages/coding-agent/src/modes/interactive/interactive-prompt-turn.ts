import type { AgentSessionInternalSurface } from "../../core/agent-session-methods.ts";
import { tryExecuteSessionSlashCommand } from "../../core/agent-session-prompt.ts";
import { yieldToEventLoop } from "../../utils/event-loop.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { restoreFailedSubmissionDraft } from "./interactive-prompt-restore.ts";
import { type InteractiveSubmission, toInteractiveSubmission } from "./interactive-submission.ts";

InteractiveModeBase.prototype.runUserPromptTurn = async function (
	this: InteractiveModeBase,
	input: InteractiveSubmission | string,
): Promise<void> {
	const { text: userInput, draft } = toInteractiveSubmission(input);
	// Show the working spinner immediately on submit so there is no visible gap
	// while prompt preflight runs before the agent emits `agent_start`. The
	// ownership flag keeps deferred startup from tearing it down mid-way.
	this.promptTurnWorkingLoaderActive = true;
	this.showWorkingLoaderNow();
	const deferredStartupNeedsPromptGate = this.deferredStartupPending || this.deferredStartupPromise !== undefined;
	// Yield once so the freshly-mounted spinner paints before synchronous
	// preflight work can block the event loop.
	await yieldToEventLoop();
	// A submission that never reaches an agent turn stays user-owned, so track
	// whether the turn actually started before deciding to restore the draft.
	let turnStarted = false;
	const unsubscribeTurnStart = this.session.subscribe((event) => {
		if (event.type === "agent_start") turnStarted = true;
	});
	try {
		if (deferredStartupNeedsPromptGate) {
			await this.ensureDeferredStartupComplete();
		}
		// The public facade omits prototype-installed command methods, but the
		// interactive runtime always owns the concrete AgentSession dispatcher.
		const handledSlashCommand = await tryExecuteSessionSlashCommand(
			this.session as typeof this.session &
				Pick<AgentSessionInternalSurface, "_tryExecuteBuiltinSlashCommand" | "_tryExecuteExtensionCommand">,
			userInput,
		);
		if (!handledSlashCommand) {
			await this.session.resumeQueuedMessages();
			await this.session.prompt(userInput);
		}
	} catch (error) {
		this.discardDeferredRenderedUserInput(userInput);
		const restored = restoreFailedSubmissionDraft(this, error, draft, { turnStarted });
		// A restored draft already tells the user the submission did not land, and
		// the recovery status explains why. A red transport error beside it is noise.
		if (!restored) {
			this.showError(error instanceof Error ? error.message : "Unknown error occurred");
		}
	} finally {
		unsubscribeTurnStart();
		this.promptTurnWorkingLoaderActive = false;
		// A submission that resolves without starting an agent turn (e.g. a
		// handled slash command) never emits `agent_end`, so clear the pre-shown
		// spinner here when idle to avoid a lingering indicator.
		if (!this.session.isStreaming) {
			this.stopWorkingLoader();
		}
	}
};
