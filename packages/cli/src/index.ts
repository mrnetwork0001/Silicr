// @silicr/cli: the `silicr` command (entry: src/main.ts). Exported for tests and embedding.
export { buildProgram } from './program.ts';
export { DaemonClient, ApiError, DEFAULT_URLS } from './client.ts';
export { follow, printBids } from './follow.ts';
export { repoRoot } from './config.ts';
