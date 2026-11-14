/** A cloud identity that issues PostgreSQL passwords: Microsoft Entra ID, AWS RDS IAM, or Google Cloud SQL IAM. */
export type CloudAuth = "azure-entra" | "aws-iam" | "gcp-iam";

export interface CloudPasswordOptions {
	readonly auth: CloudAuth;
	/** The database host, as the connection URL names it. AWS signs its token for this host. */
	readonly host: string;
	readonly port: number;
	/** The database user the token is for. */
	readonly user: string;
	/** Upper bound for each credential source, in milliseconds. Default: 5000 for metadata endpoints, 30000 for CLIs. */
	readonly timeoutMs?: number;
}

/**
 * A password reader for `pg` that returns a cloud IAM token for each new connection. Tokens live only in memory and
 * are reused until 5 minutes before they expire; concurrent connections share one fetch. Throws a
 * `StorageConfigError` with reason `invalid-auth-target` for a host or user a CLI could misread, and the reader
 * rejects with reason `auth-unavailable`, naming each source tried, when no source issues a token.
 */
export function createCloudPasswordProvider(options: CloudPasswordOptions): () => Promise<string>;
