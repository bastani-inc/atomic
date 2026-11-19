import type { Credential } from "../auth/types.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";

interface AccountListResponse {
	ok: boolean;
	status: number;
	body?: unknown;
}

export async function fetchAccountModelList(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<AccountListResponse> {
	const response = await fetch(url, { headers, signal });
	return { ok: response.ok, status: response.status, body: response.ok ? await response.json() : undefined };
}

type Read = { controller: AbortController; result: Promise<AccountListResponse>; waiters: number };
const refreshing = new Map<string, Set<AccountListRequests>>();

/** A normal refresh may still be publishing its public catalog when a peer receives the account's reply.
 * Share just that raw GET with overlapping refreshes. Each applies it to its own catalog and credentials. */
export class AccountListRequests {
	private readonly reads = new Map<string, Read>();
	private readonly peers: Set<AccountListRequests>;
	private readonly account: string;

	constructor(provider: string, baseUrl: string | undefined, credential: Credential) {
		// Register only after resolving auth. A slow restore must not own another account's completed GETs.
		this.account = JSON.stringify([
			provider,
			baseUrl,
			credential.type,
			credential.type === "oauth" ? credential.access : credential.key,
			credential.type === "oauth" && typeof credential.enterpriseUrl === "string" ? credential.enterpriseUrl : undefined,
		]);
		this.peers = refreshing.get(this.account) ?? new Set();
		this.peers.add(this);
		refreshing.set(this.account, this.peers);
	}

	readonly get = async (
		url: string,
		headers: Record<string, string>,
		signal: AbortSignal,
	): Promise<AccountListResponse> => {
		signal.throwIfAborted();
		const key = JSON.stringify([url, headers]);
		let flight = this.reads.get(key);
		if (!flight || flight.controller.signal.aborted) {
			// Someone may have started before this refresh joined the group. Reuse an identical live request only.
			for (const peer of this.peers) {
				const candidate = peer.reads.get(key);
				if (candidate && candidate.waiters > 0 && !candidate.controller.signal.aborted) {
					flight = candidate;
					break;
				}
			}
			if (!flight || flight.controller.signal.aborted) {
				const controller = new AbortController();
				flight = { controller, result: fetchAccountModelList(url, headers, controller.signal), waiters: 0 };
				for (const peer of this.peers) peer.reads.set(key, flight);
			}
		}
		flight.waiters++;
		try {
			return await raceWithAbortSignal(flight.result, signal);
		} finally {
			if (--flight.waiters === 0 && signal.aborted) flight.controller.abort();
		}
	};

	close(): void {
		this.reads.clear();
		this.peers.delete(this);
		if (this.peers.size === 0) refreshing.delete(this.account);
	}
}
