import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallableRequest } from "firebase-functions/v2/https";
import { createVoiceSession, updateMeetingActionItem } from "../functions/src/index";
import { mintVoiceSecret, reviseActionItems, validateActionItemUpdate } from "../functions/src/voice";

const owner = { uid: "owner", token: { email: "mjvermeltfoort@gmail.com", email_verified: true, firebase: { sign_in_provider: "google.com" } } };
const patch = { meetingId: "m1", expectedRevision: "rev1", itemIndex: 0, description: "Planning", owner: "Mark", deadline: "Donderdag" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("voice backend", () => {
  it("returns only a short-lived client secret using the server key", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 123, secret_server_field: "hidden" }), { status: 200 }));
    const result = await mintVoiceSecret("server-test-key", fetcher);
    expect(result.value).toBe("ek_test");
    expect(JSON.stringify(result)).not.toContain("server-test-key");
    expect(JSON.stringify(result)).not.toContain("secret_server_field");
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.expires_after.seconds).toBe(60);
    expect(body.session.audio.input.turn_detection.interrupt_response).toBe(true);
    expect(body.session.tools[0].name).toBe("propose_action_item_update");
  });
  it("does not expose upstream errors or keys", async () => {
    const fetcher = vi.fn(async () => new Response("private error", { status: 401 }));
    await expect(mintVoiceSecret("server-test-key", fetcher)).rejects.toMatchObject({ code: "failed-precondition" });
  });
  it.each([undefined, { ...owner, token: { ...owner.token, email: "someone@example.com" } }, { ...owner, token: { ...owner.token, email_verified: false } }])("denies unauthorized access before API or database work", async (auth) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const req = { auth, data: patch } as unknown as CallableRequest;
    await expect(createVoiceSession.run(req)).rejects.toMatchObject({ code: auth ? "permission-denied" : "unauthenticated" });
    await expect(updateMeetingActionItem.run(req)).rejects.toMatchObject({ code: auth ? "permission-denied" : "unauthenticated" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects invalid meetings and edits for the owner before external work", async () => {
    await expect(createVoiceSession.run({ auth: owner, data: { meetingId: "../other" } } as unknown as CallableRequest)).rejects.toMatchObject({ code: "invalid-argument" });
    for (const input of [null, {}, { ...patch, itemIndex: -1 }, { ...patch, owner: 1 }, { ...patch, description: "" }, { ...patch, expectedRevision: "" }]) expect(() => validateActionItemUpdate(input)).toThrow();
  });
});

describe("confirmed action-item updates", () => {
  const oldItem = { description: "Oude planning", owner: null, deadline: null, status: "needs_clarification" };
  it("rejects stale revisions and missing items", () => {
    expect(() => reviseActionItems({ revision: "new", actionItems: [oldItem] }, patch)).toThrow("intussen gewijzigd");
    expect(() => reviseActionItems({ revision: "rev1", actionItems: [] }, patch)).toThrow("bestaat niet");
  });
  it("changes only the selected action and derives its readiness", () => {
    const notes = { revision: "rev1", actionItems: [oldItem, oldItem] };
    const items = reviseActionItems(notes, patch);
    expect(items[0]).toEqual({ description: "Planning", owner: "Mark", deadline: "Donderdag", status: "ready" });
    expect(items[1]).toBe(oldItem);
    expect(notes.actionItems[0]).toBe(oldItem);
    expect(reviseActionItems(notes, { ...patch, owner: " " })[0]).toMatchObject({ owner: null, status: "needs_clarification" });
  });
});
