'use client';

import { Play, RefreshCw } from '@/components/icons';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { errorMessage } from '@/lib/client';
import { hostOf } from '@/lib/config';
import { getDriver, retryConnection } from '@/lib/driver';
import { useSilicr } from '@/lib/store';
import { Button } from '../ui';

/** Always visible in mock mode, so mock data can never pass for the real thing. */
export function MockBanner() {
  const reason = useSilicr((s) => s.mockReason);
  const conn = useSilicr((s) => s.conn);
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'retry' | 'replay'>(null);
  const [err, setErr] = useState<string | null>(null);
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => setHost(window.location.hostname), []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="mock-stripes border-b border-mock/50 text-xs"
    >
      <div className="mx-auto flex min-h-9 max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 sm:px-6">
        <span className="rounded bg-mock px-1.5 py-0.5 font-mono shadow-[0_0_12px_rgba(139,124,246,0.5)] text-[11px] font-bold tracking-[0.12em] text-white">MOCK DATA</span>
        <span className="rounded bg-black/70 px-1.5 text-fg">
          Scripted replay in this browser tab. No daemon, relay or Zcash node is involved and time is compressed.
        </span>
        {reason === 'unreachable' && (
          <span className="text-muted">
            Daemons unreachable at load ({hostOf(conn.buyer.url)}, {hostOf(conn.provider.url)}).
            {host && host !== 'localhost' && host !== '127.0.0.1' ? ' Daemons only allow CORS from localhost:7703 and 127.0.0.1:7703.' : ''}
          </span>
        )}
        {reason === 'forced' && <span className="text-muted">Forced by NEXT_PUBLIC_SILICR_MOCK or ?mock=1.</span>}
        {err && <span className="text-bad">{err}</span>}
        <span className="ml-auto flex items-center gap-2">
          <Button
            size="xs"
            variant="secondary"
            icon={<Play className="size-3" aria-hidden />}
            loading={busy === 'replay'}
            onClick={async () => {
              const d = getDriver();
              if (!d?.replayDemo) return;
              setBusy('replay');
              setErr(null);
              try {
                const id = await d.replayDemo();
                router.push(`/rfq/${id}`);
              } catch (e) {
                setErr(errorMessage(e));
              } finally {
                setBusy(null);
              }
            }}
          >
            Replay demo
          </Button>
          {reason === 'unreachable' && (
            <Button
              size="xs"
              variant="secondary"
              icon={<RefreshCw className="size-3" aria-hidden />}
              loading={busy === 'retry'}
              onClick={async () => {
                setBusy('retry');
                setErr(null);
                try {
                  await retryConnection();
                } catch (e) {
                  setErr(errorMessage(e));
                } finally {
                  setBusy(null);
                }
              }}
            >
              Retry daemons
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}
