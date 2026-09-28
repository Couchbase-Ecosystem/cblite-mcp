import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, INTRO, MONO } from "./theme";

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = (delay: number) => spring({ frame: frame - delay, fps, config: { damping: 200 } });
  const out = interpolate(frame, [INTRO - 15, INTRO], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const chips = ["One debugImplementation line", "20 MCP tools", "Live UI updates", "Pairs with mobile-mcp"];

  return (
    <AbsoluteFill
      style={{
        opacity: out,
        background: `radial-gradient(1200px 700px at 30% 20%, #2A1A12 0%, ${C.bg} 60%)`,
        justifyContent: "center",
        padding: "0 160px",
      }}
    >
      <div style={{ opacity: rise(0), transform: `translateY(${(1 - rise(0)) * 20}px)`, fontFamily: MONO, color: C.caramel, fontSize: 28, letterSpacing: 2 }}>
        COUCHBASE LITE × MODEL CONTEXT PROTOCOL
      </div>
      <div
        style={{
          opacity: rise(8),
          transform: `translateY(${(1 - rise(8)) * 30}px)`,
          fontSize: 96,
          fontWeight: 800,
          lineHeight: 1.05,
          marginTop: 24,
          letterSpacing: -2,
        }}
      >
        Let your AI agent work
        <br />
        inside your app's <span style={{ color: C.cbl }}>live database</span>.
      </div>
      <div style={{ opacity: rise(22), fontSize: 36, color: C.dim, marginTop: 36, maxWidth: 1350, lineHeight: 1.35 }}>
        An MCP server + a debug-only Android library that let Claude query, seed and edit the Couchbase Lite database
        of a running app, while the UI reacts in real time.
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 56 }}>
        {chips.map((c, i) => (
          <div
            key={c}
            style={{
              opacity: rise(34 + i * 6),
              transform: `translateY(${(1 - rise(34 + i * 6)) * 16}px)`,
              border: `1.5px solid ${C.line}`,
              background: C.panel,
              borderRadius: 999,
              padding: "14px 26px",
              fontSize: 26,
              color: C.text,
            }}
          >
            {c}
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", bottom: 60, left: 160, fontSize: 24, color: C.faint, opacity: rise(60) }}>
        Everything that follows is a real, unedited agent session. Idle stretches are sped up, reading pauses are added, and both are labelled.
      </div>
    </AbsoluteFill>
  );
};
