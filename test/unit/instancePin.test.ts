import { beforeEach, describe, expect, it } from "vitest";
import { getSettings, patchSettings } from "../../src/background/settings";
import { INSTANCES } from "../fixtures/chat";

describe("pinnedInstanceId settings round-trip", () => {
  beforeEach(async () => {
    await patchSettings({ instances: INSTANCES });
  });

  it("defaults to Auto (null)", async () => {
    expect((await getSettings()).pinnedInstanceId).toBeNull();
  });

  it("persists a pin to a known instance", async () => {
    await patchSettings({ pinnedInstanceId: "test" });
    expect((await getSettings()).pinnedInstanceId).toBe("test");
  });

  it("null clears the pin", async () => {
    await patchSettings({ pinnedInstanceId: "prod" });
    await patchSettings({ pinnedInstanceId: null });
    expect((await getSettings()).pinnedInstanceId).toBeNull();
  });

  it("rejects unknown ids on write and resolves stale stored ids to Auto", async () => {
    await patchSettings({ pinnedInstanceId: "not-an-instance" });
    expect((await getSettings()).pinnedInstanceId).toBeNull();
    // A pin whose instance later disappears must read as Auto, not a dead pin.
    await chrome.storage.local.set({ chatPinnedInstanceId: "ghost" });
    expect((await getSettings()).pinnedInstanceId).toBeNull();
  });
});
