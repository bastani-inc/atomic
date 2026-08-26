import type { ExtensionAPI } from "@bastani/atomic";
import type { SubagentState } from "../shared/types.js";

/** Human `/run` and `/parallel` commands are gone. Launch children with `subagent`. */
export function registerSlashCommands(_pi: ExtensionAPI, _state: SubagentState): void {}
