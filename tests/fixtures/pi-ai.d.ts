declare module "@earendil-works/pi-ai" {
  export interface AssistantMessageEventStream {
    push(event: unknown): void;
    end(): void;
  }

  export function createAssistantMessageEventStream(): AssistantMessageEventStream;
}
