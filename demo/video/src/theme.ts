import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

export const { fontFamily: SANS } = loadInter("normal", { weights: ["400", "500", "600", "700", "800"], subsets: ["latin"] });
export const { fontFamily: MONO } = loadMono("normal", { weights: ["400", "500", "700"], subsets: ["latin"] });

export const C = {
  bg: "#0D0B0A",
  panel: "#16120F",
  panel2: "#1E1814",
  line: "#2E2520",
  text: "#F4EDE6",
  dim: "#A8988B",
  faint: "#6E6058",
  caramel: "#E8A15C",
  cbl: "#EF5B4F",
  mobile: "#6FB7FF",
  green: "#7DDC8C",
  red: "#FF6B6B",
};

export const FPS = 30;
export const INTRO = 165;
export const ARCH = 270;
export const OUTRO = 300;
