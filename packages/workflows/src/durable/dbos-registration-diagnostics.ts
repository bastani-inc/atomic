/**
 * Classify DBOS durability failures so a duplicate operation registration
 * is not described as a Postgres provisioning problem (#2022 / #2462).
 *
 * Uses the SDK `Error` namespace (`DBOSConflictingRegistrationError` and
 * `getDBOSErrorCode`). The SDK is loaded lazily so this module never
 * statically imports `@dbos-inc/dbos-sdk`. `instanceof` is not used: two
 * resolved copies of the SDK would make it fail.
 */

export type DbosDurabilityFailureKind = "duplicate_registration" | "other";

interface DbosSdkErrorModule {
	readonly DBOSConflictingRegistrationError?: new (msg: string) => object;
	readonly getDBOSErrorCode?: (error: Error) => number | undefined;
}

let cachedErrorModule: DbosSdkErrorModule | undefined;
let errorModuleLoad: Promise<DbosSdkErrorModule | undefined> | undefined;

async function loadDbosErrorModule(): Promise<DbosSdkErrorModule | undefined> {
	if (cachedErrorModule !== undefined) return cachedErrorModule;
	errorModuleLoad ??= (async () => {
		const spec = "@dbos-inc/dbos-sdk";
		try {
			const mod = (await import(spec)) as { readonly Error?: DbosSdkErrorModule };
			cachedErrorModule = mod.Error;
			return cachedErrorModule;
		} catch {
			return undefined;
		}
	})();
	return await errorModuleLoad;
}

function conflictingRegistrationCode(errors: DbosSdkErrorModule | undefined): number | undefined {
	const ctor = errors?.DBOSConflictingRegistrationError;
	if (ctor === undefined) return undefined;
	try {
		const code = Reflect.get(new ctor(""), "dbosErrorCode");
		return typeof code === "number" ? code : undefined;
	} catch {
		return undefined;
	}
}

function isDuplicateRegistration(value: object, errors: DbosSdkErrorModule | undefined): boolean {
	const expected = conflictingRegistrationCode(errors);
	const code = readOwn(value, "dbosErrorCode");
	if (typeof code === "number" && typeof expected === "number" && code === expected) return true;
	if (errors?.getDBOSErrorCode !== undefined && value instanceof Error) {
		try {
			if (errors.getDBOSErrorCode(value) === expected) return true;
		} catch {
			/* keep walking */
		}
	}
	const name = readOwn(value, "name");
	const className = errors?.DBOSConflictingRegistrationError?.name;
	return typeof name === "string" && typeof className === "string" && name === className;
}

function classifyWith(error: unknown, errors: DbosSdkErrorModule | undefined): DbosDurabilityFailureKind {
	try {
		const seen = new Set<object>();
		let current: unknown = error;
		while (current !== undefined && current !== null) {
			if (typeof current !== "object") return "other";
			if (seen.has(current)) return "other";
			seen.add(current);
			if (isDuplicateRegistration(current, errors)) return "duplicate_registration";
			current = readOwn(current, "cause");
		}
	} catch {
		return "other";
	}
	return "other";
}

/**
 * Async classification used at the durability boundary so the first failure
 * can load the SDK error classes before deciding. Subsequent sync callers
 * reuse the cached module.
 */
export async function classifyDbosDurabilityFailure(error: unknown): Promise<DbosDurabilityFailureKind> {
	const errors = await loadDbosErrorModule();
	return classifyWith(error, errors);
}

/**
 * Read an error's display detail without letting a throwing `message` getter
 * escape the durability wrapper. `String(error)` is the last-resort fallback
 * and is itself guarded: some `toString` implementations also throw.
 */
export function readDbosFailureDetail(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const message = readOwn(error, "message");
		if (typeof message === "string" && message !== "") return message;
	}
	try {
		return String(error);
	} catch {
		return "unknown error";
	}
}

function readOwn(value: object, key: string): unknown {
	try {
		return Reflect.get(value, key);
	} catch {
		return undefined;
	}
}
