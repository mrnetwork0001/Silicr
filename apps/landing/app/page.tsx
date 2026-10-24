import { SiteHeader } from '@/components/SiteHeader';
import { Backdrop } from '@/components/motion/Backdrop';
import { FinalCta, SiteFooter } from '@/components/sections/Closing';
import { SettlementSection } from '@/components/sections/Compare';
import { FaqSection } from '@/components/sections/FaqSection';
import { EclipseHero } from '@/components/eclipse/EclipseHero';
import { HowItWorks } from '@/components/sections/HowItWorks';
import { LeakInspector } from '@/components/sections/LeakInspector';
import { QuickStart } from '@/components/sections/QuickStart';

export default function Page() {
  return (
    <>
      <Backdrop />
      <EclipseHero />
      <SiteHeader />
      <main id="main" tabIndex={-1} className="outline-none">
        <HowItWorks />
        <LeakInspector />
        <SettlementSection />
        <QuickStart />
        <FaqSection />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
