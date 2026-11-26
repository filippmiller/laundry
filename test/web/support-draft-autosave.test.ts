import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
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

/**
 * Lets the promise chain of the controller settle.
 *
 * A write can trigger the next one — the reconciliation compares the box with the confirmed state
 * of the server and writes the difference away — so more turns of the microtask queue are needed
 * than for a single request.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/**
 * A fake server for the draft endpoint.
 *
 * The stored draft is the only state that matters here: the tests check what the server holds
 * after the controller is done. The PUT waits for `release()` so that a write can be caught in
 * flight — that is the window in which the cleared box and the sent answer used to be lost.
 */
function draftServer() {
  const calls: Call[] = [];
  const stored = new Map<string, { body: string }>();
  const gate = deferred<null>();
  let gated = true;
  // The draft of every thread is a record of its own, exactly like on the server.
  const threadOf = (path: string) => path.split("/")[3] ?? "";
  const api: SupportDraftApiFn = async (path, options) => {
    const method = (options?.method ?? "GET").toUpperCase();
    calls.push({ path, method, body: options?.body });
    const threadId = threadOf(path);
    if (method === "GET") return stored.get(threadId) ?? null;
    if (method === "PUT") {
      if (gated) await gate.promise;
      stored.set(threadId, { body: String((options?.body as { body: string }).body) });
      return null;
    }
    if (method === "DELETE") {
      stored.delete(threadId);
      return null;
    }
    return null;
  };
  return {
    calls,
    api,
    getStored: (threadId: string) => stored.get(threadId) ?? null,
    /** Lets the pending PUT finish. */
    release: () => {
      gated = false;
      gate.resolve(null);
    },
  };
}

describe("LND-R5-01 and LND-R5-02: the send confirmation and the draft writes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the text that was typed while the message was on its way and saves it", async () => {
    const server = draftServer();
    server.release();
    const controller = createSupportDraftController({ api: server.api, formatError });

    await controller.openThread("thread-r5-1");
    controller.setBody("Ответ, который уходит клиенту");
    // The workspace captures the revision of the text it sends.
    const sentRevision = controller.getSnapshot().revision;
    // The operator types on while the message is on its way.
    controller.setBody("Новый текст, который ещё не отправлен");

    controller.markSent("thread-r5-1", sentRevision);
    await vi.advanceTimersByTimeAsync(800);
    await flush();

    expect(controller.getSnapshot().body).toBe("Новый текст, который ещё не отправлен");
    expect(server.getStored("thread-r5-1")?.body).toBe("Новый текст, который ещё не отправлен");
    expect(controller.getSnapshot().status).toBe("saved");
    expect(server.calls.filter(call => call.method === "DELETE")).toEqual([]);

    // A reload brings the newer text back.
    const reloaded = createSupportDraftController({ api: server.api, formatError });
    await reloaded.openThread("thread-r5-1");
    expect(reloaded.getSnapshot().body).toBe("Новый текст, который ещё не отправлен");
  });

  it("does not let a stale acknowledgement erase the new edit or change the selected thread", async () => {
    const server = draftServer();
    server.release();
    const controller = createSupportDraftController({ api: server.api, formatError });

    await controller.openThread("thread-a");
    controller.setBody("Ответ, который уходит клиенту");
    const sentRevision = controller.getSnapshot().revision;
    controller.setBody("Правка, написанная до подтверждения");

    // The operator opens another thread while the message is on its way.
    await controller.openThread("thread-b");
    controller.setBody("Ответ по второму обращению");

    controller.markSent("thread-a", sentRevision);
    await vi.advanceTimersByTimeAsync(800);
    await flush();

    // The acknowledgement of the sent message does not touch the selection.
    expect(controller.getSnapshot().threadId).toBe("thread-b");
    expect(controller.getSnapshot().body).toBe("Ответ по второму обращению");

    // The newer text of the first thread survived it and was saved.
    await controller.openThread("thread-a");
    expect(controller.getSnapshot().body).toBe("Правка, написанная до подтверждения");
    expect(server.getStored("thread-a")?.body).toBe("Правка, написанная до подтверждения");
  });

  it("deletes the stored draft of a cleared box even while the PUT of that box is running", async () => {
    const server = draftServer();
    const controller = createSupportDraftController({ api: server.api, formatError });

    await controller.openThread("thread-r5-2");
    controller.setBody("Черновик ответа");
    await vi.advanceTimersByTimeAsync(800);
    await flush();
    expect(server.calls.filter(call => call.method === "PUT")).toHaveLength(1);

    // The operator clears the box while the PUT is still running.
    controller.setBody("");
    server.release();
    await flush();

    // The server holds the text no more and the box is not stuck in a "dirty" state without a
    // pending save.
    expect(server.getStored("thread-r5-2")).toBeNull();
    expect(server.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(controller.getSnapshot().body).toBe("");
    expect(controller.getSnapshot().status).toBe("clean");
  });

  it("ends in the same state when the cleared text is typed again while the PUT is running", async () => {
    const server = draftServer();
    const controller = createSupportDraftController({ api: server.api, formatError });

    await controller.openThread("thread-r5-3");
    controller.setBody("Черновик ответа");
    await vi.advanceTimersByTimeAsync(800);
    await flush();

    controller.setBody("");
    controller.setBody("Черновик ответа");
    server.release();
    await flush();

    expect(server.getStored("thread-r5-3")?.body).toBe("Черновик ответа");
    expect(controller.getSnapshot().body).toBe("Черновик ответа");
    expect(controller.getSnapshot().status).toBe("saved");
    expect(server.calls.filter(call => call.method === "PUT")).toHaveLength(1);
    expect(server.calls.filter(call => call.method === "DELETE")).toEqual([]);
  });

  it("waits for the running PUT before it removes the sent answer from the server", async () => {
    const server = draftServer();
    const controller = createSupportDraftController({ api: server.api, formatError });

    await controller.openThread("thread-r5-4");
    controller.setBody("Отправленный ответ");
    await vi.advanceTimersByTimeAsync(800);
    await flush();

    const sentRevision = controller.getSnapshot().revision;
    controller.markSent("thread-r5-4", sentRevision);
    server.release();
    await flush();

    // The removal comes after the write that is still running, not before it.
    expect(server.calls.map(call => call.method)).toEqual(["GET", "PUT", "DELETE"]);
    expect(server.getStored("thread-r5-4")).toBeNull();
    expect(controller.getSnapshot().body).toBe("");
    expect(controller.getSnapshot().status).toBe("clean");

    // A reload does not bring the sent answer back as a draft.
    const reloaded = createSupportDraftController({ api: server.api, formatError });
    await reloaded.openThread("thread-r5-4");
    expect(reloaded.getSnapshot().body).toBe("");
  });

  it("removes the sent answer without waiting for the debounce", async () => {
    const server = draftServer();
    server.release();
    const controller = createSupportDraftController({ api: server.api, formatError });

    await controller.openThread("thread-r5-5");
    controller.setBody("Отправленный ответ");
    await vi.advanceTimersByTimeAsync(800);
    await flush();
    expect(server.getStored("thread-r5-5")?.body).toBe("Отправленный ответ");

    const sentRevision = controller.getSnapshot().revision;
    controller.markSent("thread-r5-5", sentRevision);
    await flush();

    expect(server.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(server.getStored("thread-r5-5")).toBeNull();
  });

  it("drops the draft of a closed thread and removes it from the server", async () => {
    const server = draftServer();
    server.release();
    const controller = createSupportDraftController({ api: server.api, formatError });

    await controller.openThread("thread-r5-6");
    controller.setBody("Черновик закрытого обращения");
    await vi.advanceTimersByTimeAsync(800);
    await flush();
    expect(server.getStored("thread-r5-6")?.body).toBe("Черновик закрытого обращения");

    controller.discardDraft("thread-r5-6");
    await flush();

    expect(controller.getSnapshot().body).toBe("");
    expect(controller.getSnapshot().status).toBe("clean");
    expect(server.getStored("thread-r5-6")).toBeNull();
    expect(server.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  });

  it("leaves every draft write of the workspace to the controller", async () => {
    const source = await readFile(
      new URL("../../apps/web/src/workspaces/SupportClaimsWorkspace.tsx", import.meta.url),
      "utf8",
    );
    // The workspace must not delete the draft behind the back of the controller: a DELETE that
    // overtakes a running PUT brings the sent answer back.
    expect(source).not.toMatch(/draft`[^\n]*method:\s*"DELETE"/);
    expect(source).toContain("markSent(targetThreadId, capturedRevision)");
    expect(source).toContain("discardDraft(targetThreadId)");
  });
});
