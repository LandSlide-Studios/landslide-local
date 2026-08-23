/**
 * RuntimeSupervisor — starts the local model server and gets a model resident,
 * so using these models is one click rather than a checklist.
 *
 * Interface:
 *   status()        -> Promise<{ running, version, loaded[], canStart, bin }>
 *   start()         -> Promise<{ ok, version?, tookMs, error? }>
 *   warm(modelId)   -> Promise<{ ok, tookMs, error? }>
 *
 * Two things make this worth a module rather than a shell command:
 *
 * 1. It launches Ollama with the environment from config, so the model store is
 *    found regardless of what the shell or Explorer happened to inherit. That is
 *    the exact failure that made `ollama list` come back empty after the store
 *    moved to N:.
 * 2. "Started" means health-checked and answering, not "spawn() returned".
 *
 * The executable path comes from config or a known install location - never from
 * a request. The HTTP layer passes no parameters into this module except a model
 * id that must already exist in the catalog.
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 500;
const WARM_TIMEOUT_MS = 300_000;

const WINDOWS_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'),
  path.join(process.env.ProgramFiles ?? '', 'Ollama', 'ollama.exe'),
];
const POSIX_CANDIDATES = ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama'];

export function createRuntimeSupervisor(runtimeConfig = {}) {
  const base = (runtimeConfig.ollamaUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const configuredBin = runtimeConfig.ollamaBin || '';
  const extraEnv = runtimeConfig.ollamaEnv ?? {};
  let starting = null;

  async function findBin() {
    if (configuredBin) {
      return (await canExecute(configuredBin)) ? configuredBin : null;
    }
    const candidates = process.platform === 'win32' ? WINDOWS_CANDIDATES : POSIX_CANDIDATES;
    for (const c of candidates) {
      if (c && (await canExecute(c))) return c;
    }
    return null;
  }

  async function version() {
    try {
      const res = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      return (await res.json()).version ?? 'ok';
    } catch {
      return null;
    }
  }

  async function loadedModels() {
    try {
      const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return [];
      const body = await res.json();
      return (body.models ?? []).map((m) => ({
        name: m.name,
        sizeGb: Number((m.size / 1024 ** 3).toFixed(2)),
        expiresAt: m.expires_at ?? null,
      }));
    } catch {
      return [];
    }
  }

  return {
    async status() {
      const v = await version();
      const bin = await findBin();
      return {
        running: v !== null,
        version: v,
        loaded: v === null ? [] : await loadedModels(),
        canStart: bin !== null,
        bin,
        starting: starting !== null,
      };
    },

    /** Idempotent, and safe to call twice: concurrent callers share one attempt. */
    async start() {
      const already = await version();
      if (already) return { ok: true, version: already, tookMs: 0, alreadyRunning: true };
      if (starting) return starting;

      starting = (async () => {
        const began = Date.now();
        const bin = await findBin();
        if (!bin) {
          return {
            ok: false,
            tookMs: 0,
            error: 'Could not find the Ollama executable. Set runtime.ollamaBin in config.json.',
          };
        }

        try {
          const child = spawn(bin, ['serve'], {
            // Explicit env is the point: a stale environment block is why the
            // model store on another drive goes unseen.
            env: { ...process.env, ...extraEnv },
            detached: true,
            stdio: 'ignore',
            shell: false,
          });
          child.unref(); // outlive this server; the user's models should not die with it
          child.on('error', () => {});
        } catch (err) {
          return { ok: false, tookMs: Date.now() - began, error: String(err.message ?? err) };
        }

        const deadline = Date.now() + HEALTH_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await sleep(HEALTH_POLL_MS);
          const v = await version();
          if (v) return { ok: true, version: v, tookMs: Date.now() - began };
        }
        return {
          ok: false,
          tookMs: Date.now() - began,
          error: 'Ollama did not answer within 60 seconds of starting.',
        };
      })().finally(() => {
        starting = null;
      });

      return starting;
    },

    /**
     * Preload a model into VRAM. Without this the first message of a session
     * pays the whole load cost - about 20 seconds for a 9B off a SATA SSD.
     */
    async warm(modelId) {
      const began = Date.now();
      try {
        const res = await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: modelId, prompt: '', keep_alive: '30m' }),
          signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
        });
        if (!res.ok) {
          return { ok: false, tookMs: Date.now() - began, error: `runtime returned ${res.status}` };
        }
        const body = await res.json();
        return { ok: body.done === true, tookMs: Date.now() - began };
      } catch (err) {
        const msg = err?.name === 'TimeoutError' ? 'loading timed out' : String(err.message ?? err);
        return { ok: false, tookMs: Date.now() - began, error: msg };
      }
    },
  };
}

function canExecute(p) {
  return access(p, constants.X_OK).then(
    () => true,
    () => false,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
