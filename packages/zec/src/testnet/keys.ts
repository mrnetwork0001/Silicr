/**
 * Viewing-key export without a running wallet: runs `zec-sidecar export-ufvk --confirm` as a
 * one-shot process. Needs no light-wallet server and takes no wallet lock, so it works while a
 * daemon has the wallet open. The key is returned to the caller and nowhere else.
 */
import { execFile } from 'node:child_process';
import { assertExecutable, defaultSidecarPath } from './sidecar.ts';

export interface OfflineExportOptions {
  dataDir: string;
  /** The network the wallet was created on; the sidecar refuses a mismatch. */
  network: 'main' | 'test';
  /** zec-sidecar binary (default $SILICR_ZEC_SIDECAR, else the repo build). */
  sidecarPath?: string;
  timeoutMs?: number;
}

/**
 * The wallet's unified full viewing key (Orchard component only). It reveals every payment the
 * wallet ever sent or received, with amounts and memos, and links all of its addresses; it never
 * includes spending authority.
 */
export async function exportViewingKeyOffline(o: OfflineExportOptions): Promise<string> {
  const binary = o.sidecarPath ?? process.env['SILICR_ZEC_SIDECAR'] ?? defaultSidecarPath();
  assertExecutable(binary);
  const hrp = o.network === 'main' ? 'uview1' : 'uviewtest1';
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['export-ufvk', '--data-dir', o.dataDir, '--network', o.network, '--confirm'],
      { timeout: o.timeoutMs ?? 30_000, maxBuffer: 1 << 16 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr).trim().split('\n').filter((l) => !l.includes(' INFO ')).slice(-3).join('\n');
          reject(new Error(`zec-sidecar export-ufvk failed: ${detail || err.message}`));
          return;
        }
        const key = String(stdout).trim();
        if (!key.startsWith(hrp) || !/^[a-z0-9]+$/.test(key)) {
          reject(new Error(`zec-sidecar export-ufvk did not return a ${hrp}… viewing key`));
          return;
        }
        resolve(key);
      },
    );
  });
}
