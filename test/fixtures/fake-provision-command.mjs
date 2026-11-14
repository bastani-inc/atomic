// A provisioner script for the `command` provisioner's conformance suite (#4768), run as
// `node fake-provision-command.mjs <state dir> --token=<secret> up|down|list`. `up` reads ATOMIC_TARGET, `down` reads
// ATOMIC_PROVIDER_ID, and `list` prints the hosts as JSON.
const [dir, , action] = process.argv.slice(2);
process.env.FAKE_CLOUD_DIR = dir;
const { begin, fail, observe, remove, scale, update } = await import("./fake-cloud.mjs");

const secret = process.argv[3]?.replace(/^--token=/, "");
if (begin([action], `provision: authentication failed for token ${secret}; password=${secret}`)) {
	if (action === "up") {
		const target = process.env.ATOMIC_TARGET ?? "";
		if (!/^\d+$/.test(target)) fail(`provision: bad ATOMIC_TARGET ${target}`, 2);
		update((state) => scale(state, Number(target)));
	} else if (action === "down") {
		const id = process.env.ATOMIC_PROVIDER_ID;
		if (!id) fail("provision: ATOMIC_PROVIDER_ID is not set", 2);
		update((state) => remove(state, id));
	} else if (action === "list") {
		const states = { creating: "pending", running: "running", deleting: "draining" };
		const hosts = update(observe).map((host) => ({ id: host.id, state: states[host.phase], since: host.created }));
		process.stdout.write(`${JSON.stringify(hosts)}\n`);
	} else fail(`provision: unknown action ${action}`, 2);
}
