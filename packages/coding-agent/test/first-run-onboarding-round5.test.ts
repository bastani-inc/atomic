import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { assessOnboardingRoute, type OnboardingRoutingAssessment } from "../src/modes/interactive/interactive-onboarding.ts";

function getAssess(): (this: Record<string, unknown>, seed: string) => Promise<OnboardingRoutingAssessment> {
  return Reflect.get(InteractiveMode.prototype, "runOnboardingRoutingAssessment") as (
    this: Record<string, unknown>,
    seed: string,
  ) => Promise<OnboardingRoutingAssessment>;
}

function hostWithSubagent(execute: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return {
    sessionManager: { getCwd: () => process.cwd() },
    session: {
      getToolDefinition: (name: string) => name === "subagent" ? { execute } : undefined,
      extensionRunner: { createContext: () => ({}) },
    },
  };
}

describe("first-run onboarding round 5 regressions", () => {
  it("runs bounded targeted follow-up probe roles with read-only args when locator signal is insufficient", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "not json" }], details: { results: [] } })
      .mockResolvedValueOnce({
        details: { results: [{ finalOutput: JSON.stringify({
          workflow: "ralph",
          estimatedChangedLines: 2600,
          estimatedUniqueFiles: 10,
          touchedAreas: ["packages/coding-agent", "packages/workflows"],
          reason: "Follow-up evidence says ralph for non-trivial work over about 2K LoC.",
        }) }] },
      });

    const assessment = await getAssess().call(
      hostWithSubagent(execute),
      "Refactor onboarding routing to match existing patterns and React 19 API behavior",
    );

    expect(assessment.workflow).toBe("ralph");
    expect(execute).toHaveBeenCalledTimes(2);
    const followupArgs = execute.mock.calls[1]?.[1];
    expect(followupArgs).toMatchObject({
      context: "fresh",
      async: false,
      clarify: false,
      output: false,
      reads: false,
      artifacts: false,
      agentScope: "both",
      concurrency: 3,
    });
    expect(followupArgs.tasks.map((task: { agent: string }) => task.agent)).toEqual([
      "codebase-analyzer",
      "codebase-pattern-finder",
      "codebase-online-researcher",
    ]);
    for (const task of followupArgs.tasks) {
      expect(task).toMatchObject({ output: false, reads: false });
      expect(task.task).toContain("read-only");
      expect(task.task).toContain("do not edit files");
    }
  });

  it("still runs pattern and online follow-ups when locator provides numeric estimates", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({
        workflow: "goal",
        estimatedChangedLines: 400,
        estimatedUniqueFiles: 3,
        touchedAreas: ["packages/coding-agent"],
        reason: "Locator estimates a bounded goal-sized change.",
      }) }] })
      .mockResolvedValueOnce({ details: { results: [{ finalOutput: JSON.stringify({
        workflow: "goal",
        estimatedChangedLines: 600,
        estimatedUniqueFiles: 4,
        touchedAreas: ["packages/coding-agent"],
        reason: "Targeted probes still estimate goal scope.",
      }) }] } });

    const assessment = await getAssess().call(
      hostWithSubagent(execute),
      "Migrate existing request patterns to React 19 external API behavior",
    );

    expect(assessment.workflow).toBe("goal");
    expect(execute).toHaveBeenCalledTimes(2);
    const followupArgs = execute.mock.calls[1]?.[1];
    expect(followupArgs).toMatchObject({
      context: "fresh",
      async: false,
      clarify: false,
      output: false,
      reads: false,
      artifacts: false,
      agentScope: "both",
      concurrency: 2,
    });
    expect(followupArgs.tasks.map((task: { agent: string }) => task.agent)).toEqual([
      "codebase-pattern-finder",
      "codebase-online-researcher",
    ]);
  });

  it("reconciles multiple follow-up results conservatively when any result is broad", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({
        workflow: "goal",
        estimatedChangedLines: 300,
        estimatedUniqueFiles: 2,
        touchedAreas: ["packages/coding-agent"],
        reason: "Locator estimates a bounded goal-sized change.",
      }) }] })
      .mockResolvedValueOnce({ details: { results: [
        { finalOutput: JSON.stringify({
          workflow: "goal",
          estimatedChangedLines: 500,
          estimatedUniqueFiles: 3,
          touchedAreas: ["packages/coding-agent"],
          reason: "Pattern probe initially looks localized.",
        }) },
        { finalOutput: JSON.stringify({
          workflow: "ralph",
          estimatedChangedLines: 2600,
          estimatedUniqueFiles: 12,
          touchedAreas: ["packages/coding-agent", "packages/workflows", "test"],
          reason: "Online probe found broad API migration impact over about 2K LoC.",
        }) },
      ] } });

    const assessment = await getAssess().call(
      hostWithSubagent(execute),
      "Update repeated integration patterns for an external SDK API migration",
    );

    expect(assessment.workflow).toBe("ralph");
    expect(assessment.estimatedChangedLines).toBe(2600);
    expect(assessment.estimatedUniqueFiles).toBe(12);
    expect(assessment.touchedAreas).toContain("packages/workflows");
    expect(assessment.reason).toContain("Conservative reconciliation");
  });

  it("keeps broad locator evidence when a follow-up probe narrows the estimate", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({
        workflow: "ralph",
        estimatedChangedLines: 2600,
        estimatedUniqueFiles: 10,
        touchedAreas: ["packages/coding-agent", "packages/workflows"],
        reason: "Locator found broad repeated migration scope over about 2K LoC.",
      }) }] })
      .mockResolvedValueOnce({ details: { results: [{ finalOutput: JSON.stringify({
        workflow: "goal",
        estimatedChangedLines: 500,
        estimatedUniqueFiles: 3,
        touchedAreas: ["packages/coding-agent"],
        reason: "Follow-up saw only a localized pattern.",
      }) }] } });

    const assessment = await getAssess().call(
      hostWithSubagent(execute),
      "Migrate repeated onboarding patterns for an external API behavior change",
    );

    expect(assessment.workflow).toBe("ralph");
    expect(assessment.estimatedChangedLines).toBe(2600);
    expect(assessment.estimatedUniqueFiles).toBe(10);
    expect(assessment.reason).toContain("Conservative reconciliation");
  });

  it("normalizes URL-only seeds with subagent goal output to ralph", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({
      workflow: "goal",
      estimatedChangedLines: 100,
      estimatedUniqueFiles: 1,
      touchedAreas: [],
      reason: "Subagent guessed this bug was a small goal task.",
    }) }] });

    const assessment = await getAssess().call(
      hostWithSubagent(execute),
      "fix bug https://github.com/acme/widget/issues/123",
    );

    expect(assessment.workflow).toBe("ralph");
    expect(assessment.reason).toContain("URL-only seed has no localizing repository evidence");
  });

  it("routes URL-only fix/bug seeds conservatively to ralph without localizing evidence", () => {
    const issue = assessOnboardingRoute("fix bug https://github.com/acme/widget/issues/123", process.cwd());
    const local = assessOnboardingRoute("fix bug in packages/coding-agent/src/foo.ts", process.cwd());

    expect(issue.workflow).toBe("ralph");
    expect(issue.reason).toContain("conservatively routes to ralph");
    expect(local.workflow).toBe("goal");
  });

  it("adds low-confidence wording to timeout and cancellation fallback reasons", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const execute = vi.fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({ isError: true, content: "Operation cancelled by timeout cap" });

    const aborted = await getAssess().call(hostWithSubagent(execute), "Fix typo in packages/coding-agent/docs/quickstart.md");
    const cancelled = await getAssess().call(hostWithSubagent(execute), "Add SAML SSO support with user provisioning");

    expect(aborted.reason).toContain("Low-confidence fallback");
    expect(aborted.reason).toContain("aborted or cancelled");
    expect(cancelled.reason).toContain("Low-confidence fallback");
    expect(cancelled.reason).toContain("timed out or was cancelled");
  });

  it("preserves broad locator evidence when follow-up probes timeout or cancel", async () => {
    const locatorOutput = {
      workflow: "ralph",
      estimatedChangedLines: 2600,
      estimatedUniqueFiles: 10,
      touchedAreas: ["packages/coding-agent", "packages/workflows"],
      reason: "Locator found broad repeated migration scope over about 2K LoC.",
    };
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    const timedOutExecute = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify(locatorOutput) }] })
      .mockRejectedValueOnce(timeoutError);
    const cancelledExecute = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify(locatorOutput) }] })
      .mockResolvedValueOnce({ isError: true, content: "Operation cancelled by timeout cap" });

    const timedOut = await getAssess().call(
      hostWithSubagent(timedOutExecute),
      "Migrate repeated onboarding patterns for an external API behavior change",
    );
    const cancelled = await getAssess().call(
      hostWithSubagent(cancelledExecute),
      "Migrate repeated onboarding patterns for an external API behavior change",
    );

    for (const assessment of [timedOut, cancelled]) {
      expect(assessment.workflow).toBe("ralph");
      expect(assessment.estimatedChangedLines).toBe(2600);
      expect(assessment.estimatedUniqueFiles).toBe(10);
      expect(assessment.touchedAreas).toContain("packages/workflows");
      expect(assessment.reason).toContain("Locator found broad repeated migration scope");
      expect(assessment.reason).toContain("Low-confidence fallback");
    }
  });
});
