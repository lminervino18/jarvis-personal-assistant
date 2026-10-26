import json
from datetime import datetime, timezone
from pathlib import Path

REQUIRED_FIELDS = ("file", "source_url", "title", "channel", "dub", "authorization", "status")


def template(raw_files: list[str]) -> dict:
    """Provenance manifest skeleton, one entry per raw file, to be completed by hand."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    sources = [
        {
            "file": name, "source_url": "", "title": "", "channel": "", "duration_s": None,
            "downloaded_at": now, "dub": "", "authorization": "", "status": "raw",
        }
        for name in sorted(raw_files)
    ]
    return {"manifest_version": 1, "sources": sources}


def write_template(private_dir: Path) -> Path:
    path = private_dir / "manifest.json"
    if path.exists():
        raise FileExistsError(f"{path} already exists; edit it instead of overwriting provenance")
    names = [f"raw/{p.name}" for p in (private_dir / "raw").glob("*") if p.suffix in {".webm", ".mp3", ".m4a", ".wav", ".mp4", ".opus"}]
    path.write_text(json.dumps(template(names), indent=2, ensure_ascii=False) + "\n")
    return path


def load_verified(private_dir: Path) -> list[dict]:
    """Returns the sources, refusing to continue when a file lacks provenance or authorization."""
    manifest = json.loads((private_dir / "manifest.json").read_text())
    for source in manifest["sources"]:
        missing = [field for field in REQUIRED_FIELDS if not source.get(field)]
        if missing:
            raise ValueError(f"{source.get('file', '?')}: manifest is missing {', '.join(missing)}")
        if not (private_dir / source["file"]).exists():
            raise FileNotFoundError(private_dir / source["file"])
    return manifest["sources"]


def active_sources(private_dir: Path) -> list[dict]:
    """Verified sources minus the ones the owner set to status "excluded", such as a different voice actor."""
    return [source for source in load_verified(private_dir) if source["status"] != "excluded"]


def source_id(source: dict) -> str:
    return Path(source["file"]).stem
