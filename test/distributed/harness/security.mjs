// @ts-check
/**
 * The security gate's verdicts, as pure functions over what the gate observed: sqld listener addresses and the list
 * of recorded checks. The gate fails as a whole when any check fails, before any scenario starts.
 */
import { DistributedSecurityError } from "./errors.mjs";

/**
 * @typedef {{ name: string, subject: string, passed: boolean, observed: unknown }} SecurityCheck
 */

/**
 * Whether a database host's listening sockets keep sqld's HTTP and admin listeners on loopback and the gateway and
 * replication listeners on the private address only. Returns the offending sockets.
 * @param {readonly string[]} sockets `address:port` as `ss -ltnH` prints them
 * @param {{ privateIp: string, gatewayPort: number, replicationPort: number, loopbackPorts: readonly number[] }} expected
 */
export function bindViolations(sockets, { privateIp, gatewayPort, replicationPort, loopbackPorts }) {
	const offending = sockets.filter((socket) => {
		const at = socket.lastIndexOf(":");
		const port = Number(socket.slice(at + 1));
		const address = socket.slice(0, at);
		if (loopbackPorts.includes(port)) return address !== "127.0.0.1";
		if (port === gatewayPort || port === replicationPort) return address !== privateIp;
		return false;
	});
	if (!sockets.includes(`${privateIp}:${gatewayPort}`)) return [...offending, `missing ${privateIp}:${gatewayPort}`];
	return offending;
}

/**
 * The gate's result, throwing `DistributedSecurityError` with every failed check when any failed. An empty list of
 * checks is a failure: a gate that checked nothing proves nothing.
 * @param {readonly SecurityCheck[]} checks
 */
export function gateVerdict(checks) {
	const failed = checks.filter((check) => !check.passed);
	if (checks.length === 0)
		failed.push({ name: "gate-ran", subject: "security gate", passed: false, observed: "no checks recorded" });
	if (failed.length > 0) {
		throw new DistributedSecurityError({
			violations: failed.map((check) => ({
				check: check.name,
				subject: check.subject,
				detail: (JSON.stringify(check.observed) ?? "").slice(0, 300),
			})),
		});
	}
	return { passed: true, checks: [...checks] };
}
