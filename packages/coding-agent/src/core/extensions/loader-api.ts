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
      if (runtime.canRegisterResource?.(extension, "tool", tool.name) === false) return;
      const registration = { definition: tool, sourceInfo: extension.sourceInfo };
      if (runtime.stageToolRegistration?.(extension, tool.name, registration)) return;
      extension.tools.set(tool.name, registration);
      if (runtime.refreshToolsAfterRegistration) runtime.refreshToolsAfterRegistration();
      else runtime.refreshTools();
    },

    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
      runtime.assertActive();
      if (runtime.canRegisterResource?.(extension, "command", name) === false) return;
      const registration = { name, sourceInfo: extension.sourceInfo, ...options };
      if (runtime.stageCommandRegistration?.(extension, name, registration)) return;
      extension.commands.set(name, registration);
    },

    registerShortcut(
      shortcut: KeyId,
      options: {
        description?: string;
        handler: (ctx: ExtensionContext) => Promise<void> | void;
      },
    ): void {
      runtime.assertActive();
      if (runtime.canRegisterResource?.(extension, "shortcut", shortcut) === false) return;
      const registration = { shortcut, extensionPath: extension.path, ...options };
      if (runtime.stageShortcutRegistration?.(extension, shortcut, registration)) return;
      extension.shortcuts.set(shortcut, registration);
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
      if (runtime.canRegisterResource?.(extension, "flag", name) === false) return;
      const registration = { name, extensionPath: extension.path, ...options };
      if (runtime.stageFlagRegistration?.(extension, name, registration, options.default)) return;
      extension.flags.set(name, registration);
      const flagOwners = runtime.flagOwners ??= new Map();
      const flagOwnerOrigins = runtime.flagOwnerOrigins ??= new Map();
      if (!flagOwners.has(name)) {
        flagOwners.set(name, extension.path);
        flagOwnerOrigins.set(name, extension.sourceInfo.configurationOrigin);
      }
      if (options.default !== undefined && !runtime.flagValues.has(name)) {
        if (runtime.applyFlagDefaultAfterRegistration) {
          runtime.applyFlagDefaultAfterRegistration(
            name,
            extension.path,
            options.default,
            extension.sourceInfo.configurationOrigin,
          );
        } else {
          runtime.flagValues.set(name, options.default);
        }
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
      const pendingDefault = runtime.getPendingFlagDefault?.(extension.path, name);
      if (!extension.flags.has(name) && pendingDefault === undefined) return undefined;
      return runtime.flagValues.get(name) ?? pendingDefault;
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
      return runtime.getActiveToolsAfterRegistration?.(extension) ?? runtime.getActiveTools();
    },

    getAllTools() {
      runtime.assertActive();
      return runtime.getAllToolsAfterRegistration?.(extension) ?? runtime.getAllTools();
    },

    setActiveTools(toolNames: string[]): void {
      runtime.assertActive();
      if (!runtime.setActiveToolsAfterRegistration?.(extension, toolNames)) runtime.setActiveTools(toolNames);
    },

    getCommands() {
      runtime.assertActive();
      return runtime.getCommandsAfterRegistration?.(extension) ?? runtime.getCommands();
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
