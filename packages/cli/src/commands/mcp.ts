import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `silicr mcp [options]`: run the MCP server (packages/mcp) for AI agents. stdio is the MCP
 * channel, so the child inherits it untouched; every option is passed through unchanged.
 */
export function mcp(args: string[]): Promise<never> {
  // Workspace layout: packages/cli/src/commands → packages/mcp/bin.
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = join(here, '..', '..', '..', 'mcp', 'bin', 'silicr-mcp.js');
  return new Promise((_, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  });
}
