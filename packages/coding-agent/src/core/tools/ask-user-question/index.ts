/**
 * `ask_user_question` base tool — registered alongside read/bash/edit/write.
 *
 * Upstream: https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question
 * Upstream copyright: (c) 2026 juicesharp — MIT (see ./LICENSE.upstream).
 *
 * Differences from upstream:
 *  - i18n is removed entirely. The upstream `state/i18n-bridge.ts`,
 *    `locales/*.json`, and the optional `@juicesharp/rpiv-i18n` peer
 *    dependency are gone. All UI copy is plain English string literals
 *    or local module-level constants.
 *  - Exposed as a base tool definition (no extension registration).
 *
 * cross-ref:
 *  - ../index.ts (registers via createAllToolDefinitions)
 *  - ./ask-user-question.ts (tool definition + execute pipeline)
 */
export {
	createAskUserQuestionToolDefinition,
	createLoadedAskUserQuestionToolDefinition,
} from "./ask-user-question.js";
