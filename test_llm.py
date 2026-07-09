#!/usr/bin/env python3
"""
Test script for LLM Provider Abstraction.
Validates connection, response format, and token usage for the configured provider.

Usage:
    python test_llm.py
"""

import os
import sys
import json
import time
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

from ai_chat_engine import get_client, LLM_PROVIDER, MODEL, BASE_URL, log_provider_usage

def test_provider():
    print(f"🧪 Testing Provider: {LLM_PROVIDER.upper()}")
    print(f"   Base URL: {BASE_URL}")
    print(f"   Model: {MODEL}")
    print("-" * 60)
    
    try:
        client = get_client()
    except ValueError as e:
        print(f"❌ Error: {e}")
        return
    
    test_prompt = """Extract the following broker message into structured JSON.

Message: "1Bhk new building resale purchased. Budget 1.75cr. Location: Santa Cruz east and west. Contact: Prahlad bind 8928018148"

Return ONLY JSON with keys: intent, bhk, price, price_unit, location_raw, building_name, broker_name, broker_phone"""

    messages = [
        {"role": "system", "content": "You are a structured data extractor. Return ONLY valid JSON."},
        {"role": "user", "content": test_prompt}
    ]
    
    print("📤 Sending request...")
    start = time.time()
    
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            max_tokens=500,
            temperature=0.1,
        )
    except Exception as e:
        print(f"❌ API Error: {e}")
        return
    
    latency = time.time() - start
    msg = response.choices[0].message
    content = msg.content or ""
    
    # Parse tokens
    usage = response.usage
    input_tokens = usage.prompt_tokens if usage else 0
    output_tokens = usage.completion_tokens if usage else 0
    
    print(f"✅ Response received in {latency:.2f}s")
    print("-" * 60)
    
    # Print raw response
    print("📄 Raw Response:")
    print(content[:500] + "..." if len(content) > 500 else content)
    print("-" * 60)
    
    # Try to parse JSON
    try:
        # Clean up response (remove markdown code blocks if present)
        clean_content = content.strip()
        if clean_content.startswith("```json"):
            clean_content = clean_content[7:]
        if clean_content.startswith("```"):
            clean_content = clean_content[3:]
        if clean_content.endswith("```"):
            clean_content = clean_content[:-3]
        
        parsed = json.loads(clean_content)
        print("✅ Parsed JSON:")
        print(json.dumps(parsed, indent=2))
    except json.JSONDecodeError as e:
        print(f"⚠️  Failed to parse JSON: {e}")
        print("   (This may be expected if the model returned non-JSON)")
    
    # Log usage
    print("-" * 60)
    log_provider_usage(
        provider=LLM_PROVIDER,
        model=MODEL,
        latency=latency,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost=0.0  # Cost calculation would require provider-specific pricing
    )
    
    print("\n✅ Test completed successfully!")

if __name__ == "__main__":
    test_provider()