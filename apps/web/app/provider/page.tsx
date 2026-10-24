import type { Metadata } from 'next';
import { ProviderView } from '@/components/provider/ProviderView';

export const metadata: Metadata = { title: 'Provider' };

export default function ProviderPage() {
  return <ProviderView />;
}
