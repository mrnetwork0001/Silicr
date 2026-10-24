import { describe, expect, it } from 'vitest';
import { explorerTxLink, explorerTxUrlFor } from '../lib/config';

const TXID = '4e4d5ae9fcd9be92d045388986f1dde345a17c606df1d46ac423cb954bd5c301';

describe('explorer links', () => {
  it('has a template per real network and none for simulated chains', () => {
    expect(explorerTxUrlFor('main')).toContain('{txid}');
    expect(explorerTxUrlFor('test')).toContain('{txid}');
    expect(explorerTxUrlFor('main')).not.toBe(explorerTxUrlFor('test'));
    expect(explorerTxUrlFor('memory')).toBeNull();
    expect(explorerTxUrlFor('regtest')).toBeNull();
    expect(explorerTxUrlFor(null)).toBeNull();
  });

  it('builds links only where an explorer exists', () => {
    const main = explorerTxLink(TXID, 'main');
    expect(main).toMatch(/^https:\/\//);
    expect(main).toContain(TXID);
    expect(main).not.toContain('testnet');
    expect(explorerTxLink(TXID, 'test')).toContain(TXID);
    expect(explorerTxLink(TXID, 'memory')).toBeNull();
    expect(explorerTxLink('', 'main')).toBeNull();
  });

  it('URL-encodes the txid', () => {
    expect(explorerTxLink('a/b?c', 'main')).toContain('a%2Fb%3Fc');
  });
});
