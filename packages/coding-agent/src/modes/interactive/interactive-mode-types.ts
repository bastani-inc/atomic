import type { ImageContent } from "./interactive-mode-deps.ts";

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
  /** Cwd to persist as trusted after reload if it gains project config during an implicitly trusted session. */
  autoTrustOnReloadCwd?: string;
  /** Initial message to send on startup (can include @file content) */
  initialMessage?: string;
  /** Images to attach to the initial message */
  initialImages?: ImageContent[];
  /** Additional messages to send after the initial message */
  initialMessages?: string[];
  /** Force verbose startup (overrides quietStartup setting) */
  verbose?: boolean;
}
