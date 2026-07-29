'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const WORKER_URL = process.env.WORKER_URL || 'http://localhost:3001';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll GET /records/:id until it reaches `wanted` status or we time out.
async function waitForStatus(id, wanted, timeoutMs = 30000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const res = await fetch(`${API_URL}/records/${id}`);
    assert.equal(res.status, 200, 'record should be fetchable while we wait');
    const body = await res.json();
    last = body.status;
    if (body.status === wanted) return body;
    await sleep(intervalMs);
  }
  throw new Error(`record ${id} never reached status '${wanted}' (last saw '${last}')`);
}

test('POST /records creates a pending record and worker drives it to done', async () => {
  const email = `e2e-${Date.now()}@example.com`;

  const createRes = await fetch(`${API_URL}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(createRes.status, 201, 'create should return 201');
  const created = await createRes.json();
  assert.ok(Number.isInteger(created.id), 'created record should have an integer id');
  assert.equal(created.email, email);
  assert.equal(created.status, 'pending', 'new records start pending');

  // Immediately fetch it back — still pending (worker polls every ~5s).
  const getRes = await fetch(`${API_URL}/records/${created.id}`);
  assert.equal(getRes.status, 200);
  const fetched = await getRes.json();
  assert.equal(fetched.status, 'pending');

  // Give the worker time to claim + process (5s poll + 2s work + margin).
  const done = await waitForStatus(created.id, 'done', 30000, 1000);
  assert.equal(done.status, 'done', 'worker should mark the record done');
});

test('GET /records/:id returns 404 for a missing record', async () => {
  const res = await fetch(`${API_URL}/records/999999999`);
  assert.equal(res.status, 404);
});

test('api-service health/readiness/metrics endpoints return 200', async () => {
  for (const path of ['/healthz', '/readyz', '/metrics']) {
    const res = await fetch(`${API_URL}${path}`);
    assert.equal(res.status, 200, `GET ${path} on api-service should be 200`);
  }
});

test('worker-service health/readiness/metrics endpoints return 200', async () => {
  for (const path of ['/healthz', '/readyz', '/metrics']) {
    const res = await fetch(`${WORKER_URL}${path}`);
    assert.equal(res.status, 200, `GET ${path} on worker-service should be 200`);
  }
});
