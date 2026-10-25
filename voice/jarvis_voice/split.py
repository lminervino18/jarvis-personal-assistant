EVAL_SHARE = 0.2


def choose_eval_sources(durations: dict[str, float], reference: str | None = None, share: float = EVAL_SHARE) -> set[str]:
    """
    Picks whole source clips for evaluation until they hold about `share` of the audio. The reference clip
    is used last because its voice defines the speaker centroid, which would make the check circular.
    """
    total = sum(durations.values())
    order = sorted((s for s in durations if s != reference), key=lambda s: (durations[s], s))
    if reference in durations:
        order.append(reference)
    chosen: set[str] = set()
    held = 0.0
    for source in order:
        if held >= share * total:
            break
        if chosen and held + durations[source] > 1.5 * share * total:
            continue
        chosen.add(source)
        held += durations[source]
    return chosen
