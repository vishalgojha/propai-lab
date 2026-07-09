"""
Embedding engine abstraction for PropAI.

Two implementations:
1. TfidfEmbedding — built-in TF-IDF vectoriser (zero dependencies beyond numpy).
   Works immediately, no model download needed.
2. FastEmbedEmbedding — wraps fastembed for real transformer embeddings.
   Falls back to Tfidf if model is unavailable.

Both produce 384-dim float32 vectors for drop-in compatibility.
"""

from __future__ import annotations

import json
import math
import re
import struct
from abc import ABC, abstractmethod
from collections import Counter
from pathlib import Path
from typing import Optional

import numpy as np


# ── Serialisation helpers ─────────────────────────────────────────

def pack_embedding(vec: np.ndarray) -> bytes:
    """Pack a 1-D float32 numpy array into bytes for BLOB storage."""
    return vec.astype(np.float32).tobytes()


def unpack_embedding(blob: bytes) -> np.ndarray:
    """Unpack a BLOB back into a float32 numpy array."""
    return np.frombuffer(blob, dtype=np.float32).copy()


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


# ── Abstract interface ────────────────────────────────────────────


class EmbeddingEngine(ABC):
    """Abstract embedding engine. Every observation gets one vector."""

    DIMENSION: int = 384

    @abstractmethod
    def embed(self, text: str) -> np.ndarray: ...

    @abstractmethod
    def embed_batch(self, texts: list[str]) -> list[np.ndarray]: ...


# ── TF-IDF based embedding (built-in, no model download) ──────────

_STOP_WORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "has", "have", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "each",
    "every", "both", "few", "most", "other", "some", "such", "no", "nor",
    "not", "only", "own", "same", "so", "than", "too", "very", "just",
    "because", "but", "and", "or", "if", "while", "although", "this",
    "that", "these", "those", "it", "its", "hi", "hello", "dear", "sir",
    "please", "thanks", "thank", "regards", "best", "warm",
})


class TfidfEmbedding(EmbeddingEngine):
    """
    Lightweight TF-IDF vectoriser that projects into 384 dimensions
    via random projection (Johnson-Lindenstrauss style).

    Builds vocabulary adaptively from all texts it sees. Thread-safe
    for read operations after initial fit.
    """

    DIMENSION: int = 384

    def __init__(self):
        self._vocab: dict[str, int] = {}
        self._idf: dict[int, float] = {}
        self._n_docs: int = 0
        self._fitted: bool = False
        # Random projection matrix — fixed seed for reproducibility
        rng = np.random.RandomState(42)
        self._projection: np.ndarray = rng.randn(self.DIMENSION, self.DIMENSION).astype(np.float32)
        self._projection /= np.linalg.norm(self._projection, axis=0, keepdims=True) + 1e-12

    # ── Tokeniser ────────────────────────────────────────────────

    @staticmethod
    def _tokenise(text: str) -> list[str]:
        """Lowercase, split on non-alpha, remove stop-words and short tokens."""
        text = text.lower()
        tokens = re.findall(r"[a-z]+(?:[-'][a-z]+)?", text)
        return [t for t in tokens if t not in _STOP_WORDS and len(t) > 1]

    # ── Training / update ────────────────────────────────────────

    def partial_fit(self, texts: list[str]):
        """Update vocabulary and IDF from new texts."""
        for text in texts:
            tokens = self._tokenise(text)
            for t in tokens:
                if t not in self._vocab:
                    self._vocab[t] = len(self._vocab)
            self._n_docs += 1
        self._recompute_idf()

    def _recompute_idf(self):
        """Recompute IDF weights from current vocabulary."""
        n = max(self._n_docs, 1)
        self._idf = {
            idx: math.log((1 + n) / (1 + 1)) + 1.0
            for idx in self._vocab.values()
        }
        self._fitted = True

    # ── Embedding ────────────────────────────────────────────────

    def embed(self, text: str) -> np.ndarray:
        tokens = self._tokenise(text)
        tf = Counter(tokens)
        vec = np.zeros(len(self._vocab), dtype=np.float32) if self._vocab else np.zeros(1, dtype=np.float32)
        for t, count in tf.items():
            idx = self._vocab.get(t)
            if idx is not None:
                vec[idx] = count * self._idf.get(idx, 1.0)
        # Normalise
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec /= norm
        # Project to 384 dims
        if len(vec) < self.DIMENSION:
            padded = np.zeros(self.DIMENSION, dtype=np.float32)
            padded[:len(vec)] = vec
            vec = padded
        else:
            vec = vec[:self.DIMENSION]
        # Random projection for dimensionality reduction
        projected = vec @ self._projection
        norm_p = np.linalg.norm(projected)
        if norm_p > 0:
            projected /= norm_p
        return projected

    def embed_batch(self, texts: list[str]) -> list[np.ndarray]:
        return [self.embed(t) for t in texts]


# ── FastEmbed backend (optional, for real transformer embeddings) ──

class FastEmbedEmbedding(EmbeddingEngine):
    """Wraps fastembed's TextEmbedding. Falls back to TfidfEmbedding on load failure."""

    DIMENSION: int = 384

    def __init__(self, model_name: str = "sentence-transformers/all-MiniLM-L6-v2"):
        self._model_name = model_name
        self._model = None
        self._fallback = TfidfEmbedding()
        self._load()

    def _load(self):
        try:
            from fastembed import TextEmbedding
            self._model = TextEmbedding(self._model_name)
        except Exception:
            self._model = None

    def embed(self, text: str) -> np.ndarray:
        if self._model is not None:
            try:
                vec = list(self._model.embed([text]))[0]
                return np.array(vec, dtype=np.float32)
            except Exception:
                pass
        return self._fallback.embed(text)

    def embed_batch(self, texts: list[str]) -> list[np.ndarray]:
        if self._model is not None:
            try:
                return [np.array(v, dtype=np.float32) for v in self._model.embed(texts)]
            except Exception:
                pass
        return self._fallback.embed_batch(texts)


# ── Factory ───────────────────────────────────────────────────────

def create_engine(prefer_fastembed: bool = False) -> EmbeddingEngine:
    """Create the best available embedding engine."""
    if prefer_fastembed:
        return FastEmbedEmbedding()
    return TfidfEmbedding()


# ── Text builder for observations ─────────────────────────────────

_FIELD_WEIGHTS = {
    "intent": 3.0,
    "principal": 1.5,
    "bhk": 2.0,
    "building_name": 3.0,
    "landmark_name": 3.0,
    "street_name": 2.0,
    "area": 2.0,
    "micro_market": 2.5,
    "furnishing": 1.5,
    "broker_name": 1.0,
    "developer": 2.0,
    "price": 1.0,
    "price_unit": 1.0,
    "location_raw": 2.0,
}


def observation_text(parsed: dict) -> str:
    """
    Build a weighted text representation of a parsed observation
    for embedding. Heavier-weight fields are repeated to bias the
    embedding toward them.
    """
    parts = []
    for field, weight in _FIELD_WEIGHTS.items():
        val = parsed.get(field)
        if val is not None and val != "" and val != 0 and val != "0":
            s = str(val).strip()
            if s:
                parts.extend([s] * max(1, int(round(weight))))
    return " ".join(parts)
