import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.mjs';
import { seedDatabase } from '../lib/seed.mjs';
import { makeApp, expireStaleOrders } from '../lib/app.mjs';

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function createTestServer() {
  const db = openDatabase(':memory:');
  seedDatabase(db, ROOT_DIR);
  const app = makeApp({
    db,
    rootDir: ROOT_DIR,
    env: {
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      MASTER_KEY: 'test-master-key-0123456789abcdef0123',
      PLATFORM_DOMAIN: 'localhost'
    }
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function req(p, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(baseUrl + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, text, json };
  }

  return { db, server, baseUrl, req, close: () => { server.close(); db.close(); } };
}

test('multi-tenant signup stays pending until super-admin approves, and tenants are isolated', async () => {
  const ctx = await createTestServer();
  try {
    // Sign up new tenant
    const signup = await ctx.req('/api/tenants/signup', {
      method: 'POST',
      body: { slug: 'bistro-mart', name: 'Bistro Mart', email: 'chef@bistro.test', password: 'secret-password-1', city: 'Boston' }
    });
    assert.equal(signup.status, 201);
    assert.equal(signup.json.tenant.status, 'pending');

    // Public access to pending tenant is blocked
    const blocked = await ctx.req('/api/store', { headers: { 'X-Tenant': 'bistro-mart' } });
    assert.equal(blocked.status, 403);

    // Owner of pending tenant can sign in and access their own store
    const ownerLogin = await ctx.req('/api/auth/login', {
      method: 'POST',
      body: { store: 'bistro-mart', email: 'chef@bistro.test', password: 'secret-password-1' }
    });
    assert.equal(ownerLogin.status, 200);
    const ownerToken = ownerLogin.json.token;

    const ownerStore = await ctx.req('/api/admin/store', {
      headers: { 'X-Tenant': 'bistro-mart', Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(ownerStore.status, 200);
    assert.equal(ownerStore.json.tenant.slug, 'bistro-mart');

    // Cross-tenant isolation: bistro-mart owner CANNOT read trove-market admin endpoints
    const crossRead = await ctx.req('/api/admin/orders', {
      headers: { 'X-Tenant': 'trove-market', Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(crossRead.status, 403);

    // Super-admin approves bistro-mart
    const superLogin = await ctx.req('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@platform.test', password: 'demo-admin-pass' }
    });
    assert.equal(superLogin.status, 200);
    const superToken = superLogin.json.token;

    const approve = await ctx.req(`/api/super/tenants/${signup.json.tenant.id}/status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superToken}` },
      body: { status: 'active' }
    });
    assert.equal(approve.status, 200);

    // Now public storefront can access bistro-mart
    const live = await ctx.req('/api/store', { headers: { 'X-Tenant': 'bistro-mart' } });
    assert.equal(live.status, 200);
    assert.equal(live.json.tenant.status, 'active');
  } finally {
    ctx.close();
  }
});

test('multi-warehouse routing picks nearest stocked warehouse and falls back when closest lacks stock', async () => {
  const ctx = await createTestServer();
  try {
    const login = await ctx.req('/api/auth/login', {
      method: 'POST',
      body: { store: 'trove-market', email: 'owner@trove-market.test', password: 'demo-password-1' }
    });
    const token = login.json.token;

    const { json: whData } = await ctx.req('/api/admin/warehouses', {
      headers: { 'X-Tenant': 'trove-market', Authorization: `Bearer ${token}` }
    });
    const whDt = whData.warehouses.find(w => w.code === 'NYC-DT');
    const whBk = whData.warehouses.find(w => w.code === 'NYC-BK');
    const whNj = whData.warehouses.find(w => w.code === 'NJ-WB');
    assert.ok(whDt && whBk && whNj);

    const { json: prodData } = await ctx.req('/api/products', { headers: { 'X-Tenant': 'trove-market' } });
    const p1 = prodData.products[0];
    const v1 = p1.variants[0];

    // Set NYC-DT stock = 2, NYC-BK stock = 15, NJ-WB stock = 20
    await ctx.req('/api/admin/stock', {
      method: 'PUT',
      headers: { 'X-Tenant': 'trove-market', Authorization: `Bearer ${token}` },
      body: { warehouse_id: whDt.id, variant_id: v1.id, qty: 2 }
    });
    await ctx.req('/api/admin/stock', {
      method: 'PUT',
      headers: { 'X-Tenant': 'trove-market', Authorization: `Bearer ${token}` },
      body: { warehouse_id: whBk.id, variant_id: v1.id, qty: 15 }
    });

    // Customer near Downtown Manhattan ordering qty=2 -> routes to NYC-DT
    const q1 = await ctx.req('/api/quote', {
      method: 'POST',
      headers: { 'X-Tenant': 'trove-market' },
      body: { items: [{ variant_id: v1.id, qty: 2 }], lat: 40.7282, lng: -73.9962 }
    });
    assert.equal(q1.status, 200);
    assert.equal(q1.json.warehouse.code, 'NYC-DT');

    // Customer near Downtown Manhattan ordering qty=5 -> NYC-DT only has 2, falls back to NYC-BK (next closest!)
    const q2 = await ctx.req('/api/quote', {
      method: 'POST',
      headers: { 'X-Tenant': 'trove-market' },
      body: { items: [{ variant_id: v1.id, qty: 5 }], lat: 40.7282, lng: -73.9962 }
    });
    assert.equal(q2.status, 200);
    assert.equal(q2.json.warehouse.code, 'NYC-BK');

    // Customer in Weehawken NJ ordering qty=5 -> NJ-WB is closest!
    const q3 = await ctx.req('/api/quote', {
      method: 'POST',
      headers: { 'X-Tenant': 'trove-market' },
      body: { items: [{ variant_id: v1.id, qty: 5 }], lat: 40.7662, lng: -74.0176 }
    });
    assert.equal(q3.status, 200);
    assert.equal(q3.json.warehouse.code, 'NJ-WB');
  } finally {
    ctx.close();
  }
});

test('split_nearest strategy allocates across multiple warehouses when no single hub holds full order', async () => {
  const ctx = await createTestServer();
  try {
    // urban-pantry is configured with routing_strategy = 'split_nearest'
    const login = await ctx.req('/api/auth/login', {
      method: 'POST',
      body: { store: 'urban-pantry', email: 'owner@urban-pantry.test', password: 'demo-password-1' }
    });
    const token = login.json.token;

    const { json: whData } = await ctx.req('/api/admin/warehouses', {
      headers: { 'X-Tenant': 'urban-pantry', Authorization: `Bearer ${token}` }
    });
    const whMid = whData.warehouses.find(w => w.code === 'UP-MID');
    const whHrb = whData.warehouses.find(w => w.code === 'UP-HRB');

    const { json: prodData } = await ctx.req('/api/products', { headers: { 'X-Tenant': 'urban-pantry' } });
    const vA = prodData.products[0].variants[0];
    const vB = prodData.products[1].variants[0];

    // Item A only in UP-MID (5), Item B only in UP-HRB (5)
    await ctx.req('/api/admin/stock', { method: 'PUT', headers: { 'X-Tenant': 'urban-pantry', Authorization: `Bearer ${token}` }, body: { warehouse_id: whMid.id, variant_id: vA.id, qty: 5 } });
    await ctx.req('/api/admin/stock', { method: 'PUT', headers: { 'X-Tenant': 'urban-pantry', Authorization: `Bearer ${token}` }, body: { warehouse_id: whHrb.id, variant_id: vA.id, qty: 0 } });
    await ctx.req('/api/admin/stock', { method: 'PUT', headers: { 'X-Tenant': 'urban-pantry', Authorization: `Bearer ${token}` }, body: { warehouse_id: whMid.id, variant_id: vB.id, qty: 0 } });
    await ctx.req('/api/admin/stock', { method: 'PUT', headers: { 'X-Tenant': 'urban-pantry', Authorization: `Bearer ${token}` }, body: { warehouse_id: whHrb.id, variant_id: vB.id, qty: 5 } });

    const quote = await ctx.req('/api/quote', {
      method: 'POST',
      headers: { 'X-Tenant': 'urban-pantry' },
      body: { items: [{ variant_id: vA.id, qty: 2 }, { variant_id: vB.id, qty: 3 }], lat: 40.7549, lng: -73.9742 }
    });
    assert.equal(quote.status, 200);
    assert.equal(quote.json.split_shipment, true);
    assert.equal(quote.json.allocations.length, 2);
  } finally {
    ctx.close();
  }
});

test('atomic stock reservation, payment commit, cancellation/expiry release & server-side pricing', async () => {
  const ctx = await createTestServer();
  try {
    const login = await ctx.req('/api/auth/login', {
      method: 'POST',
      body: { store: 'fresh-harvest', email: 'owner@fresh-harvest.test', password: 'demo-password-1' }
    });
    const token = login.json.token;

    const { json: whData } = await ctx.req('/api/admin/warehouses', {
      headers: { 'X-Tenant': 'fresh-harvest', Authorization: `Bearer ${token}` }
    });
    const whCity = whData.warehouses.find(w => w.code === 'FH-CTY');
    const whNorth = whData.warehouses.find(w => w.code === 'FH-NTH');

    const { json: prodData } = await ctx.req('/api/products', { headers: { 'X-Tenant': 'fresh-harvest' } });
    const v = prodData.products[0].variants[0];

    await ctx.req('/api/admin/stock', { method: 'PUT', headers: { 'X-Tenant': 'fresh-harvest', Authorization: `Bearer ${token}` }, body: { warehouse_id: whCity.id, variant_id: v.id, qty: 4 } });
    await ctx.req('/api/admin/stock', { method: 'PUT', headers: { 'X-Tenant': 'fresh-harvest', Authorization: `Bearer ${token}` }, body: { warehouse_id: whNorth.id, variant_id: v.id, qty: 0 } });

    // Place order for 3 units with tampered client price (ignored by server!) + coupon FRESH15
    const checkout = await ctx.req('/api/checkout', {
      method: 'POST',
      headers: { 'X-Tenant': 'fresh-harvest' },
      body: {
        items: [{ variant_id: v.id, qty: 3, price: 1 }],
        customer_name: 'Jane Doe',
        coupon_code: 'FRESH15',
        lat: 40.7359,
        lng: -73.9911
      }
    });
    assert.equal(checkout.status, 201);
    const ord = checkout.json.order;
    assert.equal(ord.subtotal_cents, v.price_cents * 3);
    assert.ok(ord.discount_cents > 0);
    assert.equal(ord.warehouse_id, whCity.id);

    // Stock should now show qty=4, reserved=3 (only 1 available!) -> ordering 2 more must fail
    const oversell = await ctx.req('/api/checkout', {
      method: 'POST',
      headers: { 'X-Tenant': 'fresh-harvest' },
      body: { items: [{ variant_id: v.id, qty: 2 }], customer_name: 'Bob', lat: 40.7359, lng: -73.9911 }
    });
    assert.equal(oversell.status, 409);

    // Pay order -> commits reserved stock (qty becomes 1, reserved becomes 0)
    const pay = await ctx.req(`/api/orders/${ord.order_no}/pay`, {
      method: 'POST',
      headers: { 'X-Tenant': 'fresh-harvest' }
    });
    assert.equal(pay.status, 200);
    assert.equal(pay.json.order.payment_status, 'paid');

    const stockRow = ctx.db.sqlite.prepare(`SELECT qty, reserved FROM warehouse_stock WHERE warehouse_id = ? AND variant_id = ?`).get(whCity.id, v.id);
    assert.equal(stockRow.qty, 1);
    assert.equal(stockRow.reserved, 0);

    // Create another unpaid order for 1 unit, then simulate expiry sweep -> stock released back to 1 available
    const chk2 = await ctx.req('/api/checkout', {
      method: 'POST',
      headers: { 'X-Tenant': 'fresh-harvest' },
      body: { items: [{ variant_id: v.id, qty: 1 }], customer_name: 'Tim', lat: 40.7359, lng: -73.9911 }
    });
    assert.equal(chk2.status, 201);
    ctx.db.sqlite.prepare(`UPDATE orders SET expires_at = '2020-01-01T00:00:00.000Z' WHERE order_no = ?`).run(chk2.json.order.order_no);
    const swept = expireStaleOrders(ctx.db);
    assert.equal(swept, 1);

    const afterSweep = ctx.db.sqlite.prepare(`SELECT qty, reserved FROM warehouse_stock WHERE warehouse_id = ? AND variant_id = ?`).get(whCity.id, v.id);
    assert.equal(afterSweep.qty, 1);
    assert.equal(afterSweep.reserved, 0);
  } finally {
    ctx.close();
  }
});

test('atomic inter-warehouse transfer works within tenant and rejects cross-tenant warehouses', async () => {
  const ctx = await createTestServer();
  try {
    const login = await ctx.req('/api/auth/login', {
      method: 'POST',
      body: { store: 'trove-market', email: 'owner@trove-market.test', password: 'demo-password-1' }
    });
    const token = login.json.token;

    const { json: whData } = await ctx.req('/api/admin/warehouses', {
      headers: { 'X-Tenant': 'trove-market', Authorization: `Bearer ${token}` }
    });
    const whDt = whData.warehouses.find(w => w.code === 'NYC-DT');
    const whBk = whData.warehouses.find(w => w.code === 'NYC-BK');
    const { json: prodData } = await ctx.req('/api/products', { headers: { 'X-Tenant': 'trove-market' } });
    const v = prodData.products[0].variants[0];

    await ctx.req('/api/admin/stock', { method: 'PUT', headers: { 'X-Tenant': 'trove-market', Authorization: `Bearer ${token}` }, body: { warehouse_id: whDt.id, variant_id: v.id, qty: 10 } });
    await ctx.req('/api/admin/stock', { method: 'PUT', headers: { 'X-Tenant': 'trove-market', Authorization: `Bearer ${token}` }, body: { warehouse_id: whBk.id, variant_id: v.id, qty: 5 } });

    const tr = await ctx.req('/api/admin/warehouses/transfer', {
      method: 'POST',
      headers: { 'X-Tenant': 'trove-market', Authorization: `Bearer ${token}` },
      body: { from_warehouse_id: whDt.id, to_warehouse_id: whBk.id, variant_id: v.id, qty: 4, note: 'Rebalance' }
    });
    assert.equal(tr.status, 200);
    assert.equal(tr.json.transferred, 4);

    const dtRow = ctx.db.sqlite.prepare(`SELECT qty FROM warehouse_stock WHERE warehouse_id = ? AND variant_id = ?`).get(whDt.id, v.id);
    const bkRow = ctx.db.sqlite.prepare(`SELECT qty FROM warehouse_stock WHERE warehouse_id = ? AND variant_id = ?`).get(whBk.id, v.id);
    assert.equal(dtRow.qty, 6);
    assert.equal(bkRow.qty, 9);

    // Cross-tenant warehouse transfer must fail with 404
    const crossTr = await ctx.req('/api/admin/warehouses/transfer', {
      method: 'POST',
      headers: { 'X-Tenant': 'trove-market', Authorization: `Bearer ${token}` },
      body: { from_warehouse_id: whDt.id, to_warehouse_id: 'wh_fh_north', variant_id: v.id, qty: 1 }
    });
    assert.equal(crossTr.status, 404);
  } finally {
    ctx.close();
  }
});

test('Shopify-compatible storefront endpoints, pickup availability, and HTML bridge injection work', async () => {
  const ctx = await createTestServer();
  try {
    // Storefront HTML has bridge injected
    const home = await ctx.req('/?store=trove-market');
    assert.equal(home.status, 200);
    assert.ok(home.text.includes('/mt-bridge.js'));
    assert.ok(home.text.includes('window.__MT_CONTEXT__'));

    // Predictive search
    const search = await ctx.req('/search/suggest?q=Avocado', { headers: { 'X-Tenant': 'trove-market' } });
    assert.equal(search.status, 200);
    assert.ok(search.text.includes('PredictiveSearchResults-'));
    assert.ok(search.text.includes('Avocado'));

    // Quick view section
    const qv = await ctx.req('/products/premium-beef-short-ribs-bone-in-2-lb?section_id=quick-view', { headers: { 'X-Tenant': 'trove-market' } });
    assert.equal(qv.status, 200);
    assert.ok(qv.text.includes('Multi-Warehouse Availability'));

    // Pickup availability for variant
    const pickup = await ctx.req('/variants/46809584730341/?section_id=pickup-availability', { headers: { 'X-Tenant': 'trove-market' } });
    assert.equal(pickup.status, 200);
    assert.ok(pickup.text.includes('pickup-availability-preview'));
    assert.ok(pickup.text.includes('Warehouse Pickup Availability'));

    // Cart add -> returns sections & cart cookie
    const add = await ctx.req('/cart/add.js', {
      method: 'POST',
      headers: { 'X-Tenant': 'trove-market' },
      body: { id: '46809584730341', quantity: 2, sections: ['sections--19692154126565__cart-drawer'] }
    });
    assert.equal(add.status, 200);
    assert.equal(add.json.item_count, 2);
    assert.ok(add.json.sections['sections--19692154126565__cart-drawer'].includes('CartDrawerBody-'));
  } finally {
    ctx.close();
  }
});
