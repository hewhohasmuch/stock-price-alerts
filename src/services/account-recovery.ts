// Account recovery: forgot/reset password, change password, email verification.
// No Express and no SQL here — storage and email are injected (see createAccountRecovery).
// Spec: docs/superpowers/specs/2026-10-04-account-recovery-design.md
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

export const PASSWORD_MIN_CHARS = 15;
export const PASSWORD_MAX_CHARS = 64;
export const BCRYPT_MAX_BYTES = 72;
export const RESET_TTL_MINUTES = 30;
export const VERIFY_TTL_MINUTES = 24 * 60;
export const MAX_RESETS_PER_ACCOUNT_PER_HOUR = 3;
export const MAX_EMAILS_PER_ADDRESS_PER_HOUR = 5;

export const EXPIRED_LINK_ERROR = "This link has expired or was already used.";

/** Returns an error message, or null when the password is acceptable for a NEW password. */
export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required.";
  const chars = [...password].length;            // count code points, not UTF-16 units
  if (chars < PASSWORD_MIN_CHARS) return `Password must be at least ${PASSWORD_MIN_CHARS} characters.`;
  if (chars > PASSWORD_MAX_CHARS) return `Password must be at most ${PASSWORD_MAX_CHARS} characters.`;
  if (Buffer.byteLength(password, "utf8") > BCRYPT_MAX_BYTES) {
    return "Password is too long once encoded; please use fewer special characters.";
  }
  return null;
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A session is valid only while its stored version matches the user's current session_version.
 * Sessions created before this feature have no version and count as 0 (every user starts at 0).
 */
export function isSessionCurrent(sessionVersion: number | undefined, currentVersion: number | null): boolean {
  return currentVersion !== null && (sessionVersion ?? 0) === currentVersion;
}

export type TokenPurpose = "reset" | "verify_email";

export interface RecoveryTarget { userId: string; username: string; email: string }

export interface AccountStore {
  /** Accounts matching a username or a VERIFIED email (case-insensitive) that have a verified email. */
  findRecoveryTargets(identifier: string): Promise<RecoveryTarget[]>;
  /**
   * In one transaction with the user row locked: check throttles, invalidate the user's open
   * tokens of this purpose, insert the new token. Returns false (and changes nothing) if throttled.
   */
  issueToken(args: {
    userId: string; purpose: TokenPurpose; email: string; tokenHash: string; ttlMinutes: number;
    maxPerAccountPerHour: number | null; maxPerAddressPerHour: number;
  }): Promise<boolean>;
  /** Claim a reset token and set the new password hash, bump session_version, invalidate the
   *  user's other reset tokens — all in one transaction. Null if expired/used/unknown. */
  consumeResetToken(tokenHash: string, newPasswordHash: string): Promise<RecoveryTarget | null>;
  /** Lock the user, check the current password with `verify`, set the new hash, bump
   *  session_version, invalidate open reset tokens — one transaction. */
  changePassword(
    userId: string,
    verify: (currentHash: string) => Promise<boolean>,
    newPasswordHash: string,
  ): Promise<{ status: "ok"; sessionVersion: number; username: string; email: string | null }
           | { status: "wrong-password" | "no-user" }>;
  /** Claim a verify token; set notification_email + email_verified_at; invalidate open reset
   *  tokens — one transaction. Returns the previous verified address (if any) for notification. */
  consumeVerifyToken(tokenHash: string):
    Promise<{ userId: string; username: string; email: string; previousEmail: string | null } | null>;
  getUsername(userId: string): Promise<string | null>;
}

export interface Mailer {
  sendResetLink(to: string, username: string, link: string): Promise<void>;
  sendVerifyLink(to: string, username: string, link: string): Promise<void>;
  sendPasswordChanged(to: string, username: string): Promise<void>;
  sendEmailChanged(to: string, username: string, newEmail: string): Promise<void>;
}

export interface RecoveryDeps {
  store: AccountStore;
  mailer: Mailer;
  /** Trusted base URL, e.g. https://wekintech.com — never derived from request headers. */
  appUrl: string | null;
  bcryptCost?: number;
  log?: (msg: string) => void;
}

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export function createAccountRecovery(deps: RecoveryDeps) {
  const { store, mailer, appUrl } = deps;
  const cost = deps.bcryptCost ?? 10;
  const log = deps.log ?? ((m: string) => console.error(m));

  function link(kind: "reset" | "verify", token: string): string | null {
    if (!appUrl) return null;
    // Token in the fragment: browsers never send it to the server or in Referer.
    return `${appUrl.replace(/\/+$/, "")}/#${kind}=${token}`;
  }

  // Email failures must never change the HTTP outcome (and never log tokens).
  async function safeSend(what: string, send: () => Promise<void>): Promise<void> {
    try { await send(); } catch (err) { log(`[account-recovery] ${what} email failed: ${(err as Error).message}`); }
  }

  async function requestReset(identifier: unknown): Promise<void> {
    if (typeof identifier !== "string" || !identifier.trim()) return;
    if (!appUrl) { log("[account-recovery] APP_URL is not set; reset email not sent"); return; }
    const targets = await store.findRecoveryTargets(identifier.trim());
    for (const t of targets) {
      const token = newToken();
      const issued = await store.issueToken({
        userId: t.userId, purpose: "reset", email: t.email, tokenHash: hashToken(token),
        ttlMinutes: RESET_TTL_MINUTES,
        maxPerAccountPerHour: MAX_RESETS_PER_ACCOUNT_PER_HOUR,
        maxPerAddressPerHour: MAX_EMAILS_PER_ADDRESS_PER_HOUR,
      });
      if (issued) await safeSend("reset", () => mailer.sendResetLink(t.email, t.username, link("reset", token)!));
    }
  }

  async function resetPassword(token: unknown, newPassword: unknown): Promise<Result<{ userId: string }>> {
    const rule = validateNewPassword(newPassword);
    if (rule) return { ok: false, error: rule };
    if (typeof token !== "string" || !token) return { ok: false, error: EXPIRED_LINK_ERROR };
    const hash = await bcrypt.hash(newPassword as string, cost);
    const user = await store.consumeResetToken(hashToken(token), hash);
    if (!user) return { ok: false, error: EXPIRED_LINK_ERROR };
    await safeSend("password-changed", () => mailer.sendPasswordChanged(user.email, user.username));
    return { ok: true, userId: user.userId };
  }

  async function changePassword(userId: string, current: unknown, next: unknown):
      Promise<Result<{ sessionVersion: number }>> {
    if (typeof current !== "string" || !current) return { ok: false, error: "Current password is required." };
    const rule = validateNewPassword(next);
    if (rule) return { ok: false, error: rule };
    const newHash = await bcrypt.hash(next as string, cost);
    const result = await store.changePassword(userId, (h) => bcrypt.compare(current, h), newHash);
    if (result.status !== "ok") return { ok: false, error: "Current password is incorrect." };
    const { email, username, sessionVersion } = result;
    if (email) await safeSend("password-changed", () => mailer.sendPasswordChanged(email, username));
    return { ok: true, sessionVersion };
  }

  /** Sends a verification link for `email` (signup or change). Silently skips if throttled. */
  async function requestEmailVerification(userId: string, email: string): Promise<void> {
    if (!appUrl) { log("[account-recovery] APP_URL is not set; verification email not sent"); return; }
    const username = await store.getUsername(userId);
    if (!username) return;
    const token = newToken();
    const issued = await store.issueToken({
      userId, purpose: "verify_email", email, tokenHash: hashToken(token),
      ttlMinutes: VERIFY_TTL_MINUTES, maxPerAccountPerHour: null,
      maxPerAddressPerHour: MAX_EMAILS_PER_ADDRESS_PER_HOUR,
    });
    if (issued) await safeSend("verify", () => mailer.sendVerifyLink(email, username, link("verify", token)!));
  }

  async function verifyEmail(token: unknown): Promise<Result<{ email: string }>> {
    if (typeof token !== "string" || !token) return { ok: false, error: EXPIRED_LINK_ERROR };
    const r = await store.consumeVerifyToken(hashToken(token));
    if (!r) return { ok: false, error: EXPIRED_LINK_ERROR };
    if (r.previousEmail && r.previousEmail.toLowerCase() !== r.email.toLowerCase()) {
      const prev = r.previousEmail;
      await safeSend("email-changed", () => mailer.sendEmailChanged(prev, r.username, r.email));
    }
    return { ok: true, email: r.email };
  }

  return { requestReset, resetPassword, changePassword, requestEmailVerification, verifyEmail };
}
