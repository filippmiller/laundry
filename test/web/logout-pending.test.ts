import { beforeEach, describe, expect, it } from "vitest";
import {
  PENDING_LOGOUT_KEY,
  bootstrapSessionWithPendingLogout,
  performServerLogout,
  type LogoutStorage,
} from "../../apps/web/src/auth-logout.js";

function createMemoryStorage(): LogoutStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

function makeHttpError(code: string, status: number): Error & { code: string; status: number } {
  return Object.assign(new Error(code), { code, status });
}

describe("LND-PRO-010: pending logout state and startup recovery", () => {
  let storage: LogoutStorage;

  beforeEach(() => {
    storage = createMemoryStorage();
  });

  it("(a) keeps PENDING_LOGOUT_KEY set and returns { completed: false } on network error", async () => {
    const result = await performServerLogout({
      storage,
      request: async () => {
        throw new Error("Failed to fetch");
      },
    });

    expect(result.completed).toBe(false);
    expect(result.error).toBe("Failed to fetch");
    expect(storage.getItem(PENDING_LOGOUT_KEY)).toBe("1");
  });

  it("(b) startup with PENDING_LOGOUT_KEY calls /auth/logout BEFORE /me and does NOT restore me if logout fails again", async () => {
    storage.setItem(PENDING_LOGOUT_KEY, "1");
    const calls: string[] = [];

    const boot = await bootstrapSessionWithPendingLogout<{ userId: string }>({
      storage,
      request: async <T>(path: string) => {
        calls.push(path);
        if (path === "/auth/logout") {
          throw new Error("Network offline");
        }
        return { userId: "user-1" } as T;
      },
    });

    expect(calls).toEqual(["/auth/logout"]);
    expect(boot.me).toBeNull();
    expect(boot.pendingLogout).toBe(true);
    expect(boot.logoutError).toBe("Network offline");
    expect(storage.getItem(PENDING_LOGOUT_KEY)).toBe("1");
  });

  it("(c) clears PENDING_LOGOUT_KEY when /auth/logout subsequently succeeds or returns 401", async () => {
    storage.setItem(PENDING_LOGOUT_KEY, "1");
    const calls: string[] = [];

    const bootSuccess = await bootstrapSessionWithPendingLogout<{ userId: string }>({
      storage,
      request: async <T>(path: string) => {
        calls.push(path);
        if (path === "/auth/logout") {
          return {} as T;
        }
        if (path === "/me") {
          throw makeHttpError("UNAUTHORIZED", 401);
        }
        return {} as T;
      },
    });

    expect(calls).toEqual(["/auth/logout", "/me"]);
    expect(bootSuccess.pendingLogout).toBe(false);
    expect(bootSuccess.logoutError).toBeNull();
    expect(bootSuccess.me).toBeNull();
    expect(storage.getItem(PENDING_LOGOUT_KEY)).toBeNull();

    // Also verify 401 from /auth/logout clears the pending marker.
    storage.setItem(PENDING_LOGOUT_KEY, "1");
    const retry401 = await performServerLogout({
      storage,
      request: async () => {
        throw makeHttpError("UNAUTHORIZED", 401);
      },
    });

    expect(retry401).toEqual({ completed: true, error: null });
    expect(storage.getItem(PENDING_LOGOUT_KEY)).toBeNull();
  });
});
