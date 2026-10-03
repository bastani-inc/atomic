export interface DbosDatabaseDiagnostics {
	readonly provider: string;
	readonly url: string;
	readonly failure?: string;
}

export function redactedDatabaseEndpoint(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return "unparseable PostgreSQL endpoint";
	}
}

export function redactedDatabaseMessage(message: string, url?: string): string {
	let safe = message.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, (value) => redactedDatabaseEndpoint(value));
	if (url !== undefined) {
		try {
			const parsed = new URL(url);
			const secrets = [parsed.username, parsed.password, ...parsed.searchParams.values()];
			for (const secret of secrets) {
				if (secret.length === 0) continue;
				safe = safe.replaceAll(secret, "[redacted]").replaceAll(decodeURIComponent(secret), "[redacted]");
			}
		} catch {
			return "PostgreSQL diagnostic could not be safely redacted; check the configured endpoint.";
		}
	}
	return safe.replace(
		/\b(password|passwd|token|secret|sslpassword)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
		"$1=[redacted]",
	);
}

export function databaseDependencyMessage(message: string, diagnostics?: DbosDatabaseDiagnostics): string {
	const safe = redactedDatabaseMessage(message, diagnostics?.url);
	if (diagnostics === undefined) return safe;
	const failure =
		diagnostics.failure === undefined
			? ""
			: ` Last probe/recovery failure: ${redactedDatabaseMessage(diagnostics.failure, diagnostics.url)}`;
	return `${safe} Provider: ${diagnostics.provider}; endpoint: ${redactedDatabaseEndpoint(diagnostics.url)}.${failure}`;
}
