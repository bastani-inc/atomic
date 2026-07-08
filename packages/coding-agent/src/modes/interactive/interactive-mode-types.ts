import type { ImageContent } from "./interactive-mode-deps.ts";
import type { EarlyInputCapture } from "../../main-early-input.ts";

/** Interface for components that can be expanded/collapsed. */
export interface Expandable {
  setExpanded(expanded: boolean): void;
}

export type CompactionQueuedMessage = {
  text: string;
  mode: "steer" | "followUp";
};

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
  /** Providers that were migrated to auth.json (shows warning) */
  migratedProviders?: string[];
  /** Warning message if session model couldn't be restored */
  modelFallbackMessage?: string;
  /** Cwd to persist as trusted after reload/shutdown if it gains trust inputs during an implicitly trusted session. */
  autoTrustOnReloadCwd?: string;
  /** Initial message to send on startup (can include @file content) */
  initialMessage?: string;
  /** Images to attach to the initial message */
  initialImages?: ImageContent[];
  /** Additional messages to send after the initial message */
  initialMessages?: string[];
  /** Force verbose startup (overrides quietStartup setting) */
  verbose?: boolean;
  /** Runtime was created without extension code; finish loading in the background after first paint. */
  deferredExtensionLoad?: boolean;
  /** Model scope patterns resolved again after deferred extension load registers providers. */
  deferredModelScopePatterns?: string[];
  /** Preserve an explicit CLI thinking level when applying deferred model-scope suffixes. */
  deferredModelScopePreserveThinking?: boolean;
  /** Raw terminal input capture active until the TUI prompt is ready to take over stdin. */
  startupInputCapture?: EarlyInputCapture;
}
