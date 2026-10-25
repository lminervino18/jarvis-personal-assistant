import os
import threading

from fastapi import FastAPI, File, Form, UploadFile
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "1"))

whisper = WhisperModel(
    MODEL_NAME,
    device="cpu",
    compute_type="int8",
    cpu_threads=int(os.environ.get("WHISPER_THREADS", "4")),
    download_root=os.environ.get("WHISPER_MODEL_DIR", "/models"),
)
lock = threading.Lock()
app = FastAPI()


@app.get("/health")
def health():
    return {"model": MODEL_NAME, "compute_type": "int8"}


@app.post("/v1/audio/transcriptions")
def transcribe(
    file: UploadFile = File(...),
    model: str = Form(""),
    language: str | None = Form(None),
    prompt: str | None = Form(None),
    temperature: float = Form(0.0),
    response_format: str = Form("json"),
):
    with lock:
        segments, _ = whisper.transcribe(
            file.file,
            language=language or None,
            initial_prompt=prompt or None,
            temperature=temperature,
            beam_size=BEAM_SIZE,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
    return {"text": text}
