import { describe, expect, it } from "vitest";
import {
  createRequestGeneration,
  type RequestToken,
} from "../../apps/web/src/workspaces/request-generation.js";

/**
 * The late-answer guard of the panels that hold one current value of the server
 * (finance analytics, fiscal receipts, stuck orders).
 *
 * Such a panel can be refreshed while the previous request is still running. The answer that
 * arrives last is not the newest answer: on a slow network the first answer was still in flight
 * when the second request was started, so it landed on the screen afterwards and overwrote the
 * fresh numbers (the browser showed 5770,00 ₽ while the server had 4770,00 ₽). The same class of
 * defect that wave 8 closed for the dispute list (LND-R5-03) was never applied to these panels.
 *
 * The panels are React components and this repository has no DOM test harness, so the guard is
 * driven here without React: the harness below performs exactly the steps the panels perform —
 * open a request with beginFresh(), then write its answer only while generation.isCurrent(token)
 * holds. The generation module is therefore the single place where the rule lives, and this test
 * pins the guarantees the panels rely on.
 */

type Value = { receivableKopeks: number };

/** Everything a single-value panel shows. */
type PanelState = {
  value: Value | null;
  error: string | null;
  busy: boolean;
};

function createHarness() {
  const generation = createRequestGeneration();
  let state: PanelState = { value: null, error: null, busy: false };

  /** Opens a request exactly like the panels do. */
  const start = (): RequestToken => {
    const token = generation.beginFresh();
    state = { ...state, error: null, busy: true };
    return token;
  };

  /** The answer of a request arrives. */
  const succeed = (token: RequestToken, value: Value) => {
    if (!generation.isCurrent(token)) return;
    state = { value, error: null, busy: false };
  };

  /** The answer of a request fails. */
  const fail = (token: RequestToken, message: string) => {
    if (!generation.isCurrent(token)) return;
    state = { ...state, error: message, busy: false };
  };

  /** The generation is closed without starting a request — e.g. the panel was left behind. */
  const invalidate = () => generation.invalidate();

  return {
    start,
    succeed,
    fail,
    invalidate,
    state: () => state,
    generation,
  };
}

const freshValue: Value = { receivableKopeks: 477_000 };
const staleValue: Value = { receivableKopeks: 577_000 };

describe("the late-answer guard of the single-value panels", () => {
  it("keeps the newest value when the older answer arrives late", () => {
    const harness = createHarness();

    const older = harness.start();
    const newer = harness.start();

    // The newer request answers first…
    harness.succeed(newer, freshValue);
    // …and the answer of the older request lands afterwards.
    harness.succeed(older, staleValue);

    expect(harness.state().value).toEqual(freshValue);
    expect(harness.state().error).toBeNull();
    expect(harness.state().busy).toBe(false);
  });

  it("shows no error of a stale request and keeps the spinner of the running one", () => {
    const harness = createHarness();

    const older = harness.start();
    // The newer request is still running — its token is not needed here.
    harness.start();

    // The older request fails while the newer one is still running.
    harness.fail(older, "старый запрос не загрузился");

    expect(harness.state().error).toBeNull();
    expect(harness.state().busy).toBe(true);
  });

  it("lets the newest answer win and clears the spinner", () => {
    const harness = createHarness();

    const older = harness.start();
    const newer = harness.start();

    harness.succeed(newer, freshValue);

    expect(harness.state().value).toEqual(freshValue);
    expect(harness.state().busy).toBe(false);

    // The older answer arrives afterwards and changes nothing at all.
    harness.succeed(older, staleValue);

    expect(harness.state().value).toEqual(freshValue);
    expect(harness.state().busy).toBe(false);
  });

  it("shows the error of the current request and stops its spinner", () => {
    const harness = createHarness();

    const request = harness.start();
    harness.fail(request, "сервер недоступен");

    expect(harness.state().error).toBe("сервер недоступен");
    expect(harness.state().busy).toBe(false);
  });

  it("closes every issued token when the generation is invalidated", () => {
    const generation = createRequestGeneration();
    const first = generation.beginFresh();
    const second = generation.beginFresh();

    generation.invalidate();

    expect(generation.isCurrent(first)).toBe(false);
    expect(generation.isCurrent(second)).toBe(false);
  });

  it("drops the answer of a request that was invalidated", () => {
    const harness = createHarness();

    const request = harness.start();
    harness.invalidate();
    harness.succeed(request, staleValue);

    expect(harness.state().value).toBeNull();
  });

  it("loads again after the generation was invalidated", () => {
    const harness = createHarness();

    const closed = harness.start();
    harness.invalidate();

    // The panel reloads — a new generation is opened and its answer is accepted.
    const reopened = harness.start();
    harness.succeed(reopened, freshValue);

    expect(harness.state().value).toEqual(freshValue);
    expect(harness.state().busy).toBe(false);
    // The token of the closed generation stays dead.
    expect(harness.generation.isCurrent(closed)).toBe(false);
  });
});
