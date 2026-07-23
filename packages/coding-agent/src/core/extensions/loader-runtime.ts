import type {
  Extension,
  ExtensionFlag,
  ExtensionRuntime,
  ExtensionShortcut,
  RegisteredCommand,
  RegisteredTool,
} from "./types.ts";

export async function runResourceRegistrationBatch<T>(runtime: ExtensionRuntime, run: () => Promise<T>): Promise<T> {
  if (!runtime.beginResourceRegistrationBatch || !runtime.endResourceRegistrationBatch) return run();
  runtime.beginResourceRegistrationBatch();
  try {
    return await run();
  } finally {
    runtime.endResourceRegistrationBatch();
  }
}

function registrationKey(extension: Extension, name: string): string {
  return `${extension.path}\0${name}`;
}

/** Create a runtime with throwing stubs for action methods. */
export function createExtensionRuntime(): ExtensionRuntime {
  const notInitialized = () => {
    throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
  };
  const state: { staleMessage?: string } = {};
  let batchDepth = 0;
  const pendingTools = new Map<string, { extension: Extension; name: string; registration: RegisteredTool }>();
  const pendingCommands = new Map<string, { extension: Extension; name: string; registration: RegisteredCommand }>();
  const pendingFlags = new Map<string, { extension: Extension; name: string; registration: ExtensionFlag; defaultValue?: boolean | string }>();
  const pendingShortcuts = new Map<string, { extension: Extension; name: string; registration: ExtensionShortcut }>();
  const shouldStage = (extension: Extension) => batchDepth > 0 && extension.sourceInfo.configurationOrigin === "inherited-pi";
  let pendingActiveToolNames: string[] | undefined;
  const assertActive = () => {
    if (state.staleMessage) throw new Error(state.staleMessage);
  };

  const runtime: ExtensionRuntime = {
    sendMessage: notInitialized,
    sendMessages: notInitialized,
    sendUserMessage: notInitialized,
    appendEntry: notInitialized,
    setSessionName: notInitialized,
    getSessionName: notInitialized,
    setLabel: notInitialized,
    getActiveTools: notInitialized,
    getAllTools: notInitialized,
    setActiveTools: notInitialized,
    refreshTools: () => {},
    getCommands: notInitialized,
    setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
    getThinkingLevel: notInitialized,
    setThinkingLevel: notInitialized,
    flagValues: new Map(),
    explicitFlagNames: new Set(),
    flagOwners: new Map(),
    pendingProviderRegistrations: [],
    canRegisterResource: () => true,
    beginResourceRegistrationBatch: () => { batchDepth += 1; },
    endResourceRegistrationBatch: () => {
      batchDepth -= 1;
      if (batchDepth !== 0) return;
      const refreshTools = pendingTools.size > 0;
      for (const pending of pendingTools.values()) pending.extension.tools.set(pending.name, pending.registration);
      for (const pending of pendingCommands.values()) pending.extension.commands.set(pending.name, pending.registration);
      for (const pending of pendingFlags.values()) {
        pending.extension.flags.set(pending.name, pending.registration);
        if (runtime.flagOwners?.get(pending.name) === pending.extension.path
          && pending.defaultValue !== undefined && !runtime.flagValues.has(pending.name)) {
          runtime.flagValues.set(pending.name, pending.defaultValue);
        }
      }
      for (const pending of pendingShortcuts.values()) pending.extension.shortcuts.set(pending.name as never, pending.registration);
      pendingTools.clear();
      pendingCommands.clear();
      pendingFlags.clear();
      pendingShortcuts.clear();
      if (refreshTools) runtime.refreshTools();
      if (pendingActiveToolNames) runtime.setActiveTools(pendingActiveToolNames);
      pendingActiveToolNames = undefined;
    },
    stageToolRegistration: (extension, name, registration) => {
      if (!shouldStage(extension)) return false;
      pendingTools.set(registrationKey(extension, name), { extension, name, registration });
      if (pendingActiveToolNames && !pendingActiveToolNames.includes(name)) pendingActiveToolNames.push(name);
      return true;
    },
    stageCommandRegistration: (extension, name, registration) => {
      if (!shouldStage(extension)) return false;
      pendingCommands.set(registrationKey(extension, name), { extension, name, registration });
      return true;
    },
    stageFlagRegistration: (extension, name, registration, defaultValue) => {
      if (!shouldStage(extension)) return false;
      const key = registrationKey(extension, name);
      const firstDefault = pendingFlags.get(key)?.defaultValue;
      pendingFlags.set(key, { extension, name, registration, defaultValue: firstDefault ?? defaultValue });
      const owners = runtime.flagOwners ??= new Map();
      if (!owners.has(name)) owners.set(name, extension.path);
      return true;
    },
    stageShortcutRegistration: (extension, name, registration) => {
      if (!shouldStage(extension)) return false;
      pendingShortcuts.set(registrationKey(extension, name), { extension, name, registration });
      return true;
    },
    hasPendingResourceRegistration: (extension, resourceType, name) => {
      const key = registrationKey(extension, name);
      if (resourceType === "tool") return pendingTools.has(key);
      if (resourceType === "command") return pendingCommands.has(key);
      if (resourceType === "flag") return pendingFlags.has(key);
      if (resourceType === "shortcut") return pendingShortcuts.has(key);
      return false;
    },
    deletePendingResourceRegistration: (extension, resourceType, name) => {
      const key = registrationKey(extension, name);
      if (resourceType === "tool") pendingTools.delete(key);
      else if (resourceType === "command") pendingCommands.delete(key);
      else if (resourceType === "flag") pendingFlags.delete(key);
      else if (resourceType === "shortcut") pendingShortcuts.delete(key);
    },
    getPendingFlagDefault: (ownerPath, name) => {
      if (!pendingFlags.has(`${ownerPath}\0${name}`)) return undefined;
      return [...pendingFlags.values()].find((pending) => pending.name === name)?.defaultValue;
    },
    getAllToolsAfterRegistration: (extension) => {
      const tools = runtime.getAllTools();
      if (extension.sourceInfo.configurationOrigin !== "inherited-pi") return tools;
      const names = new Set(tools.map((tool) => tool.name));
      for (const pending of pendingTools.values()) {
        if (names.has(pending.name)) continue;
        const { definition, sourceInfo } = pending.registration;
        tools.push({ name: definition.name, description: definition.description, parameters: definition.parameters, promptGuidelines: definition.promptGuidelines, sourceInfo });
        names.add(pending.name);
      }
      return tools;
    },
    getCommandsAfterRegistration: (extension) => {
      const commands = runtime.getCommands();
      if (extension.sourceInfo.configurationOrigin !== "inherited-pi") return commands;
      const names = new Set(commands.map((command) => command.name));
      for (const pending of pendingCommands.values()) {
        if (names.has(pending.name)) continue;
        commands.push({ name: pending.registration.name, description: pending.registration.description, source: "extension", sourceInfo: pending.registration.sourceInfo });
        names.add(pending.name);
      }
      return commands;
    },
    refreshToolsAfterRegistration: () => {
      runtime.refreshTools();
      if (batchDepth > 0 && pendingActiveToolNames) pendingActiveToolNames = runtime.getActiveTools();
    },
    applyFlagDefaultAfterRegistration: (name, ownerPath, value) => {
      if (runtime.flagOwners?.get(name) === ownerPath && !runtime.flagValues.has(name)) runtime.flagValues.set(name, value);
    },
    getActiveToolsAfterRegistration: (extension) => {
      const active = runtime.getActiveTools();
      if (extension.sourceInfo.configurationOrigin !== "inherited-pi") return active;
      if (pendingActiveToolNames) return [...pendingActiveToolNames];
      const names = new Set(active);
      for (const pending of pendingTools.values()) names.add(pending.name);
      return [...names];
    },
    setActiveToolsAfterRegistration: (extension, toolNames) => {
      if (batchDepth === 0) return false;
      pendingActiveToolNames = [...toolNames];
      if (extension.sourceInfo.configurationOrigin !== "inherited-pi") return false;
      const liveNames = new Set(runtime.getAllTools().map((tool) => tool.name));
      runtime.setActiveTools(toolNames.filter((name) => liveNames.has(name)));
      return true;
    },
    assertActive,
    invalidate: (message) => {
      state.staleMessage ??= message
        ?? "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
    },
    registerProvider: (nameOrProvider, configOrPath, extensionPath = "<unknown>") => {
      if (typeof nameOrProvider === "string") {
        runtime.pendingProviderRegistrations.push({ name: nameOrProvider, config: configOrPath as import("./types.ts").ProviderConfig, extensionPath: extensionPath as string });
      } else {
        runtime.pendingProviderRegistrations.push({ provider: nameOrProvider, extensionPath: typeof configOrPath === "string" ? configOrPath : extensionPath as string });
      }
    },
    unregisterProvider: (name) => {
      runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((registration) =>
        "provider" in registration ? registration.provider.id !== name : registration.name !== name);
    },
  };
  return runtime;
}
