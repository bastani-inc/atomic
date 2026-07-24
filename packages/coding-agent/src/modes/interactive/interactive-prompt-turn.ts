import type { AgentSessionInternalSurface } from "../../core/agent-session-methods.ts";
import { tryExecuteSessionSlashCommand } from "../../core/agent-session-prompt.ts";
import { yieldToEventLoop } from "../../utils/event-loop.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";

InteractiveModeBase.prototype.runUserPromptTurn = async function(
  this: InteractiveModeBase,
  userInput: string,
): Promise<void> {
  // Show the working spinner immediately on submit so there is no visible gap
  // while prompt preflight runs before the agent emits `agent_start`.
  this.showWorkingLoaderNow();
  const deferredStartupNeedsPromptGate =
    this.deferredStartupPending || this.deferredStartupPromise !== undefined;
  if (deferredStartupNeedsPromptGate) {
    this.deferLoadedResourcesDisclosureUntilAgentEnd = true;
  }
  // Yield once so the freshly-mounted spinner paints before synchronous
  // preflight work can block the event loop.
  await yieldToEventLoop();
  try {
    if (deferredStartupNeedsPromptGate) {
      await this.ensureDeferredStartupComplete();
    }
    // The public facade omits prototype-installed command methods, but the
    // interactive runtime always owns the concrete AgentSession dispatcher.
    const handledSlashCommand = await tryExecuteSessionSlashCommand(
      this.session as typeof this.session & Pick<
        AgentSessionInternalSurface,
        "_tryExecuteBuiltinSlashCommand" | "_tryExecuteExtensionCommand"
      >,
      userInput,
    );
    if (!handledSlashCommand) {
      await this.session.resumeQueuedMessages();
      await this.session.prompt(userInput);
    }
    this.deferLoadedResourcesDisclosureUntilAgentEnd = false;
    if (this.pendingLoadedResourcesDisclosure) {
      this.pendingLoadedResourcesDisclosure = false;
      this.showLoadedResources({
        force: true,
        showDiagnosticsWhenQuiet: true,
        targetContainer: this.startupNoticesContainer,
      });
      void this.maybeWarnAboutAnthropicSubscriptionAuth(
        undefined,
        this.startupNoticesContainer,
      );
      this.showStartupNoticesIfNeeded(this.startupNoticesContainer);
    }
  } catch (error) {
    this.deferLoadedResourcesDisclosureUntilAgentEnd = false;
    this.discardDeferredRenderedUserInput(userInput);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    this.showError(errorMessage);
  } finally {
    // A submission that resolves without starting an agent turn (e.g. a
    // handled slash command) never emits `agent_end`, so clear the pre-shown
    // spinner here when idle to avoid a lingering indicator.
    if (!this.session.isStreaming) {
      this.stopWorkingLoader();
    }
  }
};
