import type { SqliteValue, StorageDescriptor } from "./database.js";

export type StorageFailureCause = object | SqliteValue | boolean | symbol | undefined;

export class StorageError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

export class StorageUnavailableError extends StorageError {
	readonly adapter: string;
	readonly location: string;
	declare readonly cause: StorageFailureCause;
	constructor(descriptor: StorageDescriptor, cause: StorageFailureCause) {
		super(`Storage unavailable: ${descriptor.adapter} at ${descriptor.location}`, { cause });
		this.adapter = descriptor.adapter;
		this.location = descriptor.location;
	}
}

export class StoreClosedError extends StorageError {
	readonly adapter: string;
	readonly location: string;
	constructor(descriptor: StorageDescriptor) {
		super(`Storage closed: ${descriptor.adapter} at ${descriptor.location}`);
		this.adapter = descriptor.adapter;
		this.location = descriptor.location;
	}
}

export class StorageTransactionClosedError extends StorageError {
	constructor() {
		super("Storage transaction is closed");
	}
}

export class StorageRollbackError extends StorageError {
	declare readonly cause: StorageFailureCause;
	readonly rollbackCause: StorageFailureCause;
	constructor(cause: StorageFailureCause, rollbackCause: StorageFailureCause) {
		super("Storage rollback failed", { cause });
		this.rollbackCause = rollbackCause;
	}
}

export class StorageInvalidTextError extends StorageError {
	readonly parameterIndex: number;
	readonly reason = "nul-character";
	constructor(parameterIndex: number) {
		super(`Storage parameter ${parameterIndex} contains a NUL character`);
		this.parameterIndex = parameterIndex;
	}
}

export class StorageSchemaVersionError extends StorageError {
	readonly domain: string;
	readonly found: SqliteValue;
	readonly supported: number;
	constructor(domain: string, found: SqliteValue, supported: number) {
		super(`Unsupported ${domain} storage schema version`);
		this.domain = domain;
		this.found = found;
		this.supported = supported;
	}
}

export class StoragePrefixError extends StorageError {
	readonly prefix: string;
	readonly reason: "pattern" | "reserved";
	constructor(prefix: string, reason: "pattern" | "reserved") {
		super(`Invalid storage prefix: ${reason}`);
		this.prefix = prefix;
		this.reason = reason;
	}
}

export class StorageConfigError extends StorageError {
	readonly source: "sdk" | "cli" | "env" | "settings";
	readonly field: string;
	readonly reason: string;
	constructor(source: "sdk" | "cli" | "env" | "settings", field: string, reason: string) {
		super(`Invalid storage configuration: ${field} (${reason})`);
		this.source = source;
		this.field = field;
		this.reason = reason;
	}
}

export class StorageAdapterLoadError extends StorageError {
	readonly module: string;
	declare readonly cause: StorageFailureCause;
	constructor(module: string, cause: StorageFailureCause) {
		super(`Could not load storage adapter: ${module}`, { cause });
		this.module = module;
	}
}

export class StorageOutcomeUnknownError extends StorageError {
	readonly domain: string;
	readonly id: string;
	readonly key: string;
	constructor(domain: string, id: string, key: string) {
		super(`Storage write outcome unknown: ${domain} ${id}`);
		this.domain = domain;
		this.id = id;
		this.key = key;
	}
}

export class StoragePayloadTooLargeError extends StorageError {
	readonly limitBytes: number;
	readonly actualBytes: number;
	constructor(limitBytes: number, actualBytes: number) {
		super("Storage payload exceeds the backend limit");
		this.limitBytes = limitBytes;
		this.actualBytes = actualBytes;
	}
}
