import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSupportDraftController,
  type SupportDraftApiFn,
} from "../../apps/web/src/workspaces/support-draft-autosave.js";

type Call = {
  path: string;
  method: string;
  body?: unknown;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const formatError = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Lets the promise chain of the controller settle without touching the timers.
 *
 * The controller awaits the API call before it reports the new state, so the assertions have to
 * run after the microtasks of that call are done.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("LND-R4-01: reply draft autosave of the support workspace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a stored draft that arrives after the debounce and never deletes it", async () => {
    const calls: Call[] = [];
    const gate = deferred<{ body: string } | null>();
    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: options?.body });
      if (method === "GET") return gate.promise;
      return null;
    };
    const controller = createSupportDraftController({ api, formatError });

    const opening = controller.openThread("thread-1");

    // The debounce elapses while the stored draft is still on its way.
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(calls.filter(call => call.method !== "GET")).toEqual([]);

    gate.resolve({ body: "Черновик ответа" });
    await opening;

    expect(controller.getSnapshot().body).toBe("Черновик ответа");
    expect(controller.getSnapshot().status).toBe("saved");
    expect(calls.filter(call => call.method === "DELETE")).toEqual([]);
    expect(calls.filter(call => call.method === "PUT")).toEqual([]);
  });

  it("keeps a failed save unsaved, reports it and sends the same body again on a retry", async () => {
    const calls: Call[] = [];
    const errors: string[] = [];
    let failNextPut = true;
    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: options?.body });
      if (method === "GET") return null;
      if (method === "PUT" && failNextPut) {
        failNextPut = false;
        throw new Error("Сеть недоступна");
      }
      return null;
    };
    const controller = createSupportDraftController({
      api,
      formatError,
      onError: message => errors.push(message),
    });

    await controller.openThread("thread-2");
    controller.setBody("Привет, клиент");
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    // The server did not confirm the draft: the text stays unsaved and the operator is told.
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().body).toBe("Привет, клиент");
    expect(controller.getSnapshot().savedBody).toBe("");
    expect(errors).toEqual(["Сеть недоступна"]);

    const putsBefore = calls.filter(call => call.method === "PUT").length;
    await controller.retry();
    await vi.advanceTimersByTimeAsync(0);
    await settle();

    const puts = calls.filter(call => call.method === "PUT");
    expect(puts).toHaveLength(putsBefore + 1);
    expect(puts[putsBefore].body).toEqual({ body: "Привет, клиент" });
    expect(controller.getSnapshot().status).toBe("saved");
    expect(controller.getSnapshot().savedBody).toBe("Привет, клиент");
  });

  it("does not send a confirmed text twice and restores it in a fresh controller", async () => {
    const calls: Call[] = [];
    let stored: { body: string } | null = null;
    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: options?.body });
      if (method === "GET") return stored;
      if (method === "PUT") {
        stored = { body: String((options?.body as { body: string }).body) };
      }
      return null;
    };
    const controller = createSupportDraftController({ api, formatError });

    await controller.openThread("thread-3");
    controller.setBody("Ответ сохранён");
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(controller.getSnapshot().status).toBe("saved");
    expect(calls.filter(call => call.method === "PUT")).toHaveLength(1);

    // The very same text must not produce a second request.
    controller.setBody("Ответ сохранён");
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(calls.filter(call => call.method === "PUT")).toHaveLength(1);

    // A reload brings the confirmed text back.
    const reloaded = createSupportDraftController({ api, formatError });
    await reloaded.openThread("thread-3");
    expect(reloaded.getSnapshot().body).toBe("Ответ сохранён");
    expect(reloaded.getSnapshot().status).toBe("saved");
    expect(calls.filter(call => call.method === "PUT")).toHaveLength(1);
  });

  it("deletes the stored draft when the operator clears the field after the load", async () => {
    const calls: Call[] = [];
    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: options?.body });
      if (method === "GET") return { body: "Черновик ответа" };
      return null;
    };
    const controller = createSupportDraftController({ api, formatError });

    await controller.openThread("thread-4");
    expect(controller.getSnapshot().body).toBe("Черновик ответа");

    controller.setBody("");
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(controller.getSnapshot().status).toBe("clean");
  });

  it("deletes nothing when the draft load failed", async () => {
    const calls: Call[] = [];
    const errors: string[] = [];
    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: options?.body });
      if (method === "GET") throw new Error("Черновик недоступен");
      return null;
    };
    const controller = createSupportDraftController({
      api,
      formatError,
      onError: message => errors.push(message),
    });

    await controller.openThread("thread-5");
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().body).toBe("");
    expect(errors).toEqual(["Черновик недоступен"]);
    expect(calls.filter(call => call.method !== "GET")).toEqual([]);
  });

  it("never overwrites the text of the operator with a late draft response", async () => {
    const calls: Call[] = [];
    const gate = deferred<{ body: string } | null>();
    const api: SupportDraftApiFn = async (path, options) => {
      const method = (options?.method ?? "GET").toUpperCase();
      calls.push({ path, method, body: options?.body });
      if (method === "GET") return gate.promise;
      return null;
    };
    const controller = createSupportDraftController({ api, formatError });

    const opening = controller.openThread("thread-6");
    controller.setBody("Мой ответ");

    gate.resolve({ body: "Черновик прошлого раза" });
    await opening;

    expect(controller.getSnapshot().body).toBe("Мой ответ");
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    const puts = calls.filter(call => call.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ body: "Мой ответ" });
    expect(controller.getSnapshot().status).toBe("saved");
  });
});
