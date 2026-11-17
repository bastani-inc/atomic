/**
 * #5352: a second process holding an Intercom session with a reach policy. It connects to the broker of the agent
 * directory it inherits, reports what it can and cannot do, then reports what it received. Lines on stdout are JSON.
 */
import { IntercomClient } from "../../../packages/intercom/broker/client.js";

const [home, hostId, hostHome] = process.argv.slice(2);
if (home === undefined || hostId === undefined || hostHome === undefined)
	throw new Error("usage: intercom-reach-peer <home> <hostSessionId> <hostHome>");

function report(record: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

function failure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const client = new IntercomClient(undefined, { reach: () => ({ home, reachable: [] }) });
const received: string[] = [];
client.on("message", (_from: unknown, message: { content: { text: string } }) => {
	received.push(message.content.text);
	report({ type: "received", text: message.content.text });
});

const now = Date.now();
await client.connect(
	{
		name: "reach-peer",
		cwd: process.cwd(),
		model: "peer",
		pid: process.pid,
		startedAt: now,
		lastActivity: now,
		groups: [home],
		group: home,
	},
	undefined,
	undefined,
	undefined,
	home,
);
const listed = (await client.listSessions()).map((session) => session.id);
const send = await client.send(hostId, { text: "from the other process" });
const join = await client.joinGroup(hostHome).then(
	(groups) => ({ joined: groups }),
	(error: unknown) => ({ refused: failure(error) }),
);
const peek = await client.listDirectory(hostHome);
const groups = (await client.listGroups()).map((summary) => summary.group);
report({
	type: "ready",
	sessionId: client.sessionId,
	listed,
	send: { delivered: send.delivered, reason: send.reason },
	join,
	peek: { restricted: peek.restricted === true, sessions: peek.sessions.map((session) => session.id) },
	groups,
});

const deadline = Date.now() + 20_000;
while (received.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
await client.disconnect();
report({ type: "done", received });
