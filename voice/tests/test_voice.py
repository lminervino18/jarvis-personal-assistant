import json
import shutil

import numpy as np
import pytest

from jarvis_voice import audio, manifest, pipeline
from jarvis_voice.dedupe import group_duplicates, near_duplicates, normalize_text
from jarvis_voice.phrases import Word, clip_bounds, join_accepted, split_phrases
from jarvis_voice.segment import Span, merge_spans
from jarvis_voice.speakers import dominant_centroid
from jarvis_voice.split import choose_eval_sources


def test_merge_spans_joins_short_gaps_and_drops_short_leftovers():
    spans = [Span(0.0, 1.0), Span(1.2, 2.5), Span(5.0, 5.4), Span(8.0, 10.0)]
    assert merge_spans(spans) == [Span(0.0, 2.5), Span(8.0, 10.0)]


def test_merge_spans_respects_the_maximum_length():
    spans = [Span(0.0, 8.0), Span(8.1, 16.0)]
    assert merge_spans(spans) == [Span(0.0, 8.0), Span(8.1, 16.0)]


def test_split_phrases_breaks_at_punctuation_pauses_and_opening_marks():
    words = [Word(0.0, 0.4, "Entonces,"), Word(0.5, 0.9, "qué"), Word(0.9, 1.3, "dices?"), Word(1.4, 1.8, "Nuestra"),
             Word(1.8, 2.3, "descarga"), Word(2.9, 3.2, "lista"), Word(3.2, 3.5, "señor"), Word(3.6, 3.9, "¿Iniciamos?")]
    texts = [[w.text for w in phrase] for phrase in split_phrases(words)]
    assert texts == [["Entonces,", "qué", "dices?"], ["Nuestra", "descarga"], ["lista", "señor"], ["¿Iniciamos?"]]


def test_split_phrases_caps_the_phrase_length():
    words = [Word(float(i), i + 0.9, "palabra") for i in range(20)]
    assert [len(phrase) for phrase in split_phrases(words, max_gap=1.0, max_len=5.0)] == [5, 5, 5, 5]


def test_join_accepted_merges_only_adjacent_accepted_phrases():
    phrases = [[Word(0.0, 1.0, "a.")], [Word(1.2, 2.0, "b.")], [Word(2.1, 3.0, "c.")], [Word(3.1, 4.0, "d.")], [Word(5.0, 6.0, "e.")]]
    assert join_accepted(phrases, [True, True, False, True, True]) == [[0, 1], [3], [4]]


def test_clip_bounds_pad_without_crossing_the_gap_midpoint():
    words = [Word(2.0, 3.0, "hola")]
    assert clip_bounds(words, Word(1.0, 1.9, "x"), Word(4.0, 4.5, "y")) == (1.95, 3.15)
    assert clip_bounds([Word(0.05, 1.0, "hola")], None, None) == (0.0, 1.15)


def test_cached_words_skip_whisper(tmp_path):
    (tmp_path / "transcripts").mkdir()
    (tmp_path / "transcripts" / "x.json").write_text(json.dumps([{"start": 0.0, "end": 0.5, "text": "Señor.", "probability": 0.9}]))

    def model():
        raise AssertionError("Whisper must not run when a transcript is cached")

    assert pipeline.cached_words(tmp_path, "x", model) == [Word(0.0, 0.5, "Señor.", 0.9)]


def test_text_normalization_ignores_case_accents_and_punctuation():
    assert normalize_text("¡Buenas noches, Señor Stark!") == "buenas noches senor stark"


def test_near_duplicates_match_asr_slips_and_containment_but_not_different_lines():
    assert near_duplicates("A sus órdenes, señor.", "a sus ordenes señor")
    assert near_duplicates("Todos los sistemas están en línea, señor", "Todos los sistemas están en línea, señor Stark, y listos")
    assert not near_duplicates("Bienvenido a casa, señor.", "Los sistemas están en línea.")


def test_group_duplicates_returns_connected_components():
    texts = ["a sus órdenes señor", "Los sistemas están en línea", "A sus ordenes, señor.", "Bienvenido a casa"]
    assert sorted(map(sorted, group_duplicates(texts))) == [[0, 2], [1], [3]]


def test_dominant_centroid_finds_the_longest_speaker():
    rng = np.random.default_rng(0)
    jarvis, tony = rng.normal(size=192), rng.normal(size=192)
    embeddings = np.stack([jarvis + 0.1 * rng.normal(size=192) for _ in range(6)] + [tony + 0.1 * rng.normal(size=192) for _ in range(3)])
    durations = np.array([3.0] * 6 + [2.0] * 3)
    centroid, members = dominant_centroid(embeddings, durations)
    assert members.tolist() == [True] * 6 + [False] * 3
    assert float(centroid @ (jarvis / np.linalg.norm(jarvis))) > 0.95


def test_eval_sources_are_whole_clips_and_avoid_the_reference_first():
    durations = {"ref": 40.0, "a": 30.0, "b": 12.0, "c": 18.0}
    chosen = choose_eval_sources(durations, reference="ref")
    assert chosen == {"b", "c"} or chosen == {"b"}
    assert "ref" not in chosen
    assert choose_eval_sources({"only": 10.0}, reference="only") == {"only"}


def test_manifest_refuses_missing_authorization(tmp_path):
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw" / "x.webm").write_bytes(b"synthetic")
    entry = {"file": "raw/x.webm", "source_url": "u", "title": "t", "channel": "c", "dub": "latino", "authorization": "", "status": "raw"}
    (tmp_path / "manifest.json").write_text(json.dumps({"sources": [entry]}))
    with pytest.raises(ValueError, match="authorization"):
        manifest.load_verified(tmp_path)
    entry["authorization"] = "personal use"
    (tmp_path / "manifest.json").write_text(json.dumps({"sources": [entry]}))
    assert manifest.source_id(manifest.load_verified(tmp_path)[0]) == "x"
    entry["status"] = "excluded"
    (tmp_path / "manifest.json").write_text(json.dumps({"sources": [entry]}))
    assert manifest.active_sources(tmp_path) == []


def test_manifest_template_never_overwrites_existing_provenance(tmp_path):
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw" / "x.webm").write_bytes(b"synthetic")
    path = manifest.write_template(tmp_path)
    assert json.loads(path.read_text())["sources"][0]["file"] == "raw/x.webm"
    with pytest.raises(FileExistsError):
        manifest.write_template(tmp_path)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")
def test_normalize_produces_mono_wav_at_the_training_rate(tmp_path):
    rate = 44100
    tone = (0.3 * np.sin(2 * np.pi * 220 * np.arange(rate) / rate)).astype("float32")
    source = tmp_path / "tone.wav"
    audio.write_wav(source, tone, rate)
    target = tmp_path / "out" / "tone.wav"
    audio.normalize(source, target)
    samples, out_rate = audio.read_mono(target)
    assert out_rate == audio.TRAIN_RATE
    assert abs(len(samples) / out_rate - 1.0) < 0.05
