#!/usr/bin/env python3
"""End-to-end smoke test of the on-device bridge's HTTP API (no MCP involved).

Usage: ANDROID_SERIAL=<device> scripts/bridge_smoke_test.py [package]
Needs the demo app (or any app with the bridge) running on the device.
"""
import json, os, subprocess, sys, urllib.request, urllib.error

PKG = sys.argv[1] if len(sys.argv) > 1 else "io.github.cblmcp.brewboard"
LOCAL = 47199

def adb(*args):
    return subprocess.run(["adb", *args], check=True, capture_output=True, text=True).stdout

conn = json.loads(adb("shell", "run-as", PKG, "cat", "files/.cbl-bridge/bridge.json"))
adb("forward", f"tcp:{LOCAL}", f"tcp:{conn['port']}")
TOKEN = conn["token"]

def call(path, body=None, expect=200):
    req = urllib.request.Request(f"http://127.0.0.1:{LOCAL}{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            status, data = r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        status, data = e.code, json.loads(e.read())
    assert status == expect, f"{path}: expected {expect}, got {status}: {data}"
    return data

passed = 0
def check(name, cond, detail=""):
    global passed
    assert cond, f"FAIL {name} {detail}"
    passed += 1
    print(f"  ok  {name}")

# auth
req = urllib.request.Request(f"http://127.0.0.1:{LOCAL}/info")
try:
    urllib.request.urlopen(req); check("rejects missing token", False)
except urllib.error.HTTPError as e:
    check("rejects missing token", e.code == 401)

info = call("/info")
cols = {c["fullName"] for d in info["databases"] for c in d.get("collections", [])}
check("info lists shop scope collections", {"shop.orders", "shop.menu"} <= cols, str(cols))

d = call("/collection/describe", {"collection": "shop.menu"})
check("describe infers menu schema", d["fields"]["price"]["types"] == {"number": d["sampled"]}, str(d["fields"]))

start_seq = call("/changes?timeoutMs=0")["lastSeq"]
r = call("/doc/put", {"collection": "shop.orders", "id": "smoke-1", "body": {"customer": "Smoke Test", "items": [{"name": "Espresso", "qty": 1}], "total": 3.0, "status": "new", "createdAt": 0}})
check("put creates doc", r["created"] is True)
rev1 = r["revisionId"]
r = call("/doc/put", {"collection": "shop.orders", "id": "smoke-1", "mode": "merge", "body": {"status": "brewing", "note": "extra hot", "items": None}})
g = call("/doc/get", {"collection": "shop.orders", "id": "smoke-1"})["body"]
check("merge patch updates/removes keys", g["status"] == "brewing" and g["note"] == "extra hot" and "items" not in g and g["customer"] == "Smoke Test", str(g))
call("/doc/put", {"collection": "shop.orders", "id": "smoke-1", "expectedRevision": rev1, "body": {"x": 1}}, expect=409)
check("stale expectedRevision -> 409", True)
call("/doc/put", {"collection": "shop.orders", "id": "smoke-1", "mode": "create", "body": {"x": 1}}, expect=409)
check("create on existing -> 409", True)

q = call("/query", {"sql": "SELECT META(o).id AS id, o.status FROM shop.orders AS o WHERE o.customer = $name", "parameters": {"name": "Smoke Test"}})
check("parameterised SQL++ query", q["rows"] == [{"id": "smoke-1", "status": "brewing"}], str(q))
e = call("/explain", {"sql": "SELECT * FROM shop.orders WHERE status = 'new'"})
check("explain returns a plan", "idx_orders_status" in e["plan"] or "SCAN" in e["plan"].upper(), e["plan"][:200])

b = call("/batch", {"collection": "shop.orders", "operations": [
    {"op": "create", "id": "smoke-2", "body": {"customer": "B", "status": "new", "total": 1}},
    {"op": "merge", "id": "smoke-1", "body": {"status": "ready"}},
]})
check("batch commits", b["count"] == 2)
call("/batch", {"collection": "shop.orders", "operations": [
    {"op": "create", "id": "smoke-3", "body": {"customer": "C"}},
    {"op": "create", "id": "smoke-2", "body": {"customer": "dup"}},
]}, expect=409)
check("failed batch rolls back", call("/doc/get", {"collection": "shop.orders", "id": "smoke-3"}, expect=404) is not None)

ch = call(f"/changes?since={start_seq}&timeoutMs=2000")
srcs = {ev["source"] for ev in ch["events"]}
check("change feed attributes bridge writes", ch["events"] and srcs == {"bridge"}, str(ch))

call("/blob/put", {"collection": "shop.orders", "id": "smoke-1", "property": "receipt", "contentType": "text/plain", "base64": "aGVsbG8="})
bl = call("/blob/get", {"collection": "shop.orders", "id": "smoke-1", "property": "receipt"})
check("blob round-trip", bl["base64"] == "aGVsbG8=" and bl["length"] == 5)

call("/index/create", {"collection": "shop.orders", "name": "idx_smoke", "expressions": ["customer"]})
check("index create/list", "idx_smoke" in call("/index/list", {"collection": "shop.orders"})["indexes"])
call("/index/delete", {"collection": "shop.orders", "name": "idx_smoke"})

call("/collection/create", {"collection": "scratch.tmp"})
check("collection create", "scratch.tmp" in {c["fullName"] for d in call("/info")["databases"] for c in d.get("collections", [])})
call("/collection/delete", {"collection": "scratch.tmp"})

for i in ("smoke-1", "smoke-2"):
    call("/doc/delete", {"collection": "shop.orders", "id": i, "purge": True})
check("cleanup", call("/query", {"sql": "SELECT COUNT(*) AS n FROM shop.orders WHERE META().id LIKE 'smoke-%'"})["rows"][0]["n"] == 0)
call("/nope", {}, expect=404)
check("unknown endpoint -> 404", True)
adb("forward", "--remove", f"tcp:{LOCAL}")
print(f"\n{passed} checks passed")
