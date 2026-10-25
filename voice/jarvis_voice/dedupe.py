import re
import unicodedata
from difflib import SequenceMatcher

NEAR_DUPLICATE_RATIO = 0.85


def normalize_text(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.lower())
    letters = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9ñ ]+", " ", letters)).strip()


def near_duplicates(a: str, b: str) -> bool:
    """True when two transcripts are the same line up to punctuation, accents and small ASR slips."""
    x, y = normalize_text(a), normalize_text(b)
    if not x or not y:
        return False
    if SequenceMatcher(None, x, y).ratio() >= NEAR_DUPLICATE_RATIO:
        return True
    shorter, longer = sorted((x, y), key=len)
    return len(shorter.split()) >= 4 and shorter in longer


def group_duplicates(texts: list[str]) -> list[list[int]]:
    """Connected components of the near-duplicate relation, as lists of indices."""
    parent = list(range(len(texts)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            if near_duplicates(texts[i], texts[j]):
                parent[find(j)] = find(i)
    groups: dict[int, list[int]] = {}
    for i in range(len(texts)):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())
