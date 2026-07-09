#!/usr/bin/env node

import { execute } from '@oclif/core';
import { pathToFileURL } from 'node:url';

(async () => {
  await execute({ development: false, dir: pathToFileURL(__filename).href });
})().catch(console.error);
