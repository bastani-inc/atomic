import { Client } from "pg";

const POSTGRESQL_VALIDATION_TIMEOUT_MS = 5_000;
const POSTGRESQL_CREDENTIAL_PARAMETERS = new Set(["user", "password", "passwd", "pwd", "sslpassword"]);

function credentialRepresentations(value: string): string[] {
	if (value.length === 0) return [];
	try {
		const decoded = decodeURIComponent(value);
		return decoded === value ? [value] : [value, decoded];
	} catch {
		return [value];
	}
}

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
	const credentialValues = [
		...credentialRepresentations(safeUrl.username),
		...credentialRepresentations(safeUrl.password),
	];
	const credentialParameterNames = new Set<string>();
	for (const [name, value] of safeUrl.searchParams) {
		if (!POSTGRESQL_CREDENTIAL_PARAMETERS.has(name.toLowerCase())) continue;
		credentialParameterNames.add(name);
		credentialValues.push(...credentialRepresentations(value));
	}

	safeUrl.username = "";
	safeUrl.password = "";
	for (const name of credentialParameterNames) safeUrl.searchParams.delete(name);

	let detail = error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, () => safeUrl.toString());
	for (const value of new Set(credentialValues)) detail = detail.replaceAll(value, "[REDACTED]");
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
	let validationTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				await client.connect();
				await client.query("SELECT 1");
			})(),
			new Promise<never>((_, reject) => {
				validationTimer = setTimeout(
					() => reject(new Error("PostgreSQL validation timed out.")),
					POSTGRESQL_VALIDATION_TIMEOUT_MS,
				);
			}),
		]);
	} catch (error) {
		throw sanitizedConnectionError(error instanceof Error ? error : new Error(String(error)), parsed);
	} finally {
		if (validationTimer !== undefined) clearTimeout(validationTimer);
		await client.end();
	}
	return normalized;
}
