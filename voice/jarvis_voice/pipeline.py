import csv
import json
import shutil
from collections import Counter
from dataclasses import asdict
from functools import cache
from pathlib import Path

import numpy as np

from . import audio, manifest
from .dedupe import group_duplicates
from .phrases import Word, clip_bounds, join_accepted, split_phrases
from .segment import detect_speech
from .speakers import dominant_centroid, embed, embed_segments, load_encoder, similarity_to
from .split import choose_eval_sources
from .transcribe import load_model, transcribe, transcribe_words

DEFAULT_THRESHOLD = 0.5
MIN_LOGPROB = -1.0
MIN_PHRASE_S = 0.8


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
        "histogram": histogram(similarity),
    }
    (private / "speaker_report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def histogram(similarity: np.ndarray) -> dict:
    return dict(sorted(Counter(round(float(np.floor(s * 10) / 10), 1) for s in similarity).items()))


def read_normalized(private: Path, sid: str) -> np.ndarray:
    return audio.read_mono(private / "normalized" / f"{sid}.wav")[0]


def cached_words(private: Path, sid: str, model) -> list[Word]:
    path = private / "transcripts" / f"{sid}.json"
    if not path.exists():
        words = transcribe_words(model(), read_normalized(private, sid), audio.TRAIN_RATE)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps([asdict(word) for word in words], ensure_ascii=False))
    return [Word(**word) for word in json.loads(path.read_text())]


def source_phrases(private: Path) -> dict[str, list[list[Word]]]:
    """Phrases of every active source. Word timings are cached in transcripts/, so a rerun with another threshold skips Whisper."""
    model = cache(lambda: load_model(str(private / "cache")))
    sids = [manifest.source_id(source) for source in manifest.active_sources(private)]
    return {sid: split_phrases(cached_words(private, sid, model)) for sid in sids}


def cut(samples: np.ndarray, start: float, end: float, rate: int = audio.TRAIN_RATE) -> np.ndarray:
    return samples[int(start * rate): int(end * rate)]


def score_phrases(private: Path, sources: dict[str, list[list[Word]]], reference: str) -> tuple[dict[tuple[str, int], float], dict]:
    """Similarity to the dominant speaker of the reference source for every phrase long enough to embed, one source in memory at a time."""
    encoder = load_encoder(str(private / "cache"))
    keys, embeddings, durations = [], [], []
    for sid, phrases in sources.items():
        long = [i for i, p in enumerate(phrases) if p[-1].end - p[0].start >= MIN_PHRASE_S]
        if not long:
            continue
        samples = read_normalized(private, sid)
        waveforms = [cut(samples, phrases[i][0].start, phrases[i][-1].end) for i in long]
        keys += [(sid, i) for i in long]
        embeddings.append(embed(encoder, waveforms, audio.TRAIN_RATE))
        durations += [len(w) / audio.TRAIN_RATE for w in waveforms]
    vectors, seconds = np.concatenate(embeddings), np.array(durations)
    in_reference = np.array([sid == reference for sid, _ in keys])
    centroid, cluster = dominant_centroid(vectors[in_reference], seconds[in_reference])
    similarity = similarity_to(centroid, vectors)
    stats = {"reference_phrases": int(in_reference.sum()), "reference_cluster_phrases": int(cluster.sum()), "histogram": histogram(similarity)}
    return {key: float(score) for key, score in zip(keys, similarity)}, stats


def phrase_record(sid: str, name: str, phrases: list[list[Word]], indices: list[int], scores: dict[int, float]) -> dict:
    words = [word for i in indices for word in phrases[i]]
    before = phrases[indices[0] - 1][-1] if indices[0] > 0 else None
    after = phrases[indices[-1] + 1][0] if indices[-1] + 1 < len(phrases) else None
    start, end = clip_bounds(words, before, after)
    spoken = [phrases[i][-1].end - phrases[i][0].start for i in indices]
    return {
        "id": f"{sid}_{name}", "source": sid, "start": round(start, 2), "end": round(end, 2), "duration": round(end - start, 2),
        "similarity": round(float(np.average([scores[i] for i in indices], weights=spoken)), 3),
        "text": " ".join(word.text for word in words),
        "logprob": round(float(np.mean(np.log([max(word.probability, 1e-6) for word in words]))), 3),
    }


def write_phrase_clips(private: Path, sid: str, phrases: list[list[Word]], scores: dict[int, float], threshold: float) -> list[dict]:
    samples = read_normalized(private, sid)
    accepted = [scores.get(i, 0.0) >= threshold for i in range(len(phrases))]
    records = []
    for n, clip in enumerate(join_accepted(phrases, accepted)):
        record = phrase_record(sid, f"{n:03d}", phrases, clip, scores) | {"kept": True}
        audio.write_wav(private / "segments" / sid / f"{record['id']}.wav", cut(samples, record["start"], record["end"]), audio.TRAIN_RATE)
        records.append(record)
    return records + [phrase_record(sid, f"x{i:03d}", phrases, [i], scores) | {"kept": False} for i in sorted(scores) if not accepted[i]]


def segment_phrases(private: Path, reference: str, threshold: float) -> dict:
    """
    Cuts every active source at speaker turns: Whisper words grouped into phrases, each phrase scored against
    the reference speaker, and runs of accepted phrases written as clips. Replaces segment, filter and transcribe.
    """
    sources = source_phrases(private)
    scores, stats = score_phrases(private, sources, reference)
    shutil.rmtree(private / "segments", ignore_errors=True)
    records = []
    for sid, phrases in sources.items():
        own = {i: score for (source, i), score in scores.items() if source == sid}
        records += write_phrase_clips(private, sid, phrases, own, threshold)
    write_segments(private, records)
    total = sum(len(phrases) for phrases in sources.values())
    report = {"reference": reference, "phrases": total, "phrases_too_short": total - len(scores), **stats, "threshold": threshold}
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


def review_drops(private: Path) -> set[str]:
    """Clip ids dropped by hand after listening or reading transcripts, from review.json: {"drop": {"<id>": "<reason>"}}."""
    path = private / "review.json"
    return set(json.loads(path.read_text())["drop"]) if path.exists() else set()


def drop_reason(segment: dict, reviewed: set[str]) -> str:
    if not segment.get("kept"):
        return "other_speaker"
    return "manual_review" if segment["id"] in reviewed else "low_confidence_transcript"


def dedupe_and_split(private: Path, reference: str) -> dict:
    segments = read_segments(private)
    reviewed = review_drops(private)
    usable = [s for s in segments if s.get("kept") and s.get("text") and s["logprob"] >= MIN_LOGPROB and s["id"] not in reviewed]
    for segment in segments:
        segment["drop"] = None if segment in usable else drop_reason(segment, reviewed)
    for group in group_duplicates([s["text"] for s in usable]):
        best = max(group, key=lambda i: (usable[i]["duration"], usable[i]["similarity"]))
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

    dropped = {reason: stats([s for s in segments if s.get("drop") == reason]) for reason in ("other_speaker", "manual_review", "low_confidence_transcript", "near_duplicate")}
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
    shutil.rmtree(out / "wavs", ignore_errors=True)
    for split in ("train", "eval"):
        rows = [s for s in segments if s["split"] == split]
        for segment in rows:
            audio.write_wav(out / "wavs" / f"{segment['id']}.wav", audio.read_mono(private / "segments" / segment["source"] / f"{segment['id']}.wav")[0], audio.TRAIN_RATE)
        with open(out / f"{split}.csv", "w", newline="") as handle:
            csv.writer(handle, delimiter="|", quoting=csv.QUOTE_NONE, escapechar="\\").writerows((f"{s['id']}.wav", s["text"]) for s in rows)
    report = summarize(read_segments(private))
    (private / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    return report
