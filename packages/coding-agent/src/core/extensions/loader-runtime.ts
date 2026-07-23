import type { Extension, ExtensionRuntime, RegisteredTool } from "./types.ts";

export async function runResourceRegistrationBatch<T>(runtime: ExtensionRuntime, run: () => Promise<T>): Promise<T> {
  if (!runtime.beginResourceRegistrationBatch || !runtime.endResourceRegistrationBatch) return run();
  runtime.beginResourceRegistrationBatch();
  try {
    return await run();
  } finally {
    runtime.endResourceRegistrationBatch();
  }
}

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
  const notInitialized = () => {
    throw new Error(
      "Extension runtime not initialized. Action methods cannot be called during extension loading.",
    );
  };
  const state: { staleMessage?: string } = {};
  let resourceRegistrationBatchDepth = 0;
  let toolRefreshPending = false;
  const pendingFlagDefaults = new Map<string, { ownerPath: string; value: boolean | string }>();
  const pendingToolRegistrations = new Map<string, { extension: Extension; name: string }>();
  const assertActive = () => {
    if (state.staleMessage) {
      throw new Error(state.staleMessage);
    }
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
    beginResourceRegistrationBatch: () => {
      resourceRegistrationBatchDepth += 1;
    },
    endResourceRegistrationBatch: () => {
      resourceRegistrationBatchDepth -= 1;
      if (resourceRegistrationBatchDepth !== 0) return;
      for (const [name, pending] of pendingFlagDefaults) {
        if (runtime.flagOwners?.get(name) === pending.ownerPath && !runtime.flagValues.has(name)) {
          runtime.flagValues.set(name, pending.value);
        }
      }
      pendingFlagDefaults.clear();
      pendingToolRegistrations.clear();
      if (toolRefreshPending) {
        toolRefreshPending = false;
        runtime.refreshTools();
      }
    },
    refreshToolsAfterRegistration: (extension, toolName, deferUntilBatchEnd = false) => {
      if (resourceRegistrationBatchDepth > 0 && deferUntilBatchEnd && extension && toolName) {
        pendingToolRegistrations.set(`${extension.path}\0${toolName}`, { extension, name: toolName });
        toolRefreshPending = true;
        return;
      }
      const hidden: Array<{ extension: Extension; name: string; tool: RegisteredTool }> = [];
      if (resourceRegistrationBatchDepth > 0) {
        for (const pending of pendingToolRegistrations.values()) {
          const tool = pending.extension.tools.get(pending.name);
          if (!tool) continue;
          pending.extension.tools.delete(pending.name);
          hidden.push({ ...pending, tool });
        }
      }
      try {
        runtime.refreshTools();
      } finally {
        for (const pending of hidden) {
          if (!pending.extension.tools.has(pending.name)) pending.extension.tools.set(pending.name, pending.tool);
        }
      }
    },
    applyFlagDefaultAfterRegistration: (name, ownerPath, value, deferUntilBatchEnd = false) => {
      if (resourceRegistrationBatchDepth > 0 && deferUntilBatchEnd) {
        pendingFlagDefaults.set(name, { ownerPath, value });
      } else if (runtime.flagOwners?.get(name) === ownerPath && !runtime.flagValues.has(name)) {
        runtime.flagValues.set(name, value);
      }
    },
    assertActive,
    invalidate: (message) => {
      state.staleMessage ??=
        message ??
        "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
    },
    registerProvider: (nameOrProvider, configOrPath, extensionPath = "<unknown>") => {
      if (typeof nameOrProvider === "string") {
        runtime.pendingProviderRegistrations.push({
          name: nameOrProvider,
          config: configOrPath as import("./types.ts").ProviderConfig,
          extensionPath: extensionPath as string,
        });
      } else {
        runtime.pendingProviderRegistrations.push({
          provider: nameOrProvider,
          extensionPath: typeof configOrPath === "string" ? configOrPath : extensionPath as string,
        });
      }
    },
    unregisterProvider: (name) => {
      runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((registration) =>
        "provider" in registration ? registration.provider.id !== name : registration.name !== name,
      );
    },
  };

  return runtime;
}
