import type { ExtensionRuntime } from "./types.ts";

export async function runResourceRegistrationBatch<T>(runtime: ExtensionRuntime, run: () => Promise<T>): Promise<T> {
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
      if (resourceRegistrationBatchDepth === 0 && toolRefreshPending) {
        toolRefreshPending = false;
        runtime.refreshTools();
      }
    },
    refreshToolsAfterRegistration: () => {
      if (resourceRegistrationBatchDepth > 0) {
        toolRefreshPending = true;
      } else {
        runtime.refreshTools();
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
