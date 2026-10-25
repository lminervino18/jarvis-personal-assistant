import numpy as np

from .audio import ANALYSIS_RATE, resample

MODEL = "large-v3-turbo"


def load_model(cache_dir: str):
    from faster_whisper import WhisperModel

    return WhisperModel(MODEL, device="cpu", compute_type="int8", download_root=f"{cache_dir}/whisper")


def transcribe(model, samples: np.ndarray, rate: int) -> tuple[str, float]:
    """Returns the Spanish transcript and the mean log-probability of its segments."""
    audio = resample(samples, rate, ANALYSIS_RATE).astype(np.float32)
    segments, _ = model.transcribe(audio, language="es", beam_size=5, condition_on_previous_text=False)
    parts = list(segments)
    text = " ".join(part.text.strip() for part in parts).strip()
    logprob = float(np.mean([part.avg_logprob for part in parts])) if parts else -10.0
    return text, logprob
