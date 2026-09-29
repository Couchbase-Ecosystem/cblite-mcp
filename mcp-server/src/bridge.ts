import { forward, isInstalled, launchApp, listDevices, removeForward, runAsCat } from "./adb.js";

export const DEFAULT_DEVICE_PORT = 47111;
const PORT_RANGE = 10;

export interface BridgeHello {
  bridge: string;
  bridgeVersion: string;
  package: string;
  pid: number;
  port: number;
}

export interface FoundBridge extends BridgeHello {
  serial: string;
  model?: string;
}

interface Connection {
  serial: string;
  pkg: string;
  devicePort: number;
  localPort: number;
  token: string;
  pid: number;
}

export class BridgeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

async function httpJson(port: number, path: string, opts: { token?: string; body?: unknown; timeoutMs?: number } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  return { status: res.status, data };
}

/**
 * Talks to the cbl-bridge running inside an Android app. Handles discovery (which device / which app),
 * adb port forwarding, reading the auth token via run-as, and transparently reconnecting when the app
 * restarts (new pid, new token).
 */
export class BridgeClient {
  private conn?: Connection;
  /** Change-feed cursor so "what changed since I last looked?" works without the agent tracking seqs. */
  private cursor?: number;

  constructor(
    private readonly preferredSerial = process.env.ANDROID_SERIAL || undefined,
    private readonly preferredPackage = process.env.CBL_PACKAGE || undefined,
  ) {}

  get connection() {
    return this.conn ? { device: this.conn.serial, package: this.conn.pkg, devicePort: this.conn.devicePort, pid: this.conn.pid } : undefined;
  }

  /** Probes every attached device for bridges on ports 47111..47120. */
  /** Pass null to scan every device regardless of ANDROID_SERIAL. */
  async discover(serial?: string | null): Promise<FoundBridge[]> {
    const onlySerial = serial === undefined ? this.preferredSerial : (serial ?? undefined);
    const devices = (await listDevices()).filter((d) => d.state === "device" && (!onlySerial || d.serial === onlySerial));
    const probes = devices.flatMap((d) =>
      Array.from({ length: PORT_RANGE }, (_, i) => DEFAULT_DEVICE_PORT + i).map(async (p): Promise<FoundBridge | undefined> => {
        let local: number | undefined;
        try {
          local = await forward(d.serial, p);
          const { status, data } = await httpJson(local, "/hello", { timeoutMs: 1500 });
          if (status === 200 && data?.bridge === "cbl-mcp-bridge") return { ...data, serial: d.serial, model: d.model };
        } catch {
          // nothing listening on this port
        } finally {
          if (local) await removeForward(d.serial, local);
        }
        return undefined;
      }),
    );
    return (await Promise.all(probes)).filter((b): b is FoundBridge => b !== undefined);
  }

  async connect(opts: { device?: string; package?: string; launch?: boolean } = {}): Promise<Connection> {
    const wantSerial = opts.device ?? this.preferredSerial;
    const wantPkg = opts.package ?? this.preferredPackage;

    let bridges = await this.discover(wantSerial);
    let match = bridges.filter((b) => (!wantSerial || b.serial === wantSerial) && (!wantPkg || b.package === wantPkg));

    if (match.length === 0 && wantPkg && opts.launch !== false) {
      const devices = (await listDevices()).filter((d) => d.state === "device" && (!wantSerial || d.serial === wantSerial));
      if (devices.length === 1) {
        if (!(await isInstalled(devices[0].serial, wantPkg))) {
          throw new BridgeError(`Package ${wantPkg} is not installed on ${devices[0].serial}. Install a debug build that includes cbl-bridge first.`);
        }
        await launchApp(devices[0].serial, wantPkg);
        for (let i = 0; i < 20 && match.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 500));
          bridges = await this.discover(wantSerial);
          match = bridges.filter((b) => b.serial === devices[0].serial && b.package === wantPkg);
        }
      }
    }

    if (match.length === 0) {
      const seen = bridges.map((b) => `${b.package} on ${b.serial}`).join(", ") || "none";
      throw new BridgeError(
        `No running app with the Couchbase Lite bridge found${wantPkg ? ` for package ${wantPkg}` : ""}${wantSerial ? ` on ${wantSerial}` : ""}. ` +
          `Bridges seen: ${seen}. Make sure a debug build that includes cbl-bridge is installed and running.`,
      );
    }
    if (match.length > 1) {
      throw new BridgeError(
        `Several bridges found; pass device and/or package to cbl_connect: ${match.map((b) => `${b.package} on ${b.serial}`).join(", ")}`,
      );
    }

    const target = match[0];
    const raw = await runAsCat(target.serial, target.package, "files/.cbl-bridge/bridge.json");
    const info = JSON.parse(raw);
    if (this.conn) await removeForward(this.conn.serial, this.conn.localPort);
    const localPort = await forward(target.serial, info.port);
    this.conn = { serial: target.serial, pkg: target.package, devicePort: info.port, localPort, token: info.token, pid: info.pid };
    // Start the change cursor at "now" so the first cbl_changes call reports what happened after connecting.
    const head = await httpJson(localPort, "/changes?timeoutMs=0&limit=1", { token: info.token });
    this.cursor = head.status === 200 ? head.data.lastSeq : undefined;
    return this.conn;
  }

  async disconnect() {
    if (this.conn) await removeForward(this.conn.serial, this.conn.localPort);
    this.conn = undefined;
  }

  /** Calls a bridge endpoint, connecting (or reconnecting after an app restart) as needed. */
  async call(path: string, body?: unknown, timeoutMs?: number): Promise<any> {
    if (!this.conn) await this.connect();
    let attempt = 0;
    for (;;) {
      const conn = this.conn!;
      try {
        const { status, data } = await httpJson(conn.localPort, path, { token: conn.token, body, timeoutMs });
        if (status === 401 && attempt === 0) throw new Reconnect();
        if (status !== 200) throw new BridgeError(data?.error ?? `HTTP ${status}`, status);
        return data;
      } catch (e) {
        const retriable = e instanceof Reconnect || (e instanceof TypeError && attempt === 0); // fetch network errors are TypeErrors
        if (!retriable || attempt > 0) {
          if (e instanceof TypeError) {
            throw new BridgeError(`Lost connection to ${conn.pkg} on ${conn.serial}. Is the app still running? (${(e as any).cause?.code ?? e.message})`);
          }
          throw e;
        }
        attempt++;
        await this.connect({ device: conn.serial, package: conn.pkg });
      }
    }
  }

  /** Change feed with a server-side cursor: omit `since` to get everything since the previous call. */
  async changes(since: number | undefined, timeoutMs: number, limit: number) {
    if (since === undefined && this.cursor === undefined) {
      const first = await this.call(`/changes?timeoutMs=0&limit=1`);
      this.cursor = first.lastSeq;
    }
    const from = since ?? this.cursor!;
    const data = await this.call(`/changes?since=${from}&timeoutMs=${timeoutMs}&limit=${limit}`, undefined, timeoutMs + 15_000);
    this.cursor = data.lastSeq;
    return { since: from, ...data };
  }

}

class Reconnect extends Error {}
