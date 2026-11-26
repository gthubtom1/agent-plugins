import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { registerLab } from "./lib/menu.ts";

export default function labExtension(pi: ExtensionAPI): void {
  registerLab(pi, join(getAgentDir(), "lab", "phrases.json"));
}
