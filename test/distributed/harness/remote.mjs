// @ts-check
/**
 * SSH-side operations on the run's private VMs: staging the runtime, artifact and harness scripts, configuring sqld
 * behind its TLS gateway, and running the node agent. Scripts go to `bash -s` on stdin, so nothing but fixed words
 * appears in remote process listings; secrets travel only as files copied with `scp` and set to mode 600.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { retrying, runCommand, shellQuote } from "./commands.mjs";
import { DistributedProvisionError, isCancellation } from "./errors.mjs";

export const REMOTE_ROOT = "/opt/adt";
export const NODE_BIN = `${REMOTE_ROOT}/node/bin/node`;
export const AGENT = `${REMOTE_ROOT}/harness/agent.mjs`;
export const REF_DIR = `${REMOTE_ROOT}/atomic`;
export const SECRETS = `${REMOTE_ROOT}/secrets`;

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
export function sha256File(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex")));
	});
}

export class Host {
	/**
	 * @param {{ context: import("./commands.mjs").CommandContext, name: string, ip: string, user: string, key: string,
	 *   knownHosts: string, signal?: AbortSignal }} init
	 */
	constructor({ context, name, ip, user, key, knownHosts, signal }) {
		this.context = context;
		this.name = name;
		this.ip = ip;
		this.user = user;
		this.signal = signal;
		this.options = [
			"-i",
			key,
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			`UserKnownHostsFile=${knownHosts}`,
			"-o",
			"ConnectTimeout=15",
			"-o",
			"ServerAliveInterval=10",
			"-o",
			"ServerAliveCountMax=3",
			"-o",
			"LogLevel=ERROR",
		];
	}

	/**
	 * Runs a bash script on the host. SSH's own failures (exit 255) are retryable; the script's are not.
	 * @param {string} script
	 * @param {{ operation: string, timeoutMs?: number, allowExitCodes?: number[] }} options
	 */
	run(script, { operation, timeoutMs = 300_000, allowExitCodes = [] }) {
		return runCommand(this.context, "ssh", [...this.options, `${this.user}@${this.ip}`, "bash -s"], {
			operation: `${this.name}: ${operation}`,
			timeoutMs,
			signal: this.signal,
			input: `set -euo pipefail\n${script}\n`,
			retryableExitCodes: [255],
			allowExitCodes,
		});
	}

	/**
	 * @param {string} script
	 * @param {{ operation: string, timeoutMs?: number }} options
	 * @returns {Promise<any>}
	 */
	async json(script, options) {
		const result = await this.run(script, options);
		const line = result.stdout
			.trim()
			.split("\n")
			.filter((text) => text.startsWith("{"))
			.pop();
		if (line === undefined)
			throw new DistributedProvisionError({
				step: options.operation,
				resource: this.name,
				detail: "no JSON output",
			});
		return JSON.parse(line);
	}

	/**
	 * @param {string} local
	 * @param {string} remote
	 * @param {string} operation
	 */
	async upload(local, remote, operation) {
		await runCommand(this.context, "scp", ["-q", ...this.options, local, `${this.user}@${this.ip}:${remote}`], {
			operation: `${this.name}: ${operation}`,
			timeoutMs: 900_000,
			signal: this.signal,
			retryableExitCodes: [255, 1],
		});
	}

	/** Waits until SSH answers, retrying while the VM boots. */
	async waitForSsh() {
		await retrying(
			() => this.run("cat /proc/sys/kernel/random/boot_id", { operation: "wait for SSH", timeoutMs: 30_000 }),
			{
				attempts: 60,
				delayMs: 10_000,
				signal: this.signal,
			},
		);
	}

	/**
	 * Runs the node agent and returns its JSON document.
	 * @param {string} command
	 * @param {readonly string[]} args
	 * @param {{ timeoutMs?: number, sudo?: boolean }} [options]
	 */
	agent(command, args, { timeoutMs = 300_000 } = {}) {
		const words = [`NODE_EXTRA_CA_CERTS=${SECRETS}/ca.pem`, NODE_BIN, AGENT, command, ...args]
			.map(shellQuote)
			.join(" ");
		return this.json(words, { operation: `agent ${command}`, timeoutMs });
	}
}

/**
 * Stages the Node runtime and harness scripts on a host and prepares its directories.
 * @param {Host} host
 * @param {{ nodeTarball: string, harnessDir: string }} input
 */
export async function stageBase(host, { nodeTarball, harnessDir }) {
	await host.waitForSsh();
	await host.run(
		`sudo mkdir -p ${REMOTE_ROOT}/node ${REMOTE_ROOT}/harness ${REMOTE_ROOT}/logs ${SECRETS} && sudo chown -R ${host.user}:${host.user} ${REMOTE_ROOT} && chmod 700 ${SECRETS}`,
		{ operation: "prepare directories" },
	);
	await host.upload(nodeTarball, `${REMOTE_ROOT}/node.tar.xz`, "upload Node runtime");
	for (const file of ["agent.mjs", "gateway.mjs"])
		await host.upload(join(harnessDir, file), `${REMOTE_ROOT}/harness/${file}`, `upload ${file}`);
	await host.run(
		`tar -xJf ${REMOTE_ROOT}/node.tar.xz -C ${REMOTE_ROOT}/node --strip-components=1 && rm ${REMOTE_ROOT}/node.tar.xz && ${NODE_BIN} --version`,
		{
			operation: "install Node runtime",
		},
	);
}

/**
 * Copies one secret file to the host with mode 600.
 * @param {Host} host
 * @param {string} local
 * @param {string} name
 */
export async function stageSecret(host, local, name) {
	await host.upload(local, `${SECRETS}/${name}`, `upload secret ${name}`);
	await host.run(`chmod 600 ${SECRETS}/${shellQuote(name)}`, { operation: `protect ${name}` });
}

/**
 * Uploads the ref artifact, checks its digest on the host and unpacks it.
 * @param {Host} host
 * @param {{ artifact: string, digest: string }} input
 */
export async function stageArtifact(host, { artifact, digest }) {
	await host.upload(artifact, `${REMOTE_ROOT}/atomic.tar.zst`, "upload ref artifact");
	const result = await host.run(
		`echo "${digest}  ${REMOTE_ROOT}/atomic.tar.zst" | sha256sum -c --quiet && tar -I zstd -xf ${REMOTE_ROOT}/atomic.tar.zst -C ${REMOTE_ROOT} && rm ${REMOTE_ROOT}/atomic.tar.zst && cat ${REF_DIR}/.atomic-distributed-artifact.json`,
		{ operation: "verify and unpack artifact", timeoutMs: 600_000 },
	);
	return JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
}

/**
 * Removes git from a node so it is genuinely git-less, then proves the absence.
 * @param {Host} host
 */
export async function removeGit(host) {
	await host.run(
		"if command -v git >/dev/null; then sudo DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq git >/dev/null 2>&1 || sudo dpkg -r --force-depends git; fi; ! command -v git",
		{
			operation: "remove git",
		},
	);
}

/**
 * The block device the database lives on: the first data disk, or the local NVMe temporary disk.
 * @param {"premium-ssd" | "local-nvme"} storage
 */
function dataDeviceScript(storage) {
	return storage === "premium-ssd"
		? `DEV=""; for c in /dev/disk/azure/data/by-lun/0 /dev/disk/azure/scsi1/lun0; do if [ -e "$c" ]; then DEV=$(readlink -f "$c"); break; fi; done`
		: `DEV=""; for c in /dev/disk/azure/local/by-index/1 /dev/disk/azure/resource; do if [ -e "$c" ]; then DEV=$(readlink -f "$c"); break; fi; done; case "$DEV" in /dev/nvme*) ;; *) echo "local NVMe device not found ($DEV)" >&2; exit 41;; esac`;
}

/**
 * Formats and mounts the database volume, installs sqld and its gateway as systemd units, and starts them. The
 * primary listens for replication on its private address with mutual TLS; HTTP and admin listen on loopback only.
 * @param {Host} host
 * @param {{ role: "primary" | "replica", storage: "premium-ssd" | "local-nvme", sqldBinary: string, sqldDigest: string,
 *   primaryIp: string, gatewayPort: number, replicationPort: number }} input
 */
export async function setupSqld(
	host,
	{ role, storage, sqldBinary, sqldDigest, primaryIp, gatewayPort, replicationPort },
) {
	await host.upload(sqldBinary, `${REMOTE_ROOT}/sqld`, "upload sqld");
	const tls =
		role === "primary"
			? `--grpc-listen-addr ${host.ip}:${replicationPort} --grpc-tls --grpc-ca-cert-file ${SECRETS}/ca.pem --grpc-cert-file ${SECRETS}/host.pem --grpc-key-file ${SECRETS}/host.key`
			: `--primary-grpc-url https://${primaryIp}:${replicationPort} --primary-grpc-tls --primary-grpc-ca-cert-file ${SECRETS}/ca.pem --primary-grpc-cert-file ${SECRETS}/host.pem --primary-grpc-key-file ${SECRETS}/host.key`;
	const script = `
echo "${sqldDigest}  ${REMOTE_ROOT}/sqld" | sha256sum -c --quiet
chmod 755 ${REMOTE_ROOT}/sqld
${dataDeviceScript(storage)}
test -n "$DEV"
if mountpoint -q /mnt; then if findmnt -no SOURCE /mnt | grep -q "$DEV"; then sudo umount /mnt; fi; fi
sudo mkfs.ext4 -q -F "$DEV"
sudo mkdir -p /var/lib/adt-sqld && sudo mount "$DEV" /var/lib/adt-sqld && sudo chown ${host.user}:${host.user} /var/lib/adt-sqld
sudo tee /etc/systemd/system/adt-sqld.service >/dev/null <<UNIT
[Unit]
Description=atomic-distributed-test sqld (${role})
[Service]
User=${host.user}
ExecStart=${REMOTE_ROOT}/sqld --db-path /var/lib/adt-sqld/data --http-listen-addr 127.0.0.1:8080 --admin-listen-addr 127.0.0.1:9090 ${tls} --enable-namespaces --disable-default-namespace --auth-jwt-key-file ${SECRETS}/jwt.pub --no-welcome
Restart=no
UNIT
sudo tee /etc/systemd/system/adt-gateway.service >/dev/null <<UNIT
[Unit]
Description=atomic-distributed-test sqld TLS gateway
[Service]
User=${host.user}
ExecStart=${NODE_BIN} ${REMOTE_ROOT}/harness/gateway.mjs --listen ${host.ip}:${gatewayPort} --upstream 127.0.0.1:8080 --cert ${SECRETS}/host.pem --key ${SECRETS}/host.key --stats ${REMOTE_ROOT}/logs/gateway-stats.json
Restart=no
UNIT
sudo systemctl daemon-reload
sudo systemctl start adt-sqld adt-gateway
for i in $(seq 1 60); do if curl -fsS -o /dev/null http://127.0.0.1:8080/health 2>/dev/null; then break; fi; sleep 1; done
curl -fsS -o /dev/null http://127.0.0.1:8080/health
echo "{\\"device\\":\\"$DEV\\",\\"lsblk\\":$(lsblk -J -d -o NAME,SIZE,MODEL,TRAN "$DEV" | tr -d '\\n')}"
`;
	return host.json(script, { operation: `set up sqld ${role}`, timeoutMs: 600_000 });
}

/**
 * Creates namespaces through the primary's loopback admin API.
 * @param {Host} host
 * @param {readonly string[]} namespaces
 */
export async function createNamespaces(host, namespaces) {
	for (const namespace of namespaces) {
		await host.run(
			`curl -fsS -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:9090/v1/namespaces/${shellQuote(namespace)}/create`,
			{
				operation: `create namespace ${namespace}`,
			},
		);
	}
}

/**
 * Listening TCP sockets with their addresses, for the bind check.
 * @param {Host} host
 * @returns {Promise<string[]>}
 */
export async function listeningSockets(host) {
	const result = await host.run("ss -ltnH | awk '{print $4}' | sort -u", { operation: "list listening sockets" });
	return result.stdout.trim().split("\n").filter(Boolean);
}

/**
 * Starts the node agent as a transient systemd unit owned by the run, with its output appended to a log file.
 * @param {Host} host
 * @param {{ unit: string, args: readonly string[], properties?: readonly string[] }} input
 */
export async function startAgentUnit(host, { unit, args, properties = [] }) {
	const words = [
		"sudo",
		"systemd-run",
		"--quiet",
		`--unit=${unit}`,
		`--uid=${host.user}`,
		`--gid=${host.user}`,
		`--setenv=NODE_EXTRA_CA_CERTS=${SECRETS}/ca.pem`,
		`--property=StandardOutput=append:${REMOTE_ROOT}/logs/${unit}.log`,
		`--property=StandardError=append:${REMOTE_ROOT}/logs/${unit}.log`,
		...properties.map((property) => `--property=${property}`),
		NODE_BIN,
		AGENT,
		...args,
	];
	await host.run(words.map(shellQuote).join(" "), { operation: `start ${unit}` });
}

/**
 * The state of a run-owned unit: main PID, active state, result and process state letter.
 * @param {Host} host
 * @param {string} unit
 */
export async function unitState(host, unit) {
	return host.json(
		`P=$(systemctl show -p MainPID --value ${shellQuote(unit)} 2>/dev/null || echo 0); A=$(systemctl show -p ActiveState --value ${shellQuote(unit)} 2>/dev/null || echo unknown); R=$(systemctl show -p Result --value ${shellQuote(unit)} 2>/dev/null || echo unknown); S=$( [ "$P" != 0 ] && awk '{print $3}' /proc/$P/stat 2>/dev/null || echo -); echo "{\\"pid\\":$P,\\"active\\":\\"$A\\",\\"result\\":\\"$R\\",\\"state\\":\\"$S\\"}"`,
		{ operation: `state of ${unit}` },
	);
}

/**
 * Reads a JSON-lines file the agent wrote.
 * @param {Host} host
 * @param {string} path
 * @returns {Promise<import("./invariants.mjs").WriterRecord[]>}
 */
export async function readJsonLines(host, path) {
	const result = await host.run(`cat ${shellQuote(path)} 2>/dev/null || true`, { operation: `read ${path}` });
	return result.stdout
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
}

/**
 * Polls `probe` until it returns a truthy value, failing with the caller's error after `timeoutMs`.
 * @template T
 * @param {() => Promise<T>} probe
 * @param {{ timeoutMs: number, intervalMs: number, signal?: AbortSignal, onTimeout: () => Error }} options
 * @returns {Promise<NonNullable<T>>}
 */
export async function waitFor(probe, { timeoutMs, intervalMs, signal, onTimeout }) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		if (signal?.aborted) throw signal.reason;
		try {
			const value = await probe();
			if (value) return /** @type {NonNullable<T>} */ (value);
		} catch (error) {
			if (isCancellation(error, signal)) throw error;
			if (performance.now() > deadline) throw error;
		}
		if (performance.now() > deadline) throw onTimeout();
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
