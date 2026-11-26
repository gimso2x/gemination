import { saveConfig } from "./config.ts";
import type { GeminationHttpServerHandle } from "./http-server.ts";
import { openInBrowser } from "./setup-wizard.ts";
import {
  extractTailscaleEnableUrl,
  probePublicEndpoint,
  startCloudflaredQuickTunnel,
  startTailscaleFunnel,
  type PublicProbeResult,
  type TunnelHandle,
} from "./tunnel.ts";
import { normalizeCustomPublicUrl } from "./tunnel-selector.ts";
import type { GeminationConfig, TailscaleFunnelPort, TunnelMode } from "./types.ts";

export type TunnelConnectionState = "idle" | "starting" | "connected" | "error";

export interface TunnelControllerSnapshot {
  state: TunnelConnectionState;
  mode: TunnelMode;
  publicUrl?: string;
  error?: string;
  tailscaleEnableUrl?: string;
  probeStatus?: PublicProbeResult;
}

export interface StartManagedTunnelParams {
  mode: TunnelMode;
  publicUrl?: string;
  httpsPort?: TailscaleFunnelPort;
  skipProbe?: boolean;
  persist?: boolean;
  openEnableUrl?: boolean;
  skipPinRotate?: boolean;
}

export class TunnelController {
  private activeHandle: TunnelHandle | null = null;
  private activeAbortController: AbortController | null = null;
  private transition: Promise<TunnelControllerSnapshot> = Promise.resolve({
    state: "idle",
    mode: "none",
  });
  private epoch = 0;
  private snapshot: TunnelControllerSnapshot;

  constructor(
    private readonly options: {
      config: GeminationConfig;
      configDir: string;
      serverHandle: GeminationHttpServerHandle;
      onPersistConfig?: () => void;
      onStateChange?: (snap: TunnelControllerSnapshot) => void;
    },
  ) {
    this.snapshot = {
      state: "idle",
      mode: options.config.tunnelMode ?? (options.config.publicUrl ? "custom" : "none"),
      publicUrl: options.config.publicUrl,
    };
  }

  private persistConfig(): void {
    if (this.options.onPersistConfig) {
      this.options.onPersistConfig();
    } else {
      saveConfig(this.options.config, this.options.configDir);
    }
  }

  getSnapshot(): TunnelControllerSnapshot {
    return { ...this.snapshot };
  }

  private publish(next: TunnelControllerSnapshot): void {
    this.snapshot = next;
    this.options.serverHandle.setRuntimeMeta({
      tunnelMode: next.mode,
      probeStatus: next.probeStatus,
    });
    this.options.onStateChange?.({ ...next });
  }

  private async stopActiveHandleOnly(): Promise<void> {
    const handle = this.activeHandle;
    this.activeHandle = null;
    if (handle) {
      await handle.stop().catch(() => {});
    }
  }

  async start(params: StartManagedTunnelParams): Promise<TunnelControllerSnapshot> {
    const myEpoch = ++this.epoch;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    const run = this.transition.then(() => this.performStart(params, myEpoch));
    this.transition = run.catch(() => this.getSnapshot());
    return run;
  }

  async stop(): Promise<TunnelControllerSnapshot> {
    const myEpoch = ++this.epoch;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    // Immediately tear down any active handle even if an earlier transition is shutting down.
    await this.stopActiveHandleOnly();
    const run = this.transition.then(async () => {
      if (myEpoch !== this.epoch) return this.getSnapshot();
      await this.stopActiveHandleOnly();
      this.options.serverHandle.setPublicBaseUrl(this.options.serverHandle.localBaseUrl);
      const next: TunnelControllerSnapshot = {
        state: "idle",
        mode: "none",
      };
      this.publish(next);
      return next;
    });
    this.transition = run.catch(() => this.getSnapshot());
    return run;
  }

  private async performStart(
    params: StartManagedTunnelParams,
    myEpoch: number,
  ): Promise<TunnelControllerSnapshot> {
    if (myEpoch !== this.epoch) {
      return this.getSnapshot();
    }
    await this.stopActiveHandleOnly();

    const mode = params.mode;
    const httpsPort: TailscaleFunnelPort =
      params.httpsPort ?? this.options.config.tailscaleFunnelPort ?? 443;

    this.publish({
      state: "starting",
      mode,
    });

    const abortController = new AbortController();
    this.activeAbortController = abortController;
    const isCancelled = (): boolean => myEpoch !== this.epoch || abortController.signal.aborted;

    try {
      if (mode === "none") {
        if (isCancelled()) return this.getSnapshot();
        this.options.serverHandle.setPublicBaseUrl(this.options.serverHandle.localBaseUrl);
        if (params.persist !== false) {
          this.options.config.tunnelMode = "none";
          this.options.config.publicUrl = undefined;
          this.persistConfig();
        }
        const snap: TunnelControllerSnapshot = {
          state: "connected",
          mode: "none",
        };
        this.publish(snap);
        return snap;
      }

      if (mode === "custom") {
        const rawUrl = params.publicUrl ?? this.options.config.publicUrl ?? "";
        const norm = normalizeCustomPublicUrl(rawUrl);
        if (!norm.ok) {
          throw new Error(norm.error);
        }
        if (isCancelled()) return this.getSnapshot();
        this.options.serverHandle.setPublicBaseUrl(norm.url);
        if (params.persist !== false) {
          this.options.config.tunnelMode = "custom";
          this.options.config.publicUrl = norm.url;
          this.persistConfig();
        }
        const probeStatus = params.skipProbe ? undefined : await probePublicEndpoint(norm.url);
        if (isCancelled()) return this.getSnapshot();
        const snap: TunnelControllerSnapshot = {
          state: "connected",
          mode: "custom",
          publicUrl: norm.url,
          probeStatus,
        };
        this.publish(snap);
        return snap;
      }

      if (mode === "quick") {
        const handle = await startCloudflaredQuickTunnel(this.options.serverHandle.localBaseUrl, {
          signal: abortController.signal,
        });
        if (isCancelled()) {
          await handle.stop().catch(() => {});
          return this.getSnapshot();
        }
        this.activeHandle = handle;
        this.options.serverHandle.setPublicBaseUrl(handle.publicUrl);
        if (!params.skipPinRotate && !process.env.GEMINATION_PIN) {
          this.options.serverHandle.rotatePin();
        }
        if (params.persist !== false) {
          this.options.config.tunnelMode = "quick";
          this.options.config.publicUrl = undefined;
          this.persistConfig();
        }
        const probeStatus = params.skipProbe ? undefined : await probePublicEndpoint(handle.publicUrl);
        if (isCancelled()) {
          await this.stopActiveHandleOnly();
          return this.getSnapshot();
        }
        const snap: TunnelControllerSnapshot = {
          state: "connected",
          mode: "quick",
          publicUrl: handle.publicUrl,
          probeStatus,
        };
        this.publish(snap);
        return snap;
      }

      // Tailscale Funnel
      const handle = await startTailscaleFunnel(this.options.serverHandle.localBaseUrl, {
        httpsPort,
        signal: abortController.signal,
        onNotice: (message) => {
          if (isCancelled()) return;
          console.log("");
          console.log(message);
          const enableUrl = extractTailscaleEnableUrl(message);
          if (enableUrl) {
            this.publish({
              ...this.snapshot,
              state: "starting",
              mode: "tailscale",
              tailscaleEnableUrl: enableUrl,
            });
            if (params.openEnableUrl) {
              openInBrowser(enableUrl);
            }
          }
        },
      });
      if (isCancelled()) {
        await handle.stop().catch(() => {});
        return this.getSnapshot();
      }
      this.activeHandle = handle;
      this.options.serverHandle.setPublicBaseUrl(handle.publicUrl);
      if (params.persist !== false) {
        this.options.config.tunnelMode = "tailscale";
        this.options.config.tailscaleFunnelPort = httpsPort;
        this.options.config.publicUrl = undefined;
        this.persistConfig();
      }
      const probeStatus = params.skipProbe ? undefined : await probePublicEndpoint(handle.publicUrl);
      if (isCancelled()) {
        await this.stopActiveHandleOnly();
        return this.getSnapshot();
      }
      const snap: TunnelControllerSnapshot = {
        state: "connected",
        mode: "tailscale",
        publicUrl: handle.publicUrl,
        probeStatus,
      };
      this.publish(snap);
      return snap;
    } catch (err) {
      if (isCancelled()) {
        return this.getSnapshot();
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.options.serverHandle.setPublicBaseUrl(this.options.serverHandle.localBaseUrl);
      const errSnap: TunnelControllerSnapshot = {
        state: "error",
        mode,
        error: msg,
        tailscaleEnableUrl: this.snapshot.tailscaleEnableUrl,
      };
      this.publish(errSnap);
      throw err;
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }
}
