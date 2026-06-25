import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
  ONBOARDING_HANDOFF_NOTICE,
  ONBOARDING_ROUTING_THINKING_LEVEL,
  ONBOARDING_SEED_REPLACED_COPY,
  ONBOARDING_SEED_STASHED_COPY,
  buildOnboardingHandoffPrompt,
  isCwdLocalExistingPathSeed,
} from "../src/modes/interactive/interactive-onboarding.ts";

function installSubmitHandler(host: Record<string, unknown>): (text: string) => Promise<void> {
  const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: Record<string, unknown>) => void;
  setup.call(host);
  return (host.defaultEditor as { onSubmit: (text: string) => Promise<void> }).onSubmit;
}

const unknownModel = { provider: "unknown", id: "unknown", api: "unknown" };
const readyModel = { provider: "openai", id: "gpt-5", api: "openai" };
initTheme("dark");

describe("first-run onboarding pending seed handoff", () => {
  it("stashes a pasted seed in memory when no model/provider is ready", async () => {
    const settingsManager = SettingsManager.inMemory();
    const host = {
      firstRunOnboardingActive: true,
      firstRunOnboardingSeedInFlight: false,
      pendingFirstRunOnboardingSeed: undefined,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      showStatus: vi.fn(),
      stashFirstRunOnboardingSeed: Reflect.get(InteractiveMode.prototype, "stashFirstRunOnboardingSeed"),
      isFirstRunOnboardingReadyForHandoff: Reflect.get(InteractiveMode.prototype, "isFirstRunOnboardingReadyForHandoff"),
      handleOnboardingWorkflowSeed: vi.fn(),
      settingsManager,
      session: {
        model: unknownModel,
        modelRegistry: { hasConfiguredAuth: vi.fn(() => false) },
        isBashRunning: false,
        isCompacting: false,
        isStreaming: false,
        prompt: vi.fn(),
      },
    };
    const submit = installSubmitHandler(host);

    await submit("Implement ticket ABC");

    expect(host.pendingFirstRunOnboardingSeed).toBe("Implement ticket ABC");
    expect(host.showStatus).toHaveBeenCalledWith(ONBOARDING_SEED_STASHED_COPY);
    expect(host.handleOnboardingWorkflowSeed).not.toHaveBeenCalled();
    expect(settingsManager.getOnboardedVersion()).toBeUndefined();
    expect(JSON.stringify(settingsManager)).not.toContain("Implement ticket ABC");
  });

  it("stashes a slash-start absolute path:line seed before login without dropping the suffix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-onboarding-"));
    try {
      const specPath = join(dir, "spec.md");
      const seed = `${specPath}:12`;
      await writeFile(specPath, "# Spec\n");
      const host = {
        firstRunOnboardingActive: true,
        firstRunOnboardingSeedInFlight: false,
        pendingFirstRunOnboardingSeed: undefined,
        defaultEditor: {},
        editor: { setText: vi.fn(), addToHistory: vi.fn() },
        showStatus: vi.fn(),
        stashFirstRunOnboardingSeed: Reflect.get(InteractiveMode.prototype, "stashFirstRunOnboardingSeed"),
        isFirstRunOnboardingReadyForHandoff: vi.fn(() => false),
        handleOnboardingWorkflowSeed: vi.fn(),
        sessionManager: { getCwd: vi.fn(() => dir) },
        session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
      };
      const submit = installSubmitHandler(host);

      await submit(seed);

      expect(host.pendingFirstRunOnboardingSeed).toBe(seed);
      expect(host.showStatus).toHaveBeenCalledWith(ONBOARDING_SEED_STASHED_COPY);
      expect(host.handleOnboardingWorkflowSeed).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stashes a multiline slash-start absolute path seed before login without dropping notes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-onboarding-"));
    try {
      const specPath = join(dir, "spec.md");
      const seed = `${specPath}:12\nNotes: keep the original text`;
      await writeFile(specPath, "# Spec\n");
      const host = {
        firstRunOnboardingActive: true,
        firstRunOnboardingSeedInFlight: false,
        pendingFirstRunOnboardingSeed: undefined,
        defaultEditor: {},
        editor: { setText: vi.fn(), addToHistory: vi.fn() },
        showStatus: vi.fn(),
        stashFirstRunOnboardingSeed: Reflect.get(InteractiveMode.prototype, "stashFirstRunOnboardingSeed"),
        isFirstRunOnboardingReadyForHandoff: vi.fn(() => false),
        handleOnboardingWorkflowSeed: vi.fn(),
        sessionManager: { getCwd: vi.fn(() => dir) },
        session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
      };
      const submit = installSubmitHandler(host);

      await submit(seed);

      expect(host.pendingFirstRunOnboardingSeed).toBe(seed);
      expect(host.showStatus).toHaveBeenCalledWith(ONBOARDING_SEED_STASHED_COPY);
      expect(host.handleOnboardingWorkflowSeed).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not classify a cwd-local symlink resolving outside cwd as contained", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-onboarding-"));
    try {
      const cwd = join(dir, "workspace");
      const outsidePath = join(dir, "outside-spec.md");
      const linkPath = join(cwd, "linked-spec.md");
      await mkdir(cwd);
      await writeFile(outsidePath, "# Outside\n");
      try {
        await symlink(outsidePath, linkPath);
      } catch {
        return;
      }

      expect(isCwdLocalExistingPathSeed(linkPath, cwd)).toBe(false);
      expect(isCwdLocalExistingPathSeed(`${linkPath}:12:3`, cwd)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("hands off a ready slash-start absolute path:line:column seed without dropping the suffix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-onboarding-"));
    try {
      const specPath = join(dir, "spec.md");
      const seed = `${specPath}:12:3`;
      const onInputCallback = vi.fn();
      await writeFile(specPath, "# Spec\n");
      const host = {
        firstRunOnboardingActive: true,
        firstRunOnboardingSeedInFlight: false,
        pendingFirstRunOnboardingSeed: undefined,
        pendingUserInputs: [],
        defaultEditor: {},
        editor: { setText: vi.fn(), addToHistory: vi.fn() },
        isFirstRunOnboardingReadyForHandoff: vi.fn(() => true),
        handleOnboardingWorkflowSeed: Reflect.get(InteractiveMode.prototype, "handleOnboardingWorkflowSeed"),
        flushPendingBashComponents: vi.fn(),
        showStatus: vi.fn(),
        showError: vi.fn(),
        completeFirstRunOnboarding: vi.fn(function(this: { firstRunOnboardingActive: boolean }) {
          this.firstRunOnboardingActive = false;
        }),
        onInputCallback,
        footer: { invalidate: vi.fn() },
        updateEditorBorderColor: vi.fn(),
        sessionManager: { getCwd: vi.fn(() => dir) },
        session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn(), setThinkingLevel: vi.fn() },
      };
      const submit = installSubmitHandler(host);

      await submit(seed);

      expect(onInputCallback).toHaveBeenCalledWith(buildOnboardingHandoffPrompt(seed));
      expect(onInputCallback.mock.calls[0]?.[0]).toContain(seed);
      expect(host.showStatus).toHaveBeenCalledWith(ONBOARDING_HANDOFF_NOTICE);
      expect(host.firstRunOnboardingActive).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("hands off a ready multiline slash-start absolute path seed without dropping notes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-onboarding-"));
    try {
      const specPath = join(dir, "spec.md");
      const seed = `${specPath}:12:3\nNotes: preserve this handoff context`;
      const onInputCallback = vi.fn();
      await writeFile(specPath, "# Spec\n");
      const host = {
        firstRunOnboardingActive: true,
        firstRunOnboardingSeedInFlight: false,
        pendingFirstRunOnboardingSeed: undefined,
        pendingUserInputs: [],
        defaultEditor: {},
        editor: { setText: vi.fn(), addToHistory: vi.fn() },
        isFirstRunOnboardingReadyForHandoff: vi.fn(() => true),
        handleOnboardingWorkflowSeed: Reflect.get(InteractiveMode.prototype, "handleOnboardingWorkflowSeed"),
        flushPendingBashComponents: vi.fn(),
        showStatus: vi.fn(),
        showError: vi.fn(),
        completeFirstRunOnboarding: vi.fn(function(this: { firstRunOnboardingActive: boolean }) {
          this.firstRunOnboardingActive = false;
        }),
        onInputCallback,
        footer: { invalidate: vi.fn() },
        updateEditorBorderColor: vi.fn(),
        sessionManager: { getCwd: vi.fn(() => dir) },
        session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn(), setThinkingLevel: vi.fn() },
      };
      const submit = installSubmitHandler(host);

      await submit(seed);

      expect(onInputCallback).toHaveBeenCalledWith(buildOnboardingHandoffPrompt(seed));
      expect(onInputCallback.mock.calls[0]?.[0]).toContain(seed);
      expect(host.showStatus).toHaveBeenCalledWith(ONBOARDING_HANDOFF_NOTICE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not treat slash commands with notes as path seeds", async () => {
    for (const command of ["/login\nnotes", "/settings\nnotes", "/atomic\nnotes"]) {
      const host = {
        firstRunOnboardingActive: true,
        firstRunOnboardingSeedInFlight: false,
        pendingFirstRunOnboardingSeed: undefined,
        defaultEditor: {},
        editor: { setText: vi.fn(), addToHistory: vi.fn() },
        stashFirstRunOnboardingSeed: vi.fn(),
        isFirstRunOnboardingReadyForHandoff: vi.fn(() => false),
        handleOnboardingWorkflowSeed: vi.fn(),
        flushPendingBashComponents: vi.fn(),
        pendingUserInputs: [],
        sessionManager: { getCwd: vi.fn(() => tmpdir()) },
        session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
      };
      const submit = installSubmitHandler(host);

      await submit(command);

      expect(host.stashFirstRunOnboardingSeed).not.toHaveBeenCalled();
      expect(host.handleOnboardingWorkflowSeed).not.toHaveBeenCalled();
      expect(host.pendingFirstRunOnboardingSeed).toBeUndefined();
    }
  });

  it("uses a dynamic handoff fence that survives embedded Markdown fences", () => {
    const seed = "Before\n```ts\nconsole.log('seed');\n```\nAfter";
    const prompt = buildOnboardingHandoffPrompt(seed);

    expect(prompt).toContain("````text\n" + seed + "\n````");
    expect(prompt.split("\n")).not.toContain("```text");
  });

  it("asks the parent to show first-run workflow control commands after dispatch", () => {
    const prompt = buildOnboardingHandoffPrompt("Implement the ticket");

    expect(prompt).toContain("`/workflow status <workflow-id>` checks progress.");
    expect(prompt).toContain("`/workflow connect <workflow-id>` opens the graph viewer to watch, attach, and steer");
    expect(prompt).toContain("ask in this chat for status or to steer the run at any point");
  });

  it("replaces a pending seed before login with the latest seed", async () => {
    const host = {
      firstRunOnboardingActive: true,
      firstRunOnboardingSeedInFlight: false,
      pendingFirstRunOnboardingSeed: undefined,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      showStatus: vi.fn(),
      stashFirstRunOnboardingSeed: Reflect.get(InteractiveMode.prototype, "stashFirstRunOnboardingSeed"),
      isFirstRunOnboardingReadyForHandoff: Reflect.get(InteractiveMode.prototype, "isFirstRunOnboardingReadyForHandoff"),
      handleOnboardingWorkflowSeed: vi.fn(),
      session: {
        model: unknownModel,
        modelRegistry: { hasConfiguredAuth: vi.fn(() => false) },
        isBashRunning: false,
        isCompacting: false,
        isStreaming: false,
        prompt: vi.fn(),
      },
    };
    const submit = installSubmitHandler(host);

    await submit("First task");
    await submit("Second task");

    expect(host.pendingFirstRunOnboardingSeed).toBe("Second task");
    expect(host.showStatus).toHaveBeenLastCalledWith(ONBOARDING_SEED_REPLACED_COPY);
    expect(host.handleOnboardingWorkflowSeed).not.toHaveBeenCalled();
  });

  it("resumes a pending seed after authentication makes the session ready", async () => {
    const host = {
      firstRunOnboardingActive: true,
      pendingFirstRunOnboardingSeed: "Saved task",
      isFirstRunOnboardingReadyForHandoff: vi.fn(() => true),
      handleOnboardingWorkflowSeed: vi.fn().mockResolvedValue(undefined),
      showError: vi.fn(),
    };
    const resume = Reflect.get(InteractiveMode.prototype, "resumePendingFirstRunOnboardingSeed") as (this: typeof host) => Promise<void>;

    await resume.call(host);

    expect(host.handleOnboardingWorkflowSeed).toHaveBeenCalledWith("Saved task");
    expect(host.pendingFirstRunOnboardingSeed).toBeUndefined();
  });

  it("keeps a pending seed if post-login handoff cannot start", async () => {
    const host = {
      firstRunOnboardingActive: true,
      pendingFirstRunOnboardingSeed: "Saved task",
      isFirstRunOnboardingReadyForHandoff: vi.fn(() => true),
      handleOnboardingWorkflowSeed: vi.fn().mockRejectedValue(new Error("not ready")),
      showError: vi.fn(),
    };
    const resume = Reflect.get(InteractiveMode.prototype, "resumePendingFirstRunOnboardingSeed") as (this: typeof host) => Promise<void>;

    await resume.call(host);

    expect(host.pendingFirstRunOnboardingSeed).toBe("Saved task");
    expect(host.showError).toHaveBeenCalledWith("not ready");
  });

  it("hands a ready seed to normal input and completes onboarding at enqueue time", async () => {
    const onInputCallback = vi.fn();
    const host = {
      firstRunOnboardingActive: true,
      pendingFirstRunOnboardingSeed: undefined,
      pendingUserInputs: [],
      onInputCallback,
      flushPendingBashComponents: vi.fn(),
      showStatus: vi.fn(),
      footer: { invalidate: vi.fn() },
      updateEditorBorderColor: vi.fn(),
      session: { setThinkingLevel: vi.fn() },
      completeFirstRunOnboarding: vi.fn(function(this: { firstRunOnboardingActive: boolean }) {
        this.firstRunOnboardingActive = false;
      }),
    };
    const handleSeed = Reflect.get(InteractiveMode.prototype, "handleOnboardingWorkflowSeed") as (this: typeof host, seed: string) => Promise<void>;

    await handleSeed.call(host, "Original ticket text");

    expect(onInputCallback).toHaveBeenCalledWith(buildOnboardingHandoffPrompt("Original ticket text"));
    expect(host.session.setThinkingLevel).toHaveBeenCalledWith(ONBOARDING_ROUTING_THINKING_LEVEL);
    expect(host.footer.invalidate).toHaveBeenCalledTimes(1);
    expect(host.updateEditorBorderColor).toHaveBeenCalledTimes(1);
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("high reasoning");
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("seed text alone");
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("initial confidence signal");
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("route directly without codebase probing");
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("do not turn this into an open-ended research project");
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("codebase-locator");
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("codebase-analyzer");
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("codebase-pattern-finder");
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("choose `goal`");
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("choose `ralph`");
    expect(host.showStatus).toHaveBeenCalledWith(ONBOARDING_HANDOFF_NOTICE);
    expect(host.completeFirstRunOnboarding).toHaveBeenCalledTimes(1);
    expect(host.firstRunOnboardingActive).toBe(false);
  });

  it("does not treat /chat specially after a successful handoff", async () => {
    const onInputCallback = vi.fn();
    const host = {
      firstRunOnboardingActive: true,
      firstRunOnboardingSeedInFlight: false,
      pendingFirstRunOnboardingSeed: undefined,
      pendingUserInputs: [],
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      isFirstRunOnboardingReadyForHandoff: vi.fn(() => true),
      handleOnboardingWorkflowSeed: Reflect.get(InteractiveMode.prototype, "handleOnboardingWorkflowSeed"),
      flushPendingBashComponents: vi.fn(),
      showStatus: vi.fn(),
      completeFirstRunOnboarding: vi.fn(function(this: { firstRunOnboardingActive: boolean }) {
        this.firstRunOnboardingActive = false;
      }),
      onInputCallback,
      footer: { invalidate: vi.fn() },
      updateEditorBorderColor: vi.fn(),
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn(), setThinkingLevel: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    await submit("Implement the ticket");
    await submit("/chat explain the next step");

    expect(onInputCallback).toHaveBeenNthCalledWith(1, buildOnboardingHandoffPrompt("Implement the ticket"));
    expect(onInputCallback).toHaveBeenNthCalledWith(2, "/chat explain the next step");
  });

  it("completeProviderAuthentication attempts pending seed resume after UI refresh", async () => {
    const host = {
      session: {
        model: readyModel,
        modelRegistry: {
          refresh: vi.fn(),
          getAvailable: vi.fn(() => [readyModel]),
          hasConfiguredAuth: vi.fn(() => true),
        },
        setModel: vi.fn(),
      },
      updateAvailableProviderCount: vi.fn().mockResolvedValue(undefined),
      setupAutocompleteProvider: vi.fn(),
      footer: { invalidate: vi.fn() },
      updateEditorBorderColor: vi.fn(),
      showStatus: vi.fn(),
      showError: vi.fn(),
      maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
      resumePendingFirstRunOnboardingSeed: vi.fn().mockResolvedValue(undefined),
    };
    const complete = Reflect.get(InteractiveMode.prototype, "completeProviderAuthentication") as (
      this: typeof host,
      providerId: string,
      providerName: string,
      authType: "oauth" | "api_key",
      previousModel: typeof readyModel,
    ) => Promise<void>;

    await complete.call(host, "openai", "OpenAI", "api_key", readyModel);

    expect(host.updateAvailableProviderCount.mock.invocationCallOrder[0]).toBeLessThan(host.resumePendingFirstRunOnboardingSeed.mock.invocationCallOrder[0] ?? 0);
    expect(host.setupAutocompleteProvider.mock.invocationCallOrder[0]).toBeLessThan(host.resumePendingFirstRunOnboardingSeed.mock.invocationCallOrder[0] ?? 0);
    expect(host.resumePendingFirstRunOnboardingSeed).toHaveBeenCalledTimes(1);
  });

  it("resumes pending seeds at successful /model readiness points", async () => {
    const exactHost = {
      session: { setModel: vi.fn().mockResolvedValue(undefined) },
      findExactModelMatch: vi.fn().mockResolvedValue(readyModel),
      showModelSelector: vi.fn(),
      footer: { invalidate: vi.fn() },
      updateEditorBorderColor: vi.fn(),
      showStatus: vi.fn(),
      maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
      checkDaxnutsEasterEgg: vi.fn(),
      resumePendingFirstRunOnboardingSeed: vi.fn().mockResolvedValue(undefined),
    };
    const handleModel = Reflect.get(InteractiveMode.prototype, "handleModelCommand") as (this: typeof exactHost, searchTerm?: string) => Promise<void>;
    await handleModel.call(exactHost, "openai/gpt-5");
    expect(exactHost.resumePendingFirstRunOnboardingSeed).toHaveBeenCalledTimes(1);

    const showModelSelector = Reflect.get(InteractiveMode.prototype, "showModelSelector") as (this: Record<string, unknown>) => void;
    const selectModel = async (needsContextWindow: boolean) => {
      let selector: { onSelectCallback: (model: typeof readyModel) => Promise<void> } | undefined;
      const host = {
        ui: { requestRender: vi.fn() },
        settingsManager: SettingsManager.inMemory(),
        session: {
          model: unknownModel,
          modelRegistry: { refresh: vi.fn(), getError: vi.fn(() => undefined), getAvailable: vi.fn().mockResolvedValue([readyModel]) },
          scopedModels: [],
          setModel: vi.fn().mockResolvedValue(undefined),
          supportsContextWindowSelection: vi.fn(() => needsContextWindow),
        },
        showSelector: vi.fn((factory: (done: () => void) => { component: unknown }) => { selector = factory(vi.fn()).component as typeof selector; }),
        footer: { invalidate: vi.fn() },
        updateEditorBorderColor: vi.fn(),
        showStatus: vi.fn(),
        maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
        checkDaxnutsEasterEgg: vi.fn(),
        showContextWindowSelector: vi.fn(),
        resumePendingFirstRunOnboardingSeed: vi.fn().mockResolvedValue(undefined),
      };
      showModelSelector.call(host);
      await selector?.onSelectCallback(readyModel);
      return host;
    };

    const noContextHost = await selectModel(false);
    expect(noContextHost.showContextWindowSelector).not.toHaveBeenCalled();
    expect(noContextHost.resumePendingFirstRunOnboardingSeed).toHaveBeenCalledTimes(1);

    const needsContextHost = await selectModel(true);
    expect(needsContextHost.showContextWindowSelector).toHaveBeenCalledWith(readyModel);
    expect(needsContextHost.resumePendingFirstRunOnboardingSeed).not.toHaveBeenCalled();

    let contextSelector: { onSelectCallback: (contextWindow: number) => Promise<void> } | undefined;
    const contextHost = {
      showSelector: vi.fn((factory: (done: () => void) => { component: unknown }) => { contextSelector = factory(vi.fn()).component as typeof contextSelector; }),
      session: { model: readyModel, getAvailableContextWindows: vi.fn(() => [200000, 1000000]), setContextWindow: vi.fn() },
      footer: { invalidate: vi.fn() },
      usageMeter: { invalidate: vi.fn() },
      updateEditorBorderColor: vi.fn(),
      showStatus: vi.fn(),
      resumePendingFirstRunOnboardingSeed: vi.fn().mockResolvedValue(undefined),
    };
    const showContextWindowSelector = Reflect.get(InteractiveMode.prototype, "showContextWindowSelector") as (this: typeof contextHost, model: typeof readyModel) => void;
    showContextWindowSelector.call(contextHost, readyModel);
    await contextSelector?.onSelectCallback(1000000);
    expect(contextHost.session.setContextWindow).toHaveBeenCalledWith(1000000, { persistDefault: true });
    expect(contextHost.resumePendingFirstRunOnboardingSeed).toHaveBeenCalledTimes(1);
  });
});
