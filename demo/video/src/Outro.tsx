import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import demo from "../public/demo.json";
import { C, MONO } from "./theme";

const POINTS: [string, string][] = [
  ["Learned the schema", "by sampling live documents, no docs or source code needed"],
  ["Seeded realistic data", "in one Couchbase Lite transaction"],
  ["Edited records live", "the app's UI updated the instant each write landed"],
  ["Drove the UI & verified it", "every change is labelled as coming from the app or from the agent"],
  ["Answered questions in SQL++", "against the same data the app is showing"],
  ["Cleaned up after itself", "and release builds never contain the bridge"],
];

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: fade, padding: "80px 120px", background: `radial-gradient(1100px 700px at 75% 85%, #2A1A12 0%, ${C.bg} 60%)` }}>
      <div style={{ fontSize: 60, fontWeight: 800, letterSpacing: -1.5 }}>What the agent just did</div>
      <div style={{ fontSize: 26, color: C.dim, marginTop: 10 }}>
        {demo.realSeconds.toFixed(0)} seconds of real time, 6 plain-English requests, zero hand-written test fixtures.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "48px 70px", marginTop: 70 }}>
        {POINTS.map(([a, b], i) => {
          const s = spring({ frame: frame - 10 - i * 7, fps, config: { damping: 200 } });
          return (
            <div key={a} style={{ opacity: s, transform: `translateY(${(1 - s) * 16}px)`, display: "flex", gap: 18 }}>
              <div style={{ color: C.green, fontSize: 34, lineHeight: "40px" }}>✓</div>
              <div>
                <div style={{ fontSize: 38, fontWeight: 700 }}>{a}</div>
                <div style={{ fontSize: 27, color: C.dim, marginTop: 6 }}>{b}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          left: 120,
          right: 120,
          bottom: 90,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          opacity: spring({ frame: frame - 70, fps, config: { damping: 200 } }),
        }}
      >
        <div style={{ fontFamily: MONO, fontSize: 26, color: C.dim, lineHeight: 1.6 }}>
          <span style={{ color: C.caramel }}>debugImplementation</span>(<span style={{ color: C.green }}>"…:cbl-bridge"</span>)
          <br />
          <span style={{ color: C.text }}>claude mcp add cbl -- node mcp-server/dist/index.js</span>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 44, fontWeight: 800 }}>
            Couchbase Lite <span style={{ color: C.cbl }}>MCP</span>
          </div>
          <div style={{ fontSize: 22, color: C.faint, marginTop: 6 }}>Android · tested with Couchbase Lite 4.1 · works with any MCP client</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
