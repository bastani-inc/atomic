/**
 * An interactive session joins Intercom at startup, which starts a broker in its agent directory. Test sessions join
 * on first use instead, so a test that never uses Intercom starts no broker that outlives its temporary directory.
 * Tests of the startup join clear this for the sessions they start.
 */
export default function setup(): void {
	process.env.ATOMIC_INTERCOM_JOIN_AT_STARTUP = "0";
}
