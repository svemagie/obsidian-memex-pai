import { SkillEntry, InvokeRequest, SSEEvent } from "./types";

export class PAIClient {
  constructor(private baseUrl: string) {}

  async getStatus(): Promise<{ version: string; paiPath: string } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/status`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      return res.json() as Promise<{ version: string; paiPath: string }>;
    } catch {
      return null;
    }
  }

  async getSkills(): Promise<SkillEntry[]> {
    try {
      const res = await fetch(`${this.baseUrl}/skills`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      return res.json() as Promise<SkillEntry[]>;
    } catch {
      return [];
    }
  }

  async *invoke(req: InvokeRequest): AsyncGenerator<SSEEvent> {
    const res = await fetch(`${this.baseUrl}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, string>;
      yield { type: "done", error: body.error ?? `HTTP ${res.status}` };
      return;
    }

    if (!res.body) {
      yield { type: "done", error: "SSE stream unavailable (no response body)" };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const dataLine = line.split("\n").find(l => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const event = JSON.parse(dataLine.slice(6)) as SSEEvent;
          yield event;
          if (event.type === "done") {
            await reader.cancel();
            return;
          }
        } catch { /* malformed event — skip */ }
      }
    }
  }
}
