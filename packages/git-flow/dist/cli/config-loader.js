"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var config_loader_exports = {};
__export(config_loader_exports, {
  loadConfig: () => loadConfig
});
module.exports = __toCommonJS(config_loader_exports);
var import_node_url = require("node:url");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
async function loadConfig(cwd) {
  const configPaths = [
    (0, import_node_path.join)(cwd, "cpdevtools.config.ts"),
    (0, import_node_path.join)(cwd, "cpdevtools.config.js"),
    (0, import_node_path.join)(cwd, "cpdevtools.config.mjs")
  ];
  for (const configPath of configPaths) {
    if ((0, import_node_fs.existsSync)(configPath)) {
      try {
        const configUrl = (0, import_node_url.pathToFileURL)(configPath).href;
        const module2 = await import(configUrl);
        const config = module2.default || module2;
        return config;
      } catch (error) {
        console.warn(`Warning: Failed to load config from ${configPath}:`, error);
      }
    }
  }
  return void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  loadConfig
});
//# sourceMappingURL=config-loader.js.map