import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.ts";
import { RemoteToolExecutionComponent } from "../interactive-engine/remote-renderer.ts";
import { AssistantToolLifecycle, type ToolExecutionStartRoute } from "./assistant-tool-lifecycle.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
  type AssistantMessage,
  AssistantMessageComponent,
  ToolExecutionComponent,
} from "./interactive-mode-deps.ts";

type InteractiveToolComponent = ToolExecutionComponent | RemoteToolExecutionComponent;

const toolLifecycles = new WeakMap<
  InteractiveModeBase,
  AssistantToolLifecycle<InteractiveToolComponent>
>();

function lifecycle(mode: InteractiveModeBase): AssistantToolLifecycle<InteractiveToolComponent> {
  let state = toolLifecycles.get(mode);
  if (!state) {
    state = new AssistantToolLifecycle();
    toolLifecycles.set(mode, state);
  }
  return state;
}

export function createToolComponent(
  mode: InteractiveModeBase,
  toolName: string,
  toolCallId: string,
  args: unknown,
): InteractiveToolComponent {
  const options = {
    showImages: mode.settingsManager.getShowImages(),
    imageWidthCells: mode.settingsManager.getImageWidthCells(),
  };
  return mode.runtimeHost instanceof IsolatedInteractiveRuntime
    ? new RemoteToolExecutionComponent(
        toolName,
        toolCallId,
        args,
        options,
        mode.runtimeHost,
        () => mode.ui.requestRender(),
      )
    : new ToolExecutionComponent(
        toolName,
        toolCallId,
        args,
        options,
        mode.getRegisteredToolDefinition(toolName),
        mode.ui,
        mode.sessionManager.getCwd(),
      );
}

export function renderAssistantSnapshot(mode: InteractiveModeBase, message: AssistantMessage): void {
  let component = mode.streamingComponent;
  if (!component) {
    // RPC may drop an unsafe start; the first valid update or end restores the view.
    component = new AssistantMessageComponent(
      undefined,
      mode.hideThinkingBlock,
      mode.getMarkdownThemeWithSettings(),
      mode.hiddenThinkingLabel,
      mode.outputPad,
    );
    mode.streamingComponent = component;
    mode.chatContainer.addChild(component);
  }
  mode.streamingMessage = message;
  component.updateContent(message);
}

export function syncAssistantToolComponents(mode: InteractiveModeBase, message: AssistantMessage): void {
  for (const content of message.content) {
    if (content.type !== "toolCall") continue;
    const existing = mode.pendingTools.get(content.id);
    if (existing) {
      existing.updateArgs(content.arguments);
      lifecycle(mode).trackAssistantTool(content.id, existing);
      continue;
    }
    const component = createToolComponent(mode, content.name, content.id, content.arguments);
    component.setExpanded(mode.toolOutputExpanded);
    mode.chatContainer.addChild(component);
    mode.pendingTools.set(content.id, component);
    lifecycle(mode).trackAssistantTool(content.id, component);
  }
}

export function beginAssistantLifecycle(mode: InteractiveModeBase): void {
  for (const [toolCallId, component] of lifecycle(mode).beginAssistant()) {
    if (mode.pendingTools.get(toolCallId) === component) mode.pendingTools.delete(toolCallId);
    component.updateResult({ content: [], isError: true });
  }
}

export function closeMalformedAssistantLifecycle(mode: InteractiveModeBase): void {
  const orphaned = lifecycle(mode).closeMalformedAssistant(
    (toolCallId, component) => mode.pendingTools.get(toolCallId) === component,
  );
  for (const [toolCallId, component] of orphaned) {
    if (mode.pendingTools.get(toolCallId) === component) mode.pendingTools.delete(toolCallId);
  }
}

export function closeValidAssistantLifecycle(mode: InteractiveModeBase): void {
  lifecycle(mode).closeValidAssistant();
}

export function routeToolExecutionStart(
  mode: InteractiveModeBase,
  toolCallId: string,
): ToolExecutionStartRoute<InteractiveToolComponent> {
  return lifecycle(mode).routeExecutionStart(toolCallId);
}

export function completeToolExecution(mode: InteractiveModeBase, toolCallId: string): void {
  lifecycle(mode).completeExecution(toolCallId);
}

export function retireAssistantToolLifecycle(mode: InteractiveModeBase): void {
  const toolsToSettle = lifecycle(mode).retireExecutions(mode.pendingTools.keys());
  for (const [toolCallId, component] of toolsToSettle) {
    if (mode.pendingTools.get(toolCallId) === component) mode.pendingTools.delete(toolCallId);
    component.updateResult({ content: [], isError: true });
  }
  mode.pendingTools.clear();
}

export function resetAssistantToolLifecycle(mode: InteractiveModeBase): void {
  lifecycle(mode).reset();
}
