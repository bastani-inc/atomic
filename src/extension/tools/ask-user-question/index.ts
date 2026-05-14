/**
 * `ask_user_question` tool — ported into `@bastani/atomic-workflows`.
 *
 * Upstream: https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question
 * Upstream copyright: (c) 2026 juicesharp — MIT (see ./LICENSE.upstream).
 *
 * Differences from upstream:
 *  - i18n is removed entirely. The upstream `state/i18n-bridge.ts`,
 *    `locales/*.json`, and the optional `@juicesharp/rpiv-i18n` peer
 *    dependency are gone. All UI copy is plain English string literals
 *    or local module-level constants. To reintroduce localization later,
 *    restore the upstream bridge + locale files and rewrap each label.
 *  - No default-export factory; we re-export `registerAskUserQuestionTool`
 *    so the atomic-workflows entry point (`src/extension/index.ts`) can
 *    call it alongside the existing `workflow` tool registration.
 *
 * cross-ref:
 *  - src/extension/index.ts (calls registerAskUserQuestionTool)
 *  - ./ask-user-question.ts (tool definition + execute pipeline)
 */
export {
  createAskUserQuestionTool,
  registerAskUserQuestionTool,
} from "./ask-user-question.js";
export type { AskUserQuestionToolLifecycle } from "./ask-user-question.js";
