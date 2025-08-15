#!/usr/bin/env node
import { runCli } from '../index.js';

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Use `void` to satisfy rules like no-floating-promises
void runCli().catch((e: unknown) => {
  console.error(formatError(e));
  process.exit(1);
});
