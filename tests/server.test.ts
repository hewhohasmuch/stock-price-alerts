import { describe, it, expect, beforeAll } from "vitest";

// These tests make HTTP requests to the server module's Express app.
// We import the app and use supertest-like fetch against it.

// We need to set env to avoid production checks
process.env.SESSION_SECRET = "test-secret-for-vitest";

// Dynamic import to respect env setup above
const { default: express } = await import("express");

describe("server API", () => {
  let baseUrl: string;
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let cookie = "";

  beforeAll(async () => {
    // Import the server module — it calls app.listen() at module scope,
    // so we intercept by using the running server on its port.
    // Instead, let's start the server and use fetch directly.
    const port = 0; // let OS pick a free port

    // We can't easily import the Express app without it auto-starting,
    // so we just start the full server and test against it.
    // The server listens on port 3000 by default but for tests we'll
    // just use port 3000 since the module self-starts.
    // We'll test against the already-listening server.
    baseUrl = "http://localhost:3000";

    // Give the server a moment if needed
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  async function post(path: string, body: object, useCookie = false) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (useCookie && cookie) headers["Cookie"] = cookie;
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
    });
  }

  async function get(path: string, useCookie = true) {
    const headers: Record<string, string> = {};
    if (useCookie && cookie) headers["Cookie"] = cookie;
    return fetch(`${baseUrl}${path}`, { headers, redirect: "manual" });
  }

  async function patch(path: string, body: object) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cookie) headers["Cookie"] = cookie;
    return fetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
    });
  }

  async function del(path: string) {
    const headers: Record<string, string> = {};
    if (cookie) headers["Cookie"] = cookie;
    return fetch(`${baseUrl}${path}`, { method: "DELETE", headers, redirect: "manual" });
  }

  const testUser = { username: `test_${Date.now()}`, password: "testpass123" };

  it("rejects unauthenticated access to /api/alerts", async () => {
    const res = await get("/api/alerts", false);
    expect(res.status).toBe(401);
  });

  it("registers a new user", async () => {
    const res = await post("/api/auth/register", testUser);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.username).toBe(testUser.username);
    expect(data.id).toBeDefined();
    // Save session cookie
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
  });

  it("rejects duplicate registration", async () => {
    const res = await post("/api/auth/register", testUser);
    expect(res.status).toBe(409);
  });

  it("GET /api/auth/me returns current user", async () => {
    const res = await get("/api/auth/me");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.username).toBe(testUser.username);
  });

  it("validates register input", async () => {
    const res = await post("/api/auth/register", { username: "", password: "" });
    expect(res.status).toBe(400);
  });

  it("validates short username", async () => {
    const res = await post("/api/auth/register", { username: "ab", password: "123456" });
    expect(res.status).toBe(400);
  });

  it("validates short password", async () => {
    const res = await post("/api/auth/register", { username: "validuser", password: "12345" });
    expect(res.status).toBe(400);
  });

  // Alert CRUD
  let alertId: string;

  it("creates an alert", async () => {
    const res = await post("/api/alerts", {
      symbol: "TEST",
      abovePrice: 100,
      belowPrice: 50,
      notes: "test alert",
    }, true);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.symbol).toBe("TEST");
    expect(data.abovePrice).toBe(100);
    expect(data.belowPrice).toBe(50);
    expect(data.notes).toBe("test alert");
    expect(data.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    alertId = data.id;
  });

  it("rejects alert without thresholds", async () => {
    const res = await post("/api/alerts", { symbol: "TEST" }, true);
    expect(res.status).toBe(400);
  });

  it("lists alerts", async () => {
    const res = await get("/api/alerts");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("disables an alert", async () => {
    const res = await patch(`/api/alerts/${alertId}/disable`, {});
    expect(res.status).toBe(200);
  });

  it("enables an alert", async () => {
    const res = await patch(`/api/alerts/${alertId}/enable`, {});
    expect(res.status).toBe(200);
  });

  it("updates alert notes", async () => {
    const res = await patch(`/api/alerts/${alertId}/notes`, { notes: "updated" });
    expect(res.status).toBe(200);
  });

  it("rejects notes update with invalid type", async () => {
    const res = await patch(`/api/alerts/${alertId}/notes`, { notes: 123 });
    expect(res.status).toBe(400);
  });

  it("updates alert thresholds", async () => {
    const res = await patch(`/api/alerts/${alertId}/thresholds`, {
      abovePrice: 200,
      belowPrice: 80,
    });
    expect(res.status).toBe(200);
  });

  it("rejects threshold update with no values", async () => {
    const res = await patch(`/api/alerts/${alertId}/thresholds`, {});
    expect(res.status).toBe(400);
  });

  it("deletes an alert", async () => {
    const res = await del(`/api/alerts/${alertId}`);
    expect(res.status).toBe(200);
  });

  it("returns 404 for deleted alert", async () => {
    const res = await del(`/api/alerts/${alertId}`);
    expect(res.status).toBe(404);
  });

  // Price routes
  it("rejects prices request without symbols", async () => {
    const res = await get("/api/prices");
    expect(res.status).toBe(400);
  });

  // Logout
  it("logs out", async () => {
    const res = await post("/api/auth/logout", {}, true);
    expect(res.status).toBe(200);
  });

  it("logs in with correct credentials", async () => {
    const res = await post("/api/auth/login", testUser);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.username).toBe(testUser.username);
  });

  it("rejects login with wrong password", async () => {
    const res = await post("/api/auth/login", {
      username: testUser.username,
      password: "wrongpass",
    });
    expect(res.status).toBe(401);
  });
});
