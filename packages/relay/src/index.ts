/**
 * @silicr/relay: a dumb, ciphertext-only store-and-forward relay, plus the public
 * provider directory and an observer feed for the Leak Inspector.
 *
 * Contract (owned by the lead; flag changes in your report):
 *
 *   PUT  /m/:mailbox            body = opaque bytes (≤ 16 MiB) → { seq: number }
 *   GET  /m/:mailbox?after=N&wait=S
 *        → JSON { messages: { seq: number; size: number }[] }  (long-polls up to S seconds, max 30)
 *   GET  /m/:mailbox/:seq       → application/octet-stream (the exact bytes stored)
 *   GET  /directory             → JSON DirectoryEntry[] (latest per providerId; only signature-verified entries)
 *   POST /directory             body = JSON entry with string providerId and number updatedAt → 204
 *   GET  /_observer?after=ID    → RelayObserverResponse (only when observer: true)
 *   GET  /health                → { ok: true }
 *
 * Mailbox ids are 32 lowercase hex chars. Anything else → 400.
 * The relay never parses, decrypts or logs message contents.
 * Directory writes are verified (see below); the relay still holds no keys.
 *
 * Implementation notes (additive to the contract above):
 *   - PUT answers 201 { seq }. Seqs are 1-based, per mailbox, committed in order.
 *   - Status codes: 400 bad id/seq/query/entry, 404 unknown message or route,
 *     405 wrong method, 409 stale directory entry (older than, or conflicting with, the stored one),
 *     413 body too large, 507 mailbox full (10,000 messages) or relay storage full.
 *     Error bodies are { error: string, code: string }.
 *   - GET /m/:mailbox also takes &limit=L (default and max 1000 listed per call).
 *     An unknown mailbox lists as empty (no 404), so readers can poll before the first write.
 *   - A mailbox untouched (no append, listing or fetch) for ttlMs is deleted, and its
 *     seqs start again at 1 if it is reused.
 *   - POST /directory is authenticated: the entry must pass @silicr/protocol's
 *     verifyDirectoryEntry() (well-formed, signed by the key in its own providerId),
 *     else 400 code 'bad_signature'. updatedAt (Unix seconds) must be a non-negative safe
 *     integer at most 24 h in the future, and providerId 64 lowercase hex chars, else 400
 *     code 'bad_entry'. Body ≤ 16 KiB (413). Latest updatedAt wins; an older entry, or a
 *     different one with the same updatedAt, gets 409 'stale'; the identical entry again is
 *     a no-op 204. Entries are stored and served exactly as received. directory.json is
 *     re-checked on start and invalid rows are dropped. Rejections show up in the observer
 *     feed as 'directory-rejected' (providerId and reason only).
 *   - GET /_observer also takes &limit=L (default/max 5000). Ids are "relay-<n>"; after=
 *     takes either form. A cursor from before a relay restart returns everything retained.
 *   - CORS (http://localhost:7703, http://127.0.0.1:7703) on GET /_observer, /directory, /health.
 */

export interface RelayOptions {
  port: number;
  host?: string;
  /** Where mailboxes and the directory live, e.g. .silicr/relay */
  dataDir: string;
  /** Expose GET /_observer for the Leak Inspector (demo mode). */
  observer?: boolean;
  /** Drop mailboxes untouched for this long. Default 24 h. */
  ttlMs?: number;
  /** Request log sink (method, path, status, sizes, duration). Never receives bodies. Default: none. */
  log?: (line: string) => void;
  /** Override limits (mostly for tests). */
  limits?: Partial<RelayLimits>;
}

export interface RelayLimits {
  /** Max bytes per message. Default 16 MiB. */
  maxMessageBytes: number;
  /** Max messages per mailbox. Default 10,000. */
  maxMessagesPerMailbox: number;
  /** Max bytes across all mailboxes. Default 8 GiB. */
  maxTotalBytes: number;
  /** Max bytes per directory entry. Default 16 KiB. */
  maxDirectoryEntryBytes: number;
  /** Max providers in the directory. Default 10,000. */
  maxDirectoryEntries: number;
  /** Long-poll cap in seconds. Default 30. */
  maxWaitS: number;
  /** Max messages listed per GET /m/:mailbox. Default 1000. */
  maxListMessages: number;
  /** Observations kept in memory. Default 5000. */
  maxObservations: number;
}

export interface RunningRelay {
  url: string;
  close(): Promise<void>;
}

export interface RelayClient {
  readonly baseUrl: string;
  /** Append one message; returns its sequence number (1-based). */
  append(mailbox: string, data: Uint8Array): Promise<number>;
  /** Messages with seq > afterSeq, waiting up to waitS seconds for at least one. */
  read(mailbox: string, afterSeq: number, waitS?: number): Promise<{ seq: number; data: Uint8Array }[]>;
  listDirectory(): Promise<unknown[]>;
  publishDirectory(entry: unknown): Promise<void>;
}

export {
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_MAILBOX,
  MAX_DIRECTORY_ENTRY_BYTES,
  MAX_DIRECTORY_FUTURE_S,
  MAX_WAIT_S,
  DEFAULT_LIMITS,
} from './limits.ts';
export { startRelay } from './server.ts';
export { relayClient, RelayError } from './client.ts';
export type { RelayClientOptions } from './client.ts';
// SOCKS5 / Tor support for every outbound HTTP(S) connection (see proxy.ts). Additive.
export { parseProxyUrl, proxyFetch, socksConnect, isLoopbackHost, ProxyError } from './proxy.ts';
export type { ProxyConfig, ProxyErrorCode, ProxyFetchOptions, SocksConnectOptions } from './proxy.ts';
