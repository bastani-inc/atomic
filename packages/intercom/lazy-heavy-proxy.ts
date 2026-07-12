import type {
  AgentEndEvent, AgentStartEvent, ExtensionAPI, ExtensionContext, ExtensionHandler,
  MessageRenderer, ModelSelectEvent, RegisteredCommand, SessionShutdownEvent,
  SessionStartEvent, ToolDefinition, ToolExecutionEndEvent, ToolExecutionStartEvent,
  TurnEndEvent, TurnStartEvent,
} from "@bastani/atomic";

type CapturedCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;
type CapturedShortcut = Parameters<ExtensionAPI["registerShortcut"]>[1];
type EventHandler = Parameters<ExtensionAPI["events"]["on"]>[1];
type EventPayload = Parameters<EventHandler>[0];
const LIVE_EVENT_SUBSCRIPTIONS = new Set(["pi-intercom:detach-response"]);

export type ToolRenderResultArgs = Parameters<NonNullable<ToolDefinition["renderResult"]>>;
export type ForwardedEventMap = {
  session_start: SessionStartEvent;
  session_shutdown: SessionShutdownEvent;
  turn_start: TurnStartEvent;
  turn_end: TurnEndEvent;
  agent_start: AgentStartEvent;
  agent_end: AgentEndEvent;
  tool_execution_start: ToolExecutionStartEvent;
  tool_execution_end: ToolExecutionEndEvent;
  model_select: ModelSelectEvent;
};
type LazyLifecycleEvent = keyof ForwardedEventMap;
type ForwardedHandler<K extends LazyLifecycleEvent> = ExtensionHandler<ForwardedEventMap[K]>;
type ForwardedHandlerMap = { [K in LazyLifecycleEvent]: ForwardedHandler<K>[] };
type AnyForwardedHandler = { [K in LazyLifecycleEvent]: ForwardedHandler<K> }[LazyLifecycleEvent];

export type CapturedHeavy = {
  tools: Map<string, ToolDefinition>;
  commands: Map<string, CapturedCommand>;
  handlers: ForwardedHandlerMap;
  shortcuts: Map<string, CapturedShortcut>;
  eventHandlers: Map<string, EventHandler[]>;
};

export function createForwardedHandlerMap(): ForwardedHandlerMap {
  return {
    session_start: [], session_shutdown: [], turn_start: [], turn_end: [], agent_start: [],
    agent_end: [], tool_execution_start: [], tool_execution_end: [], model_select: [],
  };
}

function addHandler<K extends LazyLifecycleEvent>(captured: CapturedHeavy, event: K, handler: ForwardedHandler<K>): void {
  captured.handlers[event].push(handler);
}

function captureForwardedHandler(captured: CapturedHeavy, event: LazyLifecycleEvent, handler: AnyForwardedHandler): void {
  switch (event) {
    case "session_start": addHandler(captured, event, handler as ForwardedHandler<"session_start">); return;
    case "session_shutdown": addHandler(captured, event, handler as ForwardedHandler<"session_shutdown">); return;
    case "turn_start": addHandler(captured, event, handler as ForwardedHandler<"turn_start">); return;
    case "turn_end": addHandler(captured, event, handler as ForwardedHandler<"turn_end">); return;
    case "agent_start": addHandler(captured, event, handler as ForwardedHandler<"agent_start">); return;
    case "agent_end": addHandler(captured, event, handler as ForwardedHandler<"agent_end">); return;
    case "tool_execution_start": addHandler(captured, event, handler as ForwardedHandler<"tool_execution_start">); return;
    case "tool_execution_end": addHandler(captured, event, handler as ForwardedHandler<"tool_execution_end">); return;
    case "model_select": addHandler(captured, event, handler as ForwardedHandler<"model_select">);
  }
}

function addEventHandler(captured: CapturedHeavy, event: string, handler: EventHandler): void {
  const handlers = captured.eventHandlers.get(event) ?? [];
  handlers.push(handler);
  captured.eventHandlers.set(event, handlers);
}

export async function dispatchHandlers<K extends LazyLifecycleEvent>(
  captured: CapturedHeavy, eventName: K, event: ForwardedEventMap[K], ctx: ExtensionContext,
): Promise<void> {
  for (const handler of captured.handlers[eventName]) await handler(event, ctx);
}

export async function dispatchEventHandlers(captured: CapturedHeavy, eventName: string, payload: EventPayload): Promise<void> {
  for (const handler of captured.eventHandlers.get(eventName) ?? []) await handler(payload);
}

export function createHeavyProxy(pi: ExtensionAPI, captured: CapturedHeavy): ExtensionAPI {
  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "registerTool") return (tool: ToolDefinition) => captured.tools.set(tool.name, tool);
      if (prop === "registerCommand") return (name: string, options: CapturedCommand) => captured.commands.set(name, options);
      if (prop === "on") return (event: LazyLifecycleEvent, handler: AnyForwardedHandler) => captureForwardedHandler(captured, event, handler);
      if (prop === "registerShortcut") return (shortcut: string, options: CapturedShortcut) => captured.shortcuts.set(shortcut, options);
      if (prop === "registerMessageRenderer") return (customType: string, renderer: MessageRenderer) => pi.registerMessageRenderer(customType, renderer);
      if (prop === "events") {
        return new Proxy(pi.events, {
          get(eventTarget, eventProp, eventReceiver) {
            if (eventProp === "on") {
              return (event: string, handler: EventHandler) => {
                if (LIVE_EVENT_SUBSCRIPTIONS.has(event)) return pi.events.on(event, handler);
                addEventHandler(captured, event, handler);
                return () => {
                  const handlers = captured.eventHandlers.get(event) ?? [];
                  captured.eventHandlers.set(event, handlers.filter((candidate) => candidate !== handler));
                };
              };
            }
            return Reflect.get(eventTarget, eventProp, eventReceiver);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as ExtensionAPI;
}
