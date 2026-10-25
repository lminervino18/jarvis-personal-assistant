# syntax=docker/dockerfile:1

FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS restic

FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache sqlite tini tzdata ca-certificates \
 && addgroup -g 10001 jarvis \
 && adduser -D -u 10001 -G jarvis -h /home/jarvis -s /sbin/nologin jarvis \
 && mkdir -p /data /cache \
 && chown jarvis:jarvis /data /cache
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY common.sh /usr/local/bin/
COPY --chmod=755 backup.sh restore.sh schedule.sh table-counts.sh healthcheck.sh /usr/local/bin/
ENV TZ=America/Argentina/Buenos_Aires \
    DATA_DIR=/data \
    CACHE_DIR=/cache \
    RESTIC_CACHE_DIR=/cache/restic
USER jarvis
HEALTHCHECK --interval=5m --timeout=10s --start-period=10m --retries=1 CMD ["healthcheck.sh"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["schedule.sh"]
