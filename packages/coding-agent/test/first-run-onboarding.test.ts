import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
  NORMAL_CHAT_TRANSITION_COPY,
  ONBOARDING_COPY,
  ONBOARDING_PLACEHOLDER,
  assessOnboardingRoute,
  isCwdLocalExistingPathSeed,
  type OnboardingRoutingAssessment,
} from "../src/modes/interactive/interactive-onboarding.ts";

function installSubmitHandler(host: Record<string, unknown>): (text: string) => Promise<void> {
  const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: Record<string, unknown>) => void;
  setup.call(host);
  return (host.defaultEditor as { onSubmit: (text: string) => Promise<void> }).onSubmit;
}

describe("first-run onboarding", () => {
  it("stores onboarding start and completion separately from lastChangelogVersion", () => {
    const manager = SettingsManager.inMemory();
    manager.setLastChangelogVersion("0.1.0");
    manager.setFirstRunOnboardingStartedVersion("0.2.0");
    manager.setOnboardedVersion("0.3.0");

    expect(manager.getLastChangelogVersion()).toBe("0.1.0");
    expect(manager.getFirstRunOnboardingStartedVersion()).toBe("0.2.0");
    expect(manager.getOnboardedVersion()).toBe("0.3.0");
  });

  it("gates first-run onboarding on an empty started session and missing onboardedVersion", () => {
    const isEligible = Reflect.get(InteractiveMode.prototype, "isFirstRunOnboardingEligible") as (this: {
      session: { state: { messages: string[] } };
      settingsManager: {
        getFirstRunOnboardingStartedVersion: () => string | undefined;
        getOnboardedVersion: () => string | undefined;
      };
      options: { initialMessage?: string; initialMessages?: string[] };
    }) => boolean;
    const settingsManager = {
      getFirstRunOnboardingStartedVersion: () => "0.2.0",
      getOnboardedVersion: () => undefined,
    };

    expect(ONBOARDING_COPY).toContain("Paste a ticket description");
    expect(ONBOARDING_COPY).toContain("first run /login");
    expect(ONBOARDING_PLACEHOLDER).toContain("Paste a ticket");
    expect(isEligible.call({ session: { state: { messages: [] } }, settingsManager, options: {} })).toBe(true);
    expect(isEligible.call({ session: { state: { messages: ["old"] } }, settingsManager, options: {} })).toBe(false);
    expect(isEligible.call({ session: { state: { messages: [] } }, settingsManager: { ...settingsManager, getOnboardedVersion: () => "0.1.0" }, options: {} })).toBe(false);
    expect(isEligible.call({ session: { state: { messages: [] } }, settingsManager: { ...settingsManager, getFirstRunOnboardingStartedVersion: () => undefined }, options: {} })).toBe(false);
    expect(isEligible.call({ session: { state: { messages: [] } }, settingsManager, options: { initialMessage: "run once" } })).toBe(false);
    expect(isEligible.call({ session: { state: { messages: [] } }, settingsManager, options: { initialMessages: ["one"] } })).toBe(false);
  });

  it("uses a separate onboarding-start marker after changelog startup records the current version", () => {
    const manager = SettingsManager.inMemory();
    const host = {
      session: { state: { messages: [] } },
      settingsManager: manager,
      reportInstallTelemetry: vi.fn(),
      hadLastChangelogVersionAtStartup: Boolean(manager.getLastChangelogVersion()),
    };
    const getChangelogForDisplay = Reflect.get(InteractiveMode.prototype, "getChangelogForDisplay") as (this: typeof host) => string | undefined;
    const isEligible = Reflect.get(InteractiveMode.prototype, "isFirstRunOnboardingEligible") as (this: typeof host) => boolean;

    expect(getChangelogForDisplay.call(host)).toBeUndefined();
    expect(manager.getLastChangelogVersion()).toBeTruthy();
    expect(isEligible.call({ ...host, options: {} })).toBe(false);
    manager.setFirstRunOnboardingStartedVersion("0.2.0");
    expect(isEligible.call({ ...host, options: {} })).toBe(true);

    const upgraded = SettingsManager.inMemory();
    upgraded.setLastChangelogVersion("0.1.0");
    expect(isEligible.call({ ...host, settingsManager: upgraded, hadLastChangelogVersionAtStartup: true, options: {} })).toBe(false);
  });

  it("removes rendered onboarding header components when onboarding completes", () => {
    const first = { name: "first" };
    const cta = [{ name: "border" }, { name: "copy" }, { name: "bottom" }];
    const last = { name: "last" };
    const host = {
      version: "0.2.0",
      firstRunOnboardingActive: true,
      firstRunOnboardingHeaderComponents: cta,
      headerContainer: { children: [first, ...cta, last] },
      settingsManager: { setOnboardedVersion: vi.fn() },
      defaultEditor: { setPlaceholder: vi.fn() },
      ui: { requestRender: vi.fn() },
    };
    const complete = Reflect.get(InteractiveMode.prototype, "completeFirstRunOnboarding") as (this: typeof host) => void;

    complete.call(host);

    expect(host.firstRunOnboardingActive).toBe(false);
    expect(host.headerContainer.children).toEqual([first, last]);
    expect(host.firstRunOnboardingHeaderComponents).toEqual([]);
    expect(host.settingsManager.setOnboardedVersion).toHaveBeenCalledWith("0.2.0");
    expect(host.defaultEditor.setPlaceholder).toHaveBeenCalledWith(undefined);
    expect(host.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("/chat exits onboarding and sends a message through normal input", async () => {
    const onInputCallback = vi.fn();
    const host = {
      firstRunOnboardingActive: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      completeFirstRunOnboarding: vi.fn(),
      showStatus: vi.fn(),
      flushPendingBashComponents: vi.fn(),
      onInputCallback,
      pendingUserInputs: [],
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    await submit("/chat please explain the repo");

    expect(host.completeFirstRunOnboarding).toHaveBeenCalledTimes(1);
    expect(host.showStatus).toHaveBeenCalledWith(NORMAL_CHAT_TRANSITION_COPY);
    expect(onInputCallback).toHaveBeenCalledWith("please explain the repo");
    expect(host.session.prompt).not.toHaveBeenCalled();
  });

  it("slash commands other than /chat pass through without completing onboarding", async () => {
    const onInputCallback = vi.fn();
    const host = {
      firstRunOnboardingActive: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      completeFirstRunOnboarding: vi.fn(),
      handleOnboardingWorkflowSeed: vi.fn(),
      showOAuthSelector: vi.fn(),
      flushPendingBashComponents: vi.fn(),
      onInputCallback,
      pendingUserInputs: [],
      sessionManager: { getCwd: () => process.cwd() },
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    await submit("/login");
    await submit("/workflow status");

    expect(host.showOAuthSelector).toHaveBeenCalledWith("login");
    expect(onInputCallback).toHaveBeenCalledWith("/workflow status");
    expect(host.completeFirstRunOnboarding).not.toHaveBeenCalled();
    expect(host.handleOnboardingWorkflowSeed).not.toHaveBeenCalled();
  });

  it("treats cwd-local absolute spec paths with spaces as onboarding seeds instead of slash commands", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atomic onboarding "));
    const specPath = join(cwd, "spec with spaces.md");
    writeFileSync(specPath, "# Local spec\n\nFix the local onboarding route.");
    const host = {
      firstRunOnboardingActive: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      handleOnboardingWorkflowSeed: vi.fn().mockResolvedValue(undefined),
      showError: vi.fn(),
      sessionManager: { getCwd: () => cwd },
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    await submit(specPath);

    expect(host.handleOnboardingWorkflowSeed).toHaveBeenCalledWith(specPath);
    expect(host.session.prompt).not.toHaveBeenCalled();
    expect(host.editor.setText).toHaveBeenCalledWith("");
  });

  it("maps onboarding workflow launches to raw goal objective and ralph prompt inputs", async () => {
    const execute = vi.fn().mockResolvedValue({ details: { action: "run", runId: "run-1", status: "running" } });
    const sendCustomMessage = vi.fn().mockResolvedValue(undefined);
    const launch = Reflect.get(InteractiveMode.prototype, "launchOnboardingWorkflow") as (
      this: Record<string, unknown>,
      seed: string,
      assessment: OnboardingRoutingAssessment,
    ) => Promise<void>;
    const host = {
      session: {
        getToolDefinition: () => ({ execute }),
        extensionRunner: { createContext: () => ({}) },
        sendCustomMessage,
      },
    };

    await launch.call(host, "raw goal text", { workflow: "goal", estimatedChangedLines: 50, estimatedUniqueFiles: 1, touchedAreas: [], reason: "small" });
    await launch.call(host, "raw ralph text", { workflow: "ralph", estimatedChangedLines: 2500, estimatedUniqueFiles: 12, touchedAreas: [], reason: "large" });

    expect(execute.mock.calls[0]?.[1]).toMatchObject({ workflow: "goal", inputs: { objective: "raw goal text" }, action: "run" });
    expect(execute.mock.calls[1]?.[1]).toMatchObject({ workflow: "ralph", inputs: { prompt: "raw ralph text" }, action: "run" });
    expect(execute.mock.calls[1]?.[1]).not.toHaveProperty("max_loops");
    expect(execute.mock.calls[1]?.[1].inputs).not.toHaveProperty("max_loops");
    expect(sendCustomMessage).toHaveBeenCalledTimes(2);
  });

  it("does not complete onboarding when assessment or launch fails", async () => {
    const host = {
      firstRunOnboardingActive: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      handleOnboardingWorkflowSeed: vi.fn().mockRejectedValue(new Error("no auth")),
      completeFirstRunOnboarding: vi.fn(),
      showError: vi.fn(),
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    await submit("Implement ticket ABC");

    expect(host.handleOnboardingWorkflowSeed).toHaveBeenCalledWith("Implement ticket ABC");
    expect(host.completeFirstRunOnboarding).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith("no auth");
    expect(host.editor.setText).toHaveBeenLastCalledWith("Implement ticket ABC");
  });

  it("routes small focused work to goal and broad or vague work to ralph using source guidance", () => {
    const small = assessOnboardingRoute("Fix typo in packages/coding-agent/docs/quickstart.md", process.cwd());
    const large = assessOnboardingRoute("Plan a cross-cutting migration across all packages and tests", process.cwd());
    const vague = assessOnboardingRoute("Add SAML SSO support with ACS endpoint and user provisioning", process.cwd());

    expect(small.workflow).toBe("goal");
    expect(large.workflow).toBe("ralph");
    expect(vague.workflow).toBe("ralph");
    expect(small.reason).toContain("prefer goal for small fixes/quick fixes");
    expect(large.reason).toContain("over about 2K LoC estimated diff");
    expect(vague.reason).toContain("conservatively routes to ralph");
  });

  it("uses a valid subagent probe result for onboarding routing", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({
        workflow: "ralph",
        estimatedChangedLines: 2400,
        estimatedUniqueFiles: 9,
        touchedAreas: ["packages/coding-agent", "packages/workflows"],
        reason: "Guidance says ralph for non-trivial work over about 2K LoC.",
      }) }],
      details: { results: [] },
    });
    const assess = Reflect.get(InteractiveMode.prototype, "runOnboardingRoutingAssessment") as (
      this: Record<string, unknown>,
      seed: string,
    ) => Promise<OnboardingRoutingAssessment>;
    const host = {
      sessionManager: { getCwd: () => process.cwd() },
      session: {
        getToolDefinition: (name: string) => name === "subagent" ? { execute } : undefined,
        extensionRunner: { createContext: () => ({}) },
      },
    };

    const assessment = await assess.call(host, "Update onboarding routing across packages");

    expect(assessment.workflow).toBe("ralph");
    expect(assessment.estimatedChangedLines).toBe(2400);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      agent: "codebase-locator",
      output: false,
      reads: false,
      artifacts: false,
    });
    expect(execute.mock.calls[0]?.[1].task).toContain("prefer `goal` for small fixes/quick fixes");
    expect(execute.mock.calls[0]?.[1].task).toContain("Do not set or discuss ralph.max_loops");
  });

  it("falls back to the heuristic when the subagent probe returns invalid JSON", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "not json" }], details: { results: [] } });
    const assess = Reflect.get(InteractiveMode.prototype, "runOnboardingRoutingAssessment") as (
      this: Record<string, unknown>,
      seed: string,
    ) => Promise<OnboardingRoutingAssessment>;
    const host = {
      sessionManager: { getCwd: () => process.cwd() },
      session: {
        getToolDefinition: (name: string) => name === "subagent" ? { execute } : undefined,
        extensionRunner: { createContext: () => ({}) },
      },
    };

    const assessment = await assess.call(host, "Fix typo in packages/coding-agent/docs/quickstart.md");

    expect(assessment.workflow).toBe("goal");
    expect(assessment.reason).toContain("prefer goal for small fixes/quick fixes");
  });

  it("includes cwd-local spec contents with spaces in the primary subagent probe prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atomic onboarding "));
    const specPath = join(cwd, "spec with spaces.md");
    writeFileSync(specPath, "# Routed spec\n\nUpdate first-run workflow routing from this spec body.");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "not json" }], details: { results: [] } });
    const assess = Reflect.get(InteractiveMode.prototype, "runOnboardingRoutingAssessment") as (
      this: Record<string, unknown>,
      seed: string,
    ) => Promise<OnboardingRoutingAssessment>;
    const host = {
      sessionManager: { getCwd: () => cwd },
      session: {
        getToolDefinition: (name: string) => name === "subagent" ? { execute } : undefined,
        extensionRunner: { createContext: () => ({}) },
      },
    };

    await assess.call(host, specPath);

    expect(execute.mock.calls[0]?.[1].task).toContain("Referenced cwd-local spec excerpt");
    expect(execute.mock.calls[0]?.[1].task).toContain("Update first-run workflow routing from this spec body");
  });

  it("does not follow cwd-local spec symlinks outside cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atomic-onboarding-"));
    const outside = mkdtempSync(join(tmpdir(), "atomic-outside-"));
    const outsideSpec = join(outside, "secret.md");
    const symlinkPath = join(cwd, "linked spec.md");
    writeFileSync(outsideSpec, "OUTSIDE SECRET SPEC BODY");
    symlinkSync(outsideSpec, symlinkPath);
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "not json" }], details: { results: [] } });
    const assess = Reflect.get(InteractiveMode.prototype, "runOnboardingRoutingAssessment") as (
      this: Record<string, unknown>,
      seed: string,
    ) => Promise<OnboardingRoutingAssessment>;
    const host = {
      sessionManager: { getCwd: () => cwd },
      session: {
        getToolDefinition: (name: string) => name === "subagent" ? { execute } : undefined,
        extensionRunner: { createContext: () => ({}) },
      },
    };

    await assess.call(host, symlinkPath);

    expect(isCwdLocalExistingPathSeed(symlinkPath, cwd)).toBe(false);
    expect(execute.mock.calls[0]?.[1].task).not.toContain("OUTSIDE SECRET SPEC BODY");
    expect(execute.mock.calls[0]?.[1].task).not.toContain("Referenced cwd-local spec excerpt");
  });

  it("falls back to the heuristic when the subagent probe is aborted or times out", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    const execute = vi.fn().mockRejectedValueOnce(abortError).mockRejectedValueOnce(timeoutError);
    const assess = Reflect.get(InteractiveMode.prototype, "runOnboardingRoutingAssessment") as (
      this: Record<string, unknown>,
      seed: string,
    ) => Promise<OnboardingRoutingAssessment>;
    const host = {
      sessionManager: { getCwd: () => process.cwd() },
      session: {
        getToolDefinition: (name: string) => name === "subagent" ? { execute } : undefined,
        extensionRunner: { createContext: () => ({}) },
      },
    };

    const aborted = await assess.call(host, "Fix typo in packages/coding-agent/docs/quickstart.md");
    const timedOut = await assess.call(host, "Plan a cross-cutting migration across all packages and tests");

    expect(aborted.workflow).toBe("goal");
    expect(aborted.reason).toContain("prefer goal for small fixes/quick fixes");
    expect(timedOut.workflow).toBe("ralph");
    expect(timedOut.reason).toContain("over about 2K LoC estimated diff");
  });

  it("falls back when resolved subagent error results are timeout or cancellation shaped", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "TimeoutError: probe timed out" }] })
      .mockResolvedValueOnce({ isError: true, content: "Operation cancelled by timeout cap" });
    const assess = Reflect.get(InteractiveMode.prototype, "runOnboardingRoutingAssessment") as (
      this: Record<string, unknown>,
      seed: string,
    ) => Promise<OnboardingRoutingAssessment>;
    const host = {
      sessionManager: { getCwd: () => process.cwd() },
      session: {
        getToolDefinition: (name: string) => name === "subagent" ? { execute } : undefined,
        extensionRunner: { createContext: () => ({}) },
      },
    };

    await expect(assess.call(host, "Fix typo in docs/readme.md")).resolves.toMatchObject({ workflow: "goal" });
    await expect(assess.call(host, "Add SAML SSO support with ACS endpoint and user provisioning")).resolves.toMatchObject({ workflow: "ralph" });
  });

  it("normalizes inconsistent goal probe output with broad estimates to ralph", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({
      workflow: "goal",
      estimatedChangedLines: 2500,
      estimatedUniqueFiles: 12,
      touchedAreas: ["api", "auth", "db", "ui", "tests"],
      reason: "incorrectly claimed goal",
    }) }], details: { results: [] } });
    const assess = Reflect.get(InteractiveMode.prototype, "runOnboardingRoutingAssessment") as (
      this: Record<string, unknown>,
      seed: string,
    ) => Promise<OnboardingRoutingAssessment>;
    const host = {
      sessionManager: { getCwd: () => process.cwd() },
      session: {
        getToolDefinition: (name: string) => name === "subagent" ? { execute } : undefined,
        extensionRunner: { createContext: () => ({}) },
      },
    };

    const assessment = await assess.call(host, "Implement broad auth platform changes");

    expect(assessment.workflow).toBe("ralph");
    expect(assessment.reason).toContain("Normalized to ralph");
  });

  it("propagates subagent probe execution failures instead of falling back", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("No model selected"));
    const assess = Reflect.get(InteractiveMode.prototype, "runOnboardingRoutingAssessment") as (
      this: Record<string, unknown>,
      seed: string,
    ) => Promise<OnboardingRoutingAssessment>;
    const host = {
      sessionManager: { getCwd: () => process.cwd() },
      session: {
        getToolDefinition: (name: string) => name === "subagent" ? { execute } : undefined,
        extensionRunner: { createContext: () => ({}) },
      },
    };

    await expect(assess.call(host, "Plan a cross-cutting migration across all packages and tests")).rejects.toThrow("No model selected");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates subagent probe error results instead of falling back", async () => {
    const execute = vi.fn().mockResolvedValue({ isError: true, content: [{ type: "text", text: "Agent failed: No API key found" }] });
    const assess = Reflect.get(InteractiveMode.prototype, "runOnboardingRoutingAssessment") as (
      this: Record<string, unknown>,
      seed: string,
    ) => Promise<OnboardingRoutingAssessment>;
    const host = {
      sessionManager: { getCwd: () => process.cwd() },
      session: {
        getToolDefinition: (name: string) => name === "subagent" ? { execute } : undefined,
        extensionRunner: { createContext: () => ({}) },
      },
    };

    await expect(assess.call(host, "Fix typo in docs")).rejects.toThrow("No API key found");
  });

  it("falls back to the heuristic when the subagent tool is unavailable", async () => {
    const assess = Reflect.get(InteractiveMode.prototype, "runOnboardingRoutingAssessment") as (
      this: Record<string, unknown>,
      seed: string,
    ) => Promise<OnboardingRoutingAssessment>;
    const host = {
      sessionManager: { getCwd: () => process.cwd() },
      session: { getToolDefinition: () => undefined },
    };

    const assessment = await assess.call(host, "Plan a cross-cutting migration across all packages and tests");

    expect(assessment.workflow).toBe("ralph");
    expect(assessment.reason).toContain("over about 2K LoC estimated diff");
  });
});
