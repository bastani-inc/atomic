import { randomUUID } from "node:crypto";
import type { IntercomClient, SupervisorAuthorization } from "./broker/client.js";

/** Parent-runtime cache used to restore broker capabilities after reconnects. */
export class SupervisorAuthorizationRegistry {
  private readonly byCapability = new Map<string, SupervisorAuthorization>();
  readonly ownerToken = randomUUID();

  async authorize(childName: string, connect: () => Promise<IntercomClient>): Promise<SupervisorAuthorization> {
    const client = await connect();
    const authorization = await client.authorizeSupervisorChild(childName.trim());
    this.byCapability.set(authorization.capability, authorization);
    return authorization;
  }

  async restore(client: IntercomClient): Promise<void> {
    for (const [capability, existing] of this.byCapability) {
      const authorization = await client.authorizeSupervisorChild(existing.childName, capability);
      this.byCapability.set(capability, authorization);
    }
  }
}
