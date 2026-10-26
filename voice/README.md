# Voice tooling

Python tooling (managed by uv) that turns a handful of authorized clips into a small, speaker-filtered, de-duplicated dataset for voice cloning or adaptation. The owner declares permission for private use of the voice; this code never downloads anything and never uploads anything.

Nothing derived from audio is ever committed. Raw clips, normalized audio, segments, transcripts, embeddings, datasets and weights live in a private folder outside Git (by default `voice/private/` of the main checkout, already ignored). Every command takes it from `--private-dir` or `VOICE_PRIVATE_DIR`:

```
private/
  manifest.json      provenance of every raw file: url, title, channel, dub, authorization, status
  raw/               original downloads (untouched)
  normalized/        mono 22.05 kHz WAV, EBU R128 loudness
  separated/         optional vocals stem
  transcripts/       cached Whisper word timings per source (phrases step)
  segments/          one WAV per clip
  segments.jsonl     one record per segment: source, times, similarity, kept, text, logprob, drop reason, split
  dataset/           train.csv, eval.csv (`file.wav|text`, Piper format) and wavs/
  cache/             downloaded models (ECAPA speaker encoder, Whisper)
  report.json        counts and durations per stage
```

## Procedure

```bash
cd voice
uv sync                      # add --extra separate for demucs
export VOICE_PRIVATE_DIR=/path/to/private

uv run jarvis-voice manifest     # once: skeleton to fill by hand (refuses to overwrite)
uv run jarvis-voice normalize    # needs ffmpeg
uv run jarvis-voice separate     # optional, see below
uv run jarvis-voice phrases --reference <source id> --threshold 0.5
uv run jarvis-voice split --reference <source id>
uv run jarvis-voice export
uv run pytest                    # synthetic audio only
```

`phrases` replaces the older `segment`, `filter` and `transcribe` commands, which cut by silence and score whole segments; they are kept for comparison.

1. **Provenance.** `load_verified` stops the pipeline if any raw file lacks source URL, dub, authorization or status. A source with `"status": "excluded"` (plus an `excluded_reason`) is skipped by `phrases`, for example a film where the character has a different voice actor.
2. **Normalize.** ffmpeg to mono 22.05 kHz with loudness normalization. 22.05 kHz is what Piper medium voices train at; the analysis models resample to 16 kHz internally.
3. **Separate (optional).** Demucs `htdemucs` vocals stem for clips with music and effects. Source separation leaves artifacts (watery highs, ducked consonants, music bleeding in silences). Review every separated clip by ear next to the original and keep the better one per clip: `segment --from separated` only for clips that pass. Prefer the original audio when the stem sounds smeared, because a clone learns the artifacts.
4. **Phrases.** faster-whisper transcribes each source with word timings. Words are grouped into phrases that break at sentence punctuation, at an opening `¿` or `¡`, at pauses over 0.3 s and at 15 s, which is where speakers take turns in film dialogue. Phrases under 0.8 s are too short to verify and are dropped. Each phrase is scored against the speaker centroid (step 5) and runs of consecutive accepted phrases with pauses up to 0.35 s become one clip, padded by 0.15 s without crossing the midpoint to a neighbouring word. A fast reply from another voice therefore splits the clip instead of riding inside it. The older `segment` command (Silero VAD, silences of 250 ms split, segments of 1 to 15 s) cannot split such turns.
5. **Speaker filter.** The reference clip (a compilation that is mostly the target character) provides the centroid: the speaker who talks the longest in it, found with an ECAPA-TDNN embedding (`speechbrain/spkrec-ecapa-voxceleb`, Apache-2.0) by duration-weighted cosine clustering. Every segment of every clip is scored against that centroid; segments below `--threshold` are dropped. The speaker report prints the similarity histogram; pick the threshold in the valley between the two modes, not by habit. Check the choice by reading transcripts around the boundary (the character addresses the protagonist as "señor"), never by trusting the score alone.
6. **Transcribe.** faster-whisper `large-v3-turbo` int8, Spanish, beam 5. Segments with mean log-probability below -1.0 are dropped as unreliable text; read the rest before training, ASR slips on names and numbers are normal.
7. **De-duplicate.** Transcripts are lowercased, stripped of accents and punctuation, and compared with a similarity ratio of 0.85 plus containment of 4 or more words. Each group of near-identical lines keeps one segment (longest, then highest speaker similarity), because a compilation clip often contains several shorter lines of the same group and keeping it preserves all of them. Compilations repeat the same line across clips, so this matters.
8. **Split by source clip.** Whole clips go to evaluation until they hold about 20 percent of the audio, the reference clip last because its voice defined the centroid. Because duplicates collapse across all clips before the split, no near-identical line can sit on both sides.
9. **Export.** `train.csv` and `eval.csv` with pipe-delimited `file.wav|text`, the format `python -m piper.train fit` reads, plus `report.json`.

## Evaluation protocol

Run on the held-out eval clips only; compare each candidate (ElevenLabs IVC, Piper fine-tune, any open model) against two anchors: the stock voice in use (lower bound) and the real eval recordings (upper bound).

1. **Speaker similarity.** Synthesize the eval transcripts, embed them with the same ECAPA encoder and report the mean cosine to the reference centroid. A usable clone should land clearly above the stock voice and within about 0.1 of the real recordings.
2. **Intelligibility.** Transcribe the synthesized eval sentences plus 20 neutral assistant replies with faster-whisper and report word error rate against the input text.
3. **Blind listening.** The owner rates 10 shuffled sentences from 1 to 5 for similarity and for naturalness without knowing which system produced them, anchors included.
4. **Processing check.** Synthesize with `VOICE_ROBOTIC_INTENSITY=0` and with the intended value. A voice cloned from already processed film audio should be rated better at 0; a clone from natural audio at 0.15 to 0.3. Never keep both stacked.
5. **Latency.** `pnpm --filter @jarvis/server bench:voice` against the chosen provider; see `docs/voice.md` for the targets and measured numbers.

Reject a candidate that fails any of: similarity below the stock voice, word error rate more than 5 points above the stock voice, or an artifact the owner can name on a blind listen.

## Limits worth knowing

A few minutes of mixed, music-laden film audio is enough for an instant clone (about one to two minutes of clean speech) and far too little to train a voice from scratch. More material of the same speaker, ideally dry (no music), improves every option.

## First run on the owner's private material (aggregates only)

Five audio-only clips, 654 s in total (about 282 s of detected speech in 70 segments), mixing the target character with other voices, music and effects. Reference: the clip that is a compilation of the character's lines (12 segments, 88 s, all in one cluster). Source separation was implemented but not run. Threshold 0.55 (histogram valley between the other-speaker mode below 0.4 and the target mode above 0.6).

| Stage | Segments | Seconds |
| --- | --- | --- |
| VAD candidates | 70 | 282.4 |
| Dropped: other speaker (similarity below 0.55) | 47 | 130.8 |
| Dropped: near-duplicate line | 4 | 9.3 |
| Dropped: low-confidence transcript | 0 | 0 |
| Kept | 19 | 142.3 |
| Train (2 source clips) | 12 | 107.0 |
| Eval (3 source clips) | 7 | 35.3 |

Reading the boundary: 10 of the 19 kept segments contain the character's "señor" address, and 5 of the 11 transcribed-but-rejected segments contain it too, so the threshold favours precision over recall and discards some real lines recorded under music or reverb. A few kept segments contain a short reply from another voice because VAD cannot split fast turn-taking. Both need a listen before any training run. At 107 s of training audio this is enough for an instant clone reference, not for training.

## Second run: phrase-level cuts (aggregates only)

The first run kept segments where another character answered inside a JARVIS line, and its eval split included the Age of Ultron clip. Scored phrase by phrase, that clip's JARVIS lines land at 0.20 to 0.58 against 0.55 to 0.83 for the Iron Man 1 and 2 lines: a different voice, as the owner noticed by ear. It is now excluded in the manifest.

| Stage | Clips | Seconds |
| --- | --- | --- |
| Phrases transcribed (4 sources) | 135 | |
| Phrases too short to verify (< 0.8 s) | 49 | |
| Candidate clips and rejected phrases | 75 | 218.2 |
| Dropped: other speaker (similarity below 0.5) | 46 | 99.8 |
| Dropped: near-duplicate line | 10 | 28.5 |
| Kept | 19 | 89.9 |
| Train | 16 | 81.3 |
| Eval (2 source clips) | 3 | 8.6 |

Phrase scores split cleanly: other characters at 0.35 or less, the character at 0.54 or more, with a handful of ambiguous phrases between 0.40 and 0.49 that the 0.5 threshold drops. Reading every kept transcript found no line from another character. Less audio than the first run, but clean; more Iron Man 1 and 2 material is the way to grow it.

