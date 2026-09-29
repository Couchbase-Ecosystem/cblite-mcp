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
  const out = await adb(["forward", "tcp:0", `tcp:${devicePort}`], serial, 5_000);
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

/** true / false, or undefined when adb itself failed (e.g. a slow device) and we genuinely don't know. */
export async function isInstalled(serial: string, pkg: string): Promise<boolean | undefined> {
  try {
    // `pm list packages` exits 0 either way (unlike `pm path`), so an adb failure stays distinguishable.
    const out = await adb(["shell", "pm", "list", "packages", pkg], serial, 4_000);
    return out.split("\n").some((l) => l.trim() === `package:${pkg}`);
  } catch {
    return undefined;
  }
}

export async function pidOf(serial: string, pkg: string): Promise<string | undefined> {
  const out = await adb(["shell", "pidof", pkg], serial, 4_000).catch(() => "");
  return out.trim() || undefined;
}

export async function dozeState(serial: string): Promise<string | undefined> {
  const out = await adb(["shell", "dumpsys", "deviceidle", "get", "deep"], serial, 4_000).catch(() => "");
  return out.trim() || undefined;
}

/** Starts the app, or brings a running instance to the foreground without restarting it. */
export async function launchApp(serial: string, pkg: string): Promise<void> {
  const resolved = await adb(["shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", pkg], serial, 4_000).catch(() => "");
  const component = resolved.trim().split("\n").pop()?.trim();
  if (component && component.includes("/")) {
    await adb(["shell", "am", "start", "-n", component], serial, 5_000);
  } else {
    await adb(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], serial, 5_000);
  }
}
