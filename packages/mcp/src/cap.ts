// The per-session spending cap: the most an agent may commit through this server.
//
// Every request made through the server reserves its worst case (hours × max price per hour) when it
// is created, or intervals × bid price when a bid is accepted on a request made elsewhere. Once the
// daemon reports the request finished, the reservation shrinks to what was actually paid (plus fees).

export interface CapRequestState {
  state: string;
  spentZats: string;
  feesZats: string;
}

export interface CapUsage {
  maxZats: bigint;
  /** Worst case still committed: live reservations plus what finished requests actually cost. */
  committedZats: bigint;
  /** Actually paid so far (payments plus fees) across this session's requests. */
  spentZats: bigint;
  remainingZats: bigint;
  requests: number;
}

const TERMINAL = new Set(['closed', 'expired', 'failed']);

export class SpendingCap {
  readonly maxZats: bigint;
  private readonly reservations = new Map<string, bigint>();

  constructor(maxZats: bigint) {
    if (maxZats < 0n) throw new Error('the spending cap cannot be negative');
    this.maxZats = maxZats;
  }

  get rfqIds(): string[] {
    return [...this.reservations.keys()];
  }

  isReserved(rfqId: string): boolean {
    return this.reservations.has(rfqId.toLowerCase());
  }

  reserve(rfqId: string, zats: bigint): void {
    this.reservations.set(rfqId.toLowerCase(), zats < 0n ? 0n : zats);
  }

  usage(lookup: (rfqId: string) => CapRequestState | undefined): CapUsage {
    let committed = 0n;
    let spent = 0n;
    for (const [id, reserved] of this.reservations) {
      const r = lookup(id);
      if (!r) {
        committed += reserved;
        continue;
      }
      const paid = toZats(r.spentZats) + toZats(r.feesZats);
      spent += paid;
      committed += TERMINAL.has(r.state) ? paid : paid > reserved ? paid : reserved;
    }
    const remaining = this.maxZats - committed;
    return { maxZats: this.maxZats, committedZats: committed, spentZats: spent, remainingZats: remaining > 0n ? remaining : 0n, requests: this.reservations.size };
  }

  remaining(lookup: (rfqId: string) => CapRequestState | undefined): bigint {
    return this.usage(lookup).remainingZats;
  }
}

function toZats(s: string | undefined): bigint {
  return typeof s === 'string' && /^\d{1,20}$/.test(s) ? BigInt(s) : 0n;
}
