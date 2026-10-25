FROM python:3.12-slim

ARG WHISPER_MODEL=small

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
    && useradd --create-home --uid 10001 whisper \
    && mkdir /models \
    && python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8', download_root='/models')" \
    && chown -R whisper /models

COPY server.py /app/server.py
WORKDIR /app
USER whisper
ENV WHISPER_MODEL=${WHISPER_MODEL} HF_HUB_OFFLINE=1
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
