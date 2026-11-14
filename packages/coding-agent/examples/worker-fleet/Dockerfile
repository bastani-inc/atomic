# The Atomic worker image (#4768): one portable worker host. Build it with your workflow definitions in /srv/flows at
# the same absolute paths the roots use, or let roots bind their children to a workspace that hosts restore.
FROM node:22-bookworm-slim
ARG ATOMIC_VERSION=latest
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @bastani/atomic@${ATOMIC_VERSION}
USER node
RUN atomic install npm:@bastani/atomic-storage-libsql
# COPY --chown=node flows/ /srv/flows/
STOPSIGNAL SIGTERM
# exec makes atomic PID 1, so the platform's SIGTERM drains the host. ATOMIC_DB and ATOMIC_WORKER_PROVIDER_ID come from
# the environment; the token is a mounted secret file, never an environment variable or build argument.
ENTRYPOINT ["sh", "-c", "exec atomic worker start --db \"$ATOMIC_DB\" --token-file /run/secrets/atomic-db-token \"$@\"", "--"]
CMD ["--slots", "4"]
