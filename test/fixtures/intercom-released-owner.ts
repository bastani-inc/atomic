/**
 * #4401 fixture: the owner of a released subagent in a process of its own, so a test can SIGKILL it. It connects to
 * the broker of `ATOMIC_CODING_AGENT_DIR` as the given session, reserves the child for waking, authorizes it, prints
 * `READY <json>`, then prints `WAKE <json>` for every wake notice until it is killed.
 * Usage: <jiti> intercom-released-owner.ts <name> <return-address> <session-id> <owner-token> <child-name> <aliases-json>
 */
import { IntercomClient } from "../../packages/intercom/broker/client.js";

const [name, returnAddress, sessionId, ownerToken, childName, aliasesJson] = process.argv.slice(2);
if (!name || !returnAddress || !sessionId || !ownerToken || !childName || !aliasesJson) {
	throw new Error(
		"usage: intercom-released-owner <name> <return-address> <session-id> <owner-token> <child-name> <aliases-json>",
	);
}

const client = new IntercomClient(returnAddress, { preferredSessionId: sessionId, acknowledgesReceipt: true });
client.on("restoring_recipient_wake", (notice: { readonly childName: string }) => {
	process.stdout.write(`WAKE ${JSON.stringify(notice)}\n`);
});
const now = Date.now();
await client.connect(
	{
		name,
		model: "released-owner-fixture",
		cwd: process.cwd(),
		pid: process.pid,
		status: "idle",
		startedAt: now,
		lastActivity: now,
		group: "default",
		groups: ["default"],
	},
	undefined,
	ownerToken,
);
await client.reserveReleasedChildren([{ childName, aliases: JSON.parse(aliasesJson) as string[], wake: true }]);
const authorization = await client.authorizeSupervisorChild(childName);
process.stdout.write(
	`READY ${JSON.stringify({
		sessionId: client.sessionId,
		capability: authorization.capability,
		supervisorSessionId: authorization.supervisorSessionId,
	})}\n`,
);
setInterval(() => {}, 60_000);
