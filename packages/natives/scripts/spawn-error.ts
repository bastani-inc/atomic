export interface NativeSpawnResult {
	readonly status: number | null;
	readonly error?: Error;
}

export function formatNativeSpawnFailure(label: string, result: NativeSpawnResult): string {
	const status = result.status ?? "null";
	const osError = result.error ? `; spawn error: ${result.error.message}` : "";
	return `${label} exited ${status}${osError}`;
}
