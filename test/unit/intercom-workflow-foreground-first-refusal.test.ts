import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { IntercomExtensionTestOverrides } from "../../packages/intercom/intercom-test-seams.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

interface HandlerContext {
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly model: { readonly id: string };
  readonly isIdle: () => boolean;
  readonly ui: { readonly notify: () => void };
  readonly sessionManager: { readonly getSessionId: () => string };
  readonly orchestrationContext: {
    readonly kind: "workflow-stage";
    readonly messageAdmission: { readonly isOpen: () => boolean };
  };
}

type LifecycleHandler = (event: object, context: HandlerContext) => void | Promise<void>;
type AcknowledgementMode = "all" | "none" | "probe-only";

const sender: SessionInfo = {
  id: "child-id",
  name: "subagent-worker-run-1",
  cwd: "/repo",
  model: "test",
  pid: 1,
  startedAt: 1,
  lastActivity: 1,
};
const message: Message = {
  id: "blocking-question",
  timestamp: 1,
  expectsReply: true,
  content: { text: "Choose A or B" },
};

function fixture(acknowledgement: AcknowledgementMode) {
  const lifecycle = new Map<string, LifecycleHandler[]>();
  const events = new Map<string, Array<(payload: Record<string, unknown>) => void>>();
  const order: string[] = [];
  const delivered = Promise.withResolvers<void>();
  let inbound: Parameters<NonNullable<IntercomExtensionTestOverrides["captureInboundHandler"]>>[0] | undefined;
  const pi = {
    on(name: string, handler: LifecycleHandler) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
    },
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    appendEntry() {},
    getSessionName: () => undefined,
    async sendMessage(_message: object, options?: { stageAdmissionBarrier?: () => Promise<void> }) {
      order.push("agent-session:generation-admission");
      await options?.stageAdmissionBarrier?.();
      order.push("agent-session:queue-delivery");
      delivered.resolve();
    },
    events: {
      on(name: string, handler: (payload: Record<string, unknown>) => void) {
        const handlers = events.get(name) ?? [];
        handlers.push(handler);
        events.set(name, handlers);
        return () => events.set(name, (events.get(name) ?? []).filter((candidate) => candidate !== handler));
      },
      emit(name: string, payload: Record<string, unknown>) {
        if (name === "pi-intercom:detach-request") {
          order.push(`foreground-owner:${String(payload.phase)}`);
          const acknowledge = acknowledgement === "all"
            || (acknowledgement === "probe-only" && payload.phase === "probe");
          if (acknowledge) {
            for (const handler of events.get("pi-intercom:detach-response") ?? []) {
              handler({ ...payload, accepted: true });
            }
          }
        }
        for (const handler of events.get(name) ?? []) handler(payload);
      },
    },
  };
  intercomHeavy(pi as never, { captureInboundHandler: (handler) => { inbound = handler; } });
  const context: HandlerContext = {
    hasUI: false,
    cwd: process.cwd(),
    model: { id: "test-model" },
    isIdle: () => false,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => "workflow-stage-session" },
    orchestrationContext: {
      kind: "workflow-stage",
      messageAdmission: { isOpen: () => true },
    },
  };
  return { lifecycle, order, delivered: delivered.promise, context, get inbound() { return inbound; } };
}

async function start(current: ReturnType<typeof fixture>): Promise<void> {
  for (const handler of current.lifecycle.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, current.context);
  }
}

async function deliver(current: ReturnType<typeof fixture>, id: string): Promise<void> {
  await start(current);
  assert.ok(current.inbound);
  current.inbound(current.context as never, sender, { ...message, id });
  await current.delivered;
}

describe("busy workflow foreground-owner admission", () => {
  test("admits into the stage generation before exact foreground detach, then queues after commit", async () => {
    const current = fixture("all");
    await deliver(current, message.id);
    assert.deepEqual(current.order, [
      "agent-session:generation-admission",
      "foreground-owner:probe",
      "foreground-owner:commit",
      "agent-session:queue-delivery",
    ]);
  });

  test("unclaimed traffic queues inside the already-admitted stage generation", async () => {
    const current = fixture("none");
    await deliver(current, "unclaimed-question");
    assert.deepEqual(current.order, [
      "agent-session:generation-admission",
      "foreground-owner:probe",
      "agent-session:queue-delivery",
    ]);
  });

  test("a live stage queues when its foreground owner disappears before commit", async () => {
    const current = fixture("probe-only");
    await deliver(current, "owner-lost-question");
    assert.deepEqual(current.order, [
      "agent-session:generation-admission",
      "foreground-owner:probe",
      "foreground-owner:commit",
      "agent-session:queue-delivery",
    ]);
  });
});
