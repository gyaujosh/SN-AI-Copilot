// Adding an instance: what counts as a ServiceNow host, and the environment the
// form suggests for it. A wrong suggestion may only ever withhold write access.
import { describe, expect, it } from "vitest";
import { parseInstanceHost } from "../../src/shared/connection";
import { allowsChanges, isWritableRole, suggestRole } from "../../src/shared/types";

describe("parseInstanceHost", () => {
  it.each([
    ["dev12345.service-now.com", "dev12345.service-now.com"],
    ["  https://Acme.service-now.com/nav_to.do?uri=incident.do  ", "acme.service-now.com"],
    ["http://acme-dev.service-now.com#frag", "acme-dev.service-now.com"],
    ["acme.service-now.com:443", "acme.service-now.com"],
    ["acme.service-now.com.", "acme.service-now.com"],
    ["acme.service-now.com:8443", null],
    ["acme.service-now.com.evil.example", null],
    ["service-now.com", null],
    ["example.com", null],
    ["", null],
  ])("%j → %j", (input, host) => {
    expect(parseInstanceHost(input)).toBe(host);
  });
});

describe("suggestRole", () => {
  it.each([
    ["dev12345.service-now.com", "dev"],
    ["acmedev.service-now.com", "dev"],
    ["acme-dev-2.service-now.com", "dev"],
    ["acmesandbox.service-now.com", "sand"],
    ["acmesbx.service-now.com", "sand"],
    ["acmetest.service-now.com", "test"],
    ["acmeuat.service-now.com", "test"],
    ["acmeqa1.service-now.com", "test"],
    ["acmestage.service-now.com", "stage"],
    ["acmestg.service-now.com", "stage"],
    ["acme.service-now.com", "prod"],
    ["acme-sand.service-now.com", "sand"],
    // Company names that merely contain the letters are not development instances.
    ["devonfield.service-now.com", "prod"],
    ["quicksandco.service-now.com", "prod"],
    ["developerco.service-now.com", "prod"],
    ["thousand.service-now.com", "prod"],
    ["quicksand.service-now.com", "prod"],
    ["sand2go.service-now.com", "prod"],
    ["acmesand.service-now.com", "prod"],
    // A name that says production is Production, whatever else it says.
    ["acme-dev-prod.service-now.com", "prod"],
    ["acme-prod-dev.service-now.com", "prod"],
    ["acme-sandbox-prd.service-now.com", "prod"],
    ["acmeprod.service-now.com", "prod"],
    ["acme-live.service-now.com", "prod"],
  ])("%s → %s", (host, role) => {
    expect(suggestRole(host)).toBe(role);
  });

  it("every environment but Production is writable", () => {
    expect(["sand", "dev", "test", "stage", "prod"].filter((r) => isWritableRole(r as any))).toEqual(["sand", "dev", "test", "stage"]);
    expect(isWritableRole(null)).toBe(false);
  });

  it("allows changes on every instance but one marked Production, one never added included", () => {
    expect(allowsChanges(null)).toBe(true);
    expect(allowsChanges({ id: "d", label: "Dev", host: "exampledev.service-now.com", role: "dev" })).toBe(true);
    expect(allowsChanges({ id: "p", label: "Prod", host: "example.service-now.com", role: "prod" })).toBe(false);
  });
});
