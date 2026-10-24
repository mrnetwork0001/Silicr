// Container entry for a daemon: runs the command after `--` (the daemon, which binds loopback
// only by design) and forwards TCP from LISTEN_PORT on all container interfaces to it, so Docker
// can publish the port (to 127.0.0.1 on the host). Exits when the child exits, so Docker's
// restart policy sees a dead daemon. No bytes are inspected or logged.
//   node deploy/fwd.mjs <listenPort> <targetPort> -- <cmd> [args...]
import net from 'node:net';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep !== 2 || argv.length < 4) {
  process.stderr.write('usage: fwd.mjs <listenPort> <targetPort> -- <cmd> [args...]\n');
  process.exit(2);
}
const listenPort = Number(argv[0]);
const targetPort = Number(argv[1]);
const [cmd, ...args] = argv.slice(3);

const child = spawn(cmd, args, { stdio: 'inherit' });
child.on('exit', (code, sig) => {
  process.stderr.write(`fwd: child exited (${sig ?? code})\n`);
  process.exit(code ?? 1);
});
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => child.kill(s));

const server = net.createServer((inbound) => {
  const out = net.connect({ host: '127.0.0.1', port: targetPort });
  inbound.pipe(out).pipe(inbound);
  const end = () => { inbound.destroy(); out.destroy(); };
  inbound.on('error', end);
  out.on('error', end);
  inbound.on('close', end);
  out.on('close', end);
});
server.listen(listenPort, '0.0.0.0', () => process.stderr.write(`fwd: 0.0.0.0:${listenPort} -> 127.0.0.1:${targetPort}\n`));
