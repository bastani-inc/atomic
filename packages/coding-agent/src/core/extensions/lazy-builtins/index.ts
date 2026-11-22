import { hasLazyBuiltinSpec, registerLazyBuiltin } from "../lazy-builtin.js";
import { intercomLazyBuiltinSpec } from "./intercom.js";
import { webAccessLazyBuiltinSpec } from "./web-access.js";

let registered = false;

/** Register Atomic's shipped lazy-activation built-in specs once per process. */
export function ensureDefaultLazyBuiltinsRegistered(): void {
	if (registered) return;
	registered = true;
	if (!hasLazyBuiltinSpec("intercom")) registerLazyBuiltin("intercom", intercomLazyBuiltinSpec);
	if (!hasLazyBuiltinSpec("web-access")) registerLazyBuiltin("web-access", webAccessLazyBuiltinSpec);
}
