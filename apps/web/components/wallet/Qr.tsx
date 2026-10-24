'use client';

import clsx from 'clsx';
import QRCode from 'qrcode';
import { useMemo } from 'react';

/**
 * A QR code rendered as one SVG path, in the browser (nothing leaves the page). Dark modules on a
 * white quiet zone: wallets scan inverted codes badly, so the eclipse theme stops at the frame.
 */
export function Qr({ text, className, label }: { text: string; className?: string; label?: string }) {
  const { d, size } = useMemo(() => {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const data = qr.modules.data;
    let path = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!data[y * n + x]) continue;
        let run = 1;
        while (x + run < n && data[y * n + x + run]) run++;
        path += `M${x + 4} ${y + 4}h${run}v1h-${run}z`;
        x += run - 1;
      }
    }
    return { d: path, size: n + 8 };
  }, [text]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className={clsx('block rounded-lg', className)}
      role="img"
      aria-label={label ?? 'QR code'}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#0a0705" />
    </svg>
  );
}
