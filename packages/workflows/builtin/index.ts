/**
 * Builtin workflows manifest.
 * Re-exported for consumers that want to enumerate or register builtins
 * programmatically.  Atomic discovers these via the `pi.builtin`
 * package metadata pointing at this directory.
 */

export { default as adversarialVerification } from "./adversarial-verification.js";
export { default as classifyAndAct } from "./classify-and-act.js";
export { default as deepResearchCodebase } from "./deep-research-codebase.js";
export { default as fanOutAndSynthesize } from "./fan-out-and-synthesize.js";
export { default as generateAndFilter } from "./generate-and-filter.js";
export { default as goal } from "./goal.js";
export { default as ralph } from "./ralph.js";
export { default as openClaudeDesign } from "./open-claude-design.js";
export { default as loopUntilDone } from "./loop-until-done.js";
export { default as tournament } from "./tournament.js";
