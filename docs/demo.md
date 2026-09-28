# How the demo video was made

The video is a recording of a real session. Nothing in the agent's output was scripted or edited.

## Recording (`demo/record_demo.py`)

1. Restart Brew Board on the emulator and reset its data through the bridge. The board starts empty, with 10
   orders already served earlier "today" as history, so there is a schema to discover.
2. Put the system UI in demo mode (clock 07:55, full battery), and start the emulator's own screen recorder
   (`adb emu screenrecord`, in chained 170 s segments). On-device `screenrecord` produced almost no frames on this
   headless emulator.
3. Run six prompts through headless Claude Code, one `claude -p` call each, all resuming the same session:
   - `--mcp-config demo/mcp.json --strict-mcp-config`: only the `cbl` and `mobile` servers
   - `--disallowedTools Bash Read Edit Write Glob Grep WebFetch WebSearch Agent NotebookEdit`: no shell, files or
     web, so the agent couldn't read the app's source and had to learn everything through MCP
   - `--append-system-prompt`: "keep every final reply to at most 3 short sentences" (for readability on video),
     plus which emulator to use
4. Log every stream-json event with a wall-clock timestamp in `timeline.json`.

The prompts:

1. What's in this app's Couchbase Lite database? Figure out how an order document is structured.
2. Seed a realistic morning rush: 6 new orders … matching the app's order schema exactly.
3. Directly in the database, make two quick changes: move the oldest open order to brewing, and add an oat-milk
   note to the order of the customer with the biggest order.
4. Now QA the app: acting as the barista, tap Start on one of the NEW orders … then confirm in the database that the
   app itself wrote the change correctly.
5. With SQL++: how much revenue have we served today, and what's the open ticket value per status?
6. Delete the orders you created in this session so the board is back to how we found it.

Result of the published run (`demo/run/20260928-224146`, not committed): 6/6 steps succeeded, 150 s of wall time,
$0.52 total (Claude Opus 5.5). Things the agent did without being told:

- With no `new`-status order in the history, it read the status labels from the app's screen (mobile-mcp) before
  seeding.
- Asked for "the oldest open order", it skipped Dana's order, which was already *ready*, rather than moving it
  backwards.
- After tapping Start, it confirmed that the one change came from the app (`source: app`) and that the app wrote the
  same `status` and `startedAt` format it had used for its own edit.
- It checked that its SQL++ total ($46.00) matched the figure on the board.
- It pointed out that deletes leave tombstones and offered to purge them.

An earlier take was discarded because the agent spent a turn trying to read the app's source with Bash/Read, which
was blocked by permissions. That's why the final run disables those tools and exposes the device clock in `cbl_info`.

## Editing (`demo/render_prep.py` + `demo/video`)

- **Time warp:** real time plays at 1× for 2.5 s after every agent event. Longer idle stretches, where the model is
  thinking, play at 4× with a "4× SPEED" badge.
- **Reading pauses:** after each step's final reply, the frame freezes for words/6 seconds (3–8 s) with a
  "PAUSED · READING TIME" badge.
- The terminal panel is rendered from the logged events. Tool results are summarised (e.g. "1 transaction · 6
  writes committed"); `ToolSearch` calls, which are just the harness loading tool schemas, are hidden.
- Toasts under the phone point out the moments that matter: a write landing, a tap, a change attributed to the app.

Reproduce:

```bash
python3 demo/record_demo.py                   # needs the demo app installed on emulator-5554
python3 demo/render_prep.py demo/run/<timestamp>
cd demo/video && npm install && npx remotion render DemoVideo out/cbl-mcp-demo.mp4
```
