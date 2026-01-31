#!/usr/bin/env node
"use strict";
var import_core = require("@oclif/core");
var import_url = require("url");
(async () => {
  await (0, import_core.execute)({ development: false, dir: (0, import_url.pathToFileURL)(__filename).href });
})().catch(console.error);
//# sourceMappingURL=bin.js.map