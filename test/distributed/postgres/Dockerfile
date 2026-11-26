# PostgreSQL 16, the version CI's storage jobs run, plus the tools the disk faults need: mkfs.ext4 for the data disk
# image and fallocate (util-linux, already in the image) to fill it.
FROM postgres:16@sha256:63e83b5a3dc36a917dccb76fe1bd2ac51f1ec9c1deb47ff20d4f04233bf6eae9
RUN apt-get update \
	&& apt-get install -y --no-install-recommends e2fsprogs \
	&& rm -rf /var/lib/apt/lists/*
