import type { User } from "firebase/auth";

// UX check only; Functions and Security Rules enforce access independently.
// Keep in sync with functions/src/access.ts, firestore.rules and storage.rules.
export function canUseApp(user: User | null): boolean {
  return user !== null
    && user.email === "mjvermeltfoort@gmail.com"
    && user.emailVerified
    && user.providerData.some((provider) => provider.providerId === "google.com");
}
