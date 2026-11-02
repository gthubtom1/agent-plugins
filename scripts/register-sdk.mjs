import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

// Test-only SDK resolution: no installation or user configuration reads.
if (process.env.PI_SDK_DIR) {
  const sdk = resolve(process.env.PI_SDK_DIR);
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-ai") {
      const entry = join(sdk, "..", "pi-ai", "dist", "index.js");
      if (!existsSync(entry)) throw new Error(`Missing pi-ai alongside PI_SDK_DIR: ${entry}`);
      return { url: pathToFileURL(entry).href, shortCircuit: true };
    }
    return next(specifier, context);
  }});
}
