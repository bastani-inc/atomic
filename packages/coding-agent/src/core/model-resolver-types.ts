import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";

export interface ScopedModel {
  model: Model<Api>;
  /** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
  thinkingLevel?: ThinkingLevel;
}

export interface ParsedModelResult {
  model: Model<Api> | undefined;
  /** Thinking level if explicitly specified in pattern, undefined otherwise */
  thinkingLevel?: ThinkingLevel;
  warning: string | undefined;
}

export interface ResolveCliModelResult {
  model: Model<Api> | undefined;
  thinkingLevel?: ThinkingLevel;
  warning: string | undefined;
  /**
   * Error message suitable for CLI display.
   * When set, model will be undefined.
   */
  error: string | undefined;
}

export interface InitialModelResult {
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel;
  fallbackMessage: string | undefined;
}
