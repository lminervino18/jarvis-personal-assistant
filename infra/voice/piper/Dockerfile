FROM python:3.12-slim

ARG PIPER_VERSION=1.8.0
ARG PIPER_VOICE=es_MX-ald-medium

RUN pip install --no-cache-dir "piper-tts[http]==${PIPER_VERSION}" \
    && useradd --create-home --uid 10001 piper \
    && mkdir /voices \
    && python -m piper.download_voices --data-dir /voices "${PIPER_VOICE}" \
    && chown -R piper /voices

USER piper
ENV PIPER_VOICE=${PIPER_VOICE}
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/info')"

CMD ["sh", "-c", "exec python -m piper.http_server -m \"$PIPER_VOICE\" --data-dir /voices --host 0.0.0.0 --port 5000"]
