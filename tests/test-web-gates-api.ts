/**
 * Tests for the gate API endpoints (/api/gates, /api/gates/add,
 * /api/gates/remove).
 *
 * The handlers are NOT exported from web.ts (they're private to the
 * module), so we test via a live Deno.serve + HTTP requests. That also
 * exercises the real auth-token + routing path that the dashboard sees.
 *
 * Boot a server, hit each endpoint, tear down. Validates:
 *   - GET /api/gates?dir=... returns whole-archive view
 *   - GET /api/gates?dir=...&variantId=... returns inherited view with source tags
 *   - POST /api/gates/add creates a gate (requires bearer token)
 *   - POST /api/gates/remove removes a gate
 *   - POST without auth returns 401
 *   - GET on unknown dir returns 500 with error
 *
 * Run:  deno run --allow-all tests/test-web-gates-api.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import { addGate, init, snapshot } from "@snapshot/core";
import { startServer } from "../src/web.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, predicate: boolean, detail?: string): void {
  if (predicate) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
    failures.push(name);
  }
}

// Pick a random high port so parallel tests don't collide
const PORT = 40000 + Math.floor(Math.random() * 10000);
const HOST = "127.0.0.1";
const AUTH_TOKEN = "test-bearer-token-" + Math.random().toString(36).slice(2);

// Seed a refine archive
const dir = await Deno.makeTempDir({ prefix: "expo-web-gates-test-" });
await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
await init(dir);
const v1 = await snapshot(dir, { change: "baseline", summary: "first" });
await addGate(dir, v1.id, {
  name: "tests",
  command: "deno test",
  rationale: "regression prevention",
});
const v2 = await snapshot(dir, { change: "iter 2", summary: "second" });
await addGate(dir, v2.id, { name: "lint", command: "deno lint" });

// Start server (non-blocking — startServer awaits forever, so we race it)
const serverPromise = startServer({
  port: PORT,
  host: HOST,
  authToken: AUTH_TOKEN,
  logFile: `${dir}/dummy.jsonl`, // won't actually watch; good enough
}).catch((err) => {
  // startServer from the test may race against Deno.serve setup; swallow.
  console.error("[test] server error:", err);
});

// Wait a beat for the listener to be ready
await new Promise((r) => setTimeout(r, 200));

const BASE = `http://${HOST}:${PORT}`;

try {
  // ── Test 1: GET /api/gates whole archive ─────────────────────

  console.log("\nGET /api/gates?dir=... (whole archive):");
  {
    const res = await fetch(`${BASE}/api/gates?dir=${encodeURIComponent(dir)}`);
    const data = await res.json();
    check("status 200", res.status === 200);
    check("totalGates=2", data.totalGates === 2);
    check("totalVariants=2", data.totalVariants === 2);
    check("byVariant has 2 entries", Array.isArray(data.byVariant) && data.byVariant.length === 2);
    check("v1 has tests gate", data.byVariant[0]?.gates.some((g: { name: string }) => g.name === "tests"));
    check("v2 has lint gate", data.byVariant[1]?.gates.some((g: { name: string }) => g.name === "lint"));
  }

  // ── Test 2: GET /api/gates per-variant (inherited view) ──────

  console.log("\nGET /api/gates?dir=...&variantId=... (inherited view):");
  {
    const res = await fetch(`${BASE}/api/gates?dir=${encodeURIComponent(dir)}&variantId=${v2.id}`);
    const data = await res.json();
    check("status 200", res.status === 200);
    check("two gates visible from v2", data.gates?.length === 2);
    const sourceMap = new Map(data.gates.map((g: { name: string; source: string }) => [g.name, g.source]));
    check("tests is inherited", sourceMap.get("tests") === "inherited");
    check("lint is direct", sourceMap.get("lint") === "direct");
  }

  // ── Test 3: GET /api/gates missing dir → 400 ──────────────────

  console.log("\nGET /api/gates without dir → 400:");
  {
    const res = await fetch(`${BASE}/api/gates`);
    const data = await res.json();
    check("status 400", res.status === 400);
    check("error mentions dir", (data.error as string).includes("dir"));
  }

  // ── Test 4: GET /api/gates unknown variantId → 404 ───────────

  console.log("\nGET /api/gates with unknown variantId → 404:");
  {
    const res = await fetch(`${BASE}/api/gates?dir=${encodeURIComponent(dir)}&variantId=nope`);
    const data = await res.json();
    check("status 404", res.status === 404);
    check("error mentions variant", (data.error as string).includes("variant"));
  }

  // ── Test 5: POST /api/gates/add without auth → 401 ───────────

  console.log("\nPOST /api/gates/add without auth → 401:");
  {
    const res = await fetch(`${BASE}/api/gates/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir, variantId: v1.id, name: "x", command: "true" }),
    });
    check("status 401", res.status === 401);
    // Consume body so connection can close cleanly
    await res.json().catch(() => {});
  }

  // ── Test 6: POST /api/gates/add with auth succeeds ───────────

  console.log("\nPOST /api/gates/add with auth:");
  {
    const res = await fetch(`${BASE}/api/gates/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        dir,
        variantId: v2.id,
        name: "typecheck",
        command: "deno check src/",
        rationale: "catches type drift",
        timeoutMs: 30000,
      }),
    });
    const data = await res.json();
    check("status 200", res.status === 200);
    check("ok=true", data.ok === true);
    check("gate.name persisted", data.gate?.name === "typecheck");
    check("gate.timeoutMs persisted", data.gate?.timeoutMs === 30000);
    check("gate.rationale persisted", data.gate?.rationale === "catches type drift");
  }

  // ── Test 7: GET reflects the newly-added gate ────────────────

  console.log("\nGET after add reflects new gate:");
  {
    const res = await fetch(`${BASE}/api/gates?dir=${encodeURIComponent(dir)}&variantId=${v2.id}`);
    const data = await res.json();
    const names: string[] = data.gates.map((g: { name: string }) => g.name);
    check("typecheck now visible", names.includes("typecheck"));
    check("total gates on v2 is 3 (lint + typecheck direct + tests inherited)", data.gates.length === 3);
  }

  // ── Test 8: POST /api/gates/add duplicate → 400 ──────────────

  console.log("\nPOST /api/gates/add duplicate name → 400:");
  {
    const res = await fetch(`${BASE}/api/gates/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        dir,
        variantId: v2.id,
        name: "typecheck", // already exists
        command: "deno check again",
      }),
    });
    const data = await res.json();
    check("status 400", res.status === 400);
    check("error mentions already exists", (data.error as string).toLowerCase().includes("already"));
  }

  // ── Test 9: POST /api/gates/remove ──────────────────────────

  console.log("\nPOST /api/gates/remove with auth:");
  {
    const res = await fetch(`${BASE}/api/gates/remove`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({ dir, variantId: v2.id, name: "typecheck" }),
    });
    const data = await res.json();
    check("status 200", res.status === 200);
    check("ok=true", data.ok === true);
  }

  // ── Test 10: GET reflects removal ────────────────────────────

  console.log("\nGET after remove reflects removal:");
  {
    const res = await fetch(`${BASE}/api/gates?dir=${encodeURIComponent(dir)}&variantId=${v2.id}`);
    const data = await res.json();
    const names: string[] = data.gates.map((g: { name: string }) => g.name);
    check("typecheck gone", !names.includes("typecheck"));
    check("back to 2 gates", data.gates.length === 2);
  }

  // ── Test 11: POST /api/gates/remove nonexistent → 400 ────────

  console.log("\nPOST /api/gates/remove nonexistent → 400:");
  {
    const res = await fetch(`${BASE}/api/gates/remove`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({ dir, variantId: v2.id, name: "never-existed" }),
    });
    const data = await res.json();
    check("status 400", res.status === 400);
    check("error mentions not found", (data.error as string).toLowerCase().includes("not found"));
  }

  // ── Test 12: POST /api/gates/add missing fields → 400 ───────

  console.log("\nPOST /api/gates/add missing fields → 400:");
  {
    const res = await fetch(`${BASE}/api/gates/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({ dir, variantId: v2.id /* missing name+command */ }),
    });
    const data = await res.json();
    check("status 400", res.status === 400);
    check("error lists required fields", (data.error as string).includes("required"));
  }
} finally {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  // startServer doesn't expose an abort — the test process exits and the
  // server goes with it. Acceptable for a test file.
}

console.log(`\n${passed} passed, ${failed} failed`);
// Abort the server promise so Deno doesn't complain about hanging resources.
// We actually need Deno.exit here because startServer holds an open listener.
if (failed > 0) {
  console.log("\nFailures:");
  for (const name of failures) console.log(`  - ${name}`);
  Deno.exit(1);
}
// Force clean exit so the server's await-forever doesn't keep us hanging.
Deno.exit(0);
