import { describe, expect, it } from "vitest";
import { decideFollow, pickContext } from "../../src/background/instanceFollow";
import type { SnContext } from "../../src/shared/types";
import { DEV_HOST, INSTANCES, PROD_HOST } from "../fixtures/chat";

const ctx = (hostname: string, updatedAt: number): SnContext =>
  ({ hostname, instance: hostname.split(".")[0], updatedAt }) as SnContext;

describe("decideFollow", () => {
  const base = {
    pinnedInstanceId: null as string | null,
    senderTabActive: true,
    hostname: DEV_HOST,
    instances: INSTANCES,
  };

  it("follows the instance of the tab the user is viewing", () => {
    expect(decideFollow(base)).toEqual({ host: DEV_HOST, instance: INSTANCES[0] });
  });

  // Auto means "the page on screen", so an instance the user never added is
  // followed too — the agent works on it (asking before each change), not elsewhere.
  it("follows an instance that was never added, with no instance attached", () => {
    expect(decideFollow({ ...base, hostname: "dev12345.service-now.com" })).toEqual({ host: "dev12345.service-now.com", instance: null });
  });

  // Whichever background tab finishes loading last must not win the selection.
  it("never follows a background tab", () => {
    expect(decideFollow({ ...base, senderTabActive: false })).toBeNull();
  });

  it("never follows anything while pinned", () => {
    expect(decideFollow({ ...base, pinnedInstanceId: "test" })).toBeNull();
    expect(decideFollow({ ...base, pinnedInstanceId: "dev" })).toBeNull();
  });

  it("ignores pages that aren't ServiceNow", () => {
    expect(decideFollow({ ...base, hostname: "example.com" })).toBeNull();
    expect(decideFollow({ ...base, hostname: null })).toBeNull();
  });
});

describe("pickContext", () => {
  const dev1 = ctx(DEV_HOST, 100);
  const prod9 = ctx(PROD_HOST, 900);

  it("auto: bound tab wins, then the newest context anywhere", () => {
    expect(pickContext([dev1, prod9], dev1, null, false)).toBe(dev1);
    expect(pickContext([dev1, prod9], null, null, false)).toBe(prod9);
  });

  // The newest context on the preferred host must beat a newer context from
  // some other instance's tab.
  it("prefers the preferred host's newest context over a newer one elsewhere", () => {
    expect(pickContext([dev1, prod9], null, DEV_HOST, true)).toBe(dev1);
  });

  it("pinned: a bound tab on another host is ignored", () => {
    expect(pickContext([dev1, prod9], prod9, DEV_HOST, true)).toBe(dev1);
  });

  it("pinned with no matching context returns null — an honest No tab", () => {
    expect(pickContext([prod9], prod9, DEV_HOST, true)).toBeNull();
  });
});
