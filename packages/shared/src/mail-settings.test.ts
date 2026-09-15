import { describe, expect, it } from "vitest";
import { isMailFrom, isMailHost, normalizeMailSettings } from "./mail-settings-schema";

describe("mail settings", () => {
  it("takes a sender as an address or 'Name <address>', never with header characters", () => {
    for (const ok of ["hello@shop.in", "Acme Prints <hello@shop.in>", '"Acme, Pune" <hello@shop.in>']) expect(isMailFrom(ok), ok).toBe(true);
    for (const bad of ["", "Acme", "Acme <nope>", "a@b.in\r\nBcc: x@y.z", "<a@b.in> extra"]) expect(isMailFrom(bad), bad).toBe(false);
  });

  it("takes SMTP hosts, not URLs", () => {
    expect(isMailHost("smtp.gmail.com")).toBe(true);
    expect(isMailHost("10.0.0.5")).toBe(true);
    expect(isMailHost("smtp://smtp.gmail.com")).toBe(false);
    expect(isMailHost("-bad.host")).toBe(false);
  });

  it("hardens a stored blob: bad fields blanked, mail left off rather than half-set", () => {
    expect(normalizeMailSettings(null)).toBeNull();
    const n = normalizeMailSettings({ enabled: true, provider: "smtp", to: "nope", from: "Shop <s@shop.in>", smtp: { host: "smtp.x.in", port: 99999, user: "u" } })!;
    expect(n).toMatchObject({ enabled: true, provider: "smtp", to: "", from: "Shop <s@shop.in>", smtp: { host: "smtp.x.in", port: 587, secure: false, user: "u", passSealed: "" } });
    expect(normalizeMailSettings({ provider: "carrier-pigeon" })!.provider).toBe("resend");
  });
});
