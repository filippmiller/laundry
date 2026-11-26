import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifyPartnerMoneyChanged,
  subscribeToPartnerMoneyRefresh,
} from "../../apps/web/src/workspaces/partner-money-refresh.js";

/**
 * The bus that tells the money panels that the money changed (LND-R4-06).
 *
 * The panels are plain React components and this repository has no DOM test harness, so the
 * behaviour of the bus itself is covered here as pure logic: who is called, who is not, and
 * what happens when a listener fails.
 */
describe("LND-R4-06: the partner money refresh bus", () => {
  const cleanups: Array<() => void> = [];

  function subscribe(listener: () => void): () => void {
    const unsubscribe = subscribeToPartnerMoneyRefresh(listener);
    cleanups.push(unsubscribe);
    return unsubscribe;
  }

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it("notifies a subscriber exactly once per notification", () => {
    const listener = vi.fn();
    subscribe(listener);

    notifyPartnerMoneyChanged();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies every subscriber", () => {
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    subscribe(first);
    subscribe(second);
    subscribe(third);

    notifyPartnerMoneyChanged();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(1);
  });

  it("does not notify a listener that unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    notifyPartnerMoneyChanged();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    notifyPartnerMoneyChanged();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the remaining listeners working when one of them throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = vi.fn(() => {
      throw new Error("панель не обновилась");
    });
    const healthy = vi.fn();
    subscribe(broken);
    subscribe(healthy);

    notifyPartnerMoneyChanged();

    expect(broken).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps a second subscriber alive when the first one unsubscribes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribe(first);
    subscribe(second);

    unsubscribeFirst();
    notifyPartnerMoneyChanged();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not loop when a listener notifies the bus again", () => {
    // The bus is one-way: the panels reload and never notify the bus themselves. A listener
    // that does it anyway must not start an endless reload of all panels.
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
      notifyPartnerMoneyChanged();
    });

    notifyPartnerMoneyChanged();

    expect(calls).toBe(1);
    unsubscribe();
  });

  it("reloads the workspace and the dispute list from one notification of the resolver", () => {
    // The finance workspace and the dispute list are separate panels: one notification of the
    // resolver has to reach both of them.
    const reloaded: string[] = [];
    const unsubscribeWorkspace = subscribe(() => {
      reloaded.push("workspace");
    });
    const unsubscribeDisputes = subscribe(() => {
      reloaded.push("disputes");
    });

    notifyPartnerMoneyChanged();

    expect(reloaded).toEqual(["workspace", "disputes"]);
    unsubscribeWorkspace();
    unsubscribeDisputes();
  });
});
