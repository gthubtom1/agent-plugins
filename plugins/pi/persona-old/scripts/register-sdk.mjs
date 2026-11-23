// Test-only mapping to the same pi-ai view the host supplies to extensions.
import { registerHooks } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const sdkDir = process.env.PI_SDK_DIR;
if (!sdkDir) throw new Error("PI_SDK_DIR must point to an installed pi-coding-agent package");
const aiView = pathToFileURL(join(resolve(sdkDir), "dist/core/extensions/pi-ai-extension-view.js")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-ai") return { url: aiView, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
