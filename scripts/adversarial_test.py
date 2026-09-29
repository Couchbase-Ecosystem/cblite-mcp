#!/usr/bin/env python3
"""Tries to break the on-device bridge: malformed HTTP, slow clients, hostile JSON, races, overload.

Usage: ANDROID_SERIAL=<device> scripts/adversarial_test.py
Runs every probe (doesn't stop at the first failure) and exits non-zero if any failed.
The demo app must be running. Leaves no test data behind.
"""
import concurrent.futures as cf
import json, socket, subprocess, sys, threading, time, urllib.error, urllib.request

PKG = "io.github.cblmcp.brewboard"


def adb(*a):
    return subprocess.run(["adb", *a], check=True, capture_output=True, text=True).stdout


conn = json.loads(adb("exec-out", "run-as", PKG, "cat", "files/.cbl-bridge/bridge.json"))
PORT = int(adb("forward", "tcp:0", f"tcp:{conn['port']}").strip())
TOKEN = conn["token"]
results = []


def call(path, body=None, token=TOKEN, timeout=30, raw_body=None):
    data = raw_body if raw_body is not None else (None if body is None else json.dumps(body).encode())
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data,
                                 headers={"Authorization": f"Bearer {token}"}, method="GET" if data is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        txt = e.read()
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, {"raw": txt[:200]}


def raw(payload: bytes, read_timeout=20, close_write=False):
    # Note: adb forward tears down half-closed sockets, so by default we don't shutdown(SHUT_WR).
    s = socket.create_connection(("127.0.0.1", PORT), timeout=read_timeout)
    try:
        s.sendall(payload)
        if close_write:
            s.shutdown(socket.SHUT_WR)
        out = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            out += chunk
        return out
    finally:
        s.close()


def status_of(resp: bytes):
    try:
        return int(resp.split(b" ", 2)[1])
    except Exception:
        return None


def alive():
    st, d = call("/hello", timeout=5)
    return st == 200 and d.get("bridge") == "cbl-mcp-bridge"


def probe(name):
    def deco(fn):
        def run():
            t = time.time()
            try:
                detail = fn() or ""
                ok = True
            except AssertionError as e:
                ok, detail = False, str(e)
            except Exception as e:
                ok, detail = False, f"{type(e).__name__}: {e}"
            if ok and not alive():
                ok, detail = False, f"bridge dead after probe ({detail})"
            results.append((ok, name, detail, time.time() - t))
            print(f"  {'ok  ' if ok else 'FAIL'} {name}  {detail}", flush=True)
        run.__name__ = fn.__name__
        PROBES.append(run)
        return run
    return deco


PROBES = []
C = "shop.orders"


def purge(*ids, collection=C):
    call("/batch", {"collection": collection, "operations": [{"op": "purge", "id": i} for i in ids]})


# ------------------------------------------------------------------ HTTP layer

@probe("garbage bytes instead of HTTP")
def _():
    r = raw(b"\x00\xff\x13garbage\r\n\r\n")
    assert status_of(r) in (400, 401, 404), r[:80]


@probe("empty connection (connect + close)")
def _():
    raw(b"")


@probe("16 KB+ header line rejected")
def _():
    r = raw(b"GET /hello HTTP/1.1\r\nX: " + b"a" * 20000 + b"\r\n\r\n")
    assert status_of(r) in (400, 431, 500), r[:80]


@probe("negative Content-Length")
def _():
    r = raw(b"POST /query HTTP/1.1\r\nAuthorization: Bearer " + TOKEN.encode() + b"\r\nContent-Length: -5\r\n\r\n{}")
    assert status_of(r) == 400, r[:120]


@probe("Content-Length larger than body (client closes early)")
def _():
    t = time.time()
    r = raw(b"POST /query HTTP/1.1\r\nAuthorization: Bearer " + TOKEN.encode() + b"\r\nContent-Length: 1000\r\n\r\n{\"sql\":")
    assert status_of(r) in (400, 408), r[:160]
    return f"status {status_of(r)} after {time.time() - t:.1f}s"


@probe("chunked transfer encoding")
def _():
    body = b'{"sql":"SELECT COUNT(*) AS n FROM shop.menu"}'
    chunked = hex(len(body))[2:].encode() + b"\r\n" + body + b"\r\n0\r\n\r\n"
    r = raw(b"POST /query HTTP/1.1\r\nAuthorization: Bearer " + TOKEN.encode() + b"\r\nTransfer-Encoding: chunked\r\n\r\n" + chunked)
    st = status_of(r)
    assert st in (200, 411, 501), r[:160]
    return f"status {st}"


@probe("33 MB body rejected without OOM")
def _():
    r = raw(b"POST /query HTTP/1.1\r\nAuthorization: Bearer " + TOKEN.encode() + b"\r\nContent-Length: 34000000\r\n\r\n")
    assert status_of(r) in (400, 413), r[:120]


@probe("slow clients can't starve the server (20 idle sockets, then a real request)")
def _():
    socks = [socket.create_connection(("127.0.0.1", PORT)) for _ in range(20)]
    try:
        time.sleep(0.5)
        t = time.time()
        st, _ = call("/info", timeout=8)
        assert st == 200, st
        return f"/info answered in {time.time() - t:.2f}s with 20 idle connections open"
    finally:
        for s in socks:
            s.close()


@probe("long-polls can't starve the server (10 parallel /changes?timeoutMs=20000)")
def _():
    with cf.ThreadPoolExecutor(12) as ex:
        polls = [ex.submit(call, "/changes?timeoutMs=20000", None, TOKEN, 40) for _ in range(10)]
        time.sleep(1)
        t = time.time()
        st, _ = call("/info", timeout=8)
        dt = time.time() - t
        purge_after = call("/doc/put", {"collection": C, "id": "adv-lp", "body": {"x": 1}})
        done = [p.result() for p in polls]
    purge("adv-lp")
    assert st == 200, st
    assert all(s == 200 and d["events"] for s, d in done), "long polls didn't all wake on the write"
    return f"/info in {dt:.2f}s; all 10 polls woke on one write"


@probe("token check: wrong, empty, prefix-only, lowercase header")
def _():
    for tok in ("nope", "", TOKEN[:-1], TOKEN + "x"):
        st, _ = call("/info", token=tok)
        assert st == 401, (tok, st)
    r = raw(b"GET /info HTTP/1.1\r\nauthorization: Bearer " + TOKEN.encode() + b"\r\n\r\n")
    assert status_of(r) == 200, r[:80]


@probe("unknown method / path traversal")
def _():
    r = raw(b"DELETE /../../etc/passwd HTTP/1.1\r\nAuthorization: Bearer " + TOKEN.encode() + b"\r\n\r\n")
    assert status_of(r) == 404, r[:80]


# ------------------------------------------------------------------ hostile JSON / data

@probe("invalid JSON body -> 400")
def _():
    st, d = call("/query", raw_body=b"{not json")
    assert st == 400, (st, d)


@probe("JSON array as body -> 400")
def _():
    st, d = call("/query", raw_body=b"[1,2]")
    assert st == 400, (st, d)


@probe("wrong field types -> 400, not 500")
def _():
    for body in ({"collection": C, "id": "x", "body": "a string"}, {"collection": C, "id": 5, "body": {}}, {"collection": 7, "id": "x", "body": {}}):
        st, d = call("/doc/put", body)
        assert st == 400, (body, st, d)
    purge("5")


@probe("missing required fields -> 400")
def _():
    for path in ("/query", "/doc/get", "/doc/put", "/batch", "/index/create"):
        st, d = call(path, {})
        assert st == 400, (path, st, d)


@probe("empty-string id is rejected, not turned into a random id")
def _():
    st, d = call("/doc/put", {"collection": C, "id": "", "body": {"x": 1}})
    assert st == 400, (st, d)


@probe("unicode, emoji, RTL, NUL and very long ids/values round-trip")
def _():
    doc_id = "ümlaut-😀-short"
    body = {"name": "Zoë 😀 مرحبا end", "nested": {"日本": ["a", {"b": None}]}, "dot.key": 1}
    for bad in ({"a": "ab\u0000cd"}, {"k\u0000x": 1}, {"deep": [{"x": "\u0000"}]}):
        st, d = call("/doc/put", {"collection": C, "id": "adv-nul", "body": bad})
        assert st == 400 and "NUL" in d.get("error", ""), ("NUL must be refused, Couchbase Lite would truncate it", bad, st, d)
    assert call("/doc/get", {"collection": C, "id": "adv-nul"})[0] == 404, "refused NUL write still created a document"
    st, d = call("/doc/put", {"collection": C, "id": "adv-emptykey", "body": {"": 1}})
    assert st == 400, ("Couchbase Lite rejects empty property names; expected a clean 400", st, d)
    st, d = call("/doc/put", {"collection": C, "id": doc_id, "body": body})
    assert st == 200, (st, d)
    st, g = call("/doc/get", {"collection": C, "id": doc_id})
    assert g["body"] == body, g["body"]
    purge(doc_id)


@probe("numbers: big ints, negatives, floats, exponent")
def _():
    body = {"big": 9007199254740993, "neg": -42, "f": 0.1, "e": 1e300, "zero": 0}
    call("/doc/put", {"collection": C, "id": "adv-num", "body": body})
    g = call("/doc/get", {"collection": C, "id": "adv-num"})[1]["body"]
    purge("adv-num")
    assert g["neg"] == -42 and g["f"] == 0.1 and g["e"] == 1e300 and g["zero"] == 0, g
    return f"2^53+1 came back as {g['big']}" + ("" if g["big"] == 9007199254740993 else " (precision loss)")


@probe("reserved underscore properties -> 400, not 500")
def _():
    st, d = call("/doc/put", {"collection": C, "id": "adv-us", "body": {"_deleted": True, "_attachments": {}}})
    purge_ok = call("/doc/get", {"collection": C, "id": "adv-us"})[0]
    if purge_ok == 200:
        purge("adv-us")
    assert st in (200, 400), (st, d)
    return f"status {st}: {d.get('error', '')[:80]}"


@probe("1000-level nested document doesn't crash the app")
def _():
    body = cur = {}
    for _ in range(1000):
        cur["n"] = {}
        cur = cur["n"]
    st, d = call("/doc/put", {"collection": C, "id": "adv-deep", "body": body})
    if call("/doc/get", {"collection": C, "id": "adv-deep"})[0] == 200:
        st2, d2 = call("/collection/describe", {"collection": C})
        purge("adv-deep")
        assert st2 == 200, (st2, d2)
    assert st in (200, 400), (st, d)
    return f"put status {st}"


@probe("5 MB document round-trips")
def _():
    body = {"blob": "x" * 5_000_000}
    st, d = call("/doc/put", {"collection": C, "id": "adv-big", "body": body}, timeout=60)
    assert st == 200, (st, d)
    st, g = call("/doc/get", {"collection": C, "id": "adv-big"}, timeout=60)
    purge("adv-big")
    assert len(g["body"]["blob"]) == 5_000_000


@probe("query result far larger than memory-safe size is bounded")
def _():
    ops = [{"op": "put", "id": f"adv-fat-{i}", "body": {"pad": "y" * 200_000}} for i in range(60)]
    call("/batch", {"collection": "adv.fat", "createCollection": True, "operations": ops}, timeout=120)
    try:
        t = time.time()
        st, d = call("/query", {"sql": "SELECT * FROM adv.fat", "limit": 5000}, timeout=120)
        assert st == 200, (st, str(d)[:200])
        size = len(json.dumps(d))
        return f"{len(d['rows'])} rows, {size / 1e6:.1f} MB response in {time.time() - t:.1f}s, truncated={d.get('truncated')}"
    finally:
        call("/collection/delete", {"collection": "adv.fat"})


@probe("invalid SQL++, DDL, and multiple statements -> 400")
def _():
    for sql in ("SELEKT *", "DROP TABLE kv_default", "SELECT * FROM shop.orders; DELETE FROM shop.orders", "", "SELECT * FROM nope.nope"):
        st, d = call("/query", {"sql": sql})
        assert st == 400, (sql, st, d)


@probe("query parameters of every JSON type")
def _():
    st, d = call("/query", {"sql": "SELECT $s AS s, $n AS n, $b AS b, $a AS a, $o AS o, $z AS z FROM shop.menu LIMIT 1", "parameters": {"s": "x", "n": 1.5, "b": True, "a": [1, 2], "o": {"k": "v"}, "z": None}})
    assert st == 200, (st, d)
    r = d["rows"][0]
    # Couchbase Lite echoes a boolean *parameter* as 1 in a projection; stored booleans come back as true.
    assert r["s"] == "x" and r["n"] == 1.5 and r["b"] in (True, 1) and r["a"] == [1, 2] and r["o"] == {"k": "v"}, r
    st, d = call("/query", {"sql": "SELECT COUNT(*) AS n FROM shop.menu AS m WHERE m.available = $b", "parameters": {"b": True}})
    assert d["rows"][0]["n"] > 0, d


@probe("bad collection names -> 4xx, not 500")
def _():
    for col in ("a.b.c", ".x", "x.", "sp ace", "_default._default._x", "../etc"):
        st, d = call("/doc/get", {"collection": col, "id": "x"})
        assert 400 <= st < 500, (col, st, d)
    st, d = call("/collection/create", {"collection": "bad name!"})
    assert 400 <= st < 500, (st, d)
    st, d = call("/collection/delete", {"collection": "_default._default"})
    assert 400 <= st < 500, (st, d)


@probe("merge on a nonexistent doc -> 404; delete twice -> 404")
def _():
    st, _ = call("/doc/put", {"collection": C, "id": "adv-none", "mode": "merge", "body": {"a": 1}})
    assert st == 404, st
    call("/doc/put", {"collection": C, "id": "adv-del", "body": {"a": 1}})
    assert call("/doc/delete", {"collection": C, "id": "adv-del"})[0] == 200
    assert call("/doc/delete", {"collection": C, "id": "adv-del"})[0] == 404
    assert call("/doc/put", {"collection": C, "id": "adv-del", "body": {"back": True}})[0] == 200  # resurrect after tombstone
    purge("adv-del")


@probe("blob: invalid base64, missing doc, non-blob property")
def _():
    call("/doc/put", {"collection": C, "id": "adv-blob", "body": {"notblob": "text"}})
    st1, _ = call("/blob/put", {"collection": C, "id": "adv-blob", "property": "p", "contentType": "x/y", "base64": "!!!notbase64"})
    st2, _ = call("/blob/get", {"collection": C, "id": "adv-blob", "property": "notblob"})
    st3, _ = call("/blob/get", {"collection": C, "id": "adv-missing", "property": "p"})
    purge("adv-blob")
    assert st1 == 400 and st2 == 404 and st3 == 404, (st1, st2, st3)


# ------------------------------------------------------------------ concurrency

@probe("100 parallel requests, mixed reads/writes")
def _():
    def work(i):
        if i % 2:
            return call("/doc/put", {"collection": C, "id": f"adv-par-{i}", "body": {"i": i}})[0]
        return call("/query", {"sql": "SELECT COUNT(*) AS n FROM shop.menu"})[0]
    t = time.time()
    with cf.ThreadPoolExecutor(32) as ex:
        codes = list(ex.map(work, range(100)))
    purge(*[f"adv-par-{i}" for i in range(1, 100, 2)])
    assert codes.count(200) == 100, codes
    return f"{time.time() - t:.2f}s"


@probe("concurrent merges on one document don't lose updates")
def _():
    call("/doc/put", {"collection": C, "id": "adv-race", "body": {}})
    def merge(i):
        return call("/doc/put", {"collection": C, "id": "adv-race", "mode": "merge", "body": {f"k{i}": i}})[0]
    with cf.ThreadPoolExecutor(20) as ex:
        codes = list(ex.map(merge, range(40)))
    body = call("/doc/get", {"collection": C, "id": "adv-race"})[1]["body"]
    purge("adv-race")
    # The invariant: a merge that reported success is never lost. (Under extreme contention a merge may give up
    # with an explicit 409; that's allowed but should be rare.)
    lost = [i for i in range(40) if codes[i] == 200 and f"k{i}" not in body]
    assert not lost, f"{len(lost)} merges reported 200 but their keys are missing"
    gave_up = codes.count(409)
    assert gave_up <= 2, f"{gave_up}/40 merges gave up with 409"
    return f"40/40 applied" if not gave_up else f"{40 - gave_up} applied, {gave_up} explicit 409"


@probe("expectedRevision is atomic under a race (exactly one winner)")
def _():
    rev = call("/doc/put", {"collection": C, "id": "adv-occ", "body": {"v": 0}})[1]["revisionId"]
    def put(i):
        return call("/doc/put", {"collection": C, "id": "adv-occ", "expectedRevision": rev, "body": {"v": i}})[0]
    with cf.ThreadPoolExecutor(20) as ex:
        codes = list(ex.map(put, range(1, 21)))
    purge("adv-occ")
    assert codes.count(200) == 1 and codes.count(409) == 19, codes


@probe("change feed reports a gap when events fell out of the buffer")
def _():
    start = call("/changes?timeoutMs=0")[1]["lastSeq"]
    call("/collection/create", {"collection": "adv.flood"})
    n, deadline = 0, time.time() + 180
    while call("/changes?timeoutMs=0")[1]["lastSeq"] - start <= 2050:
        assert time.time() < deadline, "couldn't generate 2050 change events in 180 s"
        for _ in range(50):
            call("/doc/put", {"collection": "adv.flood", "id": f"f{n}", "body": {}})
            n += 1
            time.sleep(0.05)  # thousands of back-to-back connections can knock over the adb forward itself
    st, d = call(f"/changes?since={start}&limit=2000")
    call("/collection/delete", {"collection": "adv.flood"})
    assert d.get("gap") is True, f"no gap flag; first seq returned {d['events'][0]['seq'] if d['events'] else None}, since={start}"
    st, d2 = call(f"/changes?since={d['lastSeq']}&timeoutMs=0")
    assert d2.get("gap") is False, "gap reported for an up-to-date cursor"
    return f"{n} writes -> gap flagged, then cleared for a current cursor"


# split the unicode probe so a Couchbase Lite id limit is reported separately from data handling
@probe("unicode ids: which ones Couchbase Lite accepts")
def _():
    report = []
    for doc_id in ("ümlaut-😀", "x" * 240, "x" * 260, "a/b\\c", " spaced ", "\u0000nul"):
        st, d = call("/doc/put", {"collection": C, "id": doc_id, "body": {"k": 1}})
        report.append(f"{doc_id[:12]!r}({len(doc_id.encode())}B)->{st}")
        assert st in (200, 400), (doc_id, st, d)
        if st == 200:
            assert call("/doc/get", {"collection": C, "id": doc_id})[1]["body"] == {"k": 1}
            purge(doc_id)
    return ", ".join(report)


if __name__ == "__main__":
    only = sys.argv[1:]
    for p in PROBES:
        p()
    adb("forward", "--remove", f"tcp:{PORT}")
    failed = [r for r in results if not r[0]]
    print(f"\n{len(results) - len(failed)}/{len(results)} probes passed")
    sys.exit(1 if failed else 0)
