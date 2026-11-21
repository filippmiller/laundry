export const PENDING_LOGOUT_KEY = "laundry:pending-logout";

export interface LogoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type LogoutRequestFn = <T = unknown>(
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<T>;

function defaultStorage(): LogoutStorage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? (globalThis.localStorage as LogoutStorage)
      : null;
  } catch {
    return null;
  }
}

function isUnauthorizedError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: unknown }).status === 401
  );
}

function extractLogoutErrorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const record = err as { serverMessage?: unknown; code?: unknown; message?: unknown };
    if (typeof record.serverMessage === "string" && record.serverMessage.length > 0) {
      return record.serverMessage;
    }
    if (typeof record.code === "string" && record.code.length > 0) {
      return record.code;
    }
    if (typeof record.message === "string" && record.message.length > 0) {
      return record.message;
    }
  }
  return "NETWORK_ERROR";
}

export function hasPendingLogout(storage: LogoutStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(PENDING_LOGOUT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPendingLogoutStorage(
  pending: boolean,
  storage: LogoutStorage | null = defaultStorage(),
): void {
  try {
    if (!storage) return;
    if (pending) {
      storage.setItem(PENDING_LOGOUT_KEY, "1");
    } else {
      storage.removeItem(PENDING_LOGOUT_KEY);
    }
  } catch {
    // Ignore storage quota or privacy-mode errors.
  }
}

export async function performServerLogout(deps: {
  request: LogoutRequestFn;
  storage?: LogoutStorage | null;
}): Promise<{ completed: boolean; error: string | null }> {
  const storage = deps.storage !== undefined ? deps.storage : defaultStorage();
  try {
    await deps.request("/auth/logout", { method: "POST", body: {} });
    setPendingLogoutStorage(false, storage);
    return { completed: true, error: null };
  } catch (err) {
    if (isUnauthorizedError(err)) {
      setPendingLogoutStorage(false, storage);
      return { completed: true, error: null };
    }
    const message = extractLogoutErrorMessage(err);
    setPendingLogoutStorage(true, storage);
    return { completed: false, error: message };
  }
}

export async function bootstrapSessionWithPendingLogout<TMe>(deps: {
  request: LogoutRequestFn;
  storage?: LogoutStorage | null;
}): Promise<{
  me: TMe | null;
  pendingLogout: boolean;
  logoutError: string | null;
}> {
  const storage = deps.storage !== undefined ? deps.storage : defaultStorage();

  if (hasPendingLogout(storage)) {
    const res = await performServerLogout({ request: deps.request, storage });
    if (!res.completed) {
      return {
        me: null,
        pendingLogout: true,
        logoutError: res.error,
      };
    }
  }

  try {
    const me = await deps.request<TMe>("/me");
    return { me, pendingLogout: false, logoutError: null };
  } catch {
    return { me: null, pendingLogout: false, logoutError: null };
  }
}
