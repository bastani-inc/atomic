/**
 * The tools whose detachable calls are all questions waiting for a reply: `contact_supervisor` detaches only
 * `need_decision` and `interview_request`, and `intercom` only `ask` (the Intercom extension's `detachable-calls`).
 */
export const SUBAGENT_QUESTION_TOOLS: ReadonlySet<string> = new Set(["contact_supervisor", "intercom"]);
