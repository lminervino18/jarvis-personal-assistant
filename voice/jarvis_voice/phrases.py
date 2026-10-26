from dataclasses import dataclass

from .segment import MAX_SEGMENT_S, MERGE_GAP_S

PHRASE_GAP_S = 0.3
CLIP_PAD_S = 0.15
SENTENCE_END = (".", "?", "!", "…")
SENTENCE_START = ("¿", "¡")


@dataclass(frozen=True)
class Word:
    start: float
    end: float
    text: str
    probability: float = 1.0


def breaks_between(previous: Word, word: Word, max_gap: float = PHRASE_GAP_S) -> bool:
    return previous.text.endswith(SENTENCE_END) or word.text.startswith(SENTENCE_START) or word.start - previous.end > max_gap


def split_phrases(words: list[Word], max_gap: float = PHRASE_GAP_S, max_len: float = MAX_SEGMENT_S) -> list[list[Word]]:
    """
    Breaks a transcript at sentence punctuation and at pauses longer than `max_gap`, where speakers take turns,
    and before a phrase would exceed `max_len` seconds.
    """
    phrases: list[list[Word]] = []
    for word in words:
        if phrases and not breaks_between(phrases[-1][-1], word, max_gap) and word.end - phrases[-1][0].start <= max_len:
            phrases[-1].append(word)
        else:
            phrases.append([word])
    return phrases


def join_accepted(phrases: list[list[Word]], accepted: list[bool], max_gap: float = MERGE_GAP_S, max_len: float = MAX_SEGMENT_S) -> list[list[int]]:
    """
    Groups consecutive accepted phrases into clips, as lists of phrase indices. A rejected phrase, a pause
    longer than `max_gap` or a clip reaching `max_len` seconds starts a new clip.
    """
    clips: list[list[int]] = []
    for index, phrase in enumerate(phrases):
        if not accepted[index]:
            continue
        if clips and clips[-1][-1] == index - 1:
            last, first = phrases[index - 1][-1], phrases[clips[-1][0]][0]
            if phrase[0].start - last.end <= max_gap and phrase[-1].end - first.start <= max_len:
                clips[-1].append(index)
                continue
        clips.append([index])
    return clips


def clip_bounds(words: list[Word], before: Word | None, after: Word | None, pad: float = CLIP_PAD_S) -> tuple[float, float]:
    """Pads a clip around its words without reaching past the midpoint of the gap to a neighbouring word."""
    start, end = words[0].start - pad, words[-1].end + pad
    if before:
        start = max(start, (before.end + words[0].start) / 2)
    if after:
        end = min(end, (words[-1].end + after.start) / 2)
    return max(start, 0.0), end
