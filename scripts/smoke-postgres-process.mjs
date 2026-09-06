import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export function runSmokeCommand(path, args, { cwd, env }) {
	// Windows pg_ctl leaves a CMD shell alive even with -l. Its inherited pipes
	// keep execFileSync waiting for EOF after pg_ctl has exited successfully.
	// Files preserve diagnostics without waiting for descendant handle closure.
	const logs = mkdtempSync(join(cwd, "command-"));
	const stdoutPath = join(logs, "stdout.log");
	const stderrPath = join(logs, "stderr.log");
	const descriptors = [];
	try {
		descriptors.push(openSync(stdoutPath, "w"));
		descriptors.push(openSync(stderrPath, "w"));
		try {
			execFileSync(path, args, {
				cwd,
				env,
				encoding: "utf8",
				timeout: 30_000,
				stdio: ["ignore", ...descriptors],
			});
		} catch (error) {
			error.stdout = readFileSync(stdoutPath, "utf8");
			error.stderr = readFileSync(stderrPath, "utf8");
			error.output = [null, error.stdout, error.stderr];
			error.message += `\n${error.stdout}${error.stderr}`;
			throw error;
		}
		return readFileSync(stdoutPath, "utf8");
	} finally {
		for (const descriptor of descriptors) closeSync(descriptor);
	}
}

export async function startOnAvailablePort(start, cleanup) {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const listener = createServer();
		await new Promise((done, reject) => {
			listener.once("error", reject);
			listener.listen(0, "127.0.0.1", done);
		});
		const port = listener.address().port;
		await new Promise((done, reject) => listener.close((error) => (error ? reject(error) : done())));
		try {
			await start(port);
			return port;
		} catch (error) {
			// Never retry an exec timeout or an unrelated PostgreSQL startup failure.
			const collision =
				error.code === "EADDRINUSE" ||
				(!error.code &&
					error.status === 1 &&
					/could not bind IPv4 address "127\.0\.0\.1": (?:Address already in use|Only one usage of each socket address)/u.test(
						error.postgresLog ?? "",
					) &&
					/FATAL:\s+could not create any TCP\/IP sockets/u.test(error.postgresLog ?? ""));
			await cleanup();
			if (!collision || attempt === 3) throw error;
		}
	}
}
