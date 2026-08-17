/**
 * Classify DBOS durability failures so a duplicate operation registration
 * is not described as a Postgres provisioning problem (#2022 / #2462).
 *
 * Duck-type only: do not statically import `@dbos-inc/dbos-sdk` and do not
 * use `instanceof`. The SDK is loaded lazily through `importDbosSdk()`, and
 * `instanceof` fails if two copies of the package are resolved.
 */

/**
 * `@dbos-inc/dbos-sdk` `error.js`: `const ConflictingRegistrationError = 25`
 * on class `DBOSConflictingRegistrationError`. `decorators.js`
 * `checkFuncTypeUnassigned` throws that class.
 */
const DBOS_CONFLICTING_REGISTRATION_ERROR_CODE = 25;

const DBOS_CONFLICTING_REGISTRATION_ERROR_NAME = "DBOSConflictingRegistrationError";

export type DbosDurabilityFailureKind = "duplicate_registration" | "other";

export function classifyDbosDurabilityFailure(error: unknown): DbosDurabilityFailureKind {
	try {
		const seen = new Set<object>();
		let current: unknown = error;
		while (current !== undefined && current !== null) {
			if (typeof current !== "object") return "other";
			if (seen.has(current)) return "other";
			seen.add(current);
			if (isDuplicateRegistration(current)) return "duplicate_registration";
			current = readOwn(current, "cause");
		}
	} catch {
		return "other";
	}
	return "other";
}

function isDuplicateRegistration(value: object): boolean {
	const code = readOwn(value, "dbosErrorCode");
	if (typeof code === "number" && code === DBOS_CONFLICTING_REGISTRATION_ERROR_CODE) return true;
	const name = readOwn(value, "name");
	if (typeof name === "string" && name === DBOS_CONFLICTING_REGISTRATION_ERROR_NAME) return true;
	const message = readOwn(value, "message");
	return typeof message === "string" && matchesRegistrationMessageFallback(message);
}

/**
 * Last-resort fallback for both `checkFuncTypeUnassigned` shapes when the
 * SDK code or class name is unavailable: `... is already registered.` and
 * `... is already registered with a conflicting function type: X vs. Y`.
 */
function matchesRegistrationMessageFallback(message: string): boolean {
	return (
		/is already registered with a conflicting function type: \S+ vs\. \S+/.test(message) ||
		/is already registered\./.test(message)
	);
}

function readOwn(value: object, key: string): unknown {
	try {
		return Reflect.get(value, key);
	} catch {
		return undefined;
	}
}
