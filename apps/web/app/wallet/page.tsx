import type { Metadata } from 'next';
import { WalletPanel } from '@/components/wallet/WalletPanel';

export const metadata: Metadata = { title: 'Wallet' };

export default function WalletPage() {
  return (
    <div className="mx-auto w-full max-w-[1200px]">
      <WalletPanel />
    </div>
  );
}
