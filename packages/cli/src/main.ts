// The `silicr` command. See PRODUCT_REQUIREMENTS.md §3 for the flows.
import { buildProgram } from './program.ts';
import { pc } from './format.ts';

buildProgram()
  .parseAsync(process.argv)
  .catch((e: unknown) => {
    console.error(`${pc.red('error')} ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
