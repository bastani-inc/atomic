// Preloaded with `node --import`: this process's clock runs SKEWED_CLOCK_MS ahead (or behind, when negative) of the
// machine's, as a host whose clock drifted would. Leases must not depend on it.
const skew = Number(process.env.SKEWED_CLOCK_MS ?? "0");
const now = Date.now.bind(Date);
Date.now = () => now() + skew;
