import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContinuity } from "./runtime.mjs";

export default function projectContinuity(pi: ExtensionAPI) {
  registerContinuity(pi);
}
