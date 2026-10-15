import type { SqliteValue } from "./database.js";
import { StorageSchemaVersionError } from "./errors.js";

export function assertStorageSchemaVersion(domain: string, found: SqliteValue, supported: number): void {
	if (found !== supported) throw new StorageSchemaVersionError(domain, found, supported);
}
