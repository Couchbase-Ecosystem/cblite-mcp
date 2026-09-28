#!/usr/bin/env python3
"""Turns a recorded run (record_demo.py) into Remotion inputs:
video/public/phone.mp4 (emulator screen, time-warped) and video/public/demo.json (agent events on the
output timeline).

Time warp: real time plays at 1x while something is happening (an agent event in the last few
seconds); idle stretches while the model thinks play at IDLE_SPEED. The video shows a badge whenever
it is sped up, so nothing is hidden. Nothing is cut or reordered.

Usage: demo/render_prep.py demo/run/<timestamp>
"""
import json, subprocess, sys
from pathlib import Path

FPS = 30
ACTIVE_WINDOW = 2.5   # seconds of 1x playback after each event
IDLE_SPEED = 4.0
HERE = Path(__file__).resolve().parent
PUBLIC = HERE / "video" / "public"


def summarize_result(name, text, is_error):
    if "not found" in text[:200] and not text.lstrip().startswith("{"):
        is_error = True
    if is_error:
        return text.replace("Error: ", "").split(". Please")[0][:120]
    try:
        d = json.loads(text)
    except Exception:
        first = text.strip().splitlines()[0] if text.strip() else ""
        if name.endswith("list_elements_on_screen"):
            n = sum(1 for l in text.splitlines() if l.startswith("@e"))
            return f"{n} UI elements on screen"
        if name.endswith("list_available_devices"):
            return "2 devices: Pixel 8a (USB), Pixel_6_API_34 (emulator)"
        return first[:120]
    short = name.split("__")[-1]
    if short == "mobile_list_available_devices":
        return ", ".join(f"{x['name']} ({x['type']})" for x in d.get("devices", []))
    if short in ("cbl_connect", "cbl_info"):
        info = d.get("info", d)
        cols = [f"{c['fullName']} ({c['count']})" for db in info.get("databases", []) for c in db.get("collections", []) if c["name"] != "_default"]
        return f"{info.get('package')} · Couchbase Lite {info.get('couchbaseLiteVersion')} · " + ", ".join(cols)
    if short == "cbl_describe_collection":
        return f"{d['sampled']} docs sampled · fields: " + ", ".join(k for k in d["fields"] if "." not in k)
    if short == "cbl_query":
        rows = d["rows"]
        if len(rows) <= 3:
            return " | ".join(json.dumps(r, separators=(", ", ": ")) for r in rows)[:160]
        return f"{d['rowCount']} rows in {d['elapsedMs']:.1f} ms"
    if short == "cbl_batch":
        return f"1 transaction · {d['count']} writes committed"
    if short == "cbl_put_document":
        return f"{'created' if d.get('created') else 'updated'} {d['id']}"
    if short == "cbl_get_document":
        b = d["body"]
        keys = [k for k in ("customer", "status", "startedAt", "note") if k in b]
        return f"{d['id']} · " + ", ".join(f"{k}: {b[k]}" for k in keys)
    if short == "cbl_changes":
        ev = d.get("events", [])
        if not ev:
            return "no changes yet"
        return " · ".join(f"{e['source']} changed {', '.join(e['documentIds'])[:48]}" for e in ev[:2])
    return text.strip().splitlines()[0][:120]


def summarize_input(name, inp):
    short = name.split("__")[-1]
    if short == "cbl_batch":
        ops = inp.get("operations", [])
        kinds = sorted({o.get("op", "put") for o in ops})
        return f'collection: "{inp.get("collection", "")}", {len(ops)} × {"/".join(kinds)}'
    if short == "cbl_query":
        return inp["sql"]
    parts = []
    for k, v in inp.items():
        if k == "device":
            continue
        s = json.dumps(v, ensure_ascii=False)
        parts.append(f"{k}: {s if len(s) < 70 else s[:67] + '…'}")
    return ", ".join(parts)


def main():
    run = Path(sys.argv[1]).resolve()
    tl = json.loads((run / "timeline.json").read_text())
    seg = tl["segments"]
    t0 = seg[0]["start"]
    events = [e for e in tl["events"] if not (e["kind"] == "tool_use" and e["name"] == "ToolSearch")]
    hidden_ids = {e["id"] for e in tl["events"] if e["kind"] == "tool_use" and e["name"] == "ToolSearch"}
    events = [e for e in events if not (e["kind"] == "tool_result" and e["id"] in hidden_ids)]

    start = events[0]["t"] - t0 - 1.5
    end = events[-1]["t"] - t0 + 2.5
    marks = sorted(e["t"] - t0 for e in events)

    # Active spans: ACTIVE_WINDOW seconds of 1x after each event; everything else is idle.
    active = []
    for m in marks:
        lo, hi = max(m, start), min(m + ACTIVE_WINDOW, end)
        if active and lo <= active[-1][1]:
            active[-1][1] = max(active[-1][1], hi)
        else:
            active.append([lo, hi])
    merged, cur = [], start
    for lo, hi in active:
        if lo - cur >= 1.5:
            merged.append([cur, lo, IDLE_SPEED])
        elif lo > cur:
            lo = cur  # short idle gaps stay at 1x
        if merged and merged[-1][2] == 1.0:
            merged[-1][1] = hi
        else:
            merged.append([cur if lo == cur else lo, hi, 1.0])
        cur = hi
    if end - cur >= 1.5:
        merged.append([cur, end, IDLE_SPEED])
    elif end > cur:
        merged[-1][1] = end

    # Reading holds: freeze the frame after each step's final reply, long enough to read it.
    holds = {}
    for step in {e["step"] for e in events}:
        finals = [e for e in events if e["step"] == step and e["kind"] == "text"]
        if finals:
            words = len(finals[-1]["text"].split())
            holds[round(finals[-1]["t"] - t0 + 0.6, 3)] = min(max(words / 6.0, 3.0), 8.0)
    for h in sorted(holds):
        for i, (a, b, sp) in enumerate(merged):
            if a < h < b:
                merged[i:i + 1] = [[a, h, sp], [h, b, sp]]
                break

    def out_time(real):
        acc = 0.0
        for a, b, sp in merged:
            if real <= a:
                break
            acc += (min(real, b) - a) / sp
            if real > b and b in holds:
                acc += holds[b]
        return acc

    # Concatenate recorder segments (normally just one) then warp.
    src = run / "phone_full.mp4"
    files = [run / s["file"] for s in seg]
    if len(files) == 1:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(files[0]), "-r", str(FPS), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(src)], check=True)
    else:
        lst = run / "segments.txt"
        lst.write_text("".join(f"file '{f}'\n" for f in files))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-r", str(FPS), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(src)], check=True)

    parts, labels = [], []
    for i, (a, b, s) in enumerate(merged):
        pad = f",tpad=stop_mode=clone:stop_duration={holds[b]:.3f}" if b in holds else ""
        parts.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{s},fps={FPS},scale=486:1080:flags=lanczos{pad}[v{i}]")
        labels.append(f"[v{i}]")
    graph = ";".join(parts) + f";{''.join(labels)}concat=n={len(labels)}:v=1:a=0[out]"
    PUBLIC.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-filter_complex", graph, "-map", "[out]",
                    "-c:v", "libx264", "-crf", "15", "-preset", "slow", "-pix_fmt", "yuv420p", str(PUBLIC / "phone.mp4")], check=True)

    # timeline.json truncates tool results; the raw stream-json has them in full.
    full_results = {}
    for raw in sorted(run.glob("step_*.jsonl")):
        for rec in raw.read_text().splitlines():
            try:
                msg = json.loads(json.loads(rec)["line"])
            except Exception:
                continue
            content = msg.get("message", {}).get("content") if msg.get("type") == "user" else None
            for c in content if isinstance(content, list) else []:
                if c.get("type") == "tool_result":
                    body = c.get("content")
                    if isinstance(body, list):
                        body = "\n".join(x.get("text", "") for x in body)
                    full_results[c["tool_use_id"]] = str(body)

    tool_names = {}
    out_events = []
    for e in events:
        rt = e["t"] - t0
        o = {"frame": round(out_time(rt) * FPS), "step": e["step"], "kind": e["kind"]}
        if e["kind"] == "prompt":
            o.update(text=e["text"], title=e["title"])
        elif e["kind"] == "text":
            o.update(text=e["text"])
        elif e["kind"] == "tool_use":
            tool_names[e["id"]] = e["name"]
            server, _, tool = e["name"].removeprefix("mcp__").partition("__")
            o.update(server=server, tool=tool, args=summarize_input(e["name"], e["input"]))
        elif e["kind"] == "tool_result":
            text = full_results.get(e["id"], e["text"])
            o.update(text=summarize_result(tool_names.get(e["id"], ""), text, e["isError"]), isError=e["isError"] or ("not found" in text[:200] and not text.lstrip().startswith("{")))
        elif e["kind"] == "step_end":
            continue
        out_events.append(o)

    speed_spans = [{"from": round(out_time(a) * FPS), "to": round(out_time(b) * FPS), "speed": s} for a, b, s in merged if s != 1.0]
    for h, dur in holds.items():
        f = round(out_time(h) * FPS)
        speed_spans.append({"from": f, "to": f + round(dur * FPS), "speed": 0})
    speed_spans.sort(key=lambda x: x["from"])
    total = round(out_time(end) * FPS)
    real_total = end - start
    cost = max(((r or {}).get("cost") or 0 for r in tl["results"]), default=0)  # cumulative per resumed session
    (PUBLIC / "demo.json").write_text(json.dumps({
        "fps": FPS, "durationInFrames": total, "realSeconds": round(real_total, 1),
        "steps": tl["steps"], "events": out_events, "speedSpans": speed_spans,
        "model": "claude-opus-5-5", "costUsd": round(cost, 2),
    }, indent=1))
    print(f"real {real_total:.1f}s -> {total / FPS:.1f}s output, {len(out_events)} events, {len(speed_spans)} sped-up spans")


if __name__ == "__main__":
    main()
