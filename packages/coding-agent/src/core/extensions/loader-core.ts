import * as path from "node:path";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { endTimingSpan, startTimingSpan } from "../timings.ts";
import { createExtensionAPI } from "./loader-api.ts";
import {
  emptyWorkflowResourceProvider,
  type ResourceLoaderInheritanceSnapshotProvider,
  type WorkflowResourceProviderInput,
} from "./loader-resources.ts";
import { createExtensionRuntime } from "./loader-runtime.ts";
import { loadExtensionModule } from "./loader-virtual-modules.ts";
import type { Extension, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from "./types.ts";

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
  const source = extensionPath.startsWith("<") && extensionPath.endsWith(">")
    ? extensionPath.slice(1, -1).split(":")[0] || "temporary"
    : "local";
  const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

  return {
    path: extensionPath,
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
): Promise<{ extension: Extension | null; error: string | null }> {
  const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

  try {
    const moduleSpan = startTimingSpan(`loadExtensions.${extensionPath}.module`);
    const factory = await loadExtensionModule(resolvedPath);
    endTimingSpan(moduleSpan);
    if (!factory) {
      return {
        extension: null,
        error: `Extension does not export a valid factory function: ${extensionPath}`,
      };
    }

    const extension = createExtension(extensionPath, resolvedPath);
    const api = createExtensionAPI(
      extension,
      runtime,
      cwd,
      eventBus,
      workflowResourceProvider,
      resourceLoaderInheritanceSnapshotProvider,
    );
    const factorySpan = startTimingSpan(`loadExtensions.${extensionPath}.factory`);
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
  const extension = createExtension(extensionPath, extensionPath);
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
export async function loadExtensions(
  paths: string[],
  cwd: string,
  eventBus?: EventBus,
  workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
  runtime?: ExtensionRuntime,
  resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
): Promise<LoadExtensionsResult> {
  const extensions: Extension[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const resolvedCwd = resolvePath(cwd);
  const resolvedEventBus = eventBus ?? createEventBus();
  const resolvedRuntime = runtime ?? createExtensionRuntime();

  for (const extPath of paths) {
    const extensionSpan = startTimingSpan(`loadExtensions.${extPath}.total`);
    const { extension, error } = await loadExtension(
      extPath,
      resolvedCwd,
      resolvedEventBus,
      resolvedRuntime,
      workflowResourceProvider,
      resourceLoaderInheritanceSnapshotProvider,
    );
    endTimingSpan(extensionSpan);

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
