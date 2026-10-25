import argparse
import json
import os
from pathlib import Path

from . import manifest, pipeline

AUDIO_DIRS = ["normalized", "separated"]


def private_dir(value: str | None) -> Path:
    chosen = value or os.environ.get("VOICE_PRIVATE_DIR")
    if not chosen:
        raise SystemExit("pass --private-dir or set VOICE_PRIVATE_DIR (the folder outside Git that holds the raw clips)")
    return Path(chosen).expanduser().resolve()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="jarvis-voice")
    parser.add_argument("--private-dir", help="defaults to $VOICE_PRIVATE_DIR")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("manifest", help="write a provenance manifest template for the files in raw/")
    commands.add_parser("normalize", help="ffmpeg: mono 22.05 kHz, loudness-normalized WAVs")
    commands.add_parser("separate", help="optional: demucs vocals stem (review the output by ear)")
    segment = commands.add_parser("segment", help="VAD segmentation")
    segment.add_argument("--from", dest="audio_dir", default="normalized", choices=AUDIO_DIRS)
    speaker = commands.add_parser("filter", help="keep segments close to the reference speaker")
    speaker.add_argument("--reference", required=True, help="source id whose dominant speaker is the target")
    speaker.add_argument("--threshold", type=float, default=pipeline.DEFAULT_THRESHOLD)
    commands.add_parser("transcribe", help="faster-whisper transcripts for kept segments")
    split = commands.add_parser("split", help="drop duplicates and split train/eval by source clip")
    split.add_argument("--reference", required=True)
    commands.add_parser("export", help="write dataset CSVs, WAVs and report.json")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    private = private_dir(args.private_dir)
    if args.command == "manifest":
        print(manifest.write_template(private))
    elif args.command == "normalize":
        print(json.dumps(pipeline.normalize_all(private)))
    elif args.command == "separate":
        pipeline.separate_all(private)
    elif args.command == "segment":
        print(len(pipeline.segment_all(private, args.audio_dir)), "segments")
    elif args.command == "filter":
        print(json.dumps(pipeline.filter_speaker(private, args.reference, args.threshold), indent=2))
    elif args.command == "transcribe":
        pipeline.transcribe_kept(private)
    elif args.command == "split":
        print(json.dumps(pipeline.dedupe_and_split(private, args.reference), indent=2))
    else:
        print(json.dumps(pipeline.export_dataset(private), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
