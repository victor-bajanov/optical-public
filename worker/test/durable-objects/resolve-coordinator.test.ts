import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import {
  __setReplanRunnerForTests,
  __setWebhookReplanForTests,
  defaultRunner,
} from "../../src/durable-objects/resolve-coordinator";

describe("ResolveCoordinator", () => {
  let calls: string[];
  // DOs whose storage must be cleared after each test. Leaving a DO's SQLite
  // WAL/alarm live at suite teardown races the vitest-pool-workers isolated-
  // storage snapshot ("Isolated storage failed" on a stray .sqlite-shm), so we
  // delete each touched DO's storage to force a clean checkpoint between tests.
  let touched: ReturnType<typeof env.RESOLVE_COORDINATOR.get>[];

  function coordinatorFor(name: string) {
    const stub = env.RESOLVE_COORDINATOR.get(env.RESOLVE_COORDINATOR.idFromName(name));
    touched.push(stub);
    return stub;
  }

  beforeEach(() => {
    calls = [];
    touched = [];
    __setReplanRunnerForTests(async (_env, account) => { calls.push(account); });
  });
  afterEach(async () => {
    __setReplanRunnerForTests(null);
    __setWebhookReplanForTests(null);
    for (const stub of touched) {
      await runInDurableObject(stub, async (_inst, state) => {
        await state.storage.deleteAlarm();
        await state.storage.deleteAll();
      });
    }
  });

  it("coalesces a burst of notifyChange into one alarm and one resolve", async () => {
    const stub = coordinatorFor("a@example.com");
    await runInDurableObject(stub, (inst) => inst.notifyChange("a@example.com"));
    await runInDurableObject(stub, (inst) => inst.notifyChange("a@example.com"));
    await runInDurableObject(stub, (inst) => inst.notifyChange("a@example.com"));

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(calls).toEqual(["a@example.com"]);
    // No second alarm is pending after a coalesced burst.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("schedules a fresh resolve for changes arriving after a resolve completes", async () => {
    const stub = coordinatorFor("b@example.com");
    await runInDurableObject(stub, (inst) => inst.notifyChange("b@example.com"));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(calls).toEqual(["b@example.com"]);

    await runInDurableObject(stub, (inst) => inst.notifyChange("b@example.com"));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(calls).toEqual(["b@example.com", "b@example.com"]);
  });

  it("does nothing on alarm if no account was recorded", async () => {
    const stub = coordinatorFor("c@example.com");
    // No notifyChange: manually set a far-future alarm and fire it manually.
    // A near-now alarm (e.g. now+1ms) races the real workerd alarm scheduler,
    // which can auto-fire and clear it before runDurableObjectAlarm reads it,
    // making the manual trigger flakily observe no pending alarm.
    await runInDurableObject(stub, (_inst, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("warns with the unsat core when the resolve is unsatisfiable", async () => {
    const unsatCore = ["task:42", "block:0900-0930"];
    __setWebhookReplanForTests(async () => ({ kind: "unsat", unsatCore }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await defaultRunner(env, "u@example.com");
    expect(warn).toHaveBeenCalledWith("resolve_coordinator_unsat", {
      account: "u@example.com",
      unsatCore,
    });
    warn.mockRestore();
  });

  it("does not warn for a satisfiable resolve", async () => {
    __setWebhookReplanForTests(async () => ({
      kind: "replanned",
      planHash: "h",
      sent: true,
      model: {} as never,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await defaultRunner(env, "ok@example.com");
    expect(warn).not.toHaveBeenCalledWith(
      "resolve_coordinator_unsat",
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("reset() clears pending alarm and all storage keys", async () => {
    const stub = coordinatorFor("reset@example.com");

    // Arm a debounce so the DO has an alarm + storage entries.
    await runInDurableObject(stub, (inst) => inst.notifyChange("reset@example.com"));

    // Verify the alarm is set and storage is non-empty before resetting.
    const alarmBefore = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(alarmBefore).not.toBeNull();

    await runInDurableObject(stub, (inst) => inst.reset());

    // After reset, alarm must be gone.
    const alarmAfter = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(alarmAfter).toBeNull();

    // After reset, no storage keys should remain.
    const storageAfter = await runInDurableObject(stub, (_inst, state) => state.storage.list());
    expect(storageAfter.size).toBe(0);
  });
});
