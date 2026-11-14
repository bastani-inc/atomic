/** A cloud identity that issues PostgreSQL passwords: Microsoft Entra ID, AWS RDS IAM, or Google Cloud SQL IAM. */
export type CloudAuth = "azure-entra" | "aws-iam" | "gcp-iam";

/**
 * The SDK each cloud signs in with and the version the adapter is tested with. Each is an optional peer dependency,
 * imported only when its `auth` is used: `@azure/identity`, `@aws-sdk/rds-signer`, `google-auth-library`.
 */
export const CLOUD_AUTH_PACKAGES: { readonly [auth in CloudAuth]: { readonly name: string; readonly version: string } };

export interface CloudPasswordOptions {
	readonly auth: CloudAuth;
	/** The database host, as the connection URL names it. AWS signs its token for this host. */
	readonly host: string;
	readonly port: number;
	/** The database user the token is for. */
	readonly user: string;
	/** Upper bound for one token request, in milliseconds. Default 8000. */
	readonly timeoutMs?: number;
}

/**
 * A password reader for `pg` that returns a cloud IAM token for each new connection, from the cloud's own SDK:
 * `DefaultAzureCredential`, the RDS `Signer`, or `GoogleAuth`. Tokens live only in memory; concurrent connections
 * share one request. Throws a `StorageConfigError` with reason `invalid-auth-target` when the host or user is
 * missing, and the reader rejects with reason `auth-unavailable` when the SDK is not installed or issues no token.
 */
export function createCloudPasswordProvider(options: CloudPasswordOptions): () => Promise<string>;
