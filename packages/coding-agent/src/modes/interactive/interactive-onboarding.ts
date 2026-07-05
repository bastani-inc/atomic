import { InteractiveModeBase } from "./interactive-mode-base.ts";

export const ONBOARDING_COPY = [
  "Atomic is a verifiable coding agent runtime for building and running",
  "agent workflows you can feel confident in.",
  "Use it to implement tickets, research a codebase, design a UI,",
  "or build and run your own loops.",
  "Run dynamic workflows and save the ones you like for future use.",
  "Start building a verifiable software factory.",
  "",
  "Type a message or slash command below to continue normally.",
  "If you have not connected a provider yet, run `/login` first.",
  "Run `/atomic` for guides or `/workflow list` to see built-in workflows.",
].join("\n");

InteractiveModeBase.prototype.initializeFirstRunOnboardingMarkers = function(this: InteractiveModeBase): void {
  if (
    this.session.state.messages.length !== 0
    || this.settingsManager.getFirstRunOnboardingStartedVersion()
    || this.settingsManager.getOnboardedVersion()
  ) {
    return;
  }

  if (this.hadLastChangelogVersionAtStartup) {
    this.settingsManager.setOnboardedVersion(this.version);
  } else {
    this.settingsManager.setFirstRunOnboardingStartedVersion(this.version);
  }
};

InteractiveModeBase.prototype.isFirstRunOnboardingEligible = function(this: InteractiveModeBase): boolean {
  const hasInitialInput = Boolean(this.options.initialMessage) || Boolean(this.options.initialMessages?.length);
  return this.session.state.messages.length === 0
    && !hasInitialInput
    && !this.settingsManager.getOnboardedVersion()
    && Boolean(this.settingsManager.getFirstRunOnboardingStartedVersion());
};

InteractiveModeBase.prototype.clearFirstRunOnboardingUi = function(this: InteractiveModeBase): void {
  this.firstRunNoticeVisible = false;
  if (this.firstRunOnboardingNoticeComponents.length > 0) {
    this.chatContainer.children = this.chatContainer.children.filter(
      (child) => !this.firstRunOnboardingNoticeComponents.includes(child),
    );
    this.firstRunOnboardingNoticeComponents = [];
  }
  this.ui.requestRender();
};
