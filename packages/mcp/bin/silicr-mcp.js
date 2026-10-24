#!/usr/bin/env node
// Runs the TypeScript entry point through tsx (no build step) in this same process, so the MCP
// client's stdin/stdout are the server's. tsx is resolved from this package, so `silicr-mcp`
// works from any directory.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
