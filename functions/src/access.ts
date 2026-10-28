import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";

// Keep in sync with src/lib/access.ts, firestore.rules and storage.rules.
export const OWNER_EMAIL = "mjvermeltfoort@gmail.com";

export function requireOwnerAccess(auth: CallableRequest["auth"]): string {
  if (!auth) throw new HttpsError("unauthenticated", "Log in met je Google-account.");
  if (auth.token.email !== OWNER_EMAIL
      || auth.token.email_verified !== true
      || auth.token.firebase?.sign_in_provider !== "google.com") {
    throw new HttpsError("permission-denied", "Dit account heeft geen toegang tot deze app.");
  }
  return auth.uid;
}
