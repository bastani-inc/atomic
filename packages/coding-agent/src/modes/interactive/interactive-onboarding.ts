import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, relative } from "node:path";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import type { Api, Model } from "./interactive-mode-deps.ts";
import { isUnknownModel } from "./interactive-mode-helpers.ts";

export const ONBOARDING_PLACEHOLDER = "Paste a ticket, issue, path to a spec, or task prompt…";

export const ONBOARDING_COPY = [
  "Atomic runs agent loops as workflows you can watch and trust:",
  "implement a ticket, research a codebase, design a UI, or build",
  "your own loop.",
  "",
  "Paste a ticket description, GitHub issue, path to a spec, or task prompt to start.",
  "/chat to chat normally · /atomic for guides",
  "If you have not logged in yet, first run /login.",
].join("\n");

export const NORMAL_CHAT_TRANSITION_COPY = [
  "You're in a normal coding-agent session now. Atomic can chat and edit like other",
  "coding agents, but it also runs loops and workflows. Ask Atomic to build any loop,",
  "or run a built-in workflow like `goal` for small focused changes or `ralph` for",
  "larger, cross-cutting work. Run `/workflow list` to see built-ins, and use `/atomic`",
  "for help running or building your own loops and workflows.",
].join("\n");

export const ONBOARDING_SEED_STASHED_COPY = [
  "Task saved for after login. Run /login to connect a provider; once login finishes,",
  "Atomic will continue with your saved task.",
].join("\n");

export const ONBOARDING_SEED_REPLACED_COPY = [
  "Latest task saved for after login, replacing the previous saved task. Run /login to",
  "connect a provider; once login finishes, Atomic will continue with the latest task.",
].join("\n");

export const ONBOARDING_HANDOFF_NOTICE = "Handing your task to the normal coding-agent session.";
export const ONBOARDING_ROUTING_THINKING_LEVEL = "high";

function isInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathCandidatesWithOptionalLocationSuffix(pathText: string): string[] {
  const candidates = [pathText, pathText.replace(/:\d+:\d+$/, ""), pathText.replace(/:\d+$/, "")];
  return candidates.filter((candidate, index) => candidate && candidates.indexOf(candidate) === index);
}

function firstSeedLine(seed: string): string { return seed.trim().split(/\r?\n/, 1)[0]?.trim() ?? ""; }

function getContainedExistingPath(pathText: string, cwd: string): string | undefined {
  if (!pathText || /\r|\n/.test(pathText) || /^[a-z]+:\/\//i.test(pathText)) return undefined;
  const root = resolve(cwd);
  let rootReal: string;
  try { rootReal = realpathSync(root); } catch { return undefined; }
  for (const candidate of pathCandidatesWithOptionalLocationSuffix(pathText)) {
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
    if (!isInside(root, absolute)) continue;
    try {
      lstatSync(absolute);
      const real = realpathSync(absolute);
      if (isInside(rootReal, real)) return real;
    } catch {}
  }
  return undefined;
}

export function isCwdLocalExistingPathSeed(seed: string, cwd: string): boolean {
  const trimmed = firstSeedLine(seed);
  if (!trimmed || !isAbsolute(trimmed)) return false;
  const real = getContainedExistingPath(trimmed, cwd);
  if (!real) return false;
  try {
    const stat = statSync(real);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

export function isExistingAbsolutePathSeed(seed: string): boolean {
  const trimmed = firstSeedLine(seed);
  if (!trimmed || /\r|\n/.test(trimmed) || /^[a-z]+:\/\//i.test(trimmed) || !isAbsolute(trimmed)) return false;
  for (const candidate of pathCandidatesWithOptionalLocationSuffix(trimmed)) {
    if (!isAbsolute(candidate)) continue;
    try {
      const stat = statSync(candidate);
      if (stat.isFile() || stat.isDirectory()) return true;
    } catch {}
  }
  return false;
}

function sameModel(a: Model<Api>, b: Model<Api>): boolean {
  return a.provider === b.provider && a.id === b.id;
}

function backtickFenceFor(seed: string): string {
  let longest = 0;
  for (const match of seed.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export function buildOnboardingHandoffPrompt(seed: string): string {
  const fence = backtickFenceFor(seed);
  return [
    "First-run onboarding handoff: continue as a normal Atomic coding-agent session.",
    "",
    "Original task seed:",
    `${fence}text`,
    seed,
    fence,
    "",
    "Perform a quick scope-routing pass before acting. Atomic has switched the selected model",
    "to high reasoning for this routing decision when the model supports it. First estimate the",
    "likely scope from the seed text alone: tickets, GitHub issues, and especially specs often",
    "name enough work items, files, systems, tests, docs, migrations, or acceptance criteria to",
    "classify the task without immediately inspecting the repo. Treat that text-only estimate as",
    "an initial confidence signal for routing, not as final implementation planning.",
    "",
    "If the seed makes the task clearly tiny or small and the routing choice is high-confidence,",
    "you may route directly without codebase probing. If the seed references a local path, issue,",
    "spec, or repo area that must be read to understand the task, inspect only that targeted",
    "context. When the scope is medium, large, unclear, risky, or otherwise not obviously tiny,",
    "gather quick read-only codebase context with targeted subagents such as `codebase-locator`,",
    "`codebase-analyzer`, and `codebase-pattern-finder`. Use those subagents with their normal",
    "default model/thinking settings; do not override their models just for routing. Do only the",
    "probing needed to route scope; do not turn this into an open-ended research project.",
    "",
    "Then make the final choice in this high-reasoning parent session using the existing Atomic",
    "workflow guidance: choose `goal` for clearly small, focused fixes or quick fixes; choose `ralph`",
    "for non-trivial, broad, cross-cutting, risky, unclear, or around-2K+-changed-line work.",
    "Start the selected workflow with the original seed. After the `goal` or `ralph` run is",
    "dispatched, show the new developer the workflow id and succinct next steps:",
    "- `/workflow status <workflow-id>` checks progress.",
    "- `/workflow connect <workflow-id>` opens the graph viewer to watch, attach, and steer.",
    "- They can ask in this chat for status or to steer the run at any point.",
    "Then continue normally in this session. Slash commands should behave like normal",
    "coding-agent slash commands from here on.",
  ].join("\n");
}

InteractiveModeBase.prototype.isFirstRunOnboardingEligible = function(this: InteractiveModeBase): boolean {
  const hasInitialInput = Boolean(this.options.initialMessage) || Boolean(this.options.initialMessages?.length);
  return this.session.state.messages.length === 0
    && !hasInitialInput
    && !this.settingsManager.getOnboardedVersion()
    && Boolean(this.settingsManager.getFirstRunOnboardingStartedVersion());
};

InteractiveModeBase.prototype.isFirstRunOnboardingReadyForHandoff = function(this: InteractiveModeBase): boolean {
  const registry = this.session.modelRegistry;
  if (!registry) return true;
  const model = this.session.model;
  if (!model || isUnknownModel(model)) return false;
  if (typeof registry.hasConfiguredAuth === "function") {
    return registry.hasConfiguredAuth(model);
  }
  if (typeof registry.getAvailable === "function") {
    return registry.getAvailable().some((availableModel) => sameModel(availableModel, model));
  }
  return true;
};

InteractiveModeBase.prototype.stashFirstRunOnboardingSeed = function(this: InteractiveModeBase, seed: string): void {
  const replaced = Boolean(this.pendingFirstRunOnboardingSeed);
  this.pendingFirstRunOnboardingSeed = seed;
  this.showStatus(replaced ? ONBOARDING_SEED_REPLACED_COPY : ONBOARDING_SEED_STASHED_COPY);
};

InteractiveModeBase.prototype.resumePendingFirstRunOnboardingSeed = async function(this: InteractiveModeBase): Promise<void> {
  if (!this.firstRunOnboardingActive || !this.pendingFirstRunOnboardingSeed) return;
  if (!this.isFirstRunOnboardingReadyForHandoff()) return;
  const seed = this.pendingFirstRunOnboardingSeed;
  this.pendingFirstRunOnboardingSeed = undefined;
  try {
    await this.handleOnboardingWorkflowSeed(seed);
  } catch (error: unknown) {
    this.pendingFirstRunOnboardingSeed = seed;
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.showError(errorMessage);
  }
};

InteractiveModeBase.prototype.clearPendingFirstRunOnboardingSeed = function(this: InteractiveModeBase): void {
  this.firstRunOnboardingSeedInFlight = false;
  this.pendingFirstRunOnboardingSeed = undefined;
};

InteractiveModeBase.prototype.clearFirstRunOnboardingUi = function(this: InteractiveModeBase): void {
  this.firstRunOnboardingActive = false;
  InteractiveModeBase.prototype.clearPendingFirstRunOnboardingSeed.call(this);
  this.defaultEditor.setPlaceholder(undefined);
  if (this.firstRunOnboardingHeaderComponents.length > 0) {
    this.headerContainer.children = this.headerContainer.children.filter(
      (child) => !this.firstRunOnboardingHeaderComponents.includes(child),
    );
    this.firstRunOnboardingHeaderComponents = [];
  }
  this.ui.requestRender();
};

InteractiveModeBase.prototype.completeFirstRunOnboarding = function(this: InteractiveModeBase): void {
  this.settingsManager.setOnboardedVersion(this.version);
  InteractiveModeBase.prototype.clearFirstRunOnboardingUi.call(this);
};

InteractiveModeBase.prototype.handleOnboardingWorkflowSeed = async function(
  this: InteractiveModeBase,
  seed: string,
): Promise<void> {
  const handoffPrompt = buildOnboardingHandoffPrompt(seed);
  this.session.setThinkingLevel(ONBOARDING_ROUTING_THINKING_LEVEL);
  this.footer.invalidate();
  this.updateEditorBorderColor();
  this.flushPendingBashComponents();
  if (this.onInputCallback) {
    this.onInputCallback(handoffPrompt);
  } else {
    this.pendingUserInputs.push(handoffPrompt);
  }
  this.showStatus(ONBOARDING_HANDOFF_NOTICE);
  this.completeFirstRunOnboarding();
};
