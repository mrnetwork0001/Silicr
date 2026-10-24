import type { Metadata } from 'next';
import { RequestView } from '@/components/rfq/RequestView';

export const metadata: Metadata = { title: 'Request' };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequestView id={decodeURIComponent(id)} />;
}
