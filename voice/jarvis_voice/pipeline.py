import csv
import json
from collections import Counter
from pathlib import Path

import numpy as np

from . import audio, manifest
from .dedupe import group_duplicates
from .segment import detect_speech
from .speakers import dominant_centroid, embed_segments, similarity_to
from .split import choose_eval_sources
from .transcribe import load_model, transcribe

DEFAULT_THRESHOLD = 0.5
MIN_LOGPROB = -1.0


def read_segments(private: Path) -> list[dict]:
    path = private / "segments.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def write_segments(private: Path, segments: list[dict]) -> None:
    (private / "segments.jsonl").write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in segments))


def normalize_all(private: Path) -> list[str]:
    ids = []
    for source in manifest.load_verified(private):
        sid = manifest.source_id(source)
        audio.normalize(private / source["file"], private / "normalized" / f"{sid}.wav")
        ids.append(sid)
    return ids


def separate_all(private: Path) -> None:
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    model = get_model("htdemucs")
    model.eval()
    for wav in sorted((private / "normalized").glob("*.wav")):
        samples, rate = audio.read_mono(wav)
        stereo = torch.from_numpy(audio.resample(samples, rate, model.samplerate)).repeat(2, 1)
        with torch.no_grad():
            stems = apply_model(model, stereo[None], device="cpu", split=True)[0]
        vocals = stems[model.sources.index("vocals")].mean(dim=0).numpy()
        audio.write_wav(private / "separated" / wav.name, audio.resample(vocals, model.samplerate, rate), rate)


def segment_all(private: Path, audio_dir: str) -> list[dict]:
    segments: list[dict] = []
    for wav in sorted((private / audio_dir).glob("*.wav")):
        samples, rate = audio.read_mono(wav)
        for index, span in enumerate(detect_speech(samples, rate)):
            sid = f"{wav.stem}_{index:03d}"
            clip = samples[int(span.start * rate): int(span.end * rate)]
            audio.write_wav(private / "segments" / wav.stem / f"{sid}.wav", clip, rate)
            segments.append({"id": sid, "source": wav.stem, "start": round(span.start, 2), "end": round(span.end, 2), "duration": round(span.duration, 2)})
    write_segments(private, segments)
    return segments


def load_clips(private: Path, segments: list[dict]) -> list[np.ndarray]:
    return [audio.read_mono(private / "segments" / s["source"] / f"{s['id']}.wav")[0] for s in segments]


def filter_speaker(private: Path, reference: str, threshold: float) -> dict:
    segments = read_segments(private)
    rate = audio.TRAIN_RATE
    embeddings = embed_segments(load_clips(private, segments), rate, str(private / "cache"))
    durations = np.array([s["duration"] for s in segments])
    in_reference = np.array([s["source"] == reference for s in segments])
    centroid, cluster = dominant_centroid(embeddings[in_reference], durations[in_reference])
    similarity = similarity_to(centroid, embeddings)
    for segment, score in zip(segments, similarity):
        segment["similarity"] = round(float(score), 3)
        segment["kept"] = bool(score >= threshold)
    write_segments(private, segments)
    report = {
        "reference": reference,
        "reference_segments": int(in_reference.sum()),
        "reference_cluster_segments": int(cluster.sum()),
        "reference_cluster_seconds": round(float(durations[in_reference][cluster].sum()), 1),
        "threshold": threshold,
        "histogram": dict(sorted(Counter(round(float(np.floor(s * 10) / 10), 1) for s in similarity).items())),
    }
    (private / "speaker_report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def transcribe_kept(private: Path) -> None:
    segments = read_segments(private)
    model = load_model(str(private / "cache"))
    for segment in segments:
        if not segment.get("kept"):
            continue
        samples, rate = audio.read_mono(private / "segments" / segment["source"] / f"{segment['id']}.wav")
        segment["text"], segment["logprob"] = transcribe(model, samples, rate)
    write_segments(private, segments)


def dedupe_and_split(private: Path, reference: str) -> dict:
    segments = read_segments(private)
    usable = [s for s in segments if s.get("kept") and s.get("text") and s["logprob"] >= MIN_LOGPROB]
    for segment in segments:
        segment["drop"] = None if segment in usable else ("other_speaker" if not segment.get("kept") else "low_confidence_transcript")
    for group in group_duplicates([s["text"] for s in usable]):
        best = max(group, key=lambda i: (usable[i]["similarity"], usable[i]["duration"]))
        for i in group:
            if i != best:
                usable[i]["drop"] = "near_duplicate"
    final = [s for s in usable if s["drop"] is None]
    durations: dict[str, float] = {}
    for segment in final:
        durations[segment["source"]] = durations.get(segment["source"], 0.0) + segment["duration"]
    evaluation = choose_eval_sources(durations, reference)
    for segment in final:
        segment["split"] = "eval" if segment["source"] in evaluation else "train"
    write_segments(private, segments)
    return summarize(segments)


def summarize(segments: list[dict]) -> dict:
    def stats(rows: list[dict]) -> dict:
        return {"segments": len(rows), "seconds": round(sum(r["duration"] for r in rows), 1)}

    dropped = {reason: stats([s for s in segments if s.get("drop") == reason]) for reason in ("other_speaker", "low_confidence_transcript", "near_duplicate")}
    final = [s for s in segments if s.get("drop") is None and s.get("split")]
    return {
        "candidates": stats(segments),
        "dropped": dropped,
        "kept": stats(final),
        "train": stats([s for s in final if s["split"] == "train"]),
        "eval": stats([s for s in final if s["split"] == "eval"]),
        "eval_sources": sorted({s["source"] for s in final if s["split"] == "eval"}),
    }


def export_dataset(private: Path) -> dict:
    segments = [s for s in read_segments(private) if s.get("split")]
    out = private / "dataset"
    for split in ("train", "eval"):
        rows = [s for s in segments if s["split"] == split]
        for segment in rows:
            audio.write_wav(out / "wavs" / f"{segment['id']}.wav", audio.read_mono(private / "segments" / segment["source"] / f"{segment['id']}.wav")[0], audio.TRAIN_RATE)
        with open(out / f"{split}.csv", "w", newline="") as handle:
            csv.writer(handle, delimiter="|", quoting=csv.QUOTE_NONE, escapechar="\\").writerows((f"{s['id']}.wav", s["text"]) for s in rows)
    report = summarize(read_segments(private))
    (private / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    return report
