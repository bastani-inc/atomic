export function defaultPostgresUrl(
	database: string,
	host = process.env.PGHOST || "localhost",
	port = process.env.PGPORT || "5432",
): string {
	const url = new URL("postgresql://localhost");
	url.pathname = `/${database}`;
	if (host.startsWith("/") || host.includes(":")) url.searchParams.set("host", host);
	else url.hostname = host;
	url.port = port;
	url.username = encodeURIComponent(process.env.PGUSER || "postgres");
	url.password = encodeURIComponent(process.env.PGPASSWORD || "dbos");
	url.searchParams.set("connect_timeout", process.env.PGCONNECT_TIMEOUT || "10");
	url.searchParams.set("sslmode", process.env.PGSSLMODE || (host === "localhost" ? "disable" : "allow"));
	return url.toString();
}
