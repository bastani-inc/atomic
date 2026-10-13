import { getDbosProcessOwner } from "./dbos-process-owner.js";

export function validateDbosPoolSize(poolSize: number, name = "durability.poolSize"): void {
	if (typeof poolSize !== "number" || !Number.isInteger(poolSize) || poolSize < 2) {
		throw new TypeError(
			`${name} must be an integer of at least 2 (one ownership connection and one transaction connection)`,
		);
	}
}

export function resolvedDbosPoolSize(): number {
	return getDbosProcessOwner().poolSize ?? 10;
}

/** DBOS uses one database configuration for the lifetime of the process. */
export function requestDbosPoolSize(poolSize: number): void {
	validateDbosPoolSize(poolSize);
	const owner = getDbosProcessOwner();
	if ((owner.configured !== undefined || owner.wrappers !== undefined) && resolvedDbosPoolSize() !== poolSize) {
		throw new Error(
			`Workflow durability is already configured for this process with poolSize ${resolvedDbosPoolSize()}; DBOS cannot switch to poolSize ${poolSize} until the process restarts.`,
		);
	}
	owner.poolSize = poolSize;
}
