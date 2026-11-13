/**
 * Marks a run's options once its resume checked that this node may take the run, so `run()` does not check again.
 * Restoring the run's checkouts has no preconditions (#4738): a checkout that cannot be restored is restored as well as
 * this node can, or the run continues without it.
 */
export const restorePreconditionsChecked = Symbol("restore-preconditions-checked");

/**
 * The directory a resume of a run was started from (#4738): where the run continues when the checkout its working
 * directory is in cannot be restored and is not on this node. `run()` called directly uses its own `cwd`.
 */
export const resumeLaunchCwd = Symbol("resume-launch-cwd");

/**
 * The working directory a run recorded, when its resume continues it elsewhere because the checkout that directory is
 * in could not be restored (#4738): the run keeps it as its own, so a later resume restores that checkout again.
 */
export const recordedInvocationCwd = Symbol("recorded-invocation-cwd");
