// @ts-check
/**
 * The database side of a run: its secrets and TLS certificates, and the Docker Compose project that runs PostgreSQL,
 * PgBouncer and the replica. Every secret lives in a file of mode 600 under the run's `secrets/` directory and reaches
 * the containers through the Compose environment file there; none is printed.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

export const COMPOSE_FILE = resolve(import.meta.dirname, "..", "compose.yaml");
/** Every project this harness starts is named with this prefix, so the sweeper finds them. */
export const PROJECT_PREFIX = "adt-";
const DOCKER_TIMEOUT_MS = 1_200_000;

/** @typedef {{ host: string, port: number }} Endpoint */

/**
 * @typedef {object} Stack
 * @property {string} project
 * @property {string} envFile
 * @property {string[]} profiles
 * @property {string} tlsDir
 * @property {Record<"owner" | "runtime" | "superuser" | "pgbouncerAuth" | "replication", { user: string, passwordFile: string }>} roles
 */

/** @param {string} runId */
export function projectName(runId) {
	return `${PROJECT_PREFIX}${runId}`;
}

/**
 * `count` TCP ports free on 127.0.0.1 right now, for the services to publish on.
 * @param {number} count
 * @returns {Promise<number[]>}
 */
export async function freePorts(count) {
	const servers = await Promise.all(
		Array.from(
			{ length: count },
			() =>
				new Promise((resolve, reject) => {
					const server = createServer();
					server.once("error", reject);
					server.listen(0, "127.0.0.1", () => resolve(server));
				}),
		),
	);
	const ports = servers.map((server) => /** @type {import("node:net").AddressInfo} */ (server.address()).port);
	await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))));
	return ports;
}

/**
 * Writes the run's passwords and the Compose environment file that hands them, the TLS directory and the host ports
 * to the containers.
 * @param {string} runDir
 * @param {{ diskMb: number, ports: { primary: number, pgbouncer: number, replica: number } }} options
 */
export function writeSecrets(runDir, options) {
	const secrets = join(runDir, "secrets");
	mkdirSync(secrets, { recursive: true, mode: 0o700 });
	/** @type {Record<string, { user: string, variable: string }>} */
	const roles = {
		owner: { user: "atomic_owner", variable: "ADT_OWNER_PASSWORD" },
		runtime: { user: "atomic_runtime", variable: "ADT_RUNTIME_PASSWORD" },
		superuser: { user: "postgres", variable: "ADT_SUPERUSER_PASSWORD" },
		pgbouncerAuth: { user: "pgbouncer_auth", variable: "ADT_PGBOUNCER_AUTH_PASSWORD" },
		replication: { user: "replicator", variable: "ADT_REPLICATION_PASSWORD" },
	};
	/** @type {Record<string, { user: string, passwordFile: string }>} */
	const files = {};
	const lines = [];
	for (const [role, { user, variable }] of Object.entries(roles)) {
		const password = randomBytes(18).toString("base64url");
		const passwordFile = join(secrets, `${role}.password`);
		writeFileSync(passwordFile, password, { mode: 0o600 });
		files[role] = { user, passwordFile };
		lines.push(`${variable}=${password}`);
	}
	const tlsDir = join(runDir, "tls");
	lines.push(
		`ADT_TLS_DIR=${tlsDir}`,
		`ADT_DISK_MB=${options.diskMb}`,
		`ADT_PRIMARY_PORT=${options.ports.primary}`,
		`ADT_PGBOUNCER_PORT=${options.ports.pgbouncer}`,
		`ADT_REPLICA_PORT=${options.ports.replica}`,
	);
	const envFile = join(secrets, "compose.env");
	writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
	return { envFile, tlsDir, roles: /** @type {Stack["roles"]} */ (files) };
}

/**
 * A CA, the servers' certificates it signs (PostgreSQL as `primary` and `replica`, PgBouncer as `pgbouncer`, both as
 * localhost and 127.0.0.1), and a decoy CA that signs nothing the servers present.
 * @param {string} tlsDir
 */
export function writeCertificates(tlsDir) {
	mkdirSync(tlsDir, { recursive: true });
	const openssl = (/** @type {string[]} */ ...args) =>
		execFileSync("openssl", args, { cwd: tlsDir, stdio: ["ignore", "ignore", "pipe"] });
	const ca = (/** @type {string} */ name) =>
		openssl(
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"3",
			"-subj",
			`/CN=${name}`,
			"-keyout",
			`${name}.key`,
			"-out",
			`${name}.crt`,
		);
	ca("root");
	ca("decoy");
	for (const [name, names] of [
		["server", "DNS:primary,DNS:replica,DNS:localhost,IP:127.0.0.1"],
		["pgbouncer", "DNS:pgbouncer,DNS:localhost,IP:127.0.0.1"],
	]) {
		openssl(
			"req",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-subj",
			`/CN=${name}`,
			"-keyout",
			`${name}.key`,
			"-out",
			`${name}.csr`,
		);
		writeFileSync(join(tlsDir, `${name}.ext`), `subjectAltName=${names}\n`);
		openssl(
			"x509",
			"-req",
			"-in",
			`${name}.csr`,
			"-CA",
			"root.crt",
			"-CAkey",
			"root.key",
			"-CAcreateserial",
			"-days",
			"3",
			"-extfile",
			`${name}.ext`,
			"-out",
			`${name}.crt`,
		);
	}
	// The containers run as other users; these are throwaway test keys that live only as long as the run.
	for (const file of ["root.crt", "decoy.crt", "server.crt", "server.key", "pgbouncer.crt", "pgbouncer.key"])
		chmodSync(join(tlsDir, file), 0o644);
	return { ca: join(tlsDir, "root.crt"), decoyCa: join(tlsDir, "decoy.crt") };
}

/**
 * `docker compose` on a run's project.
 * @param {Pick<Stack, "project" | "envFile" | "profiles">} stack
 * @param {string[]} args
 * @param {{ inherit?: boolean }} [options] inherit: let the command's output through to the terminal
 */
export function compose(stack, args, options = {}) {
	return execFileSync(
		"docker",
		[
			"compose",
			"--project-name",
			stack.project,
			"--file",
			COMPOSE_FILE,
			"--env-file",
			stack.envFile,
			...stack.profiles.flatMap((profile) => ["--profile", profile]),
			...args,
		],
		{
			encoding: "utf8",
			timeout: DOCKER_TIMEOUT_MS,
			stdio: options.inherit === true ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
		},
	);
}

/**
 * Where a service's port is published on the host.
 * @param {Pick<Stack, "project" | "envFile" | "profiles">} stack
 * @param {string} service
 * @param {number} port
 * @returns {Endpoint}
 */
export function publishedPort(stack, service, port) {
	const answer = compose(stack, ["port", service, String(port)]).trim();
	const match = /^(.+):(\d+)$/.exec(answer);
	if (match === null) throw new Error(`docker compose port ${service} ${port} answered ${JSON.stringify(answer)}`);
	return { host: match[1] === "0.0.0.0" ? "127.0.0.1" : match[1], port: Number(match[2]) };
}

/**
 * Starts the project and waits until every service is healthy.
 * @param {Pick<Stack, "project" | "envFile" | "profiles">} stack
 */
export function up(stack) {
	compose(stack, ["up", "--detach", "--wait", "--build", "--quiet-pull"], { inherit: true });
}

/**
 * Removes the project's containers, network and volumes, then checks that none is left.
 * @param {Pick<Stack, "project" | "envFile" | "profiles">} stack
 * @returns {string[]} what is still there: empty when teardown worked
 */
export function down(stack) {
	compose(stack, ["down", "--volumes", "--remove-orphans", "--timeout", "10"], { inherit: true });
	return leftovers(stack.project);
}

/**
 * Containers, volumes and networks still labelled with `project`.
 * @param {string} project
 */
export function leftovers(project) {
	const filter = `label=com.docker.compose.project=${project}`;
	const listed = (/** @type {string[]} */ command, /** @type {string} */ field) =>
		execFileSync("docker", [...command, "--filter", filter, "--format", `{{.${field}}}`], { encoding: "utf8" })
			.split("\n")
			.map((name) => name.trim())
			.filter(Boolean);
	return [
		...listed(["ps", "--all"], "Names").map((name) => `container ${name}`),
		...listed(["volume", "ls"], "Name").map((name) => `volume ${name}`),
		...listed(["network", "ls"], "Name").map((name) => `network ${name}`),
	];
}
