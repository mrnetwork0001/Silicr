// The `silicr` command line.
import { Command, Option } from 'commander';
import { ENGINE_VERSION } from '@silicr/engine';
import { demo } from './commands/demo.ts';
import { daemon, init, relay } from './commands/node.ts';
import { accept, bids, fault, migrate, result, rfqs, run, stop } from './commands/buyer.ts';
import { jobs, provide } from './commands/provider.ts';
import { status } from './commands/status.ts';
import { audit } from './commands/audit.ts';
import { mcp } from './commands/mcp.ts';
import { exportViewingKey, watch } from './commands/keys.ts';
import { wallet, withdraw } from './commands/wallet.ts';

const collect = (v: string, prev: string[] = []) => [...prev, v];

export function buildProgram(): Command {
  const program = new Command('silicr')
    .description('Rent a GPU without telling the world: a private compute market on Zcash.')
    .version(ENGINE_VERSION)
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nMainnet: only with `--network main` (real ZEC, small balances). A mainnet daemon needs spend caps in its config\n' +
        '(`silicr init --network main --cap-per-request <zec> --cap-total <zec>`), and `silicr run` asks for a go-ahead\n' +
        '(or --yes) before committing real funds. Tests and `silicr demo` never touch mainnet. See docs/MAINNET.md.\n' +
        'Silicr runs on Zcash testnet (`--network test`) or mainnet (`--network main`); the simulated chain exists only inside the test suite.\n',
    );

  program
    .command('demo')
    .description('testnet demo: relay (7700) + buyer (7701) + provider (7702) on Zcash testnet, using the funded wallets in .silicr/wallets/test-buyer and test-provider, then rent the provider for examples/tiny-train')
    .option('--network <network>', 'test only: the demo spends from shared demo wallets, so mainnet (real ZEC) is refused', 'test')
    .option('--no-run', 'start the stack and wait, without making the tiny-train request')
    .addOption(new Option('--runner <mode>', 'job runner').choices(['auto', 'process', 'docker']).default('auto'))
    .option('--keep', 'keep everything running after the deal (for the web terminal)')
    .option('--port-base <port>', 'relay on this port, buyer on +1, provider on +2', '7700')
    .option('--buyer-data <dir>', 'buyer wallet dir (default .silicr/wallets/test-buyer)')
    .option('--provider-data <dir>', 'provider wallet dir (default .silicr/wallets/test-provider)')
    .option('--data <dir>', 'relay data dir, wiped at start (default .silicr/demo-test)')
    .option('--server <host:port>', 'lightwalletd / Zaino for testnet (default: from the wallets\' config, else the sidecar default)')
    .option('--proxy <url>', 'SOCKS5 proxy for the wallets\' and relay connections, e.g. socks5h://127.0.0.1:9050; also $SILICR_PROXY')
    .addOption(new Option('--transport <mode>', 'relay (default) or memo: run the deal relay-less, every blob in Zcash memos').choices(['relay', 'memo']))
    .action((o) => demo(o));

  program
    .command('init')
    .description('create a data dir for one party: keys, wallet and config')
    .addOption(new Option('--role <role>', 'buyer or provider').choices(['buyer', 'provider']).makeOptionMandatory())
    .addOption(
      new Option('--network <network>', 'test = Zcash testnet, main = Zcash mainnet (REAL ZEC; needs --cap-per-request and --cap-total)').default('test'),
    )
    .option('--data <dir>', 'data dir, kept under .silicr/ and never committed (default .silicr/wallets/main-<role> on mainnet, .silicr/wallets/<role> on testnet)')
    .option('--cap-per-request <zec>', 'spend cap: the most one request may pay its provider, in ZEC (required on mainnet for a buyer)')
    .option('--cap-total <zec>', 'spend cap: the most this party may ever spend, payments and fees, in ZEC (required on mainnet)')
    .option('--relay <url>', 'relay URL', 'http://127.0.0.1:7700')
    .option('--port <port>', 'daemon port (default 7701 buyer, 7702 provider)')
    .option('--server <host:port>', 'lightwalletd / Zaino for testnet or mainnet')
    .option('--proxy <url>', 'SOCKS5 proxy for every outbound connection, e.g. socks5h://127.0.0.1:9050 (Tor); also $SILICR_PROXY')
    .addOption(new Option('--transport <mode>', 'relay (default) or memo: relay-less, job/logs/result in Zcash memos (small jobs, fees per memo)').choices(['relay', 'memo']))
    .action((o) => init(o));

  program
    .command('daemon')
    .description('run one party: the local daemon the CLI and web terminal talk to')
    .option('--data <dir>', 'data dir from `silicr init` (default: the init default for --role and --network)')
    .addOption(new Option('--role <role>', 'buyer or provider (default: from config)').choices(['buyer', 'provider']))
    .addOption(new Option('--network <network>', 'test = Zcash testnet, main = Zcash mainnet (REAL ZEC; needs spend caps) (default: from config, else test)'))
    .option('--cap-per-request <zec>', 'spend cap per request in ZEC (default: from config; required on mainnet for a buyer)')
    .option('--cap-total <zec>', 'total spend cap in ZEC, payments and fees (default: from config; required on mainnet)')
    .option('--relay <url>', 'relay URL')
    .option('--port <port>', 'port')
    .option('--host <addr>', 'bind address (default 127.0.0.1; a non-loopback address needs --public-origin)')
    .option('--server <host:port>', 'lightwalletd / Zaino for testnet or mainnet')
    .addOption(new Option('--runner <mode>', 'provider job runner').choices(['auto', 'process', 'docker']))
    .option('--demo-mode', 'tell the web terminal every party runs on this machine')
    .option('--public-demo', 'public testnet demo (refused on mainnet without --allow-mainnet): requests run server-side presets only (examples/tiny-train), ≤ 15 min, 1 GPU, one live request, 3 per IP per hour; withdraw, policy, migrate and provider stop disabled')
    .option('--allow-mainnet', 'with --public-demo on --network main: a public demo with REAL ZEC from a tiny shared wallet; the spend caps are required and enforced as a hard ceiling on every request (worst case, fees included), max price ≤ 0.001 ZEC/h, ≤ 15 min; the provider bids only with ≥ 0.0003 ZEC for fees')
    .option('--public-origin <url>', 'hosted deployment: also allow this Origin and its host name in the Host header (repeatable), e.g. https://app.example.org', collect)
    .option('--trust-proxy', 'behind a reverse proxy: take the client IP from X-Forwarded-For (last entry) for the public-demo rate limit')
    .option('--proxy <url>', 'SOCKS5 proxy for every outbound connection (relay and light-wallet server), e.g. socks5h://127.0.0.1:9050 for Tor; also $SILICR_PROXY; "none" forces direct')
    .addOption(new Option('--transport <mode>', 'relay or memo (default: from config, else relay): relay-less, job/logs/result in Zcash memos (small jobs, fees per memo)').choices(['relay', 'memo']))
    .action((o) => daemon(o));

  program
    .command('relay')
    .description('run a ciphertext-only relay (and the public provider directory)')
    .option('--port <port>', 'port', '7700')
    .option('--host <addr>', 'bind address (default 127.0.0.1)')
    .option('--data <dir>', 'data dir', '.silicr/relay')
    .option('--observer', 'expose /_observer for the Leak Inspector')
    .action((o) => relay(o));

  program
    .command('run')
    .description('rent GPUs for a job: sealed RFQ, signed bids, metered shielded payments')
    .argument('<path>', 'job directory (or a single .py/.sh file)')
    .argument('[command...]', 'command to run, after --')
    .requiredOption('--gpu <model>', 'GPU model, e.g. a100, h100, cpu')
    .option('--count <n>', 'number of GPUs', '1')
    .option('--hours <h>', 'requested runtime in hours (decimals ok)', '1')
    .requiredOption('--max <zec/h>', 'max price per hour for the whole job, in ZEC (e.g. 0.8 or 0.8zec/h); private by default')
    .option('--disclose-max', 'put the max in the RFQ memo so providers see it (default: undisclosed; providers bid their own price and bids above the max are dropped locally)')
    .option('--auto', 'auto-accept the cheapest signed bid')
    .option('--wait-blocks <n>', 'with --auto: blocks to wait for more bids', '2')
    .option('--image <image>', 'container image (default python:3.12-slim)')
    .option('--env <NAME=value>', 'environment for the job (repeatable)', collect)
    .option('--providers <ids>', 'comma-separated provider ids to ask (default: every match in the directory)')
    .option('--out <file>', 'save the result tar.gz here when done')
    .option('--no-follow', 'submit and return immediately')
    .option('--yes', 'mainnet: commit real funds without the interactive go-ahead (needed when there is no terminal)')
    .option('--daemon <url>', 'buyer daemon', undefined)
    .action((path: string, command: string[], o) => run(path, command, o));

  program
    .command('provide')
    .description('sell GPU time: set the policy and publish a signed, pseudonymous directory entry')
    .requiredOption('--gpu <model>', 'GPU model, e.g. a100')
    .option('--count <n>', 'number of GPUs', '1')
    .requiredOption('--min <zec/h>', 'minimum price per hour, in ZEC')
    .option('--vram <gb>', 'VRAM per GPU in GB', '0')
    .option('--interval <s>', 'billing interval in seconds')
    .option('--grace <s>', 'seconds a late payment may take before the job stops')
    .option('--no-auto-bid', 'publish, but do not bid automatically')
    .option('--follow', 'keep watching jobs')
    .option('--daemon <url>', 'provider daemon')
    .action((o) => provide(o));

  program.command('status').description('show the local daemons').option('--buyer <url>').option('--provider <url>').action((o) => status(o));
  program.command('audit').description('privacy receipt for one request: self-contained HTML (buyer /api/leaks, in demo mode also the provider and the relay observer, plus public tx views)').argument('<rfqId>', 'id or unique prefix').option('--out <file>', 'write the HTML here (default silicr-receipt-<id>.html)').option('--json', 'print the receipt data as JSON instead').option('--buyer <url>').option('--provider <url>').option('--relay <url>', 'relay URL (default: the one the buyer daemon reports)').action((id: string, o) => audit(id, o));
  program
    .command('wallet')
    .description('fund this wallet from your own Zcash wallet: address, ZIP 321 QR, balance and confirmations')
    .option('--data <dir>', 'data dir from `silicr init` (its daemon port; default: the buyer daemon)')
    .option('--daemon <url>', 'daemon URL (default http://127.0.0.1:7701)')
    .option('--amount <zec>', 'put this amount in the ZIP 321 URI and QR')
    .option('--no-qr', 'skip the QR code')
    .action((o) => wallet(o));
  program
    .command('withdraw')
    .description('move funds back to your own shielded wallet (Orchard-receiver UA only); not counted against the spend cap')
    .argument('<to>', 'unified address with an Orchard receiver (u1… on mainnet, utest1… on testnet)')
    .argument('<amount>', 'amount in ZEC (e.g. 0.01), or "all" for the spendable balance minus the fee')
    .option('--yes', 'mainnet: send without the interactive go-ahead (needed when there is no terminal)')
    .option('--force', 'withdraw even while a request or job is live')
    .option('--data <dir>', 'data dir from `silicr init` (its daemon port; default: the buyer daemon)')
    .option('--daemon <url>', 'daemon URL (default http://127.0.0.1:7701)')
    .action((to: string, amount: string, o) => withdraw(to, amount, o));
  program.command('rfqs').description('list this buyer\'s RFQs').option('--daemon <url>').action((o) => rfqs(o));
  program.command('jobs').description('list this provider\'s jobs').option('--follow').option('--daemon <url>').action((o) => jobs(o));
  program.command('bids').description('show the bids on an RFQ').argument('<rfqId>', 'id or unique prefix').option('--daemon <url>').action((id: string, o) => bids(id, o));
  program
    .command('accept')
    .description('accept a bid (pays interval 0) and follow the job')
    .argument('<rfqId>', 'id or unique prefix')
    .argument('<provider>', 'provider alias or id prefix')
    .option('--no-follow', 'return right after the ACCEPT')
    .option('--out <file>', 'save the result tar.gz here when done')
    .option('--yes', 'mainnet: pay without the interactive go-ahead (needed when there is no terminal)')
    .option('--daemon <url>')
    .action((id: string, p: string, o) => accept(id, p, o));
  program.command('stop').description('stop a job: CLOSE(buyer_stop), no further payments').argument('<rfqId>').option('--daemon <url>').action((id: string, o) => stop(id, o));
  program
    .command('migrate')
    .description('move a job to another provider: a new RFQ for the same job, resumed from the latest checkpoint; the old one is stopped')
    .argument('<rfqId>', 'id or unique prefix')
    .option('--providers <ids>', 'comma-separated provider ids to ask (default: every match in the directory except the current provider)')
    .option('--wait-blocks <n>', 'blocks to wait for more bids before auto-accepting the cheapest (default: as the original request, else 1)')
    .option('--no-follow', 'return right after the new RFQ is out')
    .option('--out <file>', 'save the result tar.gz here when done')
    .option('--yes', 'mainnet: commit real funds without the interactive go-ahead (needed when there is no terminal)')
    .option('--daemon <url>', 'buyer daemon')
    .action((id: string, o) => migrate(id, o));
  program.command('result').description('download a result tar.gz').argument('<rfqId>').option('-o, --out <file>').option('--daemon <url>').action((id: string, o) => result(id, o));
  program
    .command('mcp')
    .description('run the MCP server for AI agents (stdio); options pass through to silicr-mcp, e.g. --max-total-zec 0.05')
    .allowUnknownOption()
    .helpOption(false)
    .argument('[args...]')
    .action((args: string[], _o: unknown, cmd: { args: string[] }) => mcp(cmd.args));
  program
    .command('fault')
    .description('demo fault injection: stop-paying | resume-paying (buyer), stop-heartbeats | resume-heartbeats (provider)')
    .argument('<rfqId>', 'id or unique prefix')
    .argument('<fault>')
    .option('--daemon <url>', 'buyer daemon')
    .option('--provider <url>', 'provider daemon')
    .action((id: string, f: string, o) => fault(id, f, o));
  program
    .command('export-viewing-key')
    .description('AUDIT: print this wallet\'s unified full viewing key (Orchard-only UFVK). It reveals the whole wallet\'s history, never spending authority')
    .requiredOption('--data <dir>', 'data dir from `silicr init` (or a wallet dir)')
    .addOption(new Option('--network <network>', 'main or test (default: from config.json / wallet.json)').choices(['main', 'test']))
    .option('--yes', 'acknowledge the warning without the interactive prompt (needed when there is no terminal)')
    .action((o) => exportViewingKey(o));
  program
    .command('watch')
    .description('AUDIT: open a watch-only wallet from a viewing key and print its ledger (received and sent, amounts, memos); it can never spend')
    .option('--viewing-key <ufvk>', 'uview1… (mainnet) or uviewtest1… (testnet) unified full viewing key; omit to re-open the wallet already in --data')
    .addOption(new Option('--network <network>', 'main or test').choices(['main', 'test']).makeOptionMandatory())
    .requiredOption('--data <dir>', 'a NEW data dir for the watch-only wallet (never a spending wallet\'s dir)')
    .option('--birthday <height>', 'start scanning here (default: tip - 100; use the audited wallet\'s birthday to see its whole history)')
    .option('--server <host:port>', 'lightwalletd / Zaino')
    .option('--proxy <url>', 'SOCKS5 proxy, e.g. socks5h://127.0.0.1:9050 (Tor); also $SILICR_PROXY')
    .option('--json', 'print the ledger as JSON')
    .action((o) => watch(o));
  return program;
}
