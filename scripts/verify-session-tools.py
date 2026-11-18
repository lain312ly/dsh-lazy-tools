#!/usr/bin/env python3
"""Inspect DSH session logs for dsh-lazy-tools acceptance evidence.

Usage:
  python verify-session-tools.py                     # summarize the newest 5 sessions
  python verify-session-tools.py --limit 3
  python verify-session-tools.py --session <path>
  python verify-session-tools.py --check --max-tools 20 --max-chars 16000 \
      --require-tools read,write,pwsh --expect-addition
  python verify-session-tools.py --sessions /path/to/.dsh/sessions

The script only reads *.jsonl.zstd session logs; it never writes anything.
It requires the `zstandard` package (`pip install zstandard`) because session
logs are zstd-compressed. Sessions live under `~/.dsh/sessions` by default;
override with `--sessions` when DSH_HOME is elsewhere.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
from pathlib import Path

import zstandard

DEFAULT_SESSIONS = Path(os.path.expanduser("~")) / ".dsh" / "sessions"


def read_log(path: Path) -> list[dict]:
    raw = path.read_bytes()
    chunks: list[bytes] = []
    reader = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw))
    while True:
        try:
            block = reader.read(1 << 20)
        except zstandard.ZstdError:
            break
        if not block:
            break
        chunks.append(block)
    text = b"".join(chunks).decode("utf-8", "replace")
    events = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def session_summary(path: Path) -> dict:
    events = read_log(path)
    header = next((e for e in events if e.get("type") == "session"), {})
    headers = []
    for event in events:
        if event.get("type") != "request/header":
            continue
        tools = (event.get("data") or {}).get("header", {}).get("tools") or []
        headers.append({
            "seq": event.get("seq"),
            "count": len(tools),
            "chars": len(json.dumps(tools, ensure_ascii=False)),
            "names": [t.get("name") for t in tools if isinstance(t, dict)],
            "deferred": [t.get("name") for t in tools if isinstance(t, dict) and t.get("deferLoading")],
        })

    additions = []
    for event in events:
        if event.get("type") != "developer/message":
            continue
        content = (event.get("data") or {}).get("message", {}).get("content") or []
        kinds = [b.get("type") for b in content if isinstance(b, dict)]
        if "tool-addition" in kinds or "tool-removal" in kinds:
            additions.append({
                "seq": event.get("seq"),
                "added": [b.get("toolName") for b in content if isinstance(b, dict) and b.get("type") == "tool-addition"],
                "removed": [b.get("toolName") for b in content if isinstance(b, dict) and b.get("type") == "tool-removal"],
            })

    calls: dict[str, dict[str, int]] = {}
    call_names: dict[str, str] = {}
    for event in events:
        if event.get("type") != "tool/call":
            continue
        data = event.get("data") or {}
        name = data.get("name") or "?"
        if isinstance(data.get("callId"), str):
            call_names[data["callId"]] = name
        entry = calls.setdefault(name, {"calls": 0, "errors": 0})
        entry["calls"] += 1
    for event in events:
        if event.get("type") != "tool/result":
            continue
        data = event.get("data") or {}
        message = data.get("message") or {}
        name = call_names.get(message.get("toolCallId"))
        if name is None:
            continue
        entry = calls.setdefault(name, {"calls": 0, "errors": 0})
        if message.get("isError") or data.get("result", {}).get("isError"):
            entry["errors"] += 1

    first_names = headers[0]["names"] if headers else []
    later_added = []
    for index, item in enumerate(headers[1:], start=1):
        for name in item["names"]:
            if name not in first_names and name not in later_added:
                later_added.append(name)

    usage = []
    for event in events:
        if event.get("type") != "assistant/message":
            continue
        u = (event.get("data") or {}).get("usage") or {}
        if u:
            usage.append(u)

    return {
        "path": str(path),
        "session": header.get("id"),
        "preset": header.get("agentPreset"),
        "cwd": header.get("cwd"),
        "events": len(events),
        "headers": len(headers),
        "firstHeader": {
            "count": headers[0]["count"] if headers else None,
            "chars": headers[0]["chars"] if headers else None,
            "names": first_names,
            "deferred": headers[0]["deferred"] if headers else [],
        },
        "headerChanges": len(headers) - 1,
        "laterAdded": later_added,
        "developerMessages": additions,
        "toolCalls": calls,
        "usage": usage[:3],
    }


def newest_logs(root: Path, limit: int) -> list[Path]:
    files = [p for p in root.rglob("*.jsonl.zstd") if p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[:limit]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sessions", default=str(DEFAULT_SESSIONS))
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--session", default=None)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--max-tools", type=int, default=16)
    parser.add_argument("--max-chars", type=int, default=15000)
    parser.add_argument("--require-tools", default="")
    parser.add_argument("--expect-addition", action="store_true")
    parser.add_argument("--find", default="")
    args = parser.parse_args()

    if args.session:
        paths = [Path(args.session)]
    else:
        paths = newest_logs(Path(args.sessions), args.limit)

    summaries = []
    for path in paths:
        try:
            summaries.append(session_summary(path))
        except Exception as error:  # a partially written live log
            summaries.append({"path": str(path), "error": str(error)})

    if args.find:
        needles = [needle for needle in args.find.split(",") if needle]
        hits = 0
        for path in paths:
            try:
                events = read_log(path)
            except Exception:
                continue
            blob = json.dumps(events, ensure_ascii=False)
            for needle in needles:
                if needle in blob:
                    hits += 1
                    print(f"FOUND {needle} in {path.name}")
        if hits == 0:
            print(f"FAIL no session contained any of: {args.find}")
            return 1
        return 0

    print(json.dumps({"sessions": summaries}, ensure_ascii=False, indent=2))

    if not args.check:
        return 0

    required = [name.strip() for name in args.require_tools.split(",") if name.strip()]
    problems = []
    matched = None
    for item in summaries:
        if "error" in item:
            continue
        first = item.get("firstHeader") or {}
        count = first.get("count")
        chars = first.get("chars")
        if count is None or chars is None:
            continue
        if count > args.max_tools or chars > args.max_chars:
            continue
        if args.expect_addition and not item.get("developerMessages"):
            continue
        missing = [name for name in required if name not in (first.get("names") or [])]
        if missing:
            continue
        matched = item
        break

    if matched is None:
        problems.append(
            f"no session matched: tools<={args.max_tools}, chars<={args.max_chars}, "
            f"required={required}, expectAddition={args.expect_addition}"
        )
    else:
        print(
            "PASS session=%s tools=%d chars=%d additions=%d laterAdded=%s"
            % (
                matched.get("session"),
                matched["firstHeader"]["count"],
                matched["firstHeader"]["chars"],
                len(matched.get("developerMessages") or []),
                ",".join(matched.get("laterAdded") or []),
            )
        )

    for problem in problems:
        print(f"FAIL {problem}")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
