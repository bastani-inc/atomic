import {
	type CoderAgentMetadata,
	createCoderClient,
} from "../../packages/workflows/src/runs/shared/run-environment-coder.js";
import type { RemoteOperatingSystem } from "../../packages/workflows/src/runs/shared/run-environment-exec.js";

export async function reportedCoderAgent(operatingSystem: RemoteOperatingSystem): Promise<CoderAgentMetadata> {
	const client = createCoderClient({
		deployment: "https://coder.test",
		sessionToken: "test-token",
		fetch: async () =>
			new Response(
				JSON.stringify({
					id: `agent-${operatingSystem}`,
					name: "main",
					operating_system: operatingSystem,
					architecture: "amd64",
				}),
				{ headers: { "content-type": "application/json" } },
			),
	});
	return client.getWorkspaceAgent(`agent-${operatingSystem}`, new AbortController().signal);
}
