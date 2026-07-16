import * as path from "node:path";
import { isBuiltinCursorExtensionPath } from "../builtin-packages.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { endTimingSpan, startTimingSpan } from "../timings.ts";
import { yieldToEventLoop } from "../../utils/event-loop.ts";
import { createExtensionAPI } from "./loader-api.ts";
import {
  emptyWorkflowResourceProvider,
  type ResourceLoaderInheritanceSnapshotProvider,
  type WorkflowResourceProviderInput,
} from "./loader-resources.ts";
import { createExtensionRuntime } from "./loader-runtime.ts";
import {
  loadExtensionModule,
  type ExtensionCacheToken,
  useExtensionCacheCwd,
} from "./loader-virtual-modules.ts";
import { trustCursorProviderSource } from "./provider-registration-source.ts";
import type { Extension, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from "./types.ts";

/** Create an Extension object with empty collections. */
function createExtension(extensionPath: string, resolvedPath: string, loadedFromModule: boolean): Extension {
  const source = extensionPath.startsWith("<") && extensionPath.endsWith(">")
    ? extensionPath.slice(1, -1).split(":")[0] || "temporary"
    : "local";
  const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

  return {
    path: extensionPath,
    loadedFromModule,
    resolvedPath,
    sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

async function loadExtension(
  extensionPath: string,
  cwd: string,
  eventBus: EventBus,
  runtime: ExtensionRuntime,
  workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
  resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
  cacheToken?: ExtensionCacheToken,
): Promise<{ extension: Extension | null; error: string | null }> {
  const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

  try {
    const moduleSpan = startTimingSpan(`loadExtensions.${extensionPath}.module`, "extensions");
    const factory = await loadExtensionModule(resolvedPath, cacheToken);
    endTimingSpan(moduleSpan);
    if (!factory) {
      return {
        extension: null,
        error: `Extension does not export a valid factory function: ${extensionPath}`,
      };
    }
    const extension = createExtension(extensionPath, resolvedPath, true);
    if (isBuiltinCursorExtensionPath(resolvedPath)) trustCursorProviderSource(extension);
    const api = createExtensionAPI(
      extension,
      runtime,
      cwd,
      eventBus,
      workflowResourceProvider,
      resourceLoaderInheritanceSnapshotProvider,
    );
    const factorySpan = startTimingSpan(`loadExtensions.${extensionPath}.factory`, "extensions");
    await factory(api);
    endTimingSpan(factorySpan);

    return { extension, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { extension: null, error: `Failed to load extension: ${message}` };
  }
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
  factory: ExtensionFactory,
  cwd: string,
  eventBus: EventBus,
  runtime: ExtensionRuntime,
  extensionPath = "<inline>",
  workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
  resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
): Promise<Extension> {
  const extension = createExtension(extensionPath, extensionPath, false);
  const resolvedCwd = resolvePath(cwd);
  const api = createExtensionAPI(
    extension,
    runtime,
    resolvedCwd,
    eventBus,
    workflowResourceProvider,
    resourceLoaderInheritanceSnapshotProvider,
  );
  await factory(api);
  return extension;
}

/**
 * Load extensions from paths.
 */
async function loadExtensionsInternal(
  paths: string[],
  cwd: string,
  eventBus?: EventBus,
  workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
  runtime?: ExtensionRuntime,
  resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
  useCache = false,
): Promise<LoadExtensionsResult> {
  const extensions: Extension[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const cacheToken = useCache ? useExtensionCacheCwd(cwd) : undefined;
  const resolvedCwd = cacheToken?.cwd ?? resolvePath(cwd);
  const resolvedEventBus = eventBus ?? createEventBus();
  const resolvedRuntime = runtime ?? createExtensionRuntime();

  let processedExtensionCount = 0;
  for (const extPath of paths) {
    if (processedExtensionCount > 0) {
      await yieldToEventLoop();
    }
    const extensionSpan = startTimingSpan(`loadExtensions.${extPath}.total`, "extensions");
    const { extension, error } = await loadExtension(
      extPath,
      resolvedCwd,
      resolvedEventBus,
      resolvedRuntime,
      workflowResourceProvider,
      resourceLoaderInheritanceSnapshotProvider,
      cacheToken,
    );
    endTimingSpan(extensionSpan);
    processedExtensionCount += 1;
    if (error) {
      errors.push({ path: extPath, error });
      continue;
    }

    if (extension) {
      extensions.push(extension);
    }
  }

  return {
    extensions,
    errors,
    runtime: resolvedRuntime,
  };
}

export async function loadExtensions(
  paths: string[],
  cwd: string,
  eventBus?: EventBus,
  workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
  runtime?: ExtensionRuntime,
  resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
): Promise<LoadExtensionsResult> {
  return loadExtensionsInternal(
    paths,
    cwd,
    eventBus,
    workflowResourceProvider,
    runtime,
    resourceLoaderInheritanceSnapshotProvider,
  );
}

export async function loadExtensionsCached(
  paths: string[],
  cwd: string,
  eventBus?: EventBus,
  workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
  runtime?: ExtensionRuntime,
  resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
): Promise<LoadExtensionsResult> {
  return loadExtensionsInternal(
    paths,
    cwd,
    eventBus,
    workflowResourceProvider,
    runtime,
    resourceLoaderInheritanceSnapshotProvider,
    true,
  );
}
