import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-panel p-8 text-center">
      <div className="font-mono text-xs text-faint">404</div>
      <h1 className="mt-1 text-lg font-semibold text-fg">Nothing here</h1>
      <p className="mt-1 text-sm text-muted">This page doesn&apos;t exist. Requests live at /rfq/&lt;id&gt; and are held by your buyer daemon.</p>
      <Link href="/" className="mt-4 inline-block text-sm text-accent hover:underline">
        Back to the market
      </Link>
    </div>
  );
}
