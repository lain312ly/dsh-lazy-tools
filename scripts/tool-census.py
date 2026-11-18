#!/usr/bin/env python3
"""Suggest a `visible` list for dsh-lazy-tools from your own session logs.

The plugin ships a resident layer tuned to the author's usage. Your own tool
mix is almost certainly different, so run this against your own history and put
the tools it marks "resident" into the plugin's `visible` config.

Usage:
  python tool-census.py                     # last 30 days, min 3 calls/day
  python tool-census.py --days 60 --min-calls-per-day 5
  python tool-census.py --json              # machine-readable output

It only reads `*.jsonl.zstd` session logs and prints; nothing is written.

How it decides:
  * calls       = number of times the tool was dispatched (PTC) or called (native)
  * schemaChars = serialized size of the tool's declaration, taken from the
                  `request/header.tools` of native-executor sessions (PTC
                  sessions only carry `run_code`, so they cannot supply sizes)
  * resident    = calls/day >= --min-calls-per-day AND schemaChars <= --max-schema-chars
  * deferred    = everything else (rare tools stay cheap to load on demand)

Caveats printed at the end: unknown schema sizes, `run_code`, `toolbox_*`.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import zstandard

DEFAULT_SESSIONS = Path(os.path.expanduser("~")) / ".dsh" / "sessions"


def read_events(path: Path) -> list[dict]:
    raw = path.read_bytes()
    reader = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw))
    chunks: list[bytes] = []
    while True:
        try:
            block = reader.read(1 << 20)
        except zstandard.ZstdError:
            break
        if not block:
            break
        chunks.append(block)
    events = []
    for line in b"".join(chunks).decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def collect(root: Path, since_ms: int) -> tuple[Counter, dict[str, int], int]:
    calls: Counter = Counter()
    schemas: dict[str, int] = {}
    sessions = 0
    for logfile in root.rglob("session.v4.jsonl.zstd"):
        try:
            if logfile.stat().st_mtime * 1000 < since_ms:
                continue
            events = read_events(logfile)
        except Exception:
            continue
        header = next((e for e in events if e.get("type") == "session"), None)
        if header is None:
            continue
        created = header.get("createdAt") or 0
        if created and created < since_ms:
            continue
        sessions += 1
        for event in events:
            kind = event.get("type")
            data = event.get("data") or {}
            if kind == "tool/ptc-dispatch":
                name = data.get("name")
                if isinstance(name, str):
                    calls[name] += 1
            elif kind == "tool/call":
                name = data.get("name")
                if isinstance(name, str):
                    calls[name] += 1
            elif kind == "request/header":
                tools = (data.get("header") or {}).get("tools") or []
                for tool in tools:
                    if not isinstance(tool, dict):
                        continue
                    name = tool.get("name")
                    if isinstance(name, str):
                        size = len(json.dumps(tool, ensure_ascii=False))
                        schemas[name] = max(schemas.get(name, 0), size)
    return calls, schemas, sessions


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sessions", default=str(DEFAULT_SESSIONS))
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--min-calls-per-day", type=float, default=3.0)
    parser.add_argument("--max-schema-chars", type=int, default=1500)
    parser.add_argument("--dominant-calls-per-day", type=float, default=50.0,
                        help="a tool this frequent stays resident even with a big schema")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    root = Path(args.sessions)
    since_ms = int((time.time() - args.days * 86400) * 1000)
    calls, schemas, sessions = collect(root, since_ms)
    if not calls:
        print(f"no tool calls found under {root} in the last {args.days} days")
        return 1

    rows = []
    for name, count in calls.most_common():
        schema = schemas.get(name)
        per_day = count / max(args.days, 1)
        resident = (
            name not in ("run_code",)
            and not name.startswith("toolbox_")
            and schema is not None
            and (per_day >= args.dominant_calls_per_day
                 or (schema <= args.max_schema_chars and per_day >= args.min_calls_per_day))
        )
        rows.append({
            "name": name,
            "calls": count,
            "perDay": round(per_day, 2),
            "schemaChars": schema,
            "suggestion": "resident" if resident else "defer",
        })

    result = {
        "days": args.days,
        "sessions": sessions,
        "minCallsPerDay": args.min_calls_per_day,
        "maxSchemaChars": args.max_schema_chars,
        "dominantCallsPerDay": args.dominant_calls_per_day,
        "resident": [r["name"] for r in rows if r["suggestion"] == "resident"],
        "deferred": [r["name"] for r in rows if r["suggestion"] == "defer"],
        "rows": rows,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    print(f"# tool census — last {args.days} days, {sessions} sessions\n")
    print(f"{'tool':<32}{'calls':>7}{'calls/day':>11}{'schema':>9}  suggestion")
    print("-" * 76)
    for row in rows:
        schema = "-" if row["schemaChars"] is None else str(row["schemaChars"])
        print(f"{row['name']:<32}{row['calls']:>7}{row['perDay']:>11}{schema:>9}  {row['suggestion']}")
    print()
    print("resident (put these in the plugin's `visible`):")
    print("  " + (", ".join(result["resident"]) or "(none)"))
    print()
    print("notes:")
    print("  * `run_code` is always resident and cannot be listed in `visible`")
    print("  * `toolbox_search` / `toolbox_load` / `toolbox_status` are always available")
    print("  * a tool with no schema size means no native-executor session declared it;")
    print("    its cost is unknown, so keep it deferred unless you need it every session")
    print("  * raising --max-schema-chars keeps more big tools resident at a higher")
    print("    per-request cost; lowering it hides more")
    print("  * the window includes calls to plugins you have since uninstalled;")
    print("    cross-check with the `awaiting` list from toolbox_status")
    print(f"  * a tool used more than {args.dominant_calls_per_day:g}/day stays resident")
    print("    even with a large schema, because hiding it only adds a load step")
    return 0


if __name__ == "__main__":
    sys.exit(main())
