#!/bin/sh
# A git that does not work: each probe of it leaves one line in $COUNTING_GIT_LOG.
echo probe >> "$COUNTING_GIT_LOG"
exit 1
