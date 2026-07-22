"""
Lightweight embedding system for knowledge records.
Uses TF-IDF for embeddings - no external API dependencies.
"""

import hashlib
import json
import math
import os
import re
from collections import Counter
from pathlib import Path


class KnowledgeEmbedder:
    """TF-IDF based embeddings for knowledge records."""

    def __init__(self, db_path: Path | object):
        self.db_path = db_path
        self._db: object | None = None
        self._vocab: dict[str, int] | None = None
        self._idf: dict[str, float] | None = None

    @property
    def db(self):
        if self._db is None:
            if hasattr(self.db_path, "execute"):
                self._db = self.db_path
            else:
                supabase_url = os.getenv("SUPABASE_URL", "")
                supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "")
                if supabase_url and supabase_key:
                    from storage import SupabaseStorage

                    self._db = SupabaseStorage(supabase_url, supabase_key).db
                    return self._db
        return self._db

    def _tokenize(self, text: str) -> list[str]:
        """Simple tokenizer - lowercase, split on non-alphanumeric, filter stopwords."""
        stopwords = {
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'are', 'was',
            'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
            'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall',
            'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'too', 'very',
            'just', 'about', 'above', 'after', 'again', 'all', 'also', 'any',
            'because', 'before', 'below', 'between', 'both', 'each', 'few',
            'more', 'most', 'other', 'some', 'such', 'into', 'only', 'own',
            'same', 'through', 'during', 'out', 'up', 'down', 'off', 'over',
            'under', 'further', 'once', 'here', 'there', 'when', 'where', 'why',
            'how', 'what', 'which', 'who', 'whom', 'these', 'those', 'i', 'me',
            'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
            'its', 'they', 'them', 'their', 'mine', 'yours', 'ours', 'theirs',
        }

        text = text.lower()
        text = re.sub(r'[^a-z0-9\s]', ' ', text)
        tokens = text.split()
        return [t for t in tokens if t not in stopwords and len(t) > 1]

    def _build_vocab(self) -> dict[str, int]:
        """Build vocabulary from all knowledge records."""
        if self._vocab is not None:
            return self._vocab

        rows = self.db.execute(
            "SELECT id, raw_content FROM knowledge_records WHERE COALESCE(is_valid, true) = true"
        ).fetchall()

        token_counts = Counter()
        for row in rows:
            tokens = self._tokenize(row[1] or "")
            token_counts.update(set(tokens))

        # Keep tokens that appear in at least 2 documents
        self._vocab = {
            token: idx for idx, (token, count) in enumerate(token_counts.most_common())
            if count >= 2
        }
        return self._vocab

    def _compute_idf(self) -> dict[str, float]:
        """Compute IDF scores."""
        if self._idf is not None:
            return self._idf

        vocab = self._build_vocab()
        n_docs = self.db.execute(
            "SELECT COUNT(*) FROM knowledge_records WHERE COALESCE(is_valid, true) = true"
        ).fetchone()[0]

        if n_docs == 0:
            self._idf = {}
            return self._idf

        # Count document frequency for each token
        df = Counter()
        rows = self.db.execute(
            "SELECT raw_content FROM knowledge_records WHERE COALESCE(is_valid, true) = true"
        ).fetchall()

        for row in rows:
            tokens = set(self._tokenize(row[0] or ""))
            for token in tokens:
                if token in vocab:
                    df[token] += 1

        # Compute IDF with smoothing
        self._idf = {
            token: math.log((n_docs + 1) / (freq + 1)) + 1
            for token, freq in df.items()
        }
        return self._idf

    def embed(self, text: str) -> list[float]:
        """Generate TF-IDF embedding for text."""
        vocab = self._build_vocab()
        idf = self._compute_idf()

        tokens = self._tokenize(text)
        if not tokens:
            return [0.0] * len(vocab)

        # TF: term frequency normalized by document length
        tf = Counter(tokens)
        doc_len = len(tokens)

        # TF-IDF vector
        vector = [0.0] * len(vocab)
        for token, count in tf.items():
            if token in vocab:
                idx = vocab[token]
                tf_val = count / doc_len
                tfidf = tf_val * idf.get(token, 1.0)
                vector[idx] = tfidf

        # L2 normalize
        norm = math.sqrt(sum(x * x for x in vector))
        if norm > 0:
            vector = [x / norm for x in vector]

        return vector

    def embed_to_bytes(self, text: str) -> bytes:
        """Generate embedding and return as bytes for storage."""
        vector = self.embed(text)
        # Pack as JSON for simplicity (could use struct for efficiency)
        return json.dumps(vector).encode('utf-8')

    def bytes_to_vector(self, data: bytes) -> list[float]:
        """Convert stored bytes back to vector."""
        return json.loads(data.decode('utf-8'))

    def cosine_similarity(self, vec1: list[float], vec2: list[float]) -> float:
        """Compute cosine similarity between two vectors."""
        if len(vec1) != len(vec2):
            return 0.0

        dot = sum(a * b for a, b in zip(vec1, vec2))
        norm1 = math.sqrt(sum(a * a for a in vec1))
        norm2 = math.sqrt(sum(b * b for b in vec2))

        if norm1 == 0 or norm2 == 0:
            return 0.0

        return dot / (norm1 * norm2)

    def embed_record(self, record_id: int) -> str | None:
        """Generate embedding for a knowledge record and store it."""
        row = self.db.execute(
            "SELECT raw_content FROM knowledge_records WHERE id = ?",
            (record_id,)
        ).fetchone()

        if not row or not row[0]:
            return None

        # Generate embedding
        embedding_bytes = self.embed_to_bytes(row[0])
        dimensions = len(self.embed(row[0]))

        # Generate embedding ID
        embedding_id = hashlib.md5(embedding_bytes).hexdigest()

        # Store embedding
        try:
            self.db.execute("""
                INSERT OR REPLACE INTO embeddings (id, record_id, model, embedding, dimensions)
                VALUES (?, ?, ?, ?, ?)
            """, (embedding_id, record_id, "tfidf-v1", embedding_bytes, dimensions))
            self.db.commit()

            # Update record with embedding reference
            self.db.execute(
                "UPDATE knowledge_records SET embedding_id = ? WHERE id = ?",
                (embedding_id, record_id)
            )
            self.db.commit()

            return embedding_id
        except Exception:
            return None

    def embed_all_records(self, batch_size: int = 100) -> int:
        """Embed all knowledge records that don't have embeddings yet."""
        rows = self.db.execute("""
            SELECT kr.id
            FROM knowledge_records kr
            LEFT JOIN embeddings e ON e.record_id = kr.id
            WHERE e.id IS NULL AND COALESCE(kr.is_valid, true) = true
        """).fetchall()

        count = 0
        for row in rows:
            if self.embed_record(row[0]):
                count += 1
                if count % batch_size == 0:
                    self.db.commit()

        self.db.commit()
        return count

    def search_similar(self, query: str, limit: int = 10) -> list[dict]:
        """Search for similar knowledge records using cosine similarity."""
        query_vec = self.embed(query)

        # Get all embeddings
        rows = self.db.execute("""
            SELECT e.record_id, e.embedding, kr.raw_content, kr.sender_name,
                   kr.conversation_name, kr.message_timestamp, kr.content_type
            FROM embeddings e
            JOIN knowledge_records kr ON kr.id = e.record_id
            WHERE COALESCE(kr.is_valid, true) = true
        """).fetchall()

        # Compute similarities
        results = []
        for row in rows:
            stored_vec = json.loads(row[1])
            similarity = self.cosine_similarity(query_vec, stored_vec)

            if similarity > 0.01:  # Minimum threshold
                results.append({
                    "record_id": row[0],
                    "similarity": round(similarity, 4),
                    "raw_content": row[2][:200] if row[2] else "",
                    "sender_name": row[3],
                    "conversation_name": row[4],
                    "timestamp": row[5],
                    "content_type": row[6],
                })

        # Sort by similarity
        results.sort(key=lambda x: x["similarity"], reverse=True)
        return results[:limit]

    def get_vocabulary_stats(self) -> dict:
        """Get vocabulary statistics."""
        vocab = self._build_vocab()
        return {
            "vocab_size": len(vocab),
            "total_records": self.db.execute(
            "SELECT COUNT(*) FROM knowledge_records WHERE COALESCE(is_valid, true) = true"
        ).fetchone()[0],
            "embedded_records": self.db.execute(
                "SELECT COUNT(*) FROM embeddings"
            ).fetchone()[0],
        }


# Global instance
_embedder: KnowledgeEmbedder | None = None


def get_embedder(db_path: Path | None = None) -> KnowledgeEmbedder:
    """Get or create the global embedder instance."""
    global _embedder
    if _embedder is None:
        if db_path is None:
            supabase_url = os.getenv("SUPABASE_URL", "")
            supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "")
            if supabase_url and supabase_key:
                from storage import SupabaseStorage

                db_path = SupabaseStorage(supabase_url, supabase_key).db
            else:
                raise RuntimeError("Supabase is required. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.")
        _embedder = KnowledgeEmbedder(db_path)
    return _embedder
