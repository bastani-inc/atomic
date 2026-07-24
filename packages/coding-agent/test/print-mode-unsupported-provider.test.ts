import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

const WARNING = "Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.";

function createRuntime(): {
  runtime: AgentSessionRuntime;
  prompt: ReturnType<typeof vi.fn>;
  bindExtensions: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const prompt = vi.fn(async () => {});
  const bindExtensions = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const runtime = {
    modelFallbackMessage: WARNING,
    modelFallbackReason: "configured-provider-unsupported",
    session: { prompt, bindExtensions },
    dispose,
    setRebindSession: vi.fn(),
  } as unknown as AgentSessionRuntime;
  return { runtime, prompt, bindExtensions, dispose };
}

afterEach(() => vi.restoreAllMocks());

describe("print mode unsupported provider preflight", () => {
  for (const mode of ["text", "json"] as const) {
    it(`rejects before ${mode} output or prompting`, async () => {
      const { runtime, prompt, bindExtensions, dispose } = createRuntime();
      const stdout: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk, encodingOrCallback, callback) => {
        stdout.push(String(chunk));
        if (typeof encodingOrCallback === "function") encodingOrCallback();
        else callback?.();
        return true;
      });
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

      const code = await runPrintMode(runtime, { mode, initialMessage: "must not prompt" });

      expect(code).toBe(1);
      expect(stderr).toHaveBeenCalledWith(WARNING);
      expect(stderr.mock.calls.flat().join("\n")).not.toContain("API key");
      expect(stdout.join("")).toBe("");
      expect(prompt).not.toHaveBeenCalled();
      expect(bindExtensions).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  }
});
