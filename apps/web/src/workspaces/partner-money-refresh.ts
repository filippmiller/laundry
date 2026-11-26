/**
 * A tiny publish/subscribe bus for the partner money panels.
 *
 * Resolving a dispute, approving a payout or opening a dispute changes the money, but the
 * button that changes it and the panels that show the money live in different parts of the
 * tree. Without a bus the sums stayed stale until the whole page was reloaded: the operator
 * saw a closed dispute still counted as contested and a payable that had already been paid out.
 *
 * The bus carries no state, no timers and no React dependency on purpose: a panel subscribes
 * on mount, reloads its data when notified and unsubscribes when it goes away. That also makes
 * the behaviour testable without a DOM.
 */

type PartnerMoneyRefreshListener = () => void;

const listeners = new Set<PartnerMoneyRefreshListener>();

/**
 * Registers a listener and returns the function that removes it again.
 *
 * The returned function belongs in the effect cleanup — a panel that never unsubscribes keeps
 * reloading after it left the screen.
 */
export function subscribeToPartnerMoneyRefresh(listener: PartnerMoneyRefreshListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tells every panel that the money changed.
 *
 * A listener that throws must not keep the other panels stale, so the failure is reported and
 * the remaining listeners are still called.
 */
export function notifyPartnerMoneyChanged(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      console.error("Панель денежных данных не обновилась", error);
    }
  }
}
