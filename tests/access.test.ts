import { describe, expect, it } from "vitest";
import type { User } from "firebase/auth";
import type { CallableRequest } from "firebase-functions/v2/https";
import { canUseApp } from "../src/lib/access";
import { requireOwnerAccess } from "../functions/src/access";
import { health, transcribeSegment, generateMeetingNotes } from "../functions/src/index";

const owner = "mjvermeltfoort@gmail.com";
function auth(email = owner, verified = true, provider = "google.com") {
  return {
    uid: "owner-uid",
    token: { email, email_verified: verified, firebase: { sign_in_provider: provider } },
  } as CallableRequest["auth"];
}
function request(identity: CallableRequest["auth"]) {
  return { auth: identity, data: {} } as CallableRequest;
}

describe("server access", () => {
  it("accepts the verified Google owner", async () => {
    expect(requireOwnerAccess(auth())).toBe("owner-uid");
    await expect(health.run(request(auth()))).resolves.toEqual({ service: "ai-vergadersecretaris", status: "ok" });
  });

  it.each([
    ["no login", undefined, "unauthenticated"],
    ["another Google account", auth("someone@example.com"), "permission-denied"],
    ["unverified email", auth(owner, false), "permission-denied"],
    ["password login", auth(owner, true, "password"), "permission-denied"],
    ["custom token", auth(owner, true, "custom"), "permission-denied"],
    ["missing claims", { uid: "owner-uid", token: {} }, "permission-denied"],
  ])("blocks %s before input validation or AI work", async (_label, identity, code) => {
    const req = request(identity as CallableRequest["auth"]);
    await expect(health.run(req)).rejects.toMatchObject({ code });
    await expect(transcribeSegment.run(req)).rejects.toMatchObject({ code });
    await expect(generateMeetingNotes.run(req)).rejects.toMatchObject({ code });
  });

  it("allows the owner through to input validation", async () => {
    await expect(transcribeSegment.run(request(auth()))).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(generateMeetingNotes.run(request(auth()))).rejects.toMatchObject({ code: "invalid-argument" });
  });
});

describe("client access", () => {
  const user = { email: owner, emailVerified: true, providerData: [{ providerId: "google.com" }] } as User;
  it("only enables the verified Google owner", () => {
    expect(canUseApp(user)).toBe(true);
    expect(canUseApp(null)).toBe(false);
    expect(canUseApp({ ...user, email: "someone@example.com" })).toBe(false);
    expect(canUseApp({ ...user, emailVerified: false })).toBe(false);
    expect(canUseApp({ ...user, providerData: [] })).toBe(false);
  });
});
