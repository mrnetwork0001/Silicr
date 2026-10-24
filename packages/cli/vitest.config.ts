import { defineConfig } from 'vitest/config';

// The CLI tests drive `init`/`daemon` against the simulated chain: test infrastructure that users
// never get (checkNetwork accepts `memory` only with this variable set).
export default defineConfig({
  test: { env: { SILICR_TEST_MEMORY_NETWORK: '1' } },
});
