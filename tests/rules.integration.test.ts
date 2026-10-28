import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc, Timestamp } from "firebase/firestore";
import { deleteObject, getBytes, ref, uploadBytes } from "firebase/storage";

const ownerEmail = "mjvermeltfoort@gmail.com";
let env: RulesTestEnvironment;
function context(uid: string, email = ownerEmail, verified = true, provider = "google.com") {
  return env.authenticatedContext(uid, {
    email, email_verified: verified, firebase: { sign_in_provider: provider },
  });
}
const meeting = {
  ownerId: "owner", title: "Test", startedAt: Timestamp.fromMillis(1),
  status: "recording", createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1),
};

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-owner-access",
    firestore: { host: "127.0.0.1", port: 8080, rules: readFileSync("firestore.rules", "utf8") },
    storage: { host: "127.0.0.1", port: 9199, rules: readFileSync("storage.rules", "utf8") },
  });
  await env.withSecurityRulesDisabled(async (admin) => {
    await setDoc(doc(admin.firestore(), "users/owner/meetings/seed"), meeting);
    await uploadBytes(ref(admin.storage(), "users/owner/meetings/seed/recordings/seed"), new Uint8Array([1]), { contentType: "audio/webm" });
  });
}, 30000);
afterAll(async () => { await env?.cleanup(); });

describe("owner access rules", () => {
  it("allows the owner to create/read/list/update/delete their meetings and audio", async () => {
    const owner = context("owner");
    const meetingRef = doc(owner.firestore(), "users/owner/meetings/allowed");
    await assertSucceeds(setDoc(meetingRef, meeting));
    await assertSucceeds(getDoc(meetingRef));
    await assertSucceeds(getDocs(collection(owner.firestore(), "users/owner/meetings")));
    await assertSucceeds(updateDoc(meetingRef, { title: "Updated" }));
    await assertSucceeds(deleteDoc(meetingRef));
    const audio = ref(owner.storage(), "users/owner/meetings/allowed/recordings/audio");
    await assertSucceeds(uploadBytes(audio, new Uint8Array([1, 2]), { contentType: "audio/webm" }));
    await assertSucceeds(getBytes(audio));
    await assertSucceeds(deleteObject(audio));
  });

  it.each(["anonymous", "other", "unverified", "password", "missing-claims", "wrong-uid"])("denies %s", async (kind) => {
    const client = kind === "anonymous" ? env.unauthenticatedContext()
      : kind === "other" ? context("other", "someone@example.com")
      : kind === "unverified" ? context("owner", ownerEmail, false)
      : kind === "password" ? context("owner", ownerEmail, true, "password")
      : kind === "missing-claims" ? env.authenticatedContext("owner")
      : context("another-uid");
    const meetingRef = doc(client.firestore(), "users/owner/meetings/seed");
    await assertFails(getDoc(meetingRef));
    await assertFails(getDocs(collection(client.firestore(), "users/owner/meetings")));
    await assertFails(setDoc(doc(client.firestore(), "users/owner/meetings/denied"), meeting));
    await assertFails(updateDoc(meetingRef, { title: "Denied" }));
    await assertFails(deleteDoc(meetingRef));
    const audio = ref(client.storage(), "users/owner/meetings/seed/recordings/seed");
    await assertFails(getBytes(audio));
    await assertFails(uploadBytes(audio, new Uint8Array([3]), { contentType: "audio/webm" }));
    await assertFails(deleteObject(audio));
  });

  it("denies another verified Google user in their OWN subtree too", async () => {
    const other = context("other", "someone@example.com");
    await assertFails(setDoc(doc(other.firestore(), "users/other/meetings/test"), { ...meeting, ownerId: "other" }));
    await assertFails(getDocs(collection(other.firestore(), "users/other/meetings")));
    await assertFails(uploadBytes(ref(other.storage(), "users/other/meetings/test/recordings/1"), new Uint8Array([1]), { contentType: "audio/webm" }));
    await assertFails(setDoc(doc(other.firestore(), "users/other"), { email: ownerEmail, isAdmin: true }));
  });

  it("keeps existing owner and schema validation", async () => {
    const db = context("owner").firestore();
    const target = doc(db, "users/owner/meetings/seed");
    await assertFails(setDoc(doc(db, "users/owner/meetings/hijack"), { ...meeting, ownerId: "other" }));
    await assertFails(updateDoc(target, { ownerId: "other" }));
    await assertFails(updateDoc(target, { title: "x".repeat(241) }));
    await assertFails(updateDoc(target, { title: 123 }));
    await assertFails(updateDoc(target, { isAdmin: true }));
    await assertFails(setDoc(doc(db, "users/owner/meetings/missing"), { ownerId: "owner" }));
    await assertFails(getDocs(collection(db, "users")));
    await assertFails(getDoc(doc(db, "users/other")));
  });
});
