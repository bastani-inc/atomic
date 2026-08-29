import { Client } from "pg";

const POSTGRESQL_VALIDATION_TIMEOUT_MS = 5_000;

export interface PostgreSqlValidationClient {
	connect(): Promise<void>;
	query(query: string): Promise<object>;
	end(): Promise<void>;
}

export type PostgreSqlValidationClientFactory = (url: string) => PostgreSqlValidationClient;

const defaultClientFactory: PostgreSqlValidationClientFactory = (url) =>
	new Client({ connectionString: url, connectionTimeoutMillis: POSTGRESQL_VALIDATION_TIMEOUT_MS });

function sanitizedConnectionError(error: Error, url: URL): Error {
	const safeUrl = new URL(url);
	safeUrl.username = "";
	safeUrl.password = "";
	const detail = error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, safeUrl.toString());
	return new Error(`Could not validate PostgreSQL at ${safeUrl.toString()}: ${detail}`);
}

export async function normalizeAndValidateDbosSystemDatabaseUrl(
	input: string,
	createClient: PostgreSqlValidationClientFactory = defaultClientFactory,
): Promise<string> {
	const normalized = input.trim();
	if (normalized.length === 0) return "";

	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error("Enter a valid PostgreSQL connection URL using the postgres: or postgresql: scheme.");
	}
	if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
		throw new Error("Enter a PostgreSQL connection URL using the postgres: or postgresql: scheme.");
	}

	const client = createClient(normalized);
	try {
		await client.connect();
		await client.query("SELECT 1");
	} catch (error) {
		throw sanitizedConnectionError(error instanceof Error ? error : new Error(String(error)), parsed);
	} finally {
		await client.end();
	}
	return normalized;
}
