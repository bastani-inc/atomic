import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, relative } from "node:path";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import type { ExtensionContext } from "./interactive-mode-deps.ts";
import {
  enforceSeedConservatism,
  getToolErrorMessage,
  isProbeTimeoutOrAbortError,
  isProbeTimeoutOrCancellationMessage,
  parseProbeAssessment,
  reconcileProbeAssessments,
  timeoutFallbackCause,
  withLowConfidenceFallbackReason,
  type OnboardingRoutingAssessment,
} from "./interactive-onboarding-probe.ts";

export type { OnboardingRoutingAssessment } from "./interactive-onboarding-probe.ts";

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

export const SCOPE_CHECK_NOTICE = [
  "Doing a quick read-only scope check so I can choose the right workflow.",
  "I'll read the ticket/spec and look up the likely code areas, but I won't do the full",
  "implementation research here. The selected workflow will handle deeper research after",
  "it starts.",
].join("\n");

interface WorkflowRunDetails {
  action: string;
  runId?: string;
  status?: string;
  error?: string;
}

function isInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function getContainedExistingPath(pathText: string, cwd: string): string | undefined {
  if (!pathText || /\r|\n/.test(pathText) || /^[a-z]+:\/\//i.test(pathText)) return undefined;
  const root = resolve(cwd);
  const absolute = isAbsolute(pathText) ? resolve(pathText) : resolve(cwd, pathText);
  if (!isInside(root, absolute)) return undefined;
  try {
    lstatSync(absolute);
    const rootReal = realpathSync(root);
    const real = realpathSync(absolute);
    return isInside(rootReal, real) ? real : undefined;
  } catch {
    return undefined;
  }
}

export function isCwdLocalExistingPathSeed(seed: string, cwd: string): boolean {
  const trimmed = seed.trim();
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
  const trimmed = seed.trim();
  if (!trimmed || /\r|\n/.test(trimmed) || /^[a-z]+:\/\//i.test(trimmed) || !isAbsolute(trimmed)) return false;
  try {
    const stat = statSync(trimmed);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

function readMentionedSpec(seed: string, cwd: string): string | undefined {
  const trimmed = seed.trim();
  if (!trimmed || /\r|\n/.test(trimmed)) return undefined;
  const real = getContainedExistingPath(trimmed, cwd);
  if (!real) return undefined;
  try {
    const stat = statSync(real);
    if (!stat.isFile() || stat.size > 256_000) return undefined;
    return readFileSync(real, "utf8").slice(0, 64_000);
  } catch {
    return undefined;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

const WORKFLOW_SCOPE_GUIDANCE = "Source-of-truth workflow guidance says to prefer goal for small fixes/quick fixes, prefer ralph for non-trivial work over about 2K LoC estimated diff, and use estimated changed LoC plus unique files/touched areas as scoping signals.";
const PATH_LIKE_TOKEN_PATTERN = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g;
const URL_TOKEN_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi;
const URL_TOKEN_TEST_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/i;

function removeUrlTokens(text: string): string {
  return text.replace(URL_TOKEN_PATTERN, " ");
}

function hasUrlToken(text: string): boolean {
  return URL_TOKEN_TEST_PATTERN.test(text);
}

function extractTouchedAreas(text: string): string[] {
  const pathMatches = removeUrlTokens(text).match(PATH_LIKE_TOKEN_PATTERN) ?? [];
  const pathAreas = pathMatches.map((match) => match.split("/").slice(0, 2).join("/"));
  const lower = text.toLowerCase();
  const keywordAreas = [
    lower.includes("test") || lower.includes("spec") ? "tests" : "",
    lower.includes("doc") || lower.includes("readme") ? "docs" : "",
    lower.includes("workflow") ? "workflows" : "",
    lower.includes("setting") || lower.includes("config") ? "settings" : "",
    lower.includes("ui") || lower.includes("tui") || lower.includes("placeholder") ? "interactive-ui" : "",
    lower.includes("auth") || lower.includes("login") ? "auth" : "",
  ];
  return unique([...pathAreas, ...keywordAreas]).slice(0, 8);
}

function hasUrlOnlyWithoutLocalizingEvidence(text: string): boolean {
  const textWithoutUrls = removeUrlTokens(text);
  const lowerWithoutUrls = textWithoutUrls.toLowerCase();
  const pathCount = unique(textWithoutUrls.match(PATH_LIKE_TOKEN_PATTERN) ?? []).length;
  const hasSpecificPath = pathCount > 0;
  const hasLocalizingEvidence = hasSpecificPath || /\b(readme|changelog|docs?|tests?|src|package|component|function|class|module|one file|single file|specific file|this file|auth|login|workflow|setting|config)\b/.test(lowerWithoutUrls);
  return hasUrlToken(text) && !hasLocalizingEvidence;
}

export function assessOnboardingRoute(seed: string, cwd: string): OnboardingRoutingAssessment {
  const specText = readMentionedSpec(seed, cwd);
  const text = `${seed}\n${specText ?? ""}`;
  const lower = text.toLowerCase();
  const touchedAreas = extractTouchedAreas(text);
  const textWithoutUrls = removeUrlTokens(text);
  const lowerWithoutUrls = textWithoutUrls.toLowerCase();
  const pathCount = unique(textWithoutUrls.match(PATH_LIKE_TOKEN_PATTERN) ?? []).length;
  const broadWords = ["migration", "migrate", "refactor", "cross-cutting", "across", "all packages", "monorepo", "architecture", "provisioning", "sso"];
  const looksBroad = broadWords.some((word) => lower.includes(word));
  const hasSpecificPath = pathCount > 0;
  const urlOnlyWithoutLocalEvidence = hasUrlOnlyWithoutLocalizingEvidence(text);
  const looksTiny = /\b(fix|bug|typo|quick|small|localized|one file|single file)\b/.test(lowerWithoutUrls) && !looksBroad && !urlOnlyWithoutLocalEvidence;
  const looksLocalized = (looksTiny || hasSpecificPath) && !looksBroad;
  const estimatedUniqueFiles = Math.max(pathCount, touchedAreas.length || (looksLocalized ? 1 : 8));
  const estimatedChangedLines = looksBroad || !looksLocalized || estimatedUniqueFiles >= 8 ? 2500 : looksTiny ? 200 : 800;
  const workflow = estimatedChangedLines >= 2000 || estimatedUniqueFiles >= 8 || touchedAreas.length >= 5
    ? "ralph"
    : "goal";
  const shape = workflow === "goal"
    ? "This appears clearly localized and likely below about 2k changed lines."
    : looksLocalized
      ? "This appears broad, cross-cutting, or near/about 2k+ changed lines."
      : "The scope is not clearly localized, so this conservatively routes to ralph.";
  return {
    workflow,
    estimatedChangedLines,
    estimatedUniqueFiles,
    touchedAreas,
    reason: `${WORKFLOW_SCOPE_GUIDANCE} ${shape}`,
  };
}

function buildOnboardingProbePrompt(seed: string, cwd: string): string {
  const trimmedSeed = seed.length > 64_000 ? `${seed.slice(0, 64_000)}\n[truncated]` : seed;
  const specText = readMentionedSpec(seed, cwd);
  const specExcerpt = specText
    ? `Referenced cwd-local spec excerpt (read with size/path safeguards):\n${specText.length > 32_000 ? `${specText.slice(0, 32_000)}\n[truncated]` : specText}`
    : undefined;
  return [
    "You are a read-only onboarding scope probe. Inspect likely files/areas only enough to route this task to the right workflow.",
    "Do not edit files. Do not create or write durable research artifacts. Do not produce a full implementation plan or research report.",
    "Source workflow guidance from packages/workflows/src/extension/workflow-prompts.ts: prefer `goal` for small fixes/quick fixes; prefer `ralph` for non-trivial tasks, especially over about 2K LoC estimated diff; use estimated changed LoC plus number of unique files/touched areas as scoping signals. Do not set or discuss ralph.max_loops.",
    "Return compact JSON only, matching exactly: {\"workflow\":\"goal\"|\"ralph\",\"estimatedChangedLines\":number|null,\"estimatedUniqueFiles\":number|null,\"touchedAreas\":string[],\"reason\":\"short reason quoting or summarizing the guidance\"}.",
    "Task seed:",
    trimmedSeed,
    specExcerpt,
  ].filter(Boolean).join("\n\n");
}

interface FollowupProbeTask { agent: "codebase-analyzer" | "codebase-pattern-finder" | "codebase-online-researcher"; task: string; output: false; reads: false }

function buildFollowupProbePrompt(agent: FollowupProbeTask["agent"], seed: string, locatorAssessment: OnboardingRoutingAssessment | undefined): string {
  const roleInstruction = agent === "codebase-analyzer"
    ? "Analyze only the most relevant current flow or area or two to refine breadth and likely changed files."
    : agent === "codebase-pattern-finder"
      ? "Check only for existing conventions, repeated patterns, or migration shape that materially changes scope."
      : "Research only external API/library/version facts that are central to judging scope.";
  return [
    "You are a targeted read-only onboarding follow-up probe. Keep this bounded; do not edit files, write artifacts, or do full research.",
    roleInstruction,
    "Use the same routing guidance: goal for small fixes/quick fixes; ralph for non-trivial work over about 2K LoC, many files, or many touched areas.",
    "Return compact JSON only: {\"workflow\":\"goal\"|\"ralph\",\"estimatedChangedLines\":number|null,\"estimatedUniqueFiles\":number|null,\"touchedAreas\":string[],\"reason\":\"short reason\"}.",
    locatorAssessment ? `Locator/heuristic signal: ${JSON.stringify(locatorAssessment)}` : undefined,
    `Task seed:\n${seed.length > 32_000 ? `${seed.slice(0, 32_000)}\n[truncated]` : seed}`,
  ].filter(Boolean).join("\n\n");
}

function getFollowupProbeTasks(seed: string, assessment: OnboardingRoutingAssessment | undefined): FollowupProbeTask[] {
  const text = `${seed}\n${assessment?.reason ?? ""}`;
  const lowerWithoutUrls = removeUrlTokens(text).toLowerCase();
  const needsMoreScopeSignal = !assessment || assessment.estimatedChangedLines === null || assessment.estimatedUniqueFiles === null;
  const tasks: FollowupProbeTask[] = [];
  if (needsMoreScopeSignal) tasks.push({ agent: "codebase-analyzer", task: buildFollowupProbePrompt("codebase-analyzer", seed, assessment), output: false, reads: false });
  if (/\b(pattern|convention|existing examples?|repeat(?:ed)?|similar|migration|migrate|refactor)\b/.test(lowerWithoutUrls)) tasks.push({ agent: "codebase-pattern-finder", task: buildFollowupProbePrompt("codebase-pattern-finder", seed, assessment), output: false, reads: false });
  if (/\b(external|library|sdk|api|version|upgrade|dependency|package|npm|crate|gem|react|github api|graphql|rest)\b/.test(lowerWithoutUrls)) tasks.push({ agent: "codebase-online-researcher", task: buildFollowupProbePrompt("codebase-online-researcher", seed, assessment), output: false, reads: false });
  return tasks.slice(0, 3);
}


function getWorkflowRunDetails(details: unknown): WorkflowRunDetails | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const record = details as Partial<WorkflowRunDetails>;
  return typeof record.action === "string" ? { action: record.action, runId: record.runId, status: record.status, error: record.error } : undefined;
}

function formatDecision(assessment: OnboardingRoutingAssessment): string {
  const areas = assessment.touchedAreas.length > 0
    ? ` Likely touched areas: ${assessment.touchedAreas.join(", ")}.`
    : "";
  if (assessment.workflow === "goal") {
    return [
      "✓ Decision: run goal",
      "",
      "This looks like a smaller, focused change: it appears localized and",
      "likely under about 2k lines. goal is built for bounded work like this.",
      areas.trim(),
      "",
      "For larger changes — broad refactors, migrations, or work that spans",
      "many files/packages — use ralph. Ralph does deeper research, delegates",
      "through sub-agents, reviews, and iterates.",
      "",
      "Starting goal now.",
    ].filter(Boolean).join("\n");
  }
  return [
    "✓ Decision: run ralph",
    "",
    "This looks like a larger or cross-cutting change: it may touch many",
    "areas or require around 2k+ lines of implementation, tests, or docs.",
    "Ralph is built for bigger work that needs research, delegation, review, and iteration.",
    areas.trim(),
    "",
    "For smaller, focused fixes or features, use goal. goal is faster and",
    "optimized for bounded work.",
    "",
    "Starting ralph now.",
  ].filter(Boolean).join("\n");
}

InteractiveModeBase.prototype.isFirstRunOnboardingEligible = function(this: InteractiveModeBase): boolean {
  const hasInitialInput = Boolean(this.options.initialMessage) || Boolean(this.options.initialMessages?.length);
  return this.session.state.messages.length === 0
    && !hasInitialInput
    && !this.settingsManager.getOnboardedVersion()
    && Boolean(this.settingsManager.getFirstRunOnboardingStartedVersion());
};

InteractiveModeBase.prototype.clearFirstRunOnboardingUi = function(this: InteractiveModeBase): void {
  this.firstRunOnboardingActive = false;
  this.firstRunOnboardingSeedInFlight = false;
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

InteractiveModeBase.prototype.runOnboardingRoutingAssessment = async function(
  this: InteractiveModeBase,
  seed: string,
): Promise<OnboardingRoutingAssessment> {
  const cwd = this.sessionManager.getCwd();
  const fallback = assessOnboardingRoute(seed, cwd);
  const tool = this.session.getToolDefinition("subagent");
  if (!tool) return fallback;
  let result: unknown;
  const timeoutSignal = AbortSignal.timeout(600_000);
  try {
    result = await tool.execute(
      "onboarding-scope-probe",
      {
        agent: "codebase-locator",
        task: buildOnboardingProbePrompt(seed, cwd),
        cwd,
        context: "fresh",
        async: false,
        clarify: false,
        output: false,
        reads: false,
        artifacts: false,
        agentScope: "both",
      } as Parameters<typeof tool.execute>[1],
      timeoutSignal,
      undefined,
      this.session.extensionRunner.createContext() as ExtensionContext,
    );
  } catch (error: unknown) {
    if (isProbeTimeoutOrAbortError(error)) return withLowConfidenceFallbackReason(fallback, timeoutFallbackCause(error));
    throw error;
  }
  const errorMessage = getToolErrorMessage(result);
  if (errorMessage) {
    if (timeoutSignal.aborted || isProbeTimeoutOrCancellationMessage(errorMessage)) {
      return withLowConfidenceFallbackReason(fallback, "timed out or was cancelled before it could finish");
    }
    throw new Error(errorMessage);
  }
  const locatorAssessment = parseProbeAssessment(result);
  const followupTasks = getFollowupProbeTasks(seed, locatorAssessment);
  if (followupTasks.length === 0) return enforceSeedConservatism(seed, locatorAssessment ?? fallback);
  try {
    result = await tool.execute(
      "onboarding-scope-followup-probe",
      {
        tasks: followupTasks,
        concurrency: followupTasks.length,
        cwd,
        context: "fresh",
        async: false,
        clarify: false,
        output: false,
        reads: false,
        artifacts: false,
        agentScope: "both",
      } as Parameters<typeof tool.execute>[1],
      timeoutSignal,
      undefined,
      this.session.extensionRunner.createContext() as ExtensionContext,
    );
  } catch (error: unknown) {
    if (isProbeTimeoutOrAbortError(error)) {
      return enforceSeedConservatism(seed, withLowConfidenceFallbackReason(locatorAssessment ?? fallback, timeoutFallbackCause(error)));
    }
    throw error;
  }
  const followupErrorMessage = getToolErrorMessage(result);
  if (followupErrorMessage) {
    if (timeoutSignal.aborted || isProbeTimeoutOrCancellationMessage(followupErrorMessage)) {
      return enforceSeedConservatism(seed, withLowConfidenceFallbackReason(locatorAssessment ?? fallback, "timed out or was cancelled before it could finish"));
    }
    throw new Error(followupErrorMessage);
  }
  const followupAssessment = parseProbeAssessment(result);
  const reconciledAssessment = reconcileProbeAssessments(
    [locatorAssessment, followupAssessment].filter((assessment): assessment is OnboardingRoutingAssessment => Boolean(assessment)),
  );
  return enforceSeedConservatism(seed, reconciledAssessment ?? locatorAssessment ?? fallback);
};

InteractiveModeBase.prototype.launchOnboardingWorkflow = async function(
  this: InteractiveModeBase,
  seed: string,
  assessment: OnboardingRoutingAssessment,
): Promise<void> {
  const tool = this.session.getToolDefinition("workflow");
  if (!tool) throw new Error("Workflow tool is not available. Run /reload and try again.");
  const inputs = assessment.workflow === "goal" ? { objective: seed } : { prompt: seed };
  const result = await tool.execute(
    "onboarding-workflow-routing",
    { workflow: assessment.workflow, inputs, action: "run" },
    AbortSignal.timeout(600_000),
    undefined,
    this.session.extensionRunner.createContext() as ExtensionContext,
  );
  const details = getWorkflowRunDetails(result.details);
  if (!details || details.action !== "run" || details.status === "failed" || !details.runId) {
    throw new Error(details?.error ?? `Workflow "${assessment.workflow}" failed to start.`);
  }
  try {
    await this.session.sendCustomMessage(
      {
        customType: "workflows:chat-surface",
        content: `Started ${assessment.workflow} workflow ${details.runId}`,
        display: true,
        details: { kind: "dispatch", workflowName: assessment.workflow, runId: details.runId, inputs },
      },
      { triggerTurn: false, excludeFromContext: true },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.showWarning(`Workflow ${assessment.workflow} started (${details.runId}), but the status card could not be displayed: ${message}`);
  }
};

InteractiveModeBase.prototype.handleOnboardingWorkflowSeed = async function(
  this: InteractiveModeBase,
  seed: string,
): Promise<void> {
  this.showStatus(SCOPE_CHECK_NOTICE);
  const assessment = await this.runOnboardingRoutingAssessment(seed);
  this.showStatus(formatDecision(assessment));
  await this.launchOnboardingWorkflow(seed, assessment);
  this.completeFirstRunOnboarding();
};
