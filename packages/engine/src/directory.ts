// Directory client: read provider entries from the relay, check them, drop the bad ones.
import type { DirectoryEntry } from '@silicr/protocol';
import type { ProviderDto } from '@silicr/api';
import type { RelayClient } from '@silicr/relay';
import type { Network } from '@silicr/zec';
import type { EngineDeps } from './deps.ts';

/** An entry whose signature verified and whose address passed the Orchard-only guard. */
export interface VerifiedProvider {
  entry: DirectoryEntry;
  providerId: string;
  alias: string;
  /** Orchard-only form of entry.address. */
  address: string;
  minPricePerHourZats: bigint;
  bondZats?: bigint;
}

export interface DirectoryListing {
  verified: VerifiedProvider[];
  /** Every well-formed entry, for display; `verified: false` ones are never used. */
  all: ProviderDto[];
  rejected: { providerId: string; reason: string }[];
}

function isWellFormed(e: unknown): e is DirectoryEntry {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.providerId === 'string' &&
    /^[0-9a-f]{64}$/.test(o.providerId) &&
    typeof o.alias === 'string' &&
    o.alias.length <= 64 &&
    typeof o.address === 'string' &&
    o.address.length <= 1024 &&
    Array.isArray(o.gpus) &&
    o.gpus.every(
      (g) =>
        g &&
        typeof g === 'object' &&
        typeof (g as Record<string, unknown>).model === 'string' &&
        Number.isInteger((g as Record<string, unknown>).count) &&
        typeof (g as Record<string, unknown>).vramGb === 'number',
    ) &&
    typeof o.minPricePerHourZats === 'string' &&
    /^\d{1,20}$/.test(o.minPricePerHourZats) &&
    (o.bondZats === undefined || (typeof o.bondZats === 'string' && /^\d{1,20}$/.test(o.bondZats))) &&
    (o.region === undefined || typeof o.region === 'string') &&
    typeof o.updatedAt === 'number' &&
    typeof o.sig === 'string'
  );
}

export class DirectoryClient {
  private readonly relay: RelayClient;
  private readonly network: Network;
  private readonly deps: EngineDeps;
  private cache: { at: number; listing: DirectoryListing } | null = null;
  private readonly cacheMs: number;

  constructor(relay: RelayClient, network: Network, deps: EngineDeps, cacheMs = 1000) {
    this.relay = relay;
    this.network = network;
    this.deps = deps;
    this.cacheMs = cacheMs;
  }

  invalidate(): void {
    this.cache = null;
  }

  async list(): Promise<DirectoryListing> {
    if (this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.listing;
    const raw = await this.relay.listDirectory();
    const listing: DirectoryListing = { verified: [], all: [], rejected: [] };
    for (const e of Array.isArray(raw) ? raw : []) {
      if (!isWellFormed(e)) {
        const id = e && typeof e === 'object' && typeof (e as { providerId?: unknown }).providerId === 'string' ? (e as { providerId: string }).providerId : '?';
        listing.rejected.push({ providerId: id, reason: 'malformed entry' });
        continue;
      }
      let ok = false;
      let reason = '';
      let address = e.address;
      try {
        ok = this.deps.protocol.verifyDirectoryEntry(e);
        if (!ok) reason = 'bad signature';
      } catch {
        reason = 'bad signature';
      }
      if (ok) {
        try {
          address = this.deps.toOrchardOnly(e.address, this.network);
        } catch (err) {
          ok = false;
          reason = `address refused: ${(err as Error).message}`;
        }
      }
      const dto: ProviderDto = {
        providerId: e.providerId,
        alias: e.alias,
        address,
        gpus: e.gpus.map((g) => ({ model: g.model, count: g.count, vramGb: g.vramGb })),
        minPricePerHourZats: e.minPricePerHourZats,
        updatedAt: e.updatedAt * 1000,
        verified: ok,
      };
      if (e.bondZats !== undefined) dto.bondZats = e.bondZats;
      if (e.region !== undefined) dto.region = e.region;
      listing.all.push(dto);
      if (!ok) {
        listing.rejected.push({ providerId: e.providerId, reason });
        continue;
      }
      const v: VerifiedProvider = {
        entry: e,
        providerId: e.providerId,
        alias: e.alias,
        address,
        minPricePerHourZats: BigInt(e.minPricePerHourZats),
      };
      if (e.bondZats !== undefined) v.bondZats = BigInt(e.bondZats);
      listing.verified.push(v);
    }
    this.cache = { at: Date.now(), listing };
    return listing;
  }

  async get(providerId: string): Promise<VerifiedProvider | undefined> {
    return (await this.list()).verified.find((p) => p.providerId === providerId);
  }
}

/** Providers whose GPUs match: same model, enough of them, minimum price within the buyer's max. */
export function matchProviders(providers: VerifiedProvider[], req: { gpu: string; count: number; maxPricePerHourZats: bigint }): VerifiedProvider[] {
  return providers
    .filter((p) => p.entry.gpus.some((g) => g.model.toLowerCase() === req.gpu.toLowerCase() && g.count >= req.count))
    .filter((p) => p.minPricePerHourZats <= req.maxPricePerHourZats)
    .sort((a, b) => (a.minPricePerHourZats < b.minPricePerHourZats ? -1 : a.minPricePerHourZats > b.minPricePerHourZats ? 1 : 0));
}
