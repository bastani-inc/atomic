import type { Provider } from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import { execCommand } from "../exec.ts";
import type { ExecOptions } from "../exec.ts";
import type { EventBus } from "../event-bus.ts";
import type {
  Extension,
  EntryRenderer,
  ExtensionAPI,
  ExtensionContext,
  ExtensionRuntime,
  MessageRenderer,
  ProviderConfig,
  RegisteredCommand,
  ToolDefinition,
} from "./types.ts";
import {
  emptyWorkflowResourceProvider,
  normalizeWorkflowResourceProvider,
  type ResourceLoaderInheritanceSnapshotProvider,
  type WorkflowResourceProviderInput,
} from "./loader-resources.ts";

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
export function createExtensionAPI(
  extension: Extension,
  runtime: ExtensionRuntime,
  cwd: string,
  eventBus: EventBus,
  workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
  resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
): ExtensionAPI {
  const workflowResources = normalizeWorkflowResourceProvider(workflowResourceProvider);
  const api = {
    on(event: string, handler: HandlerFn): void {
      runtime.assertActive();
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
    },

    registerTool(tool: ToolDefinition): void {
      runtime.assertActive();
      if (!runtime.canRegisterResource(extension, "tool", tool.name)) return;
      extension.tools.set(tool.name, {
        definition: tool,
        sourceInfo: extension.sourceInfo,
      });
      runtime.refreshToolsAfterRegistration();
    },

    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
      runtime.assertActive();
      if (!runtime.canRegisterResource(extension, "command", name)) return;
      extension.commands.set(name, {
        name,
        sourceInfo: extension.sourceInfo,
        ...options,
      });
    },

    registerShortcut(
      shortcut: KeyId,
      options: {
        description?: string;
        handler: (ctx: ExtensionContext) => Promise<void> | void;
      },
    ): void {
      runtime.assertActive();
      if (!runtime.canRegisterResource(extension, "shortcut", shortcut)) return;
      extension.shortcuts.set(shortcut, {
        shortcut,
        extensionPath: extension.path,
        ...options,
      });
    },

    registerFlag(
      name: string,
      options: {
        description?: string;
        type: "boolean" | "string";
        default?: boolean | string;
      },
    ): void {
      runtime.assertActive();
      if (!runtime.canRegisterResource(extension, "flag", name)) return;
      extension.flags.set(name, {
        name,
        extensionPath: extension.path,
        ...options,
      });
      if (!runtime.flagOwners.has(name)) runtime.flagOwners.set(name, extension.path);
      const ownsFlag = runtime.flagOwners.get(name) === extension.path;
      if (ownsFlag && options.default !== undefined && !runtime.flagValues.has(name)) {
        runtime.flagValues.set(name, options.default);
      }
    },

    registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
      runtime.assertActive();
      extension.messageRenderers.set(customType, renderer as MessageRenderer);
    },

    registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
      runtime.assertActive();
      extension.entryRenderers.set(customType, renderer as EntryRenderer);
    },

    getFlag(name: string): boolean | string | undefined {
      runtime.assertActive();
      if (!extension.flags.has(name)) return undefined;
      return runtime.flagValues.get(name);
    },

    getWorkflowResources() {
      runtime.assertActive();
      return [...workflowResources.get()];
    },

    async refreshWorkflowResources() {
      runtime.assertActive();
      const refreshed = await workflowResources.refresh?.();
      return [...(refreshed ?? workflowResources.get())];
    },

    getResourceLoaderInheritanceSnapshot() {
      runtime.assertActive();
      return resourceLoaderInheritanceSnapshotProvider?.() ?? {};
    },

    sendMessage(message, options): void | Promise<void> {
      runtime.assertActive();
      return runtime.sendMessage(message, options);
    },

    sendMessages(messages, options): void | Promise<void> {
      runtime.assertActive();
      return runtime.sendMessages(messages, options);
    },

    sendUserMessage(content, options): void {
      runtime.assertActive();
      runtime.sendUserMessage(content, options);
    },

    appendEntry(customType: string, data?: unknown): void {
      runtime.assertActive();
      runtime.appendEntry(customType, data);
    },

    setSessionName(name: string): void {
      runtime.assertActive();
      runtime.setSessionName(name);
    },

    getSessionName(): string | undefined {
      runtime.assertActive();
      return runtime.getSessionName();
    },

    setLabel(entryId: string, label: string | undefined): void {
      runtime.assertActive();
      runtime.setLabel(entryId, label);
    },

    exec(command: string, args: string[], options?: ExecOptions) {
      runtime.assertActive();
      return execCommand(command, args, options?.cwd ?? cwd, options);
    },

    getActiveTools(): string[] {
      runtime.assertActive();
      return runtime.getActiveTools();
    },

    getAllTools() {
      runtime.assertActive();
      return runtime.getAllTools();
    },

    setActiveTools(toolNames: string[]): void {
      runtime.assertActive();
      runtime.setActiveTools(toolNames);
    },

    getCommands() {
      runtime.assertActive();
      return runtime.getCommands();
    },

    setModel(model) {
      runtime.assertActive();
      return runtime.setModel(model);
    },

    getThinkingLevel() {
      runtime.assertActive();
      return runtime.getThinkingLevel();
    },

    setThinkingLevel(level) {
      runtime.assertActive();
      runtime.setThinkingLevel(level);
    },

    registerProvider(nameOrProvider: string | Provider, config?: ProviderConfig) {
      runtime.assertActive();
      if (typeof nameOrProvider === "string") {
        if (!config) throw new Error("Provider config is required");
        runtime.registerProvider(nameOrProvider, config, extension.path);
      } else {
        runtime.registerProvider(nameOrProvider, extension.path);
      }
    },

    unregisterProvider(name: string) {
      runtime.assertActive();
      runtime.unregisterProvider(name, extension.path);
    },

    events: eventBus,
  } as ExtensionAPI;

  return api;
}
