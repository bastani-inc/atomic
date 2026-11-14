// A fake Azure CLI for the provisioner conformance suite (#4768): `az vmss scale|list-instances|delete-instances` on
// one scale set kept in FAKE_CLOUD_DIR/state.json. It answers as `az` does, JSON on stdout and `ERROR:` on stderr.
import { active, begin, fail, observe, option, readState, remove, scale, update } from "./fake-cloud.mjs";

const args = process.argv.slice(2);
const secret = process.env.AZURE_CLIENT_SECRET ?? "";
if (
	begin(
		args,
		`ERROR: AADSTS7000215: Invalid client secret provided for client secret ${secret}. Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl\nPlease run 'az login' to setup account.`,
	)
) {
	const [group, command] = args;
	const { target } = readState();
	if (group !== "vmss") fail(`ERROR: 'vmss' is misspelled or not recognized by the system.`, 2);
	if (option(args, "--resource-group") !== target.resourceGroup || option(args, "--name") !== target.name)
		fail(
			`ERROR: (ResourceNotFound) The Resource 'Microsoft.Compute/virtualMachineScaleSets/${option(args, "--name")}' was not found.`,
			3,
		);
	if (option(args, "--subscription") !== target.subscription)
		fail(`ERROR: The subscription '${option(args, "--subscription")}' could not be found.`);
	if (command === "list-instances") {
		if (option(args, "--output") !== "json") fail("ERROR: expected --output json", 2);
		const hosts = update(observe);
		const states = { creating: "Creating", running: "Succeeded", deleting: "Deleting" };
		process.stdout.write(
			JSON.stringify(
				hosts.map((host) => ({
					instanceId: host.id,
					name: `${target.name}_${host.id}`,
					provisioningState: host.state ?? states[host.phase],
					timeCreated: new Date(host.created).toISOString(),
					sku: { name: "Standard_D4s_v5", tier: "Standard" },
				})),
				null,
				2,
			),
		);
	} else if (command === "scale") {
		const capacity = option(args, "--new-capacity");
		if (!/^\d+$/.test(capacity ?? "")) fail(`ERROR: argument --new-capacity: invalid int value: '${capacity}'`, 2);
		update((state) => scale(state, Number(capacity)));
	} else if (command === "delete-instances") {
		const ids = option(args, "--instance-ids");
		const known = update((state) => {
			if (!active(state).some((host) => host.id === ids)) return false;
			remove(state, ids);
			return true;
		});
		if (!known) fail(`ERROR: (InvalidParameter) Instance id ${ids} is not a valid instance id of the scale set.`);
	} else fail(`ERROR: '${command}' is misspelled or not recognized by the system.`, 2);
}
