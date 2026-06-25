/**
 * Plain mutable singleton store public API.
 * cross-ref: spec §5.5
 */

export { createStore, store } from "./store-factory.js";
export type {
  PromptAnswerRecord,
  RecordStagePromptAnswerOptions,
  ResolveStagePendingPromptOptions,
  RunBlockedMetadata,
  RunEndMetadata,
  StagePromptAnswerSource,
  Store,
} from "./store-public-types.js";
