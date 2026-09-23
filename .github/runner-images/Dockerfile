# Namespace custom GitHub runner image for Linux CI.
# Build with: nsc base-image build-github-image --os-label ubuntu-24.04 --platform linux/amd64 -f .github/runner-images/Dockerfile
# Namespace supplies NAMESPACE_BASE_IMAGE_REF and requires the final stage/user below.
ARG NAMESPACE_BASE_IMAGE_REF
FROM ${NAMESPACE_BASE_IMAGE_REF}

ARG RUST_VERSION=1.97.0
ARG RUSTUP_VERSION=1.28.2
ENV HOME=/home/runner
ENV CARGO_HOME=/home/runner/.cargo
ENV RUSTUP_HOME=/home/runner/.rustup
ENV PATH="/home/runner/.cargo/bin:${PATH}"
USER runner

# Reuse rustup from the Namespace base when present. Otherwise bootstrap only
# from a version-pinned release artifact whose published SHA-256 is verified.
RUN if [ -x "${CARGO_HOME}/bin/rustup" ]; then \
      :; \
    else \
      curl --fail --silent --show-error --location \
        "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
        --output /tmp/rustup-init \
      && echo '20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c  /tmp/rustup-init' | sha256sum --check --status \
      && chmod 0755 /tmp/rustup-init \
      && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none \
      && rm /tmp/rustup-init; \
    fi \
    && rustup toolchain install "${RUST_VERSION}" --profile minimal \
    && rustup component add --toolchain "${RUST_VERSION}" rustfmt clippy rust-analyzer \
    && rustup target add --toolchain "${RUST_VERSION}" x86_64-unknown-linux-gnu
USER runner
