import type { WaitPolicy } from "../tasks/contracts.js";

const WAIT_ACTION_KEYS: ReadonlySet<string> = new Set(["action", "id", "budgetMs"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidBudgetMs(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Validates and normalizes an observation `wait` policy for `bash`, `powershell`, `read`, or `search`.
 *
 * Strict JSON Schema providers convert optional properties into nullable required properties and emit `null` for
 * omitted values (`wait: null`, or `wait: { kind: "background", budgetMs: null }`). Treats `null` and `undefined` on
 * `wait` and on `wait.budgetMs` as omitted while strictly rejecting malformed kinds, unknown keys, non-null `budgetMs`
 * on background waits, and non-numeric, negative, or non-finite budgets.
 */
export function normalizeWaitPolicy(wait: unknown, errorLabel = "wait"): WaitPolicy | undefined {
	if (wait === undefined || wait === null) return undefined;
	const invalid = () =>
		new Error(`Invalid ${errorLabel}: expected background or foreground with a finite non-negative budgetMs`);
	if (!isPlainObject(wait)) throw invalid();
	const { kind } = wait;
	if (kind !== "background" && kind !== "foreground") throw invalid();
	for (const key of Object.keys(wait)) {
		if (key !== "kind" && key !== "budgetMs") throw invalid();
	}
	const rawBudget = wait.budgetMs;
	if (rawBudget === undefined || rawBudget === null) {
		return { kind };
	}
	if (kind !== "foreground" || !isValidBudgetMs(rawBudget)) throw invalid();
	return { kind: "foreground", budgetMs: rawBudget };
}

export interface WaitableInputSpec {
	/** Required property for primary calls (for example `"command"`, `"path"`, `"pattern"`). */
	readonly requiredKey: string;
	/** Known optional properties for primary calls (including `"wait"`). */
	readonly optionalCallKeys: readonly string[];
	/** Label used in the wait-mode error (`Invalid <waitLabel>: ...`). */
	readonly waitLabel: string;
	/** Label used in the call-mode error (`Invalid <callLabel>: ...`). */
	readonly callLabel: string;
	/** Label used when validating `wait` (`Invalid <waitPolicyLabel>: ...`). */
	readonly waitPolicyLabel: string;
}

/**
 * Prepares raw arguments for a tool that supports either a primary call (`requiredKey` + `optionalCallKeys`) or
 * observing an existing background task (`{ action: "wait", id, budgetMs? }`).
 *
 * Strips `null` and `undefined` values on known schema properties (and on `wait.budgetMs`) so strict-schema providers
 * that emit `null` for omitted optional properties work identically to callers that omit them, while still rejecting
 * unknown keys, mixed call/wait parameters, non-`"wait"` actions, missing/null required keys, and invalid budgets.
 */
export function prepareWaitableToolInput<T>(args: unknown, spec: WaitableInputSpec): T {
	if (!isPlainObject(args)) return args as T;
	const knownKeys = new Set<string>([spec.requiredKey, ...spec.optionalCallKeys, ...WAIT_ACTION_KEYS]);
	const cleaned: Record<string, unknown> = {};
	let changed = false;

	for (const [key, value] of Object.entries(args)) {
		if ((value === undefined || value === null) && knownKeys.has(key)) {
			changed = true;
			continue;
		}
		if (key === "wait" && isPlainObject(value) && Object.hasOwn(value, "budgetMs") && value.budgetMs == null) {
			const nextWait: Record<string, unknown> = {};
			for (const [waitKey, waitValue] of Object.entries(value)) {
				if (waitKey === "budgetMs") continue;
				nextWait[waitKey] = waitValue;
			}
			cleaned[key] = nextWait;
			changed = true;
			continue;
		}
		cleaned[key] = value;
	}

	const has = (key: string) => Object.hasOwn(cleaned, key);
	if (has("action")) {
		if (
			cleaned.action !== "wait" ||
			typeof cleaned.id !== "string" ||
			Object.keys(cleaned).some((key) => !WAIT_ACTION_KEYS.has(key)) ||
			(has("budgetMs") && !isValidBudgetMs(cleaned.budgetMs))
		) {
			throw new Error(
				`Invalid ${spec.waitLabel}: expected action wait, id, and optional finite non-negative budgetMs`,
			);
		}
	} else {
		if (!has(spec.requiredKey) || has("id") || has("budgetMs")) {
			throw new Error(
				`Invalid ${spec.callLabel}: ${spec.requiredKey} is required; id and budgetMs require action wait`,
			);
		}
		if (has("wait")) {
			normalizeWaitPolicy(cleaned.wait, spec.waitPolicyLabel);
		}
	}

	return (changed ? cleaned : args) as T;
}
