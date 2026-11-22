import { registerLazyBuiltin } from "../lazy-builtin.js";
import { intercomLazyBuiltinSpec } from "./intercom.js";

let registered = false;

/** Register Atomic's shipped lazy-activation built-in specs once per process. */
export function ensureDefaultLazyBuiltinsRegistered(): void {
	if (registered) return;
	registered = true;
	registerLazyBuiltin("intercom", intercomLazyBuiltinSpec);
}
