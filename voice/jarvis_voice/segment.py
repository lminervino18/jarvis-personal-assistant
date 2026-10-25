from dataclasses import dataclass

import numpy as np

from .audio import ANALYSIS_RATE, resample

MIN_SEGMENT_S = 1.0
MAX_SEGMENT_S = 15.0
MERGE_GAP_S = 0.35


@dataclass(frozen=True)
class Span:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def merge_spans(spans: list[Span], max_gap: float = MERGE_GAP_S, max_len: float = MAX_SEGMENT_S, min_len: float = MIN_SEGMENT_S) -> list[Span]:
    """Joins neighbouring speech spans separated by short gaps, never exceeding `max_len`, and drops short leftovers."""
    merged: list[Span] = []
    for span in sorted(spans, key=lambda s: s.start):
        if merged and span.start - merged[-1].end <= max_gap and span.end - merged[-1].start <= max_len:
            merged[-1] = Span(merged[-1].start, span.end)
        else:
            merged.append(span)
    return [span for span in merged if span.duration >= min_len]


def detect_speech(samples: np.ndarray, rate: int) -> list[Span]:
    import torch
    from silero_vad import get_speech_timestamps, load_silero_vad

    audio = torch.from_numpy(resample(samples, rate, ANALYSIS_RATE))
    found = get_speech_timestamps(
        audio, load_silero_vad(), sampling_rate=ANALYSIS_RATE, return_seconds=True,
        min_speech_duration_ms=300, min_silence_duration_ms=250, max_speech_duration_s=MAX_SEGMENT_S,
    )
    return merge_spans([Span(item["start"], item["end"]) for item in found])
