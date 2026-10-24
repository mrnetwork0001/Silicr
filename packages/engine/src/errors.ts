// Errors that map onto ErrorDto codes at the daemon edge.
import { isInsufficientFunds, isPrivacyError } from './chain.ts';
import { errMsg } from './util.ts';

export class EngineError extends Error {
  override name = 'EngineError';
  readonly code: string;
  readonly status: number;
  /** Extra ErrorDto fields (e.g. WithdrawConfirmDto's token and summary). */
  readonly extra: Record<string, unknown> | undefined;
  constructor(code: string, message: string, status = 400, extra?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (m: string) => new EngineError('bad_request', m, 400);
export const notFound = (m: string) => new EngineError('not_found', m, 404);
export const conflict = (m: string) => new EngineError('conflict', m, 409);
export const wrongRole = (m: string) => new EngineError('wrong_role', m, 404);

/** ErrorDto fields + HTTP status for any thrown value. */
export function toErrorDto(e: unknown): { status: number; body: { error: string; code: string } & Record<string, unknown> } {
  if (e instanceof EngineError) return { status: e.status, body: { ...(e.extra ?? {}), error: e.message, code: e.code } };
  if (isPrivacyError(e)) return { status: 400, body: { error: errMsg(e), code: 'privacy' } };
  if (isInsufficientFunds(e)) return { status: 402, body: { error: errMsg(e), code: 'insufficient_funds' } };
  if (e instanceof SyntaxError) return { status: 400, body: { error: `bad JSON: ${e.message}`, code: 'bad_request' } };
  return { status: 500, body: { error: errMsg(e), code: 'internal' } };
}
