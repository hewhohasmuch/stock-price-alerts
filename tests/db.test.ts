import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// Use a temporary data directory so tests don't touch real data.
// The db module reads DATA_DIR relative to __dirname, so we reset
// the module before each test to get a fresh db instance.
const TEST_DATA_DIR = join(import.meta.dirname!, "..", "data-test");

// We'll dynamically import db to get a fresh instance each time
async function freshDb() {
  // Clear module cache by adding a query param (ESM cache-busting)
  const mod = await import(`../src/db.js?t=${Date.now()}-${Math.random()}`);
  return mod;
}

describe("db — user functions", () => {
  beforeEach(() => {
    // Clean up the data directory before each test
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it("createUser returns a user with a full UUID id", async () => {
    const { createUser } = await import("../src/db.js");
    const user = await createUser("testuser_" + Date.now(), "password123");
    expect(user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(user.username).toContain("testuser_");
    expect(user.passwordHash).toBeDefined();
    expect(user.passwordHash).not.toBe("password123");
    expect(user.createdAt).toBeDefined();
  });

  it("createUser rejects duplicate usernames (case-insensitive)", async () => {
    const { createUser } = await import("../src/db.js");
    const name = "DuplicateTest_" + Date.now();
    await createUser(name, "password123");
    await expect(createUser(name.toLowerCase(), "otherpass")).rejects.toThrow(
      "Username already taken"
    );
  });

  it("verifyUser returns user for correct credentials", async () => {
    const { createUser, verifyUser } = await import("../src/db.js");
    const name = "verifyTest_" + Date.now();
    await createUser(name, "mypassword");
    const user = await verifyUser(name, "mypassword");
    expect(user).not.toBeNull();
    expect(user!.username).toBe(name);
  });

  it("verifyUser returns null for wrong password", async () => {
    const { createUser, verifyUser } = await import("../src/db.js");
    const name = "wrongPass_" + Date.now();
    await createUser(name, "correctpass");
    const user = await verifyUser(name, "wrongpass");
    expect(user).toBeNull();
  });

  it("verifyUser returns null for non-existent user", async () => {
    const { verifyUser } = await import("../src/db.js");
    const user = await verifyUser("nobody_" + Date.now(), "password");
    expect(user).toBeNull();
  });
});

describe("db — alert functions", () => {
  it("addAlert returns an alert with a full UUID id", async () => {
    const { createUser, addAlert } = await import("../src/db.js");
    const user = await createUser("alertuser_" + Date.now(), "pass123");
    const alert = await addAlert(user.id, "AAPL", "Apple Inc.", 200, undefined, "test note");
    expect(alert.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(alert.symbol).toBe("AAPL");
    expect(alert.name).toBe("Apple Inc.");
    expect(alert.abovePrice).toBe(200);
    expect(alert.belowPrice).toBeUndefined();
    expect(alert.notes).toBe("test note");
    expect(alert.enabled).toBe(true);
  });

  it("listAlerts returns only alerts for the given user", async () => {
    const { createUser, addAlert, listAlerts } = await import("../src/db.js");
    const user1 = await createUser("listuser1_" + Date.now(), "pass");
    const user2 = await createUser("listuser2_" + Date.now(), "pass");
    await addAlert(user1.id, "AAPL", "Apple", 200);
    await addAlert(user2.id, "MSFT", "Microsoft", 300);
    const alerts1 = await listAlerts(user1.id);
    expect(alerts1).toHaveLength(1);
    expect(alerts1[0].symbol).toBe("AAPL");
  });

  it("removeAlert deletes alert and returns true", async () => {
    const { createUser, addAlert, removeAlert, listAlerts } = await import("../src/db.js");
    const user = await createUser("removeuser_" + Date.now(), "pass");
    const alert = await addAlert(user.id, "TSLA", "Tesla", 500);
    const removed = await removeAlert(alert.id, user.id);
    expect(removed).toBe(true);
    const remaining = await listAlerts(user.id);
    expect(remaining).toHaveLength(0);
  });

  it("removeAlert returns false for non-existent alert", async () => {
    const { removeAlert } = await import("../src/db.js");
    const removed = await removeAlert("nonexistent", "nobody");
    expect(removed).toBe(false);
  });

  it("removeAlert prevents removal by wrong user", async () => {
    const { createUser, addAlert, removeAlert } = await import("../src/db.js");
    const user1 = await createUser("own1_" + Date.now(), "pass");
    const user2 = await createUser("own2_" + Date.now(), "pass");
    const alert = await addAlert(user1.id, "AAPL", "Apple", 200);
    const removed = await removeAlert(alert.id, user2.id);
    expect(removed).toBe(false);
  });

  it("setAlertEnabled toggles enabled state", async () => {
    const { createUser, addAlert, setAlertEnabled, listAlerts } = await import("../src/db.js");
    const user = await createUser("toggleuser_" + Date.now(), "pass");
    const alert = await addAlert(user.id, "AAPL", "Apple", 200);
    expect(alert.enabled).toBe(true);

    const ok = await setAlertEnabled(alert.id, user.id, false);
    expect(ok).toBe(true);
    const alerts = await listAlerts(user.id);
    expect(alerts[0].enabled).toBe(false);
  });

  it("updateAlertNotes updates notes", async () => {
    const { createUser, addAlert, updateAlertNotes, listAlerts } = await import("../src/db.js");
    const user = await createUser("noteuser_" + Date.now(), "pass");
    const alert = await addAlert(user.id, "AAPL", "Apple", 200, undefined, "old");
    await updateAlertNotes(alert.id, user.id, "new note");
    const alerts = await listAlerts(user.id);
    expect(alerts[0].notes).toBe("new note");
  });

  it("updateAlertThresholds updates prices", async () => {
    const { createUser, addAlert, updateAlertThresholds, listAlerts } = await import("../src/db.js");
    const user = await createUser("threshuser_" + Date.now(), "pass");
    const alert = await addAlert(user.id, "AAPL", "Apple", 200, 150);
    await updateAlertThresholds(alert.id, user.id, 250, 100);
    const alerts = await listAlerts(user.id);
    expect(alerts[0].abovePrice).toBe(250);
    expect(alerts[0].belowPrice).toBe(100);
  });

  it("getEnabledAlerts returns only enabled alerts", async () => {
    const { createUser, addAlert, setAlertEnabled, getEnabledAlerts } = await import("../src/db.js");
    const user = await createUser("enableduser_" + Date.now(), "pass");
    const a1 = await addAlert(user.id, "XDIS", "Disabled Co", 200);
    const a2 = await addAlert(user.id, "XENB", "Enabled Co", 300);
    await setAlertEnabled(a1.id, user.id, false);
    const enabled = await getEnabledAlerts();
    const ids = enabled.map(a => a.id);
    expect(ids).toContain(a2.id);
    expect(ids).not.toContain(a1.id);
  });
});
