#!/usr/bin/env python3
"""Records the demo: a real, unscripted Claude Code session (headless, stream-json) using the cbl and
mobile MCP servers against Brew Board on an emulator, while the emulator screen is recorded.

Outputs demo/run/<timestamp>/: timeline.json (every agent event with wall-clock time), seg_*.webm
(emulator screen), raw stream-json per step. render_prep.py + the Remotion project turn that into
the final video.

Usage: demo/record_demo.py [--serial emulator-5554]
"""
import argparse, json, os, subprocess, sys, threading, time, urllib.request, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = "io.github.cblmcp.brewboard"

STEPS = [
    ("Discover the schema",
     "What's in this app's Couchbase Lite database? Figure out how an order document is structured."),
    ("Seed a morning rush",
     "Seed a realistic morning rush: 6 new orders from different customers, using real items and prices from the menu, "
     "created over the last 10 minutes, matching the app's order schema exactly."),
    ("Live edits",
     "Directly in the database, make two quick changes: move the oldest open order to brewing, and add an oat-milk note "
     "to the order of the customer with the biggest order."),
    ("Drive the UI, verify the data",
     "Now QA the app: acting as the barista, tap Start on one of the NEW orders in the app on the emulator, "
     "then confirm in the database that the app itself wrote the change correctly."),
    ("Ask questions in SQL++",
     "With SQL++: how much revenue have we served today, and what's the open ticket value per status?"),
    ("Clean up",
     "Great demo. Delete the orders you created in this session so the board is back to how we found it."),
]

SYSTEM = (
    "You are being screen-recorded for a short product demo video, so keep every final reply to at most 3 short "
    "sentences, with no tables or headings. The Android app Brew Board (package io.github.cblmcp.brewboard) is "
    "running on the emulator emulator-5554; if a tool asks which device to use, pick that one."
)


def adb(serial, *args, check=True):
    return subprocess.run(["adb", "-s", serial, *args], check=check, capture_output=True, text=True).stdout


class Bridge:
    """Direct HTTP to the bridge, used only for resetting the demo data before recording."""

    def __init__(self, serial):
        info = json.loads(adb(serial, "exec-out", "run-as", PKG, "cat", "files/.cbl-bridge/bridge.json"))
        self.port = int(adb(serial, "forward", "tcp:0", f"tcp:{info['port']}").strip())
        self.token = info["token"]

    def call(self, path, body):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {self.token}"})
        return json.loads(urllib.request.urlopen(req, timeout=30).read())


def reset_data(serial):
    """Empty board + a history of orders served earlier today, so the schema is discoverable."""
    b = Bridge(serial)
    ids = [r["id"] for r in b.call("/query", {"sql": "SELECT META().id AS id FROM shop.orders", "limit": 5000})["rows"]]
    ops = [{"op": "purge", "id": i} for i in ids]
    now = int(time.time() * 1000)
    history = [
        ("Ana", [("Flat White", 1, 4.50)]), ("Ben", [("Espresso", 2, 3.00)]),
        ("Chloe", [("Matcha Latte", 1, 5.25), ("Banana Bread", 1, 3.50)]), ("Dev", [("Cold Brew", 1, 4.75)]),
        ("Elena", [("Oat Latte", 1, 5.00)]), ("Farid", [("Cortado", 1, 4.00), ("Butter Croissant", 1, 3.25)]),
        ("Grace", [("Chai Latte", 2, 4.25)]), ("Hugo", [("Flat White", 1, 4.50), ("Espresso", 1, 3.00)]),
        ("Isla", [("Oat Latte", 1, 5.00)]), ("Jonah", [("Cold Brew", 2, 4.75)]),
    ]
    for n, (name, items) in enumerate(history):
        created = now - (150 - n * 12) * 60_000
        ops.append({"op": "put", "id": f"order-{created}", "body": {
            "customer": name,
            "items": [{"name": i, "qty": q, "price": p} for i, q, p in items],
            "total": round(sum(q * p for _, q, p in items), 2),
            "status": "picked_up",
            "createdAt": created, "startedAt": created + 60_000, "readyAt": created + 240_000, "pickedUpAt": created + 300_000,
        }})
    b.call("/batch", {"collection": "shop.orders", "operations": ops})


class EmulatorRecorder(threading.Thread):
    """Chains `adb emu screenrecord` segments (the console caps each at 180 s)."""

    SEGMENT = 170

    def __init__(self, serial, out_dir):
        super().__init__(daemon=True)
        self.serial, self.out_dir = serial, out_dir
        self.segments, self.stop_event = [], threading.Event()

    def run(self):
        n = 0
        while not self.stop_event.is_set():
            path = self.out_dir / f"seg_{n:02d}.webm"
            adb(self.serial, "emu", "screenrecord", "start", "--time-limit", str(self.SEGMENT + 5), str(path))
            self.segments.append({"file": path.name, "start": time.time()})
            self.stop_event.wait(self.SEGMENT)
            adb(self.serial, "emu", "screenrecord", "stop", check=False)
            self.segments[-1]["end"] = time.time()
            time.sleep(1.5)  # let the encoder finalise the file before the next segment starts
            n += 1


def demo_statusbar(serial, on):
    if on:
        adb(serial, "shell", "settings", "put", "global", "sysui_demo_allowed", "1")
        for extra in (["-e", "command", "clock", "-e", "hhmm", "0755"],
                      ["-e", "command", "battery", "-e", "level", "100", "-e", "plugged", "false"],
                      ["-e", "command", "network", "-e", "wifi", "show", "-e", "level", "4", "-e", "mobile", "show", "-e", "level", "4", "-e", "datatype", "none"],
                      ["-e", "command", "notifications", "-e", "visible", "false"]):
            adb(serial, "shell", "am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", "enter")
            adb(serial, "shell", "am", "broadcast", "-a", "com.android.systemui.demo", *extra)
    else:
        adb(serial, "shell", "am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", "exit", check=False)


def run_step(i, title, prompt, session_id, out_dir, events):
    args = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose",
            "--mcp-config", str(HERE / "mcp.json"), "--strict-mcp-config",
            "--allowedTools", "mcp__cbl__*", "mcp__mobile__*",
            "--append-system-prompt", SYSTEM, "--disable-slash-commands",
            # The demo is about the MCP servers: no shell, file or web access for the agent.
            "--disallowedTools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "NotebookEdit"]
    args += ["--session-id", session_id] if i == 0 else ["--resume", session_id]
    started = time.time()
    events.append({"t": started, "step": i, "kind": "prompt", "text": prompt, "title": title})
    raw = open(out_dir / f"step_{i}.jsonl", "w")
    proc = subprocess.Popen(args, cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, text=True)
    result = None
    for line in proc.stdout:
        t = time.time()
        raw.write(json.dumps({"t": t, "line": line.rstrip("\n")}) + "\n")
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("type") in ("assistant", "user"):
            content = e["message"]["content"]
            for c in content if isinstance(content, list) else []:
                if c["type"] == "text" and c["text"].strip():
                    events.append({"t": t, "step": i, "kind": "text", "text": c["text"]})
                elif c["type"] == "tool_use":
                    events.append({"t": t, "step": i, "kind": "tool_use", "id": c["id"], "name": c["name"], "input": c["input"]})
                elif c["type"] == "tool_result":
                    body = c.get("content")
                    if isinstance(body, list):
                        body = "\n".join(x.get("text", f"[{x.get('type')}]") for x in body)
                    events.append({"t": t, "step": i, "kind": "tool_result", "id": c["tool_use_id"], "text": str(body)[:4000], "isError": bool(c.get("is_error"))})
        elif e.get("type") == "result":
            result = {"cost": e.get("total_cost_usd"), "durationMs": e.get("duration_ms"), "turns": e.get("num_turns"), "subtype": e.get("subtype")}
    proc.wait()
    raw.close()
    events.append({"t": time.time(), "step": i, "kind": "step_end", "result": result})
    print(f"  step {i + 1} '{title}': {time.time() - started:.1f}s, {result}", flush=True)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", default="emulator-5554")
    ap.add_argument("--steps", type=int, default=len(STEPS))
    a = ap.parse_args()

    out_dir = HERE / "run" / time.strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True)
    print(f"recording into {out_dir}", flush=True)

    adb(a.serial, "shell", "am", "force-stop", PKG)
    adb(a.serial, "shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(3)
    reset_data(a.serial)
    demo_statusbar(a.serial, True)
    time.sleep(2)

    rec = EmulatorRecorder(a.serial, out_dir)
    rec.start()
    time.sleep(3)
    events, session_id, results = [], str(uuid.uuid4()), []
    try:
        for i, (title, prompt) in enumerate(STEPS[: a.steps]):
            results.append(run_step(i, title, prompt, session_id, out_dir, events))
            time.sleep(3)
    finally:
        rec.stop_event.set()
        rec.join(timeout=30)
        demo_statusbar(a.serial, False)
        (out_dir / "timeline.json").write_text(json.dumps({
            "sessionId": session_id, "serial": a.serial, "segments": rec.segments,
            "steps": [{"title": t, "prompt": p} for t, p in STEPS[: a.steps]], "results": results, "events": events,
        }, indent=1))
    print(f"done: {out_dir}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
