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
	let configuredSecrets: string[] = [];
	if (url !== undefined) {
		try {
			const parsed = new URL(url);
			configuredSecrets = [parsed.username, parsed.password, ...parsed.searchParams.values()]
				.flatMap((secret) => {
					try {
						return [secret, decodeURIComponent(secret)];
					} catch {
						return [secret];
					}
				})
				.filter((secret) => secret.length > 0);
		} catch {
			return "PostgreSQL diagnostic could not be safely redacted; check the configured endpoint.";
		}
	}
	safe = safe.replace(
		/\b(password|passwd|token|secret|sslpassword|user(?:name)?)\s*(?:([=:])\s*|((?:is|was)\s+)|\s+)(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/gi,
		(
			match,
			key: string,
			separator: string | undefined,
			filler: string | undefined,
			doubleQuoted: string | undefined,
			singleQuoted: string | undefined,
			bare: string | undefined,
		) => {
			const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
			const isUserContext = /^user(?:name)?$/i.test(key);
			if (separator === undefined && !isUserContext && !configuredSecrets.includes(value)) return match;
			const rendered =
				doubleQuoted !== undefined ? '"[redacted]"' : singleQuoted !== undefined ? "'[redacted]'" : "[redacted]";
			return `${key}${separator ?? " "}${filler ?? ""}${rendered}`;
		},
	);
	for (const secret of new Set(configuredSecrets)) {
		if (secret.length < 4) continue;
		const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const expression = new RegExp(`(?<![\\p{L}\\p{N}_\\[])${escaped}(?![\\p{L}\\p{N}_\\]])`, "gu");
		safe = safe.replace(expression, "[redacted]");
	}
	return safe;
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
