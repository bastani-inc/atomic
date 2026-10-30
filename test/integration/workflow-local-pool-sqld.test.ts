import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";
import { type LatencyProxy, startLatencyProxy } from "../helpers/latency-proxy.js";
import {
	libsqlFlavor,
	REMOTE_JOURNAL_POOL_TIMEOUT_MS,
	REMOTE_JOURNAL_RESUME_TIMEOUT_MS,
	resumeCrashedRoot,
	runPooledRoot,
} from "../helpers/pooled-remote-root.js";

const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));

/**
 * Pooled roots on a real libSQL server, reached over HTTP through the shipped adapter. Runs only when a server is
 * named, for example one started with
 *   docker run -d --rm --name atomic-sqld-e2e -p 127.0.0.1:8080:8080 ghcr.io/tursodatabase/libsql-server:v0.24.33
 * and `ATOMIC_TEST_LIBSQL_URL=http://127.0.0.1:8080`. Every test works under run ids of its own and removes them, so
 * the server may be shared and may outlive the tests. `ATOMIC_TEST_LIBSQL_LATENCY_MS` puts a proxy in front of it that
 * holds every chunk that long in each direction, for a server a network away. `ATOMIC_TEST_LIBSQL_NAMESPACE` selects a
 * namespace of a server started with namespaces enabled.
 */
const serverUrl = process.env.ATOMIC_TEST_LIBSQL_URL;
const latencyMs = Number(process.env.ATOMIC_TEST_LIBSQL_LATENCY_MS ?? 0);
let proxy: LatencyProxy | undefined;
let url = serverUrl;
beforeAll(async () => {
	if (serverUrl === undefined || !(latencyMs > 0)) return;
	proxy = await startLatencyProxy(new URL(serverUrl), latencyMs);
	url = proxy.url;
});
afterAll(() => proxy?.close());
const server = () =>
	libsqlFlavor(url!, libsql, {
		resume: { POOL_RESUME_JOURNAL: "sqld", POOL_RESUME_LIBSQL_URL: url! },
		shared: true,
		namespace: process.env.ATOMIC_TEST_LIBSQL_NAMESPACE,
	});

test.skipIf(serverUrl === undefined || process.platform === "win32").each([{ crash: false }, { crash: true }])(
	"a pooled root runs on a libSQL server, with a dead worker's child replayed from it=$crash",
	({ crash }) => runPooledRoot(server, { crash, label: "sqld-pool" }),
	REMOTE_JOURNAL_POOL_TIMEOUT_MS,
);

test.skipIf(serverUrl === undefined || process.platform === "win32")(
	"resuming a pooled root whose process was killed on a libSQL server replays its children",
	() => resumeCrashedRoot(server, { label: "sqld-resume" }),
	REMOTE_JOURNAL_RESUME_TIMEOUT_MS,
);
