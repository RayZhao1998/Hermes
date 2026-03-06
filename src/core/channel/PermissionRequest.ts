export interface ToolPermissionOption {
  optionId: string;
  kind: string;
  name: string;
}

export interface ToolPermissionRequest {
  sessionId: string;
  toolCallId: string;
  title?: string;
  status?: string;
  renderedText?: string;
  message?: {
    chatId: string;
    messageId: string;
    threadId?: string;
  };
  options: ToolPermissionOption[];
}

export type ToolPermissionDecision =
  | {
      outcome: "selected";
      optionId: string;
    }
  | {
      outcome: "cancelled";
    };
