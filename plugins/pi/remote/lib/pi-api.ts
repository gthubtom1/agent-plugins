// Structural Pi API types for the hooks and commands used by remote.
export interface BaseContext {
  mode: string;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export type CommandContext = BaseContext;

export interface ExtensionApi {
  on(event: "session_start", handler: (event: unknown, ctx: BaseContext) => void): void;
  registerCommand(name: string, options: {
    description?: string;
    handler: (args: string, ctx: CommandContext) => Promise<void>;
  }): void;
  exec(command: string, args: string[], options?: { timeout?: number }): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>;
  sendMessage(message: { customType: string; content: string; display?: boolean }): void | Promise<void>;
}
