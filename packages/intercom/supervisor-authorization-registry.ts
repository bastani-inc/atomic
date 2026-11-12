import { randomUUID } from "node:crypto";
import { type IntercomClient, type SupervisorAuthorization, SupervisorAuthorizationTimeoutError } from "./broker/client.js";

const DYNAMIC_SLOT = "*";

const childKey = (childName: string): string => childName.trim().toLowerCase();

/** Parent-runtime cache used to restore the broker capabilities of live children after reconnects. */
export class SupervisorAuthorizationRegistry {
	private readonly byChild = new Map<string, SupervisorAuthorization>();
	private readonly dynamicSlots = new Map<string, SupervisorAuthorization>();
	private readonly childByCapability = new Map<string, string>();
	readonly ownerToken = randomUUID();

	get size(): number {
		return this.byChild.size + this.dynamicSlots.size;
	}

	async authorize(childName: string, connect: () => Promise<IntercomClient>): Promise<SupervisorAuthorization> {
		const client = await connect();
		const authorization = await client.authorizeSupervisorChild(childName.trim()).catch((error: unknown) => {
			// #4697: the broker answers authorization at once, so a timeout on a connection that then passed its health
			// check is a passing stall. Ask once more; the broker handles requests in order, so this answer's
			// capability is the one it keeps for the child, and the unanswered request's late reply is dropped.
			if (!(error instanceof SupervisorAuthorizationTimeoutError)) throw error;
			return client.authorizeSupervisorChild(childName.trim());
		});
		this.remember(authorization);
		return authorization;
	}

	forget(childNames: readonly string[]): void {
		for (const childName of childNames) {
			const key = childKey(childName);
			const existing = this.byChild.get(key);
			if (existing === undefined) continue;
			this.byChild.delete(key);
			this.childByCapability.delete(existing.capability);
		}
	}

	forgetCapability(capability: string): void {
		const key = this.childByCapability.get(capability);
		if (key !== undefined) this.forget([key]);
		this.dynamicSlots.delete(capability);
	}

	async restore(client: IntercomClient): Promise<void> {
		for (const existing of [...this.byChild.values(), ...this.dynamicSlots.values()]) {
			const authorization = await client.authorizeSupervisorChild(existing.childName, existing.capability);
			if (this.current(existing)) this.remember(authorization);
		}
	}

	private current(authorization: SupervisorAuthorization): boolean {
		return authorization.childName === DYNAMIC_SLOT
			? this.dynamicSlots.get(authorization.capability) === authorization
			: this.byChild.get(childKey(authorization.childName)) === authorization;
	}

	private remember(authorization: SupervisorAuthorization): void {
		if (authorization.childName === DYNAMIC_SLOT) {
			this.dynamicSlots.set(authorization.capability, authorization);
			return;
		}
		const key = childKey(authorization.childName);
		const previous = this.byChild.get(key);
		if (previous !== undefined) this.childByCapability.delete(previous.capability);
		this.byChild.set(key, authorization);
		this.childByCapability.set(authorization.capability, key);
	}
}
