import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerShellGuard } from './runtime.mjs';

export default function shellGuard(pi: ExtensionAPI) {
  registerShellGuard(pi);
}
