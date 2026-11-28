# `@bastani/atomic-timers`

Atomic's internal deadline timers. This private workspace is not published; builds embed the same source in each consumer. Each native timer is at most 2,147,483,647 milliseconds; the deadline is checked again when the timer fires. No dependencies.

- Use `setLongTimeout` or `sleepFor` for elapsed durations. Use `setLongTimeoutAt` or `sleepUntil` if you already have a `performance.now()` deadline. These waits ignore changes to the system clock. On platforms where the monotonic clock pauses during system suspend, they resume counting after wake.
- Use `setWallTimeoutAt` for a timestamp from `Date.now()` or a server. It rechecks the wall clock on each timer turn, at least once a second when the process can run, so a wait that expired during suspend can finish shortly after wake. A clock change cannot make the callback run before the clock reaches the timestamp.
- Timer handles support `clear()`, `ref()` and `unref()`. Promise waits can take an `AbortSignal`. Positive `Infinity` never arms a timer. NaN, negative durations and elapsed deadlines run on the next timer turn.

A timer only exists while its process is running. To make scheduled work survive a restart, store the wall-clock timestamp and re-arm the timer when loading it.
