import type { RelayLimits } from './index.ts';

/** Largest message the relay accepts (bytes). Split bigger blobs across several messages. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Most messages one mailbox can hold. */
export const MAX_MESSAGES_PER_MAILBOX = 10_000;
/** Largest directory entry (bytes of JSON). */
export const MAX_DIRECTORY_ENTRY_BYTES = 16 * 1024;
/** Longest long-poll (seconds). */
export const MAX_WAIT_S = 30;
/** How far in the future a directory entry's updatedAt (Unix seconds) may be. */
export const MAX_DIRECTORY_FUTURE_S = 24 * 60 * 60;

export const DEFAULT_LIMITS: RelayLimits = {
  maxMessageBytes: MAX_MESSAGE_BYTES,
  maxMessagesPerMailbox: MAX_MESSAGES_PER_MAILBOX,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxDirectoryEntryBytes: MAX_DIRECTORY_ENTRY_BYTES,
  maxDirectoryEntries: 10_000,
  maxWaitS: MAX_WAIT_S,
  maxListMessages: 1000,
  maxObservations: 5000,
};
