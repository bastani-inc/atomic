export type PostgresRuntimeTarget = "linux-x64-musl" | "linux-arm64-musl" | "windows-arm64";

export interface ZonkyPostgresArtifact {
	url: string;
	sha256: string;
	innerEntry: string;
	innerSha256: string;
	version: string;
	kind: "zonky";
}

export interface WindowsEmulatedPostgresArtifact {
	url: string;
	sha256: string;
	version: string;
	kind: "windows-x64-emulated";
}

export type PostgresRuntimeArtifact = ZonkyPostgresArtifact | WindowsEmulatedPostgresArtifact;

export const POSTGRES_RUNTIME_ARTIFACTS: Record<PostgresRuntimeTarget, PostgresRuntimeArtifact>;

export function download(
	url: string,
	destination: string,
	options?: {
		fetchImpl?: typeof fetch;
		delay?: (milliseconds: number) => Promise<void>;
		timeoutMs?: number;
	},
): Promise<void>;

/** Stages one PostgreSQL runtime payload into `<packageRoot>/postgres-runtime` and returns that path. */
export function stagePostgresRuntime(options: {
	target: PostgresRuntimeTarget;
	packageRoot: string;
	artifactFile?: string;
	artifact?: PostgresRuntimeArtifact;
}): Promise<string>;
