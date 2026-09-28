import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function adbPath(): string {
  if (process.env.ADB) return process.env.ADB;
  for (const home of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (home) {
      const p = join(home, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
      if (existsSync(p)) return p;
    }
  }
  return "adb";
}

export class AdbError extends Error {}

export function adb(args: string[], serial?: string, timeoutMs = 15_000): Promise<string> {
  const full = serial ? ["-s", serial, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(adbPath(), full, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message).toString().trim();
        reject(new AdbError(`adb ${full.join(" ")} failed: ${msg}`));
      } else {
        resolve(stdout.toString());
      }
    });
  });
}

export interface Device {
  serial: string;
  state: string;
  model?: string;
}

export async function listDevices(): Promise<Device[]> {
  const out = await adb(["devices", "-l"]);
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const model = rest.find((r) => r.startsWith("model:"))?.slice(6);
      return { serial, state, model };
    });
}

/** Forwards a free local port to the device port and returns the local port. */
export async function forward(serial: string, devicePort: number): Promise<number> {
  const out = await adb(["forward", "tcp:0", `tcp:${devicePort}`], serial);
  const port = parseInt(out.trim(), 10);
  if (!Number.isFinite(port)) throw new AdbError(`Unexpected adb forward output: ${out}`);
  return port;
}

export async function removeForward(serial: string, localPort: number): Promise<void> {
  await adb(["forward", "--remove", `tcp:${localPort}`], serial).catch(() => undefined);
}

/** Reads a file from a debuggable app's private storage via run-as. */
export async function runAsCat(serial: string, pkg: string, path: string): Promise<string> {
  const out = await adb(["exec-out", "run-as", pkg, "cat", path], serial);
  if (/is not debuggable|Unknown package|No such file/.test(out)) throw new AdbError(out.trim());
  return out;
}

export async function launchApp(serial: string, pkg: string): Promise<void> {
  await adb(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], serial);
}
