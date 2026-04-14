export interface SkillEntry {
  name: string;
  description: string;
}

export interface InvokeRequest {
  action: "skill" | "algorithm";
  skill?: string;        // required when action === "skill"
  content: string;
  notePath: string;
  history?: ConversationTurn[];
}

export interface SSEChunkEvent {
  type: "chunk";
  text: string;
}

export interface SSEDoneEvent {
  type: "done";
  resultAction?: "new-note" | "append";
  suggestedName?: string;
  error?: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export type SSEEvent = SSEChunkEvent | SSEDoneEvent;

export interface PluginSettings {
  daemonUrl: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  daemonUrl: "http://localhost:8765",
};
