// Characterizes the page-context transport in public/inject.js: the envelope
// now carries the HTTP status, and a missing top-window g_ck falls back to
// gsft_main's token. Harness constraints, all inherited from the script itself:
// it must be loaded ONCE per file (the __snaiInjected_* self-guard turns a
// reload into a no-op), every dispatch needs a fresh requestId (the dedupe set
// persists for the life of the window), and the fetch stub must answer
// headers.get("content-length") or every response falls into the empty-body
// branch.
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(process.cwd(), "public/inject.js"), "utf8");
new Function(src)();

let rid = 0;
const nextId = () => `inject-test-${++rid}`;
const REC = "a".repeat(32);

interface ApiEnvelope {
  requestId: string;
  data: unknown;
  error: string | null;
  status?: number;
}

function callApi(detail: Record<string, unknown>): Promise<ApiEnvelope> {
  return new Promise((resolve) => {
    const onResp = (e: Event) => {
      const d = (e as CustomEvent).detail as ApiEnvelope;
      if (d.requestId !== detail.requestId) return;
      document.removeEventListener("snai2-api-response", onResp);
      resolve(d);
    };
    document.addEventListener("snai2-api-response", onResp);
    document.dispatchEvent(new CustomEvent("snai2-api-request", { detail }));
  });
}

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

function emptyResponse(status: number) {
  return {
    status,
    headers: { get: (name: string) => (name === "content-length" ? "0" : null) },
    json: async () => {
      throw new Error("empty body must not be parsed");
    },
  };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).g_ck;
  document.getElementById("gsft_main")?.remove();
  vi.unstubAllGlobals();
});

describe("inject.js api transport", () => {
  it("a parseable 401 emits envelope status 401, data._status 401, and error null", async () => {
    const body = { error: { message: "User Not Authenticated" }, status: "failure" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, body)));

    const resp = await callApi({ requestId: nextId(), url: `/api/now/table/incident/${REC}`, method: "PATCH", body: { state: "2" } });
    expect(resp.error).toBeNull();
    expect(resp.status).toBe(401);
    expect((resp.data as { _status?: number })._status).toBe(401);
    expect((resp.data as { error?: { message?: string } }).error?.message).toBe("User Not Authenticated");
  });

  it("a 204 carries status without parsing a body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => emptyResponse(204)));

    const resp = await callApi({ requestId: nextId(), url: `/api/now/table/x/${REC}`, method: "DELETE" });
    expect(resp.error).toBeNull();
    expect(resp.status).toBe(204);
    expect(resp.data).toEqual({ _status: 204 });
  });

  it("a network failure emits error and no status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Failed to fetch");
    }));

    const resp = await callApi({ requestId: nextId(), url: "/api/now/table/x", method: "GET" });
    expect(resp.error).toBe("Failed to fetch");
    expect(resp.data).toBeNull();
    expect(resp.status).toBeUndefined();
  });

  it("a login page (non-JSON 200) reports _parseError with the status kept", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    })));

    const resp = await callApi({ requestId: nextId(), url: "/api/now/table/x", method: "GET" });
    expect(resp.error).toBeNull();
    expect(resp.status).toBe(200);
    expect(resp.data).toEqual({ _status: 200, _parseError: true });
  });

  it("a PATCH with no top-window g_ck sends gsft_main's token as X-UserToken", async () => {
    const frame = document.createElement("iframe");
    frame.id = "gsft_main";
    document.body.appendChild(frame);
    (frame.contentWindow as unknown as Record<string, unknown>).g_ck = "frame-token";

    const fetchMock = vi.fn(async () => jsonResponse(200, { result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await callApi({ requestId: nextId(), url: `/api/now/table/incident/${REC}`, method: "PATCH", body: { state: "2" } });
    const headers = (fetchMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    expect(headers.headers["X-UserToken"]).toBe("frame-token");
  });

  it("the top-window token wins when both exist", async () => {
    (window as unknown as Record<string, unknown>).g_ck = "top-token";
    const frame = document.createElement("iframe");
    frame.id = "gsft_main";
    document.body.appendChild(frame);
    (frame.contentWindow as unknown as Record<string, unknown>).g_ck = "frame-token";

    const fetchMock = vi.fn(async () => jsonResponse(200, { result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await callApi({ requestId: nextId(), url: "/api/now/table/x", method: "POST", body: { a: 1 } });
    const opts = (fetchMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string>; body: string };
    expect(opts.headers["X-UserToken"]).toBe("top-token");
    expect(opts.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("with no token anywhere the request still goes out, without X-UserToken", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await callApi({ requestId: nextId(), url: "/api/now/table/x", method: "GET" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    expect("X-UserToken" in headers.headers).toBe(false);
  });

  // The relay carries the user's session token, so a path it is handed can
  // never reach anything but one table or one record of the Table/Aggregate APIs.
  it.each([
    "/api/now/table/../../../cache.do#",
    "/api/now/table/incident/../../../../logout.do",
    "/xmlhttp.do?sysparm_processor=AnyProcessor",
    "/api/now/ui/concoursepicker/updateset",
    "https://evil.example/api/now/table/incident",
    "//evil.example/api/now/table/incident",
    "/api/now/table/incident/not-a-sys-id",
  ])("refuses %s without making the request", async (url) => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { result: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const resp = await callApi({ requestId: nextId(), url, method: "GET" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resp.status).toBe(400);
    expect(JSON.stringify(resp.data)).toContain("Blocked");
  });
});


it("the actual page helper answers a versioned readiness nonce", () => {
  const listener = vi.fn();
  document.addEventListener("snai2-health-response", listener);
  document.dispatchEvent(new CustomEvent("snai2-health-request", { detail: { nonce: "probe-1", version: 1 } }));
  expect(listener).toHaveBeenCalledOnce();
  expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ nonce: "probe-1", version: 1 });
  document.removeEventListener("snai2-health-response", listener);

});
