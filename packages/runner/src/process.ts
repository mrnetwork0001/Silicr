/**
 * 'process' mode: the job runs as a plain child process of the provider.
 *
 * NOT A SANDBOX. The job runs with the provider user's permissions: it can read
 * the provider's files (wallets included), use the network and ignore CPU/memory
 * limits. Only the timeout is enforced. Dev and demo fallback only.
 */
import { spawn } from 'node:child_process';
import { constants as fsc } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { constants as osc } from 'node:os';
import { delimiter, join } from 'node:path';
import { LineSplitter } from './logs.ts';
import type { JobHandle } from './job.ts';

export const PROCESS_MODE_NOTICE =
  'process mode is NOT a sandbox: the job runs as a plain child process with your user account, ' +
  'can read your files (including wallets under .silicr/) and use the network, and only the timeout is enforced. ' +
  'Use it for development and demos only; run Docker for real jobs.';

export interface ProcessLaunch {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Track live process groups so they are killed if the provider exits. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pgid: number): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const g of liveGroups) signalGroup(g, 'SIGKILL');
    });
  }
  liveGroups.add(pgid);
}

export async function launchProcess(handle: JobHandle, launch: ProcessLaunch): Promise<void> {
  const [cmd0, ...args] = launch.command as [string, ...string[]];
  let exe = cmd0;
  if (!cmd0.includes('/')) {
    const found = await which(cmd0, launch.env.PATH ?? '');
    if (!found && cmd0 === 'python' && (await which('python3', launch.env.PATH ?? ''))) {
      exe = 'python3';
      handle.note(`'python' is not installed on this provider; running 'python3' instead`);
    }
  }

  const child = spawn(exe, args, {
    cwd: launch.cwd,
    env: launch.env,
    detached: true, // own process group, so pause/stop reach the whole job
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const out = new LineSplitter((l) => handle.line(l));
  const err = new LineSplitter((l) => handle.line(l));
  child.stdout.on('data', (c: Buffer) => out.write(c));
  child.stderr.on('data', (c: Buffer) => err.write(c));

  let exitCode: number | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const pgid = child.pid;
  if (pgid !== undefined) trackGroup(pgid);

  child.on('error', (e: NodeJS.ErrnoException) => {
    if (child.pid !== undefined) return; // a later signal error; exit/close still follow
    handle.note(`could not start ${JSON.stringify(cmd0)}: ${e.code ?? e.message}`);
    out.end();
    err.end();
    handle.finish(e.code === 'ENOENT' ? 127 : 126);
  });
  child.on('exit', (code, signal) => {
    exitCode = code ?? 128 + (signal ? (osc.signals[signal] ?? 0) : 0);
    if (killTimer) clearTimeout(killTimer);
    // The job is over when its main process exits: reap anything it left behind.
    if (pgid !== undefined) signalGroup(pgid, 'SIGKILL');
    // If a stray grandchild still holds the pipes, stop waiting for them.
    setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, 2000).unref();
  });
  child.on('close', (code, signal) => {
    if (pgid !== undefined) liveGroups.delete(pgid);
    out.end();
    err.end();
    handle.finish(exitCode ?? code ?? 128 + (signal ? (osc.signals[signal] ?? 0) : 0));
  });

  handle.attach({
    async pause() {
      if (pgid !== undefined) signalGroup(pgid, 'SIGSTOP');
    },
    async resume() {
      if (pgid !== undefined) signalGroup(pgid, 'SIGCONT');
    },
    async terminate(graceMs) {
      if (pgid === undefined) return;
      signalGroup(pgid, 'SIGTERM');
      signalGroup(pgid, 'SIGCONT'); // a stopped process only sees SIGTERM once continued
      killTimer = setTimeout(() => signalGroup(pgid, 'SIGKILL'), graceMs);
      killTimer.unref();
    },
  });
}

export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM') {
      // macOS can refuse group signals while a member is a zombie; fall back to the leader.
      try {
        process.kill(pgid, signal);
      } catch {
        // gone
      }
    } else if (code !== 'ESRCH') {
      throw e;
    }
  }
}

async function which(cmd: string, path: string): Promise<string | null> {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      const st = await stat(candidate);
      if (!st.isFile()) continue;
      await access(candidate, fsc.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}
