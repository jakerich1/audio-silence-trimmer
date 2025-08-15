#!/usr/bin/env node
import { runCli } from '../index.js';

runCli().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
