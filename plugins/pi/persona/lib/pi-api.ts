// Structural Pi API types for the hooks and commands used by persona.
export interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

export interface ContextMessage {
  role?: string;
  content?: unknown;
  sections?: Record<string, string | null>;
}

export interface BaseContext {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
  sessionManager: {
    getBranch(): SessionEntryLike[];
    getEntries?(): SessionEntryLike[];
  };
}

export type CommandContext = BaseContext;

export interface ExtensionApi {
  on(event: "session_start", handler: (event: unknown, ctx: BaseContext) => void): void;
  on(event: "before_agent_start", handler: (event: {
    systemPromptOptions?: { sections?: Record<string, string | null> };
  }, ctx: BaseContext) => void): void;
  on(event: "context_with_system", handler: (event: { messages: ContextMessage[] }, ctx: BaseContext) => void): void;
  registerCommand(name: string, options: {
    description?: string;
    handler: (args: string, ctx: CommandContext) => Promise<void>;
  }): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
}
