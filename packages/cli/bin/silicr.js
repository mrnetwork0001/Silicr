#!/usr/bin/env node
// Runs the TypeScript entry point through tsx (no build step), in this same process so
// Ctrl-C and kill reach the daemons and jobs directly. tsx is resolved from this package,
// so `silicr` works from any directory.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
