import { countRoundTrips as countPostgresRoundTrips } from "./postgres-round-trips.js";
import { interceptConnectionRequests } from "./sqlite-connection-requests.js";

/** Counts round trips until `restore`; `take` returns those since the last `take` and starts again. */
export interface RoundTrips {
	take(): number;
	restore(): void;
}

/**
 * Counts the round trips a storage backend of the matrix makes, as each pays for one: on PostgreSQL the queries a
 * connection sends while none of its own are unanswered; on a SQLite file the requests a connection sends its thread
 * while none of its own are unanswered; on a libSQL server the HTTP requests sent while none is unanswered. Requests
 * sent together, while others are out, ride on their round trip.
 */
export function countStorageRoundTrips(backend: { readonly name: string }): RoundTrips {
	const name = backend.name.toLowerCase();
	if (name.includes("postgres")) return countPostgresRoundTrips();
	let trips = 0;
	const take = () => {
		const counted = trips;
		trips = 0;
		return counted;
	};
	if (name.includes("sqlite")) {
		const unanswered = new WeakMap<object, number>();
		const interception = interceptConnectionRequests(async (request, send, connection) => {
			const pending = unanswered.get(connection) ?? 0;
			if (pending === 0) trips++;
			unanswered.set(connection, pending + 1);
			try {
				return await send(request);
			} finally {
				unanswered.set(connection, (unanswered.get(connection) ?? 1) - 1);
			}
		});
		return { take, restore: interception.restore };
	}
	if (name.includes("libsql")) {
		const original = globalThis.fetch;
		let unanswered = 0;
		globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
			if (unanswered === 0) trips++;
			unanswered++;
			try {
				return await original(...args);
			} finally {
				unanswered--;
			}
		}) as typeof fetch;
		return {
			take,
			restore: () => {
				globalThis.fetch = original;
			},
		};
	}
	throw new Error(`No round-trip counter for the ${backend.name} backend`);
}
