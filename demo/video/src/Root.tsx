import React from "react";
import { Composition, registerRoot } from "remotion";
import demo from "../public/demo.json";
import { DemoVideo } from "./DemoVideo";
import { ARCH, FPS, INTRO, OUTRO } from "./theme";

const Root: React.FC = () => (
  <Composition
    id="DemoVideo"
    component={DemoVideo}
    durationInFrames={INTRO + ARCH + demo.durationInFrames + OUTRO}
    fps={FPS}
    width={1920}
    height={1080}
  />
);

registerRoot(Root);
