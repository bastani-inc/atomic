// Shifts this process's wall clock by ATOMIC_TEST_CLOCK_SKEW_MS, to inject clock skew in chaos tests.
const skewMs = Number(process.env.ATOMIC_TEST_CLOCK_SKEW_MS ?? "0");
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + skewMs;
