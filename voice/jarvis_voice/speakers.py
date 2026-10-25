import numpy as np

from .audio import ANALYSIS_RATE, resample

CLUSTER_THRESHOLD = 0.6


def unit(vectors: np.ndarray) -> np.ndarray:
    return vectors / np.linalg.norm(vectors, axis=-1, keepdims=True)


def dominant_centroid(embeddings: np.ndarray, durations: np.ndarray, threshold: float = CLUSTER_THRESHOLD) -> tuple[np.ndarray, np.ndarray]:
    """
    Finds the speaker that talks the longest in a mixed clip. Returns the unit centroid and the boolean
    mask of segments assigned to it. Each segment votes for its neighbours (cosine >= threshold) weighted
    by duration; the best-supported segment seeds the cluster and the centroid is refined once.
    """
    vectors = unit(embeddings)
    similarity = vectors @ vectors.T
    support = ((similarity >= threshold) * durations[None, :]).sum(axis=1)
    seed = int(np.argmax(support))
    members = similarity[seed] >= threshold
    centroid = unit((vectors[members] * durations[members, None]).sum(axis=0))
    members = vectors @ centroid >= threshold
    centroid = unit((vectors[members] * durations[members, None]).sum(axis=0))
    return centroid, vectors @ centroid >= threshold


def embed_segments(waveforms: list[np.ndarray], rate: int, cache_dir: str) -> np.ndarray:
    import torch
    from speechbrain.inference.speaker import EncoderClassifier

    encoder = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb", savedir=f"{cache_dir}/ecapa", run_opts={"device": "cpu"},
    )
    vectors = []
    for samples in waveforms:
        audio = torch.from_numpy(resample(samples, rate, ANALYSIS_RATE)).unsqueeze(0)
        with torch.no_grad():
            vectors.append(encoder.encode_batch(audio).squeeze().numpy())
    return unit(np.stack(vectors))


def similarity_to(centroid: np.ndarray, embeddings: np.ndarray) -> np.ndarray:
    return unit(embeddings) @ centroid
