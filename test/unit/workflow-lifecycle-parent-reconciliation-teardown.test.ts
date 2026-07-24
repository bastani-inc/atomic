import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.js";
import type { AgentSessionServices } from "../../packages/coding-agent/src/core/agent-session-services.js";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../../packages/coding-agent/src/core/agent-session-persistent-custom-messages.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { installWorkflowLifecycleNotifications } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { lifecycleConfig } from "./workflow-lifecycle-parent-reconciliation-support.js";

describe("workflow lifecycle parent reconciliation teardown", () => {
  const harnesses: Harness[] = [];
  const unsubscriptions: Array<() => void> = [];

  afterEach(() => {
    while (unsubscriptions.length > 0) unsubscriptions.pop()?.();
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  test("permanent consumed-reconciliation persistence failure stops host replacement before invalidation", async () => {
    const store = createStore();
    store.recordRunStart({
      id: "run-permanent-persistence",
      name: "permanent-persistence",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: 1,
    });
    const harness = await createHarness({
      fauxProvider: { tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } },
    });
    harnesses.push(harness);
    const oldSession = harness.session;
    const appendCustomMessageEntry = oldSession.sessionManager.appendCustomMessageEntry.bind(oldSession.sessionManager);
    let hiddenPersistenceAttempts = 0;
    oldSession.sessionManager.appendCustomMessageEntry = ((customType, content, display, details, excludeFromContext) => {
      if (customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE) {
        hiddenPersistenceAttempts += 1;
        throw new Error("permanent hidden reconciliation write failure");
      }
      return appendCustomMessageEntry(customType, content, display, details, excludeFromContext);
    }) as typeof oldSession.sessionManager.appendCustomMessageEntry;

    let runtime: AgentSessionRuntime | undefined;
    try {
      unsubscriptions.push(installWorkflowLifecycleNotifications({
        store,
        config: lifecycleConfig,
        seedExisting: false,
        sendMessage: (message, options) => oldSession.sendCustomMessage(message, options),
      }));
      let terminalized = false;
      unsubscriptions.push(oldSession.subscribe((event) => {
        if (!terminalized && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          terminalized = true;
          assert.equal(store.recordRunEnd("run-permanent-persistence", "completed", {}), true);
        }
      }));
      harness.setResponses([
        fauxAssistantMessage("This stale response is still proceeding while the workflow completes."),
        fauxAssistantMessage("permanent-persistence completed and was reconciled."),
      ]);

      await oldSession.prompt("Wait for permanent-persistence.");
      await oldSession.agent.waitForIdle();

      const protectedEntries = (oldSession as typeof oldSession & {
        _protectedStreamingCustomMessages: Array<{
          readonly message: object;
          readonly delivery: "steer" | "followUp";
          phase: "queued" | "consumed-unpersisted" | "persistence-failed";
        }>;
      })._protectedStreamingCustomMessages;
      assert.equal(terminalized, true);
      assert.ok(hiddenPersistenceAttempts >= 1);
      assert.equal(protectedEntries.length, 1);
      const protectedEntry = protectedEntries[0];
      assert.ok(protectedEntry);
      assert.equal(protectedEntry.phase, "persistence-failed");

      let createRuntimeCalls = 0;
      let beforeSessionInvalidateCalls = 0;
      let rebindCalls = 0;
      runtime = new AgentSessionRuntime(
        oldSession,
        {
          cwd: oldSession.sessionManager.getCwd(),
          agentDir: harness.tempDir,
        } as AgentSessionServices,
        async () => {
          createRuntimeCalls += 1;
          throw new Error("replacement factory must not run");
        },
      );
      runtime.setBeforeSessionInvalidate(() => {
        beforeSessionInvalidateCalls += 1;
      });
      runtime.setRebindSession(async () => {
        rebindCalls += 1;
      });
      const liveContextCwd = oldSession.extensionRunner.createContext().cwd;

      await assert.rejects(runtime.newSession(), /permanent hidden reconciliation write failure/);

      assert.equal(hiddenPersistenceAttempts >= 2, true, "host teardown must make the final persistence attempt");
      assert.equal(beforeSessionInvalidateCalls, 0);
      assert.equal(createRuntimeCalls, 0);
      assert.equal(rebindCalls, 0);
      assert.equal(runtime.session, oldSession, "the host must retain the recoverable session");
      assert.equal(oldSession.extensionRunner.createContext().cwd, liveContextCwd, "extensions must remain valid");
      assert.equal(protectedEntries.length, 1, "protected recovery state must not be discarded");
      assert.equal(protectedEntries[0], protectedEntry);
      assert.equal(protectedEntry.phase, "persistence-failed");
    } finally {
      runtime?.setBeforeSessionInvalidate(undefined);
      runtime?.setRebindSession(undefined);
      oldSession.sessionManager.appendCustomMessageEntry = appendCustomMessageEntry;
    }
  });
});
