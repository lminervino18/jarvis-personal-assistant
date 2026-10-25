import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

TRAIN_RATE = 22050
ANALYSIS_RATE = 16000


def normalize(source: Path, target: Path, rate: int = TRAIN_RATE) -> None:
    """Decodes any input to mono 16-bit WAV at `rate` with EBU R128 loudness normalization."""
    target.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(source),
        "-vn", "-ac", "1", "-ar", str(rate),
        "-af", "loudnorm=I=-23:TP=-2:LRA=11",
        "-c:a", "pcm_s16le", str(target),
    ]
    subprocess.run(command, check=True)


def read_mono(path: Path) -> tuple[np.ndarray, int]:
    samples, rate = sf.read(path, dtype="float32", always_2d=True)
    return samples.mean(axis=1), rate


def write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, samples, rate, subtype="PCM_16")


def resample(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate:
        return samples
    import torch
    import torchaudio.functional as F

    tensor = torch.from_numpy(samples).unsqueeze(0)
    return F.resample(tensor, source_rate, target_rate).squeeze(0).numpy()


def duration_s(samples: np.ndarray, rate: int) -> float:
    return len(samples) / rate
