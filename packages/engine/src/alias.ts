// Stable pseudonyms like "amber-otter-17", derived from a provider's public key.

const ADJECTIVES = [
  'amber', 'azure', 'brisk', 'calm', 'cedar', 'cobalt', 'coral', 'crisp', 'dusky', 'ember',
  'fern', 'frost', 'gilded', 'granite', 'hazel', 'indigo', 'ivory', 'jade', 'keen', 'lunar',
  'maple', 'misty', 'nimble', 'ochre', 'onyx', 'pale', 'quiet', 'rapid', 'russet', 'sable',
  'silver', 'slate', 'solar', 'swift', 'tawny', 'teal', 'umber', 'velvet', 'violet', 'willow',
];

const ANIMALS = [
  'otter', 'heron', 'lynx', 'marten', 'ibis', 'falcon', 'badger', 'kestrel', 'newt', 'orca',
  'puffin', 'quail', 'raven', 'stoat', 'tapir', 'urchin', 'vole', 'wren', 'yak', 'zebu',
  'bison', 'crane', 'dingo', 'egret', 'ferret', 'gecko', 'hare', 'jackal', 'koala', 'lemur',
  'moose', 'narwhal', 'ocelot', 'pika', 'robin', 'seal', 'tern', 'viper', 'walrus', 'finch',
];

export function aliasFor(publicKey: Uint8Array): string {
  const a = ADJECTIVES[(publicKey[0] ?? 0) % ADJECTIVES.length]!;
  const b = ANIMALS[(publicKey[1] ?? 0) % ANIMALS.length]!;
  const n = ((publicKey[2] ?? 0) * 256 + (publicKey[3] ?? 0)) % 100;
  return `${a}-${b}-${n}`;
}
