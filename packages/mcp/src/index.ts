// @silicr/mcp: an MCP server that lets an AI agent rent GPU compute on Silicr and pay in shielded ZEC,
// through the local buyer daemon's HTTP API (packages/api). It holds no keys.
export { createSilicrServer, MCP_VERSION, SERVER_INSTRUCTIONS } from './server.ts';
export type { SilicrMcp, SilicrMcpOptions } from './server.ts';
export { registerTools, resultTarget, limitsFor, TOOL_NAMES } from './tools.ts';
export type { Limits } from './tools.ts';
export type { ToolContext } from './tools.ts';
export { parseCliArgs, usage, describeOptions, DEFAULT_BUYER_URL, DEFAULT_PROVIDER_URL, DEFAULT_MAX_TOTAL_ZEC, DEFAULT_OUT_DIR } from './args.ts';
export type { McpCliOptions } from './args.ts';
export { SpendingCap } from './cap.ts';
export type { CapRequestState, CapUsage } from './cap.ts';
export { DaemonClient, ApiError } from './client.ts';
export { buildLeakReport, classifyField, classifyObservation, computeMatrix, chainObservation, requestTxids, FACTS, DEAL_FACTS, PARTIES, SELF_FACTS, EXPECTED, KNOWN_LIMITS } from './leaks.ts';
export type { Cell, CellState, ClassifiedField, ClassifyContext, ColumnInput, FactDef, LeakReport, LeakReportInput, Matrix, PartyReport } from './leaks.ts';
export { trimRfq, summarizeRfq, bidView, TERMINAL_STATES } from './trim.ts';
export type { RequestView, RequestSummary } from './trim.ts';
export { parseZec, formatZec, zatsOf, zec, perInterval, perHour, ceilDiv, ZATS_PER_ZEC } from './zec.ts';
