// Structural Pi API types for the hooks and commands used by rewind.
import type { EntryLike } from "./rewind-targets.ts";

export interface BaseContext {
  mode: string;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    setEditorText(text: string): void;
  };
  sessionManager: { getBranch(): EntryLike[] };
}

export interface CommandContext extends BaseContext {
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
}

export interface ExtensionApi {
  on(event: "session_start", handler: (event: unknown, ctx: BaseContext) => void): void;
  registerCommand(name: string, options: {
    description?: string;
    handler: (args: string, ctx: CommandContext) => Promise<void>;
  }): void;
}
