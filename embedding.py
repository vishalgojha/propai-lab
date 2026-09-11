"""Small compatibility embedding engine used by the extraction runtime.

The module is intentionally local and deterministic.  Semantic retrieval is
optional; this fallback keeps extraction and legacy admin routes importable
when the optional transformer backend is not installed.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

import numpy as np


def pack_embedding(vec: np.ndarray) -> bytes:
    return np.asarray(vec, dtype=np.float32).tobytes()


def unpack_embedding(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32).copy()


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    left = np.linalg.norm(a)
    right = np.linalg.norm(b)
    if not left or not right:
        return 0.0
    return float(np.dot(a, b) / (left * right))


class TfidfEmbedding:
    DIMENSION = 384

    def __init__(self):
        self._vocab: dict[str, int] = {}

    @staticmethod
    def _tokenise(text: str) -> list[str]:
        return [token for token in re.findall(r"[a-z0-9]+", str(text).lower()) if len(token) > 1]

    def partial_fit(self, texts: list[str]):
        for text in texts:
            for token in self._tokenise(text):
                self._vocab.setdefault(token, len(self._vocab))

    def embed(self, text: str) -> np.ndarray:
        vector = np.zeros(self.DIMENSION, dtype=np.float32)
        for token, count in Counter(self._tokenise(text)).items():
            index = self._vocab.get(token)
            if index is not None and index < self.DIMENSION:
                vector[index] = count
        norm = np.linalg.norm(vector)
        if norm:
            vector /= norm
        return vector

    def embed_batch(self, texts: list[str]) -> list[np.ndarray]:
        return [self.embed(text) for text in texts]


EmbeddingEngine = TfidfEmbedding
FastEmbedEmbedding = TfidfEmbedding


def create_engine(prefer_fastembed: bool = False) -> TfidfEmbedding:
    return TfidfEmbedding()


def observation_text(parsed: dict[str, Any]) -> str:
    fields = (
        "intent", "principal", "bhk", "building_name", "landmark_name",
        "street_name", "area", "micro_market", "furnishing", "broker_name",
        "developer", "price", "price_unit", "location_raw",
    )
    values: list[str] = []
    for field in fields:
        value = parsed.get(field)
        if value not in (None, "", 0, "0"):
            values.append(str(value).strip())
    return " ".join(value for value in values if value)
