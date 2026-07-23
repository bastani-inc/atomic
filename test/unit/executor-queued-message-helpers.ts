import type { AgentSessionEvent, PromptOptions } from "@bastani/atomic";
import {
  assert,
  createStageControlRegistry,
  createStore,
  deferred,
  mockSession,
  run,
  waitForPromptCall,
  workflow,
  RESUME_CONTINUATION_PROMPT,
  type StageSessionRuntime,
  type WorkflowDefinition,
} from "./executor-shared.js";

export interface QueuedMessageRecorder {
  readonly promptCalls: string[];
  readonly sdkPromptCalls: Array<{ readonly text: string; readonly behavior: "steer" | "followUp" }>;
  readonly steerCalls: string[];
  readonly followUpCalls: string[];
  readonly sendUserMessageCalls: Array<{ readonly text: string; readonly behavior: "steer" | "followUp" }>;
}

export type StreamingTurnSession = StageSessionRuntime & {
  finishTurn(): void;
};
export function newRecorder(): QueuedMessageRecorder {
  return { promptCalls: [], sdkPromptCalls: [], steerCalls: [], followUpCalls: [], sendUserMessageCalls: [] };
}

/**
 * Models the public AgentSession queue contract: queue_update publishes queue
 * additions, and consumption publishes the reduced queue immediately before
 * the matching user message_start. Follow-ups are consumed at the turn
 * boundary, while steering is consumed during the active turn.
 */
export function streamingTurnSession(recorder: QueuedMessageRecorder): StreamingTurnSession {
  type Listener = Parameters<StageSessionRuntime["subscribe"]>[0];
  const listeners = new Set<Listener>();
  const steering: string[] = [];
  const followUp: string[] = [];
  let streaming = false;
  let resolveTurn: (() => void) | undefined;
  let rejectTurn: ((error: Error) => void) | undefined;
  const emit = (event: AgentSessionEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const emitQueue = (): void => emit({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
  const emitUserMessage = (text: string): void => emit({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  } as AgentSessionEvent);
  const queue = (messages: string[], text: string): void => {
    messages.push(text);
    emitQueue();
  };
  const consume = (messages: string[], text: string): void => {
    const index = messages.indexOf(text);
    assert.notEqual(index, -1, `queued message ${JSON.stringify(text)} should exist`);
    messages.splice(index, 1);
    emitQueue();
    emitUserMessage(text);
  };
  const queueSteer = (text: string): void => {
    queue(steering, text);
    consume(steering, text);
  };
  const queueFollowUp = (text: string): void => queue(followUp, text);
  return {
    ...mockSession(),
    // Makes the fake visible through handle.agentSession, matching the SDK path.
    state: {} as never,
    sessionManager: {} as never,
    modelRegistry: {} as never,
    getContextUsage: (() => undefined) as never,
    get isStreaming() { return streaming; },
    get pendingMessageCount() { return steering.length + followUp.length; },
    async prompt(text: string, options?: PromptOptions) {
      if (streaming && options?.streamingBehavior !== undefined) {
        recorder.sdkPromptCalls.push({ text, behavior: options.streamingBehavior });
        if (options.streamingBehavior === "followUp") queueFollowUp(text);
        else queueSteer(text);
        return;
      }
      recorder.promptCalls.push(text);
      emit({ type: "agent_start" });
      emitUserMessage(text);
      if (text === RESUME_CONTINUATION_PROMPT) {
        emit({ type: "agent_end", messages: [] });
        return;
      }
      streaming = true;
      try {
        await new Promise<void>((resolve, reject) => {
          resolveTurn = resolve;
          rejectTurn = reject;
        });
      } finally {
        streaming = false;
      }
    },
    async sendUserMessage(content: string | readonly object[], options?: { deliverAs?: "steer" | "followUp" }) {
      assert.ok(typeof content === "string");
      const behavior = options?.deliverAs ?? "followUp";
      recorder.sendUserMessageCalls.push({ text: content, behavior });
      if (behavior === "steer") queueSteer(content);
      else queueFollowUp(content);
    },
    async steer(text: string) {
      recorder.steerCalls.push(text);
      queueSteer(text);
    },
    async followUp(text: string) {
      recorder.followUpCalls.push(text);
      queueFollowUp(text);
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async abort() {
      const reject = rejectTurn;
      resolveTurn = undefined;
      rejectTurn = undefined;
      reject?.(new Error("AbortError"));
    },
    getLastAssistantText() { return "assistant"; },
    finishTurn() {
      for (const text of [...followUp]) consume(followUp, text);
      emit({ type: "agent_end", messages: [] });
      const resolve = resolveTurn;
      resolveTurn = undefined;
      rejectTurn = undefined;
      resolve?.();
    },
  } as StreamingTurnSession;
}

function singleStageWorkflow(name: string): WorkflowDefinition {
  return workflow({
    name,
    description: "",
    inputs: {},
    outputs: {},
    run: async (ctx) => {
      await ctx.stage("worker").prompt("go");
      return {};
    },
  });
}

export async function runStreamingStage(input: {
  readonly workflowName: string;
  readonly session: StreamingTurnSession;
  readonly recorder: QueuedMessageRecorder;
  readonly signal?: AbortSignal;
  readonly gateEnabled?: boolean;
}): Promise<{
  runPromise: ReturnType<typeof run>;
  handle: NonNullable<ReturnType<ReturnType<typeof createStageControlRegistry>["get"]>>;
}> {
  const registry = createStageControlRegistry();
  const sawStage = deferred<{ runId: string; stageId: string }>();
  let sawStageResolved = false;
  const runPromise = run(singleStageWorkflow(input.workflowName), {}, {
    adapters: { agentSession: { async create() { return input.session; } } },
    store: createStore(),
    stageControlRegistry: registry,
    onStageStart: (runId, stage) => {
      if (sawStageResolved) return;
      sawStageResolved = true;
      sawStage.resolve({ runId, stageId: stage.id });
    },
    ...(input.gateEnabled === false ? {} : { confirmStageReadiness: async () => true }),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const { runId, stageId } = await sawStage.promise;
  await waitForPromptCall(input.recorder.promptCalls, "go");
  const handle = registry.get(runId, stageId);
  assert.ok(handle, "stage handle should be registered");
  assert.equal(handle.isStreaming, true);
  return { runPromise, handle };
}
