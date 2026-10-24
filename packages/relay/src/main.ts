/**
 * Run a Silicr relay:
 *   pnpm --filter @silicr/relay start -- --port 7700 --host 127.0.0.1 --data .silicr/relay --observer
 *   npx tsx packages/relay/src/main.ts --observer
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { startRelay } from './index.ts';

const USAGE = `silicr relay: ciphertext-only store-and-forward relay + public provider directory

Options:
  --port <n>        listen port (default 7700; 0 = any free port)
  --host <addr>     listen address (default 127.0.0.1)
  --data <dir>      data directory (default .silicr/relay)
  --observer        expose GET /_observer for the Leak Inspector (demo mode)
  --ttl-hours <h>   delete mailboxes untouched this long (default 24)
  --quiet           no request log
  -h, --help        show this help
`;

// `pnpm start -- --port 7700` passes the "--" through; drop it.
const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift();

const { values } = parseArgs({
  args: argv,
  options: {
    port: { type: 'string', default: '7700' },
    host: { type: 'string', default: '127.0.0.1' },
    data: { type: 'string', default: '.silicr/relay' },
    observer: { type: 'boolean', default: false },
    'ttl-hours': { type: 'string' },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`invalid --port ${values.port}\n`);
  process.exit(2);
}
let ttlMs: number | undefined;
if (values['ttl-hours'] !== undefined) {
  const h = Number(values['ttl-hours']);
  if (!Number.isFinite(h) || h <= 0) {
    process.stderr.write(`invalid --ttl-hours ${values['ttl-hours']}\n`);
    process.exit(2);
  }
  ttlMs = h * 3600 * 1000;
}

const stamp = () => new Date().toISOString();
const relay = await startRelay({
  port,
  host: values.host,
  dataDir: values.data,
  observer: values.observer,
  ttlMs,
  // Method, path, status, sizes and timing only: never bodies, never client IPs.
  log: values.quiet ? undefined : (line) => process.stdout.write(`${stamp()} ${line}\n`),
});

process.stdout.write(
  `silicr relay listening on ${relay.url}\n` +
    `  data      ${resolve(values.data)}\n` +
    `  observer  ${values.observer ? `on (GET ${relay.url}/_observer, demo only: it shows sizes, timing and client IPs)` : 'off'}\n`,
);

let stopping = false;
const shutdown = (sig: string) => {
  if (stopping) process.exit(1);
  stopping = true;
  process.stdout.write(`${stamp()} ${sig}: shutting down\n`);
  relay.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
