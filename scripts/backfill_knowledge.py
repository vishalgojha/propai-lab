"""
Backfill raw messages into knowledge_records.
Run this once to populate the knowledge base from existing data.
"""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def backfill(db_path: Path, batch_size: int = 1000):
    """Backfill all raw messages into knowledge_records."""
    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row

    # Check how many already exist
    existing = db.execute("SELECT COUNT(*) FROM knowledge_records").fetchone()[0]
    print(f"Existing knowledge records: {existing}")

    # Get all raw messages not yet in knowledge_records
    rows = db.execute("""
        SELECT rm.id, rm.group_name, rm.sender, rm.sender_jid, rm.sender_phone,
               rm.message, rm.message_type, rm.timestamp, rm.attachments
        FROM raw_messages rm
        LEFT JOIN knowledge_records kr ON kr.source_id = 'raw::' || rm.id
        WHERE kr.id IS NULL AND LENGTH(rm.message) > 10
    """).fetchall()

    print(f"Raw messages to backfill: {len(rows)}")

    count = 0
    batch = []

    for row in rows:
        raw_id = row[0]
        group_name = row[1] or "Unknown"
        sender = row[2] or "Unknown"
        sender_jid = row[3] or ""
        sender_phone = row[4] or ""
        message = row[5] or ""
        message_type = row[6] or "text"
        timestamp = row[7] or ""
        attachments = row[8] or "{}"

        # Determine source type
        is_dm = "@s.whatsapp.net" in group_name or "@lid" in group_name
        source_type = "dm" if is_dm else "whatsapp"

        # Parse attachments
        try:
            att = json.loads(attachments)
            if isinstance(att, list):
                att = {"image": len(att) > 0}
        except:
            att = {}

        batch.append({
            "source_type": source_type,
            "source_id": f"raw::{raw_id}",
            "raw_content": message,
            "sender_jid": sender_jid,
            "sender_name": sender,
            "sender_phone": sender_phone,
            "conversation_id": group_name,
            "conversation_name": group_name,
            "message_timestamp": timestamp,
            "content_type": "unknown",
            "metadata": json.dumps({
                "raw_id": raw_id,
                "message_type": message_type,
                "has_image": att.get("image", False),
                "has_video": att.get("video", False),
                "has_document": att.get("document", False),
                "backfilled": True,
            }),
        })

        if len(batch) >= batch_size:
            _insert_batch(db, batch)
            count += len(batch)
            print(f"  Inserted {count} records...")
            batch = []

    # Insert remaining
    if batch:
        _insert_batch(db, batch)
        count += len(batch)

    db.commit()
    db.close()

    print(f"Backfill complete: {count} records inserted")
    return count


def _insert_batch(db, batch):
    """Insert a batch of knowledge records."""
    for record in batch:
        try:
            db.execute("""
                INSERT INTO knowledge_records (
                    source_type, source_id, raw_content,
                    sender_jid, sender_name, sender_phone,
                    conversation_id, conversation_name,
                    message_timestamp, content_type, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                record["source_type"],
                record["source_id"],
                record["raw_content"],
                record["sender_jid"],
                record["sender_name"],
                record["sender_phone"],
                record["conversation_id"],
                record["conversation_name"],
                record["message_timestamp"],
                record["content_type"],
                record["metadata"],
            ))
        except Exception as e:
            pass  # Skip duplicates


def classify_backfilled(db_path: Path, limit: int = 500):
    """Classify backfilled records using AI."""
    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from knowledge.classifier import classify

    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row

    # Get unclassified records
    rows = db.execute("""
        SELECT id, raw_content
        FROM knowledge_records
        WHERE content_type = 'unknown' AND is_valid = 1
        ORDER BY message_timestamp DESC
        LIMIT ?
    """, (limit,)).fetchall()

    print(f"Classifying {len(rows)} records...")

    classified = 0
    for i, row in enumerate(rows):
        record_id = row[0]
        message = row[1] or ""

        result = classify(message)

        # Update record
        db.execute("""
            UPDATE knowledge_records
            SET content_type = ?, intent = ?, confidence = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE id = ?
        """, (
            result.get("content_type", "unknown"),
            result.get("intent", "NONE"),
            result.get("confidence", 0.0),
            record_id,
        ))

        # Add tags
        tags = {}
        if result.get("building_name"):
            tags["building"] = [result["building_name"]]
        if result.get("market"):
            tags["market"] = [result["market"]]
        if result.get("bhk"):
            tags["bhk"] = [f"{result['bhk']} BHK" if result['bhk'] != 0.5 else "1 RK"]
        if result.get("price"):
            tags["price"] = [str(result["price"])]
            if result.get("price_unit"):
                tags["price_unit"] = [result["price_unit"]]
        if result.get("furnishing"):
            tags["furnishing"] = [result["furnishing"]]

        for tag_type, values in tags.items():
            for value in values:
                db.execute("""
                    INSERT INTO knowledge_tags (record_id, tag_type, tag_value, confidence, source)
                    VALUES (?, ?, ?, ?, 'ai')
                """, (record_id, tag_type, value, result.get("confidence", 0.5)))

        classified += 1

        if (i + 1) % 50 == 0:
            print(f"  Classified {i + 1}/{len(rows)}...")
            db.commit()

    db.commit()
    db.close()

    print(f"Classification complete: {classified} records")
    return classified


def generate_embeddings(db_path: Path):
    """Generate embeddings for all knowledge records."""
    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from knowledge.embedder import get_embedder

    embedder = get_embedder(db_path)
    count = embedder.embed_all_records()
    print(f"Embedded {count} records")
    return count


if __name__ == "__main__":
    import sys

    db_path = Path(__file__).parent.parent / "lab.db"

    if len(sys.argv) > 1 and sys.argv[1] == "classify":
        classify_backfilled(db_path)
    elif len(sys.argv) > 1 and sys.argv[1] == "embed":
        generate_embeddings(db_path)
    else:
        backfill(db_path)
