// `silicr-mcp`: the stdio entry point. stdout is the MCP channel; diagnostics go to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { describeOptions, parseCliArgs, usage, type McpCliOptions } from './args.ts';
import { createSilicrServer } from './server.ts';

let options: McpCliOptions;
try {
  options = parseCliArgs(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`silicr-mcp: ${e instanceof Error ? e.message : String(e)}\n\n${usage()}`);
  process.exit(2);
}
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}

const log = (line: string) => process.stderr.write(`silicr-mcp: ${line}\n`);
const { server } = createSilicrServer({ ...options, log });
const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready (${describeOptions(options)})`);

let closing = false;
const shutdown = (code: number) => {
  if (closing) return;
  closing = true;
  server.close().finally(() => process.exit(code));
};
server.server.onclose = () => shutdown(0);
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.stdin.on('end', () => shutdown(0));
