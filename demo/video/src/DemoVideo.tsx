import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import demo from "../public/demo.json";
import { Architecture } from "./Architecture";
import { Intro } from "./Intro";
import { Main } from "./Main";
import { Outro } from "./Outro";
import { ARCH, C, INTRO, OUTRO, SANS } from "./theme";

export const DemoVideo: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg, fontFamily: SANS, color: C.text, fontVariantLigatures: "none" }}>
    <Sequence durationInFrames={INTRO}>
      <Intro />
    </Sequence>
    <Sequence from={INTRO} durationInFrames={ARCH}>
      <Architecture />
    </Sequence>
    <Sequence from={INTRO + ARCH} durationInFrames={demo.durationInFrames}>
      <Main />
    </Sequence>
    <Sequence from={INTRO + ARCH + demo.durationInFrames} durationInFrames={OUTRO}>
      <Outro />
    </Sequence>
  </AbsoluteFill>
);
