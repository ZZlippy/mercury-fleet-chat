import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// EventSource is not implemented by jsdom. The Fleet workspace opens one for
// realtime updates, so provide a minimal inert stub: the tests here exercise
// task/draft isolation and send handling, not the SSE transport itself.
class InertEventSource {
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = InertEventSource;

afterEach(() => cleanup());
