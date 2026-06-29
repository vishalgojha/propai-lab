"""
Efficient embedding generation for knowledge records.
Processes in batches and can be resumed.
"""

import hashlib
import json
import math
import re
import sqlite3
from collections import Counter
from pathlib import Path


class FastEmbedder:
    """Fast TF-IDF embedder optimized for batch processing."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._db = None
        self._vocab = None
        self._idf = None

    @property
    def db(self):
        if self._db is None:
            self._db = sqlite3.connect(str(self.db_path), check_same_thread=False)
            self._db.row_factory = sqlite3.Row
        return self._db

    def _tokenize(self, text):
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

    def build_vocab(self):
        """Build vocabulary from all knowledge records."""
        if self._vocab is not None:
            return self._vocab

        print("Building vocabulary...")
        rows = self.db.execute(
            "SELECT id, raw_content FROM knowledge_records WHERE is_valid = 1"
        ).fetchall()

        token_counts = Counter()
        for row in rows:
            tokens = self._tokenize(row[1] or "")
            token_counts.update(set(tokens))

        self._vocab = {
            token: idx for idx, (token, count) in enumerate(token_counts.most_common())
            if count >= 2
        }
        print(f"Vocabulary size: {len(self._vocab)}")
        return self._vocab

    def compute_idf(self):
        """Compute IDF scores."""
        if self._idf is not None:
            return self._idf

        vocab = self.build_vocab()
        n_docs = self.db.execute(
            "SELECT COUNT(*) FROM knowledge_records WHERE is_valid = 1"
        ).fetchone()[0]

        if n_docs == 0:
            self._idf = {}
            return self._idf

        print("Computing IDF...")
        df = Counter()
        rows = self.db.execute(
            "SELECT raw_content FROM knowledge_records WHERE is_valid = 1"
        ).fetchall()

        for row in rows:
            tokens = set(self._tokenize(row[0] or ""))
            for token in tokens:
                if token in vocab:
                    df[token] += 1

        self._idf = {
            token: math.log((n_docs + 1) / (freq + 1)) + 1
            for token, freq in df.items()
        }
        return self._idf

    def embed(self, text):
        """Generate TF-IDF embedding for text."""
        vocab = self._vocab or self.build_vocab()
        idf = self._idf or self.compute_idf()

        tokens = self._tokenize(text)
        if not tokens:
            return [0.0] * len(vocab)

        tf = Counter(tokens)
        doc_len = len(tokens)

        vector = [0.0] * len(vocab)
        for token, count in tf.items():
            if token in vocab:
                idx = vocab[token]
                tf_val = count / doc_len
                tfidf = tf_val * idf.get(token, 1.0)
                vector[idx] = tfidf

        norm = math.sqrt(sum(x * x for x in vector))
        if norm > 0:
            vector = [x / norm for x in vector]

        return vector

    def embed_batch(self, records):
        """Embed a batch of records."""
        results = []
        for record_id, raw_content in records:
            embedding = self.embed(raw_content)
            embedding_bytes = json.dumps(embedding).encode('utf-8')
            embedding_id = hashlib.md5(embedding_bytes).hexdigest()
            results.append((embedding_id, record_id, embedding_bytes, len(embedding)))
        return results

    def embed_all(self, batch_size=500, limit=None):
        """Embed all unembedded knowledge records."""
        import hashlib

        # Build vocab first
        self.build_vocab()
        self.compute_idf()

        # Get unembedded records
        query = """
            SELECT kr.id, kr.raw_content
            FROM knowledge_records kr
            LEFT JOIN embeddings e ON e.record_id = kr.id
            WHERE e.id IS NULL AND kr.is_valid = 1 AND LENGTH(kr.raw_content) > 10
        """
        if limit:
            query += f" LIMIT {limit}"

        rows = self.db.execute(query).fetchall()
        print(f"Records to embed: {len(rows)}")

        count = 0
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i + batch_size]
            results = self.embed_batch(batch)

            for embedding_id, record_id, embedding_bytes, dimensions in results:
                try:
                    self.db.execute("""
                        INSERT OR IGNORE INTO embeddings (id, record_id, model, embedding, dimensions)
                        VALUES (?, ?, ?, ?, ?)
                    """, (embedding_id, record_id, "tfidf-v1", embedding_bytes, dimensions))
                except:
                    pass

            self.db.commit()
            count += len(results)

            if (i + batch_size) % 2000 == 0:
                print(f"  Embedded {count}/{len(rows)}...")

        print(f"Embedded {count} records")
        return count


if __name__ == "__main__":
    db_path = Path(__file__).parent.parent / "lab.db"
    embedder = FastEmbedder(db_path)
    embedder.embed_all()
