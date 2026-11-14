// Fake `az`, `aws`, `gcloud`, `kubectl` and `gh` for the provisioner conformance suite (#4768), run as
// `node fake-cli.mjs <cli> <args>…`. Each answers the commands of its preset in packages/coding-agent/examples/
// worker-fleet/presets as the real CLI would, from one group of hosts kept in FAKE_CLOUD_DIR/state.json. The list
// queries (a JMESPath --query, a gcloud --format, a kubectl go-template, gh --json) must be the preset's exactly: the
// fake prints what the real CLI prints for them.
import { active, begin, create, fail, observe, readState, remove, scale, update } from "./fake-cloud.mjs";

const [cli, ...args] = process.argv.slice(2);
const secret = process.env.FAKE_SECRET ?? "";
const auth = {
	az: `ERROR: AADSTS7000215: Invalid client secret provided for client secret ${secret}. Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl\nPlease run 'az login' to setup account.`,
	aws: `An error occurred (ExpiredToken) when calling the DescribeAutoScalingGroups operation: The security token included in the request is expired. aws_secret_access_key=${secret}`,
	gcloud: `ERROR: (gcloud.compute.instance-groups.managed) There was a problem refreshing your current auth tokens: Reauthentication required. access_token: ${secret}`,
	kubectl: `error: You must be logged in to the server (Unauthorized): the server rejected token=${secret}\nAuthorization: Bearer ${secret}`,
	gh: `HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login. GH_TOKEN=${secret}`,
};

const has = (...expected) => expected.every((arg, index) => args[index] === arg);
const flag = (name) => {
	const index = args.indexOf(name);
	if (index >= 0) return args[index + 1];
	return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
};
const json = (value) => process.stdout.write(JSON.stringify(value, null, 2));
/** The hosts of one list call: pending ones become running a list later, deleted ones drop out a list later. */
const listed = () => update(observe);
const removeOne = (id) =>
	update((state) => {
		const host = active(state).find((entry) => String(entry.id) === id);
		if (host !== undefined) remove(state, host.id);
		return host !== undefined;
	});
const scaleTo = (value) => {
	if (!/^\d+$/.test(value ?? "")) fail(`${cli}: invalid count '${value}'`, 2);
	update((state) => scale(state, Number(value)));
};

function az() {
	const scope = ["--resource-group", "atomic-rg", "--name", "atomic-workers"];
	if (has("vmss", "scale", ...scope, "--new-capacity")) {
		scaleTo(args[7]);
	} else if (has("vmss", "list-instances", ...scope, "--query")) {
		if (args[7] !== "[].{id: instanceId, state: provisioningState, since: timeCreated}") fail("ERROR: unexpected --query", 2);
		const states = { creating: "Creating", running: "Succeeded", deleting: "Deleting" };
		json(listed().map((host) => ({ id: host.id, state: host.state ?? states[host.phase], since: new Date(host.created).toISOString() })));
	} else if (has("vmss", "delete-instances", ...scope, "--instance-ids")) {
		if (!removeOne(args[7])) fail(`ERROR: (InvalidParameter) Instance id ${args[7]} is not a valid instance id of the scale set.`);
	} else fail(`ERROR: (ResourceNotFound) unexpected az command: ${args.join(" ")}`, 3);
}

function aws() {
	if (has("autoscaling", "set-desired-capacity", "--auto-scaling-group-name", "atomic-workers", "--desired-capacity")) {
		scaleTo(args[5]);
	} else if (has("autoscaling", "describe-auto-scaling-groups", "--auto-scaling-group-names", "atomic-workers", "--query")) {
		if (args[5] !== "AutoScalingGroups[0].Instances[].{id: InstanceId, state: LifecycleState}") fail("unexpected --query", 2);
		const states = { creating: "Pending", running: "InService", deleting: "Terminating" };
		json(listed().map((host) => ({ id: host.id, state: host.state ?? states[host.phase] })));
	} else if (has("autoscaling", "terminate-instance-in-auto-scaling-group", "--instance-id")) {
		if (!args.includes("--should-decrement-desired-capacity")) fail("expected --should-decrement-desired-capacity", 2);
		if (!removeOne(args[3]))
			fail(`An error occurred (ValidationError) when calling the TerminateInstanceInAutoScalingGroup operation: Instance Id not found - No managed instance found for instance ID: ${args[3]}`, 254);
		json({ Activity: { StatusCode: "InProgress" } });
	} else fail(`aws: error: unexpected command: ${args.join(" ")}`, 252);
}

function gcloud() {
	const group = ["compute", "instance-groups", "managed"];
	if (!has(...group) || args[4] !== "atomic-workers" || args[5] !== "--zone=us-central1-a")
		fail(`ERROR: (gcloud) unexpected command: ${args.join(" ")}`, 2);
	if (args[3] === "resize") scaleTo(flag("--size"));
	else if (args[3] === "list-instances") {
		if (flag("--format") !== "json(name,currentAction)") fail("ERROR: unexpected --format", 2);
		const actions = { creating: "CREATING", running: "NONE", deleting: "DELETING" };
		json(listed().map((host) => ({ currentAction: host.state ?? actions[host.phase], name: host.id })));
	} else if (args[3] === "delete-instances") {
		if (!removeOne(flag("--instances")))
			fail(`ERROR: (gcloud.compute.instance-groups.managed.delete-instances) The resource '${flag("--instances")}' is not a member of the group.`);
	} else fail(`ERROR: (gcloud) unexpected command: ${args.join(" ")}`, 2);
}

function kubectl() {
	if (!has("--namespace", "atomic")) fail(`Error from server (Forbidden): pods is forbidden in "${flag("--namespace")}"`);
	const rest = args.slice(2);
	if (rest[0] === "scale" && rest[1] === "deployment/atomic-worker") {
		scaleTo(rest[2]?.replace(/^--replicas=/, ""));
		process.stdout.write("deployment.apps/atomic-worker scaled\n");
	} else if (rest[0] === "get" && rest[1] === "pods") {
		if (flag("--selector") !== "app=atomic-worker") return json([]);
		const template = flag("--output") ?? "";
		if (!template.startsWith("go-template=[{{range $i, $p := .items}}")) fail("error: unexpected --output", 1);
		json(
			listed().map((pod) => ({
				id: pod.id,
				state: pod.phase === "deleting" ? "Terminating" : (pod.podPhase ?? (pod.phase === "creating" ? "Pending" : "Running")),
			})),
		);
	} else if (rest[0] === "annotate" && rest[1] === "pod") {
		const found = update((state) => {
			const pod = active(state).find((entry) => entry.id === rest[2]);
			if (pod !== undefined && rest[3] === "controller.kubernetes.io/pod-deletion-cost=-1000") pod.cost = -1000;
			return pod !== undefined;
		});
		if (!found) fail(`Error from server (NotFound): pods "${rest[2]}" not found`);
		process.stdout.write(`pod/${rest[2]} annotated\n`);
	} else fail(`error: unknown command "${rest.join(" ")}" for "kubectl"`);
}

function gh() {
	if (has("workflow", "run", "atomic-workers.yml", "--repo", "acme/flows")) {
		if (!args.includes("workers=1")) fail("could not create workflow dispatch event: expected workers=1", 1);
		update(create);
	} else if (has("run", "list", "--repo", "acme/flows", "--workflow", "atomic-workers.yml", "--status")) {
		if (args[9] !== "databaseId,status,createdAt") fail("Unknown JSON field", 1);
		const statuses = { creating: "queued", running: "in_progress", deleting: "completed" };
		// The preset lists queued runs first: that call is the list that moves the cloud on, the others only read it.
		const runs = args[7] === "queued" ? listed() : readState().hosts;
		json(
			runs
				.filter((run) => statuses[run.phase] === args[7])
				.map((run) => ({ createdAt: new Date(run.created).toISOString(), databaseId: run.id, status: statuses[run.phase] })),
		);
	} else if (has("run", "cancel")) {
		if (!removeOne(args[2])) fail(`run ${args[2]} not found`);
		process.stdout.write(`✓ Request to cancel workflow ${args[2]} submitted.\n`);
	} else fail(`unknown command "${args.join(" ")}" for "gh"`);
}

if (begin(args, auth[cli])) ({ az, aws, gcloud, kubectl, gh })[cli]();
