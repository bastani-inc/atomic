import { getDbosProcessOwner } from "./dbos-process-owner.js";

function nonEmptyTrimmed(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export class DbosSystemDatabaseConflictError extends Error {
	constructor(requested: string) {
		super(
			`Workflow durability is already configured for this process with a different system database; ` +
				`DBOS cannot switch to ${redactDatabaseUrl(requested)} until the process restarts.`,
		);
		this.name = "DbosSystemDatabaseConflictError";
	}
}

function redactDatabaseUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.password !== "") parsed.password = "***";
		return parsed.toString();
	} catch {
		return "the requested database";
	}
}

/** The caller-supplied system database URL, falling back to `DBOS_SYSTEM_DATABASE_URL`. */
export function explicitDbosSystemDatabaseUrl(): string | undefined {
	return (
		nonEmptyTrimmed(getDbosProcessOwner().systemDatabaseUrl) ?? nonEmptyTrimmed(process.env.DBOS_SYSTEM_DATABASE_URL)
	);
}

/**
 * Select the process's DBOS system database. DBOS accepts configuration once
 * per process, so a different URL after configuration is rejected.
 */
export function requestDbosSystemDatabaseUrl(url: string): void {
	const requested = nonEmptyTrimmed(url);
	if (requested === undefined) throw new TypeError("durability.systemDatabaseUrl must be a non-empty Postgres URL");
	const owner = getDbosProcessOwner();
	const configured = owner.configured !== undefined || owner.wrappers !== undefined;
	if (configured && explicitDbosSystemDatabaseUrl() !== requested) {
		throw new DbosSystemDatabaseConflictError(requested);
	}
	owner.systemDatabaseUrl = requested;
}
