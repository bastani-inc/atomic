import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSingleStep } from "../../packages/subagents/src/runs/background/subagent-runner-step.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { resolveAttemptTimeoutConfig } from "../../packages/subagents/src/runs/shared/attempt-watchdog.js";
import { agentConfig, successEvent, toolEndEvent, toolStartEvent, withFakeCli } from "./subagents-attempt-watchdog-helpers.js";

describe("subagent per-attempt watchdog", () => {
  test("kills a stalled model attempt and advances to the next fallback", async () => {
    await withFakeCli(`
      const fs = require("node:fs");
      const path = require("node:path");
      const modelIndex = process.argv.indexOf("--model");
      const model = modelIndex === -1 ? "default" : process.argv[modelIndex + 1];
      fs.appendFileSync(path.join(process.cwd(), "models.log"), model + "\\n");
      if (model === "provider-a/stalled") setInterval(() => {}, 1000);
      else console.log(${JSON.stringify(successEvent("fallback ok"))});
    `, async (dir) => {
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-fallback",
        availableModels: [
          { provider: "provider-a", id: "stalled", fullId: "provider-a/stalled" },
          { provider: "provider-b", id: "working", fullId: "provider-b/working" },
        ],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.match(result.finalOutput ?? "", /fallback ok/);
      assert.deepEqual(readFileSync(join(dir, "models.log"), "utf8").trim().split("\n"), ["provider-a/stalled", "provider-b/working"]);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      assert.match(result.modelAttempts?.[0]?.error ?? "", /timed out/i);
      assert.equal(result.modelAttempts?.[1]?.success, true);
    });
  });

  test("resets the idle timer on child activity", async () => {
    await withFakeCli(`
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        process.stderr.write("tick " + ticks + "\\n");
        if (ticks === 8) {
          clearInterval(timer);
          console.log(${JSON.stringify(successEvent("activity ok"))});
        }
      }, 50);
    `, async (dir) => {
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-activity",
        modelOverride: "provider-a/stalled",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.match(result.finalOutput ?? "", /activity ok/);
      assert.equal(result.modelAttempts?.length, 1);
      assert.equal(result.modelAttempts?.[0]?.success, true);
    });
  });

  test("does not trip the idle watchdog while a slow tool call is active", async () => {
    await withFakeCli(`
      console.log(${JSON.stringify(toolStartEvent)});
      setTimeout(() => {
        console.log(${JSON.stringify(toolEndEvent)});
        console.log(${JSON.stringify(successEvent("tool ok"))});
      }, 700);
    `, async (dir) => {
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-tool-active",
        modelOverride: "provider-a/stalled",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.match(result.finalOutput ?? "", /tool ok/);
      assert.equal(result.modelAttempts?.length, 1);
      assert.equal(result.modelAttempts?.[0]?.success, true);
    });
  });

  test("trips the idle watchdog when the child stalls after a tool call ends", async () => {
    await withFakeCli(`
      const modelIndex = process.argv.indexOf("--model");
      const model = modelIndex === -1 ? "default" : process.argv[modelIndex + 1];
      if (model === "provider-a/stalled") {
        console.log(${JSON.stringify(toolStartEvent)});
        console.log(${JSON.stringify(toolEndEvent)});
        setInterval(() => {}, 1000);
      } else {
        console.log(${JSON.stringify(successEvent("fallback ok"))});
      }
    `, async (dir) => {
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-post-tool-stall",
        availableModels: [
          { provider: "provider-a", id: "stalled", fullId: "provider-a/stalled" },
          { provider: "provider-b", id: "working", fullId: "provider-b/working" },
        ],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 0);
      assert.match(result.finalOutput ?? "", /fallback ok/);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      assert.match(result.modelAttempts?.[0]?.error ?? "", /without child activity/i);
      assert.equal(result.modelAttempts?.[1]?.success, true);
    });
  });

  test("wall-clock cap is the backstop when a tool never emits its end event", async () => {
    await withFakeCli(`
      const modelIndex = process.argv.indexOf("--model");
      const model = modelIndex === -1 ? "default" : process.argv[modelIndex + 1];
      if (model === "provider-a/stalled") {
        // Tool starts but its end event is never emitted (abnormal tool end):
        // isToolActive stays true, so the idle watchdog is deferred indefinitely
        // and the wall-clock cap must terminate the attempt.
        console.log(${JSON.stringify(toolStartEvent)});
        setInterval(() => {}, 1000);
      } else {
        console.log(${JSON.stringify(successEvent("fallback ok"))});
      }
    `, async (dir) => {
      process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = "700";
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-abnormal-tool-end",
        availableModels: [
          { provider: "provider-a", id: "stalled", fullId: "provider-a/stalled" },
          { provider: "provider-b", id: "working", fullId: "provider-b/working" },
        ],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 0);
      assert.match(result.finalOutput ?? "", /fallback ok/);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      assert.match(result.modelAttempts?.[0]?.error ?? "", /timed out after 700ms\./i);
      assert.doesNotMatch(result.modelAttempts?.[0]?.error ?? "", /without child activity/i);
      assert.equal(result.modelAttempts?.[1]?.success, true);
    });
  });

  test("enforces the wall-clock cap even with steady child activity", async () => {
    await withFakeCli(`
      const modelIndex = process.argv.indexOf("--model");
      const model = modelIndex === -1 ? "default" : process.argv[modelIndex + 1];
      if (model === "provider-a/stalled") setInterval(() => process.stderr.write("tick\\n"), 50);
      else console.log(${JSON.stringify(successEvent("fallback ok"))});
    `, async (dir) => {
      process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = "600";
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-wall-cap",
        availableModels: [
          { provider: "provider-a", id: "stalled", fullId: "provider-a/stalled" },
          { provider: "provider-b", id: "working", fullId: "provider-b/working" },
        ],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 0);
      assert.match(result.finalOutput ?? "", /fallback ok/);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      assert.match(result.modelAttempts?.[0]?.error ?? "", /timed out after 600ms\./i);
      assert.doesNotMatch(result.modelAttempts?.[0]?.error ?? "", /without child activity/i);
      assert.equal(result.modelAttempts?.[1]?.success, true);
    });
  });

  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    await withFakeCli(`
      const modelIndex = process.argv.indexOf("--model");
      const model = modelIndex === -1 ? "default" : process.argv[modelIndex + 1];
      if (model === "provider-a/stalled") {
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      } else {
        console.log(${JSON.stringify(successEvent("fallback ok"))});
      }
    `, async (dir) => {
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-sigkill-escalation",
        availableModels: [
          { provider: "provider-a", id: "stalled", fullId: "provider-a/stalled" },
          { provider: "provider-b", id: "working", fullId: "provider-b/working" },
        ],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 0);
      assert.match(result.finalOutput ?? "", /fallback ok/);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      assert.match(result.modelAttempts?.[0]?.error ?? "", /timed out/i);
      assert.equal(result.modelAttempts?.[1]?.success, true);
    });
  });

  test("background runner keeps a silent tool call alive past the idle window", async () => {
    await withFakeCli(`
      console.log(${JSON.stringify(toolStartEvent)});
      setTimeout(() => {
        console.log(${JSON.stringify(toolEndEvent)});
        console.log(${JSON.stringify(successEvent("background tool ok"))});
      }, 700);
    `, async (dir) => {
      const result = await runSingleStep({
        agent: "fake-worker",
        task: "Do work",
        inheritProjectContext: false,
        inheritSkills: false,
      }, {
        previousOutput: "",
        placeholder: "{previous}",
        cwd: dir,
        sessionEnabled: false,
        id: "background-tool-active",
        flatIndex: 0,
        flatStepCount: 1,
        outputFile: join(dir, "output.txt"),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.match(result.output, /background tool ok/);
    });
  });

  test("ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS=0 disables the idle watchdog", async () => {
    await withFakeCli(`
      const modelIndex = process.argv.indexOf("--model");
      const model = modelIndex === -1 ? "default" : process.argv[modelIndex + 1];
      if (model === "provider-a/stalled") setInterval(() => {}, 1000);
      else console.log(${JSON.stringify(successEvent("fallback ok"))});
    `, async (dir) => {
      process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS = "0";
      process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = "600";
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-idle-disabled",
        availableModels: [
          { provider: "provider-a", id: "stalled", fullId: "provider-a/stalled" },
          { provider: "provider-b", id: "working", fullId: "provider-b/working" },
        ],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 0);
      assert.match(result.finalOutput ?? "", /fallback ok/);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      // A fully silent child must outlive the (disabled) idle window and only be
      // bounded by the wall-clock cap.
      assert.match(result.modelAttempts?.[0]?.error ?? "", /timed out after 600ms\./i);
      assert.doesNotMatch(result.modelAttempts?.[0]?.error ?? "", /without child activity/i);
      assert.equal(result.modelAttempts?.[1]?.success, true);
    });
  });

  test("non-numeric watchdog overrides are ignored and defaults apply", async () => {
    const previousIdle = process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS;
    const previousWall = process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS;
    process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS = "soon";
    process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = "-100";
    try {
      const config = resolveAttemptTimeoutConfig();
      assert.equal(config.idleMs, 5 * 60_000);
      assert.equal(config.wallMs, 0);
    } finally {
      if (previousIdle === undefined) delete process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS;
      else process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS = previousIdle;
      if (previousWall === undefined) delete process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS;
      else process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = previousWall;
    }
  });
});
