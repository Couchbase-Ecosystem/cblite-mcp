import React, { useLayoutEffect, useRef, useState } from "react";
import { AbsoluteFill, interpolate, OffthreadVideo, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import demo from "../public/demo.json";
import { C, MONO } from "./theme";

type Ev = {
  frame: number;
  step: number;
  kind: "prompt" | "text" | "tool_use" | "tool_result";
  text?: string;
  title?: string;
  server?: string;
  tool?: string;
  args?: string;
  isError?: boolean;
};

const EVENTS = demo.events as Ev[];
const STEPS = demo.steps as { title: string; prompt: string }[];
const SPEED = demo.speedSpans as { from: number; to: number; speed: number }[];

const TERM = { x: 60, y: 130, w: 1170, h: 900 };
const PHONE = { h: 830 };
const PHONE_W = Math.round((486 / 1080) * PHONE.h);

/** Renders `inline code` and **bold** from the agent's markdown-ish replies. */
const Rich: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") ? (
          <span key={i} style={{ fontFamily: MONO, fontSize: "0.86em", color: C.caramel, background: "#2A201A", padding: "1px 6px", borderRadius: 6 }}>
            {p.slice(1, -1)}
          </span>
        ) : p.startsWith("**") ? (
          <b key={i}>{p.slice(2, -2)}</b>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
};

const Appear: React.FC<{ at: number; children: React.ReactNode }> = ({ at, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 200 }, durationInFrames: 10 });
  return <div style={{ opacity: s, transform: `translateY(${(1 - s) * 10}px)` }}>{children}</div>;
};

const ServerPill: React.FC<{ server: string }> = ({ server }) => {
  const color = server === "cbl" ? C.cbl : server === "mobile" ? C.mobile : C.dim;
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: 17,
        fontWeight: 700,
        color,
        border: `1.5px solid ${color}`,
        borderRadius: 6,
        padding: "1px 8px",
        marginRight: 10,
        textTransform: "uppercase",
        letterSpacing: 1,
      }}
    >
      {server}
    </span>
  );
};

const Item: React.FC<{ ev: Ev; pending: boolean }> = ({ ev, pending }) => {
  const frame = useCurrentFrame();
  if (ev.kind === "prompt") {
    const chars = Math.floor(interpolate(frame - ev.frame, [0, 24], [0, ev.text!.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
    return (
      <div style={{ background: C.panel2, borderLeft: `4px solid ${C.caramel}`, borderRadius: 10, padding: "16px 20px", fontSize: 27, lineHeight: 1.4, marginBottom: 20 }}>
        <span style={{ color: C.caramel, fontFamily: MONO, marginRight: 12 }}>›</span>
        {ev.text!.slice(0, chars)}
        {chars < ev.text!.length && <span style={{ color: C.caramel }}>▍</span>}
      </div>
    );
  }
  if (ev.kind === "tool_use") {
    const blink = pending ? 0.35 + 0.65 * Math.abs(Math.sin(frame / 5)) : 1;
    return (
      <div style={{ display: "flex", alignItems: "flex-start", marginTop: 14 }}>
        <span style={{ color: ev.server === "mobile" ? C.mobile : C.green, opacity: blink, marginRight: 12, fontSize: 22, lineHeight: "32px" }}>⏺</span>
        <div style={{ fontFamily: MONO, fontSize: 21, lineHeight: "32px", color: C.text, overflow: "hidden", maxHeight: 64 }}>
          <ServerPill server={ev.server!} />
          <b>{ev.tool}</b>
          <span style={{ color: C.dim }}>({ev.args})</span>
        </div>
      </div>
    );
  }
  if (ev.kind === "tool_result") {
    return (
      <div style={{ display: "flex", fontFamily: MONO, fontSize: 19, lineHeight: "28px", color: ev.isError ? C.red : C.dim, marginLeft: 34, marginTop: 2 }}>
        <span style={{ color: C.faint, marginRight: 10 }}>⎿</span>
        <span style={{ overflow: "hidden", maxHeight: 56 }}>{ev.text}</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", marginTop: 18, fontSize: 25, lineHeight: 1.45, color: C.text }}>
      <span style={{ color: C.text, marginRight: 14 }}>●</span>
      <div>
        <Rich text={ev.text!} />
      </div>
    </div>
  );
};

const Terminal: React.FC = () => {
  const frame = useCurrentFrame();
  const current = [...EVENTS].reverse().find((e) => e.kind === "prompt" && e.frame <= frame);
  const step = current?.step ?? 0;
  const visible = EVENTS.filter((e) => e.step === step && e.frame <= frame);
  const lastVisible = visible[visible.length - 1];
  const openTools = visible.filter((e) => e.kind === "tool_use").length - visible.filter((e) => e.kind === "tool_result").length;
  const finished = lastVisible?.kind === "text" && !EVENTS.some((e) => e.step === step && e.frame > frame && e.kind !== "prompt");

  const inner = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    const h = inner.current?.scrollHeight ?? 0;
    setOffset(Math.min(0, TERM.h - 90 - h));
  });

  // index of tool_use events still waiting for results (results arrive in order in practice)
  const uses = visible.filter((e) => e.kind === "tool_use");
  const results = visible.filter((e) => e.kind === "tool_result").length;

  return (
    <div
      style={{
        position: "absolute",
        left: TERM.x,
        top: TERM.y,
        width: TERM.w,
        height: TERM.h,
        background: C.panel,
        border: `1.5px solid ${C.line}`,
        borderRadius: 18,
        overflow: "hidden",
        boxShadow: "0 30px 80px rgba(0,0,0,.45)",
      }}
    >
      <div style={{ height: 46, display: "flex", alignItems: "center", padding: "0 18px", borderBottom: `1px solid ${C.line}`, background: "#120F0D" }}>
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
          <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c, marginRight: 8 }} />
        ))}
        <div style={{ flex: 1, textAlign: "center", fontFamily: MONO, fontSize: 17, color: C.faint, marginRight: 60 }}>
          claude · MCP servers: cbl, mobile · model {demo.model}
        </div>
      </div>
      <div style={{ position: "absolute", top: 66, left: 30, right: 30, bottom: 20, overflow: "hidden" }}>
        <div ref={inner} style={{ transform: `translateY(${offset}px)` }}>
          {visible.map((e, i) => {
            const useIdx = uses.indexOf(e);
            return (
              <Appear key={`${e.step}-${i}`} at={e.frame}>
                <Item ev={e} pending={e.kind === "tool_use" && useIdx >= results} />
              </Appear>
            );
          })}
          {!finished && openTools <= 0 && lastVisible && lastVisible.kind !== "text" && (
            <div style={{ marginTop: 18, fontFamily: MONO, fontSize: 21, color: C.caramel, opacity: 0.55 + 0.45 * Math.abs(Math.sin(frame / 8)) }}>
              ✻ Thinking…
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const Toasts: React.FC = () => {
  const frame = useCurrentFrame();
  const toasts: { at: number; text: string; color: string }[] = [];
  for (let i = 0; i < EVENTS.length; i++) {
    const e = EVENTS[i];
    if (e.kind !== "tool_result" || e.isError) continue;
    const use = [...EVENTS.slice(0, i)].reverse().find((u) => u.kind === "tool_use");
    if (use?.tool === "cbl_batch" || use?.tool === "cbl_put_document") {
      toasts.push({ at: e.frame, text: "⚡ Written via the app's live Database · UI updated", color: C.cbl });
    } else if (use?.tool === "cbl_changes" && e.text?.startsWith("app changed")) {
      toasts.push({ at: e.frame, text: "↩ The app itself wrote this change (source: app)", color: C.green });
    } else if (use?.tool === "mobile_click_on_screen_at_coordinates") {
      toasts.push({ at: e.frame - 60, text: "👆 mobile-mcp taps “Start” like a barista", color: C.mobile });
    }
  }
  const active = toasts.filter((t) => frame >= t.at && frame < t.at + 75);
  return (
    <>
      {active.slice(-1).map((t) => {
        const p = interpolate(frame - t.at, [0, 8, 62, 75], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <div
            key={t.at}
            style={{
              position: "absolute",
              left: TERM.x + TERM.w + (1920 - TERM.x - TERM.w) / 2,
              top: 984,
              opacity: p,
              transform: `translate(-50%, ${(1 - p) * 14}px)`,
              background: C.panel,
              border: `2px solid ${t.color}`,
              borderRadius: 14,
              padding: "12px 16px",
              fontSize: 20,
              whiteSpace: "nowrap",
              fontWeight: 600,
              color: C.text,
              textAlign: "center",
              boxShadow: "0 16px 40px rgba(0,0,0,.5)",
            }}
          >
            {t.text}
          </div>
        );
      })}
    </>
  );
};

const Phone: React.FC = () => (
  <div
    style={{
      position: "absolute",
      left: TERM.x + TERM.w + (1920 - TERM.x - TERM.w - PHONE_W - 28) / 2,
      top: 112,
      padding: 14,
      borderRadius: 54,
      background: "#050505",
      border: "2px solid #3A332E",
      boxShadow: "0 40px 90px rgba(0,0,0,.6)",
    }}
  >
    <div style={{ width: PHONE_W, height: PHONE.h, borderRadius: 40, overflow: "hidden" }}>
      <OffthreadVideo src={staticFile("phone.mp4")} style={{ width: PHONE_W, height: PHONE.h }} muted />
    </div>
  </div>
);

const TopBar: React.FC = () => {
  const frame = useCurrentFrame();
  const current = [...EVENTS].reverse().find((e) => e.kind === "prompt" && e.frame <= frame) ?? EVENTS[0];
  const step = current.step;
  const speed = SPEED.find((s) => frame >= s.from && frame < s.to);
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - current.frame, fps, config: { damping: 200 } });
  return (
    <div style={{ position: "absolute", left: 60, top: 34, right: 60, height: 70, display: "flex", alignItems: "center" }}>
      <div style={{ fontFamily: MONO, fontSize: 22, color: C.caramel, border: `1.5px solid ${C.caramel}`, borderRadius: 8, padding: "6px 14px", marginRight: 22 }}>
        STEP {step + 1} / {STEPS.length}
      </div>
      <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: -0.5, opacity: s, transform: `translateX(${(1 - s) * 20}px)` }}>{STEPS[step].title}</div>
      <div style={{ flex: 1 }} />
      <div
        style={{
          fontFamily: MONO,
          fontSize: 22,
          color: C.bg,
          background: C.caramel,
          borderRadius: 8,
          padding: "6px 14px",
          opacity: speed ? 1 : 0,
          marginRight: 520,
        }}
      >
        {speed?.speed === 0 ? "PAUSED · READING TIME" : `${speed?.speed ?? 4}× SPEED`}
      </div>
    </div>
  );
};

export const Main: React.FC = () => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <TopBar />
      <Terminal />
      <Phone />
      <Toasts />
    </AbsoluteFill>
  );
};
