// A fake kubectl for the provisioner conformance suite (#4768): `get`, `scale` and `delete` on one Deployment or
// StatefulSet and its pods, kept in FAKE_CLOUD_DIR/state.json. A deleted pod is replaced, as its ReplicaSet or
// StatefulSet would: a ReplicaSet's replacement is a new pod, a StatefulSet's has the same name.
import { active, begin, create, fail, observe, option, readState, remove, scale, update } from "./fake-cloud.mjs";

const args = process.argv.slice(2);
const secret = process.env.KUBE_TOKEN ?? "";
if (
	begin(
		args,
		`error: You must be logged in to the server (Unauthorized): the server rejected token=${secret}\nAuthorization: Bearer ${secret}`,
	)
) {
	const { target, kind } = readState();
	const workload = kind === "statefulset" ? "statefulset" : "deployment";
	const namespace = option(args, "--namespace");
	if (namespace !== target.namespace)
		fail(`Error from server (Forbidden): pods is forbidden: cannot list resource "pods" in "${namespace}"`);
	if (option(args, "--context") !== target.context) fail(`error: context "${option(args, "--context")}" does not exist`);
	const words = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.match(/^--(namespace|context|selector|field-selector|output)$/));
	const [verb, resource, name] = words;
	const json = (value) => process.stdout.write(JSON.stringify(value, null, 2));
	if (verb === "get" && resource === "pods") {
		if (option(args, "--output") !== "json") fail("error: expected --output json");
		if (option(args, "--selector") !== target.selector) json({ apiVersion: "v1", kind: "List", items: [] });
		else {
			const only = option(args, "--field-selector")?.replace(/^metadata\.name=/, "");
			const pods = update(observe).filter((pod) => only === undefined || pod.id === only);
			json({
				apiVersion: "v1",
				kind: "List",
				items: pods.map((pod) => ({
					metadata: {
						name: pod.id,
						namespace,
						labels: { app: "atomic-worker" },
						creationTimestamp: new Date(pod.created).toISOString(),
						...(pod.phase === "deleting" ? { deletionTimestamp: new Date().toISOString() } : {}),
					},
					status: {
						phase: pod.podPhase ?? (pod.phase === "creating" ? "Pending" : "Running"),
						...(pod.phase === "creating" ? {} : { startTime: new Date(pod.created + 1000).toISOString() }),
					},
				})),
			});
		}
	} else if (verb === "get" && resource === workload) {
		if (name !== target.workload) fail(`Error from server (NotFound): ${workload}s.apps "${name}" not found`);
		const state = readState();
		if (state.rawWorkload !== undefined) {
			process.stdout.write(state.rawWorkload);
			process.exit(0);
		}
		const replicas = state.reportReplicas ?? active(state).length;
		json({ kind: kind === "statefulset" ? "StatefulSet" : "Deployment", metadata: { name }, spec: { replicas } });
	} else if (verb === "scale" && resource === `${workload}/${target.workload}`) {
		const replicas = Number(option(args, "--replicas"));
		const expected = option(args, "--current-replicas");
		const was = update((state) => {
			const current = active(state).length;
			if (expected === undefined || Number(expected) === current) scale(state, replicas);
			return current;
		});
		if (expected !== undefined && Number(expected) !== was)
			fail(`error: Expected replicas to be ${expected}, was ${was}`);
		process.stdout.write(`${workload}.apps/${target.workload} scaled\n`);
	} else if (verb === "delete" && resource === "pod") {
		update((state) => {
			const pod = state.hosts.find((host) => host.id === name && host.phase !== "deleting");
			if (pod === undefined) return;
			remove(state, name);
			// A pod that already ended was replaced when it ended; any other is replaced now.
			if (pod.podPhase !== "Failed" && pod.podPhase !== "Succeeded") create(state);
		});
		process.stdout.write(`pod "${name}" deleted\n`);
	} else fail(`error: unknown command "${words.join(" ")}" for "kubectl"`);
}
