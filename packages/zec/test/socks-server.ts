/**
 * A tiny in-process SOCKS5 server for tests. It records every CONNECT it is asked for (address
 * type, host as sent, port) and either tunnels to the address `resolve` returns, or refuses with
 * a SOCKS reply code. It never does DNS: a hostname it is not told about is refused (0x04).
 */
import { createServer, connect, type Server, type Socket } from 'node:net';

export interface SeenConnect {
  atyp: 'ipv4' | 'ipv6' | 'domain';
  host: string;
  port: number;
}

export interface SocksTestServer {
  url: string;
  port: number;
  seen: SeenConnect[];
  /** Accepted TCP connections (one per tunnel, handshake or not). */
  connections: number;
  close(): Promise<void>;
}

export interface SocksTestOptions {
  /** Where to tunnel a CONNECT for host:port; null refuses it (reply 0x02). Default: refuse everything. */
  resolve?: (host: string, port: number) => { host: string; port: number } | null;
  /** RFC 1929: require these credentials. */
  auth?: { username: string; password: string };
}

export async function startSocksServer(opts: SocksTestOptions = {}): Promise<SocksTestServer> {
  const seen: SeenConnect[] = [];
  const sockets = new Set<Socket>();
  const state: SocksTestServer = { url: '', port: 0, seen, connections: 0, close: async () => undefined };

  const server: Server = createServer((client) => {
    state.connections += 1;
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'auth' | 'request' | 'tunnel' = 'greeting';
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (buf.length < 2 || buf.length < 2 + buf[1]!) return;
          const methods = [...buf.subarray(2, 2 + buf[1]!)];
          buf = buf.subarray(2 + methods.length);
          if (opts.auth) {
            if (!methods.includes(0x02)) {
              client.end(Buffer.from([0x05, 0xff]));
              return;
            }
            client.write(Buffer.from([0x05, 0x02]));
            stage = 'auth';
          } else {
            client.write(Buffer.from([0x05, 0x00]));
            stage = 'request';
          }
        } else if (stage === 'auth') {
          if (buf.length < 2) return;
          const ulen = buf[1]!;
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen]!;
          if (buf.length < 3 + ulen + plen) return;
          const username = buf.subarray(2, 2 + ulen).toString('utf8');
          const password = buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
          buf = buf.subarray(3 + ulen + plen);
          if (username !== opts.auth!.username || password !== opts.auth!.password) {
            client.end(Buffer.from([0x01, 0x01]));
            return;
          }
          client.write(Buffer.from([0x01, 0x00]));
          stage = 'request';
        } else if (stage === 'request') {
          if (buf.length < 4) return;
          const atyp = buf[3]!;
          let host: string;
          let len: number;
          let kind: SeenConnect['atyp'];
          if (atyp === 0x01) {
            if (buf.length < 10) return;
            host = [...buf.subarray(4, 8)].join('.');
            len = 10;
            kind = 'ipv4';
          } else if (atyp === 0x04) {
            if (buf.length < 22) return;
            const g: string[] = [];
            for (let i = 0; i < 16; i += 2) g.push(buf.readUInt16BE(4 + i).toString(16));
            host = g.join(':');
            len = 22;
            kind = 'ipv6';
          } else if (atyp === 0x03) {
            if (buf.length < 5) return;
            const n = buf[4]!;
            if (buf.length < 5 + n + 2) return;
            host = buf.subarray(5, 5 + n).toString('utf8');
            len = 5 + n + 2;
            kind = 'domain';
          } else {
            client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const port = buf.readUInt16BE(len - 2);
          buf = buf.subarray(len);
          seen.push({ atyp: kind, host, port });
          const target = opts.resolve?.(host, port) ?? null;
          if (!target) {
            client.end(Buffer.from([0x05, opts.resolve ? 0x04 : 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return;
          }
          stage = 'tunnel';
          client.off('data', onData);
          const upstream = connect(target, () => {
            // Answer with a domain-typed bound address to exercise variable-length reply parsing.
            const bound = Buffer.from('bound');
            client.write(Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x03, bound.length]), bound, Buffer.from([0, 0])]));
            if (buf.length) upstream.write(buf);
            client.pipe(upstream);
            upstream.pipe(client);
          });
          sockets.add(upstream);
          upstream.on('close', () => sockets.delete(upstream));
          upstream.on('error', () => client.destroy());
          client.on('close', () => upstream.destroy());
          return;
        } else {
          return;
        }
      }
    };
    client.on('data', onData);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  state.port = addr.port;
  state.url = `socks5h://127.0.0.1:${addr.port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return state;
}
