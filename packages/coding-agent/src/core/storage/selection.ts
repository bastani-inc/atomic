import type { SqliteDatabase } from "./database.js";
import { StorageConfigError } from "./errors.js";
import type { AdapterOptions, SecretRef, StorageSelection } from "./provider.js";

export interface StorageSettingsSelection {
	readonly path?: string;
	readonly memory?: boolean;
	readonly adapter?: string;
	readonly options?: AdapterOptions;
	readonly secrets?: Readonly<Record<string, SecretRef>>;
	readonly prefix?: string;
}
export type StorageInputSelection =
	| StorageSettingsSelection
	| { readonly database: SqliteDatabase; readonly prefix?: string };

export function selectStorage(
	value: StorageInputSelection,
	source: "sdk" | "settings" | "env" | "cli",
	field: string,
	defaultPath: string,
): StorageSelection {
	const invalid = (reason: string): never => {
		throw new StorageConfigError(source, field, reason);
	};
	if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("selection-object-required");
	if ("dir" in value) return invalid("adapter-domain-unsupported");
	if ("prefix" in value && value.prefix !== undefined && typeof value.prefix !== "string")
		return invalid("invalid-prefix");
	if (source === "sdk") {
		const forms = ["path", "memory", "adapter", "database"].filter((key) => key in value);
		if (forms.length === 0) return invalid("selection-required");
		if (forms.length > 1) return invalid("multiple-selection-forms");
		if ("path" in value && typeof value.path !== "string") return invalid("invalid-path");
		if ("memory" in value && value.memory !== true) return invalid("invalid-memory");
		if ("adapter" in value && (typeof value.adapter !== "string" || value.adapter.length === 0))
			return invalid("invalid-adapter");
	}
	if ("database" in value) {
		if (["path", "memory", "adapter"].some((key) => key in value)) return invalid("multiple-selection-forms");
		const db = value.database;
		if (
			db === null ||
			typeof db !== "object" ||
			[db.exec, db.run, db.get, db.all, db.transaction, db.close].some((hook) => typeof hook !== "function") ||
			!db.descriptor ||
			typeof db.descriptor.adapter !== "string" ||
			typeof db.descriptor.location !== "string"
		)
			return invalid("async-database-required");
		return { kind: "database", database: db, ...(value.prefix === undefined ? {} : { prefix: value.prefix }) };
	}
	if (value.path !== undefined && typeof value.path !== "string") return invalid("invalid-path");
	if (value.memory !== undefined && typeof value.memory !== "boolean") return invalid("invalid-memory");
	if (value.adapter !== undefined) {
		if (typeof value.adapter !== "string" || value.adapter.length === 0) return invalid("invalid-adapter");
		if ("path" in value || "memory" in value) return invalid("multiple-selection-forms");
		if (value.options !== undefined) {
			if (value.options === null || typeof value.options !== "object" || Array.isArray(value.options))
				return invalid("invalid-options");
			for (const option of Object.values(value.options)) {
				if (
					option !== null &&
					!["string", "number", "bigint", "boolean"].includes(typeof option) &&
					!(option instanceof Uint8Array)
				)
					return invalid("invalid-options");
			}
		}
		if (value.secrets !== undefined) {
			if (value.secrets === null || typeof value.secrets !== "object" || Array.isArray(value.secrets))
				return invalid("invalid-secrets");
			for (const ref of Object.values(value.secrets)) {
				if (ref === null || typeof ref !== "object" || Array.isArray(ref) || "env" in ref === "file" in ref)
					return invalid("invalid-secret-ref");
				if ("env" in ref ? typeof ref.env !== "string" : typeof ref.file !== "string")
					return invalid("invalid-secret-ref");
			}
		}
		return {
			kind: "adapter",
			module: value.adapter,
			...(value.options === undefined ? {} : { options: value.options }),
			...(value.secrets === undefined ? {} : { secrets: value.secrets }),
			...(value.prefix === undefined ? {} : { prefix: value.prefix }),
		};
	}
	if (value.options !== undefined || value.secrets !== undefined) return invalid("adapter-required");
	if (value.path && value.memory === true) return invalid("path-and-memory");
	if (value.memory === true) return { kind: "memory" };
	return {
		kind: "sqlite",
		path: source === "sdk" && value.path !== undefined ? value.path : value.path || defaultPath,
		...(value.prefix === undefined ? {} : { prefix: value.prefix }),
	};
}
