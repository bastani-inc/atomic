import type { ConstrainedSamplingConfig } from "@earendil-works/pi-ai/compat";
import { APP_NAME, LEGACY_ENV_PREFIX } from "../config.ts";

export function areExperimentalFeaturesEnabled(): boolean {
	return (
		process.env[`${APP_NAME.toUpperCase()}_EXPERIMENTAL`] === "1" ||
		process.env[`${LEGACY_ENV_PREFIX}_EXPERIMENTAL`] === "1"
	);
}

const PREFER_STRICT_TOOL_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

/**
 * Experimental strict JSON-schema constrained sampling for built-in tool definitions.
 *
 * Returns a `prefer` (not `require`) constraint so providers without strict
 * support keep working, and `undefined` unless experimental features are enabled
 * (`ATOMIC_EXPERIMENTAL=1` or the legacy `PI_EXPERIMENTAL=1`), leaving tool
 * definitions unconstrained by default.
 */
export function getExperimentalToolSampling(): ConstrainedSamplingConfig | undefined {
	return areExperimentalFeaturesEnabled() ? PREFER_STRICT_TOOL_SAMPLING : undefined;
}

/**
 * Tool-definition spread fragment for the experimental strict sampling above.
 *
 * Sets `constrainedSampling` only when the experimental gate is on. Key presence
 * is semantic through the tool plumbing (`Object.hasOwn` guards in
 * tool-definition-wrapper, agent-session-state, and loader-runtime), so an
 * unconstrained definition must keep the property absent rather than own it
 * with `undefined`.
 */
export function experimentalToolSamplingProperty():
	| { constrainedSampling: { type: "json_schema"; strict: "prefer" } }
	| Record<string, never> {
	return areExperimentalFeaturesEnabled() ? { constrainedSampling: PREFER_STRICT_TOOL_SAMPLING } : {};
}
