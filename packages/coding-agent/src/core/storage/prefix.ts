import { StoragePrefixError } from "./errors.js";

export function validateStoragePrefix(prefix = ""): string {
	if (prefix !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
		throw new StoragePrefixError(prefix, "pattern");
	}
	if (/^sqlite_/i.test(prefix)) throw new StoragePrefixError(prefix, "reserved");
	return prefix;
}

export function renderStorageIdentifiers<T extends Readonly<Record<string, string>>>(
	domain: "journal" | "sessions",
	names: T,
	prefix = "",
): Readonly<{ [K in keyof T]: string }> {
	const validated = validateStoragePrefix(prefix);
	const domainPrefix = domain === "journal" ? "wf_" : "session_";
	return Object.freeze(
		Object.fromEntries(Object.entries(names).map(([key, name]) => [key, `${validated}${domainPrefix}${name}`])),
	) as Readonly<{ [K in keyof T]: string }>;
}

/**
 * The ledger `applyStorageMigrations` records each domain's applied versions in, one per prefix: the Postgres schema
 * of every domain under `prefix` (#4793). SQLite keeps no ledger, so its schema is unchanged.
 */
export function storageMigrationTable(prefix = ""): string {
	return `${validateStoragePrefix(prefix)}atomic_migrations`;
}
