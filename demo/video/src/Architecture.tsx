import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { ARCH, C, MONO } from "./theme";

type BoxProps = { x: number; y: number; w: number; h: number; title: string; sub: string; color: string; delay: number };

const Box: React.FC<BoxProps> = ({ x, y, w, h, title, sub, color, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        opacity: s,
        transform: `scale(${0.94 + 0.06 * s})`,
        background: C.panel,
        border: `2px solid ${color}`,
        borderRadius: 20,
        padding: "22px 26px",
        boxSizing: "border-box",
      }}
    >
      <div style={{ fontSize: 30, fontWeight: 700, color }}>{title}</div>
      <div style={{ fontSize: 22, color: C.dim, marginTop: 10, lineHeight: 1.35 }}>{sub}</div>
    </div>
  );
};

/** Polyline connector that draws itself on, with an arrowhead at the last point. */
const Arrow: React.FC<{ pts: [number, number][]; label?: string; lx?: number; ly?: number; delay: number; color?: string }> = ({
  pts,
  label,
  lx = 0,
  ly = 0,
  delay,
  color = C.dim,
}) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame - delay, [0, 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const [x2, y2] = pts[pts.length - 1];
  const [x1, y1] = pts[pts.length - 2];
  const angle = Math.atan2(y2 - y1, x2 - x1);
  return (
    <>
      <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
        <path d={d} fill="none" stroke={color} strokeWidth={3} pathLength={1} strokeDasharray={`${p} 1`} strokeLinejoin="round" />
        {p > 0.97 && (
          <polygon points="-16,-9 0,0 -16,9" fill={color} transform={`translate(${x2},${y2}) rotate(${(angle * 180) / Math.PI})`} />
        )}
      </svg>
      {label && (
        <div style={{ position: "absolute", left: lx, top: ly, fontFamily: MONO, fontSize: 20, color, opacity: p, background: C.bg, padding: "2px 8px", borderRadius: 6 }}>
          {label}
        </div>
      )}
    </>
  );
};

export const Architecture: React.FC = () => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 12, ARCH - 15, ARCH], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const devP = interpolate(frame, [70, 90], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <div style={{ position: "absolute", left: 90, top: 60, fontSize: 52, fontWeight: 800, letterSpacing: -1 }}>How it works</div>
      <div style={{ position: "absolute", left: 90, top: 132, fontSize: 26, color: C.dim }}>
        Writes go through the app's own <span style={{ fontFamily: MONO, color: C.text }}>Database</span> instance, so live queries and UI react instantly. No file copying, no app restarts.
      </div>

      {/* developer machine */}
      <div style={{ position: "absolute", left: 60, top: 220, width: 800, height: 800, border: `2px dashed ${C.line}`, borderRadius: 28 }} />
      <div style={{ position: "absolute", left: 90, top: 236, fontFamily: MONO, fontSize: 20, color: C.faint }}>YOUR MACHINE</div>

      {/* device */}
      <div style={{ position: "absolute", left: 1000, top: 220, width: 860, height: 800, border: `2px dashed ${C.line}`, borderRadius: 28, opacity: devP }} />
      <div style={{ position: "absolute", left: 1030, top: 236, fontFamily: MONO, fontSize: 20, color: C.faint, opacity: devP }}>
        ANDROID DEVICE / EMULATOR · debug build
      </div>

      <Box x={110} y={290} w={700} h={150} title="Claude Code (any MCP client)" sub="Asks questions, seeds data, runs QA flows in plain English" color={C.caramel} delay={6} />
      <Box x={190} y={540} w={620} h={150} title="cbl-mcp" sub="Node MCP server with 20 tools. Finds the app over adb and reads its token via run-as." color={C.cbl} delay={24} />
      <Box x={190} y={770} w={620} h={130} title="mobile-mcp  (optional)" sub="Taps, swipes and reads the UI like a user" color={C.mobile} delay={40} />

      <Box x={1050} y={290} w={360} h={170} title="Couchbase Lite" sub="The app's own live Database instance" color={C.text} delay={104} />
      <Box x={1450} y={290} w={360} h={170} title="App UI" sub="Live queries re-render the moment data changes" color={C.green} delay={120} />
      <Box x={1050} y={540} w={360} h={150} title="cbl-bridge" sub="debugImplementation · 127.0.0.1 · token" color={C.cbl} delay={84} />

      <Arrow pts={[[500, 440], [500, 540]]} label="MCP · stdio" lx={520} ly={474} delay={30} />
      <Arrow pts={[[150, 440], [150, 835], [190, 835]]} delay={46} color={C.mobile} />
      <Arrow pts={[[810, 615], [1050, 615]]} label="adb forward" lx={860} ly={574} delay={96} color={C.cbl} />
      <Arrow pts={[[1230, 540], [1230, 460]]} delay={112} />
      <Arrow pts={[[1410, 375], [1450, 375]]} delay={126} />
      <Arrow pts={[[810, 835], [1630, 835], [1630, 460]]} label="adb input · taps" lx={1100} ly={794} delay={136} color={C.mobile} />
      <div
        style={{
          position: "absolute",
          left: 1050,
          top: 862,
          width: 760,
          fontFamily: MONO,
          fontSize: 23,
          lineHeight: 1.45,
          color: C.dim,
          background: C.panel,
          borderRadius: 16,
          padding: "14px 22px",
          fontSize: 20,
          boxSizing: "border-box",
          opacity: interpolate(frame, [150, 170], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}
      >
        <span style={{ color: C.faint }}>// app/build.gradle.kts, the whole integration</span>
        <br />
        <span style={{ color: C.caramel }}>debugImplementation</span>(<span style={{ color: C.green }}>"…:cbl-bridge:0.1.0"</span>)
        <br />
        <span style={{ color: C.faint }}>// src/debug/…  (optional, reuse the app's instance)</span>
        <br />
        CblBridge.<span style={{ color: C.caramel }}>register</span>(database)
      </div>
    </AbsoluteFill>
  );
};
