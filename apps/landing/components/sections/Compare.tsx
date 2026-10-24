import { Comparison } from '../Comparison';
import { Section } from '../Section';
import { Settlement } from '../Settlement';

export function Compare() {
  return (
    <Section
      id="compare"
      eyebrow="Compared"
      title="Private, without an operator."
      lead={
        <p>
          Most private-market designs keep the order book and move the trust to whoever runs it. Here is how Silicr differs
          from the two common designs, including where it is weaker.
        </p>
      }
    >
      <Comparison />
    </Section>
  );
}

export function SettlementSection() {
  return (
    <Section
      id="settlement"
      eyebrow="Settlement"
      title="Pay as you go, in shielded ZEC."
      lead={
        <p>
          Zcash has no escrow contract to lean on, so Silicr doesn&apos;t hold money at all. It caps what either side can lose
          instead: the buyer pays one interval at a time, and the provider runs only what has been paid for.
        </p>
      }
      tone="panel"
    >
      <Settlement />
    </Section>
  );
}
