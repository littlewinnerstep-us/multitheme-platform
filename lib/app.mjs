import fs from 'node:fs';
import path from 'node:path';
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  encryptSecret,
  randomId,
  newOrderNo
} from './crypto.mjs';
import { parseJson } from './db.mjs';
import {
  rankWarehouses,
  getStockMap,
  planFulfillment,
  reserveAllocations,
  commitAllocations,
  releaseAllocations,
  transferStock
} from './warehouse.mjs';
import {
  getOrCreateCart,
  getCartState,
  resolveVariant,
  renderCartSections,
  renderQuickViewHtml,
  renderPickupAvailabilityHtml,
  renderPredictiveSearchHtml,
  formatMoney
} from './shopify-compat.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
};

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/json') || raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return obj;
  }
  if (ct.includes('multipart/form-data')) {
    // Parse simple form-data fields (used by Shopify cart.js FormData)
    const m = ct.match(/boundary=([^\s;]+)/);
    if (m) {
      const obj = {};
      const parts = raw.split('--' + m[1]);
      for (const p of parts) {
        const nm = p.match(/name="([^"]+)"/);
        const valIdx = p.indexOf('\r\n\r\n');
        if (nm && valIdx !== -1) {
          obj[nm[1]] = p.slice(valIdx + 4).replace(/\r\n$/, '');
        }
      }
      return obj;
    }
  }
  return {};
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(html);
}

function hydrateTenant(row) {
  if (!row) return null;
  return {
    ...row,
    theme_config: parseJson(row.theme_config, {}),
    settings: parseJson(row.settings, {})
  };
}

/** Sweep unpaid pending orders past expires_at and release their reserved stock. */
export function expireStaleOrders(db) {
  const now = new Date().toISOString();
  const stale = db.sqlite
    .prepare(`SELECT id, tenant_id, order_no, allocations_json, coupon_code FROM orders WHERE status = 'pending' AND payment_status = 'unpaid' AND expires_at IS NOT NULL AND expires_at < ?`)
    .all(now);
  for (const ord of stale) {
    const allocs = parseJson(ord.allocations_json, []);
    if (allocs.length) releaseAllocations(db, ord.tenant_id, allocs, ord.order_no, `Expired ${ord.order_no}`);
    if (ord.coupon_code) {
      db.sqlite.prepare(`UPDATE coupons SET used_count = MAX(used_count - 1, 0) WHERE tenant_id = ? AND UPPER(code) = ?`).run(ord.tenant_id, ord.coupon_code.toUpperCase());
    }
    db.sqlite.prepare(`UPDATE orders SET status = 'expired' WHERE id = ?`).run(ord.id);
  }
  return stale.length;
}

/** Build the complete HTTP request handler for multitheme. */
export function makeApp({ db, rootDir, env = {} }) {
  const SESSION_SECRET = env.SESSION_SECRET || 'dev-session-secret-0123456789abcdef';
  const MASTER_KEY = env.MASTER_KEY || 'dev-master-key-0123456789abcdef0123';
  const PLATFORM_DOMAIN = env.PLATFORM_DOMAIN || 'localhost';
  const PUBLIC_DIR = path.join(rootDir, 'public');

  function getAuthUser(req) {
    const cookies = parseCookies(req.headers.cookie);
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : cookies.mt_session;
    const payload = verifyToken(token, SESSION_SECRET);
    if (!payload?.uid) return null;
    const user = db.sqlite.prepare(`SELECT id, tenant_id, email, name, role FROM users WHERE id = ?`).get(payload.uid);
    return user || null;
  }

  function resolveTenant(req, url) {
    const cookies = parseCookies(req.headers.cookie);
    const headerSlug = req.headers['x-tenant'] ? String(req.headers['x-tenant']).trim().toLowerCase() : null;
    const querySlug = url.searchParams.get('store') ? url.searchParams.get('store').trim().toLowerCase() : null;
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();

    let row = null;
    if (headerSlug) {
      row = db.sqlite.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(headerSlug);
    } else if (querySlug) {
      row = db.sqlite.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(querySlug);
    } else if (host && host !== PLATFORM_DOMAIN && host !== '127.0.0.1' && host !== 'localhost') {
      row = db.sqlite.prepare(`SELECT * FROM tenants WHERE custom_domain = ?`).get(host);
      if (!row && host.endsWith(`.${PLATFORM_DOMAIN}`)) {
        const sub = host.slice(0, -(PLATFORM_DOMAIN.length + 1));
        if (sub && !sub.includes('.')) row = db.sqlite.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(sub);
      }
    }
    if (!row && !headerSlug && !querySlug && cookies.mt_store) {
      row = db.sqlite.prepare(`SELECT * FROM tenants WHERE slug = ?`).get(cookies.mt_store.toLowerCase());
    }
    if (!row && !headerSlug && !querySlug) {
      row = db.sqlite.prepare(`SELECT * FROM tenants ORDER BY created_at ASC LIMIT 1`).get();
    }
    return { tenant: hydrateTenant(row), querySlug };
  }

  function ensureCartCookie(req, tenantSlug) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.mt_cart) return { cartToken: cookies.mt_cart, setCookie: null };
    const cartToken = randomId('ct');
    return {
      cartToken,
      setCookie: `mt_cart=${encodeURIComponent(cartToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
    };
  }

  function listCatalogProducts(tenantId, { category = null, search = null } = {}) {
    const products = db.sqlite
      .prepare(`SELECT * FROM products WHERE tenant_id = ? AND active = 1 ORDER BY sort_order ASC, created_at ASC`)
      .all(tenantId);
    const variants = db.sqlite
      .prepare(`SELECT * FROM variants WHERE tenant_id = ? AND active = 1 ORDER BY price_cents ASC`)
      .all(tenantId);
    const warehouses = rankWarehouses(db, tenantId);
    const stockRows = db.sqlite
      .prepare(`SELECT warehouse_id, variant_id, qty, reserved FROM warehouse_stock WHERE tenant_id = ?`)
      .all(tenantId);

    const stockByVar = new Map();
    for (const s of stockRows) {
      const avail = Math.max(0, s.qty - s.reserved);
      if (!stockByVar.has(s.variant_id)) stockByVar.set(s.variant_id, []);
      stockByVar.get(s.variant_id).push({ warehouse_id: s.warehouse_id, qty: s.qty, reserved: s.reserved, available: avail });
    }

    const varsByProd = new Map();
    for (const v of variants) {
      const st = stockByVar.get(v.id) || [];
      const totalAvail = st.reduce((sum, x) => sum + x.available, 0);
      if (!varsByProd.has(v.product_id)) varsByProd.set(v.product_id, []);
      varsByProd.get(v.product_id).push({
        ...v,
        total_available: totalAvail,
        warehouse_stock: warehouses.map(w => {
          const found = st.find(x => x.warehouse_id === w.id);
          return { warehouse_id: w.id, warehouse_code: w.code, warehouse_name: w.name, qty: found?.qty ?? 0, reserved: found?.reserved ?? 0, available: found?.available ?? 0 };
        })
      });
    }

    let list = products.map(p => {
      const vs = varsByProd.get(p.id) || [];
      const totalAvail = vs.reduce((sum, v) => sum + v.total_available, 0);
      return {
        ...p,
        active: Boolean(p.active),
        min_price_cents: vs.length ? Math.min(...vs.map(v => v.price_cents)) : 0,
        total_available: totalAvail,
        variants: vs
      };
    });

    if (category && category !== 'all') {
      const cLow = category.toLowerCase();
      list = list.filter(p => p.category.toLowerCase() === cLow);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p => p.title.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
    }
    return list;
  }

  function computeQuote(tenant, body) {
    const itemsIn = Array.isArray(body.items) ? body.items : [];
    if (!itemsIn.length) return { ok: false, status: 400, error: 'Cart is empty' };

    const resolvedItems = [];
    for (const it of itemsIn) {
      const qty = Math.floor(Number(it.qty ?? it.quantity ?? 0));
      if (!Number.isFinite(qty) || qty <= 0) return { ok: false, status: 400, error: 'Invalid item quantity' };
      const v = resolveVariant(db, tenant.id, it.variant_id ?? it.id);
      if (!v) return { ok: false, status: 404, error: `Variant not found: ${it.variant_id ?? it.id}` };
      const prod = db.sqlite.prepare(`SELECT id, title, image FROM products WHERE id = ? AND tenant_id = ?`).get(v.product_id, tenant.id);
      resolvedItems.push({
        variant_id: v.id,
        shopify_variant_id: v.shopify_variant_id,
        product_id: v.product_id,
        title: prod?.title || 'Product',
        variant_title: v.title,
        sku: v.sku,
        qty,
        unit_price_cents: v.price_cents,
        line_total_cents: v.price_cents * qty
      });
    }

    const fulfillmentType = body.fulfillment_type === 'pickup' ? 'pickup' : 'delivery';
    const lat = body.lat != null && body.lat !== '' ? Number(body.lat) : null;
    const lng = body.lng != null && body.lng !== '' ? Number(body.lng) : null;
    const strategy = tenant.settings?.routing_strategy || 'nearest_single';

    const plan = planFulfillment(db, tenant.id, resolvedItems, {
      lat,
      lng,
      fulfillmentType,
      preferredWarehouseId: body.warehouse_id || null,
      strategy
    });

    if (!plan.ok) {
      return { ok: false, status: 409, error: plan.error === 'insufficient_stock_in_warehouse' ? 'Selected pickup warehouse does not have enough stock' : 'Insufficient stock across warehouses for this order', detail: plan };
    }

    const subtotalCents = resolvedItems.reduce((s, i) => s + i.line_total_cents, 0);

    // Coupon calculation (server-side)
    let discountCents = 0;
    let appliedCoupon = null;
    if (body.coupon_code) {
      const code = String(body.coupon_code).trim().toUpperCase();
      const cpn = db.sqlite.prepare(`SELECT * FROM coupons WHERE tenant_id = ? AND UPPER(code) = ? AND active = 1`).get(tenant.id, code);
      if (!cpn) return { ok: false, status: 400, error: `Invalid coupon code: ${code}` };
      if (cpn.expires_at && cpn.expires_at < new Date().toISOString()) return { ok: false, status: 400, error: 'Coupon has expired' };
      if (cpn.max_uses > 0 && cpn.used_count >= cpn.max_uses) return { ok: false, status: 400, error: 'Coupon usage limit reached' };
      if (subtotalCents < cpn.min_purchase_cents) {
        return { ok: false, status: 400, error: `Minimum purchase for ${code} is ${formatMoney(cpn.min_purchase_cents, tenant.currency)}` };
      }
      discountCents = cpn.type === 'pct' ? Math.round((subtotalCents * cpn.value) / 100) : Math.min(subtotalCents, cpn.value);
      appliedCoupon = cpn.code;
    }

    // Shipping zone fee calculation
    let shippingCents = 0;
    let zoneName = fulfillmentType === 'pickup' ? 'Store Pickup (Free)' : 'Standard Delivery';
    let eta = fulfillmentType === 'pickup' ? 'Ready in 1 hour' : 'Same day';
    const distKm = plan.warehouse.distance_km;

    if (fulfillmentType === 'delivery') {
      const zones = db.sqlite.prepare(`SELECT * FROM courier_zones WHERE tenant_id = ? AND active = 1 ORDER BY max_km ASC`).all(tenant.id);
      const freeThreshold = Number(tenant.settings?.free_shipping_cents || 0);
      if (freeThreshold > 0 && subtotalCents - discountCents >= freeThreshold) {
        shippingCents = 0;
        zoneName = 'Free Express Shipping';
      } else if (zones.length) {
        const matched = distKm != null ? zones.find(z => distKm <= z.max_km) || zones[zones.length - 1] : zones[0];
        shippingCents = matched.fee_cents;
        zoneName = matched.name;
        eta = matched.eta;
      }
    }

    const totalCents = Math.max(0, subtotalCents - discountCents + shippingCents);

    return {
      ok: true,
      items: resolvedItems,
      fulfillment_type: fulfillmentType,
      warehouse: plan.warehouse,
      split_shipment: plan.split,
      allocations: plan.allocations,
      distance_km: distKm,
      zone_name: zoneName,
      eta,
      subtotal_cents: subtotalCents,
      discount_cents: discountCents,
      coupon_code: appliedCoupon,
      shipping_cents: shippingCents,
      total_cents: totalCents,
      currency: tenant.currency
    };
  }

  function injectStorefrontBridge(html, tenant, warehouses) {
    const tc = tenant.theme_config || {};
    const contextJson = JSON.stringify({
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        currency: tenant.currency,
        theme_config: tc,
        settings: tenant.settings
      },
      warehouses: warehouses.map(w => ({ id: w.id, code: w.code, name: w.name, city: w.city, address: w.address, lat: w.lat, lng: w.lng, pickup_enabled: w.pickup_enabled }))
    }).replace(/<\/script/gi, '<\\/script');

    const themeCss = `
      <style id="mt-tenant-theme">
        :root {
          --mt-primary: ${tc.primary || '#cb321e'};
          --mt-accent: ${tc.accent || '#fec61f'};
          ${tc.primary ? `--color-cart-bubble: ${tc.primary};` : ''}
        }
      </style>
      <link rel="stylesheet" href="/mt-bridge.css">
      <script>window.__MT_CONTEXT__ = ${contextJson};</script>
    `;

    // Strip external Shopify CDN module scripts that fail or slow down local/offline browsing
    let out = html
      .replace(/<script[^>]+src="https:\/\/cdn\.shopify\.com\/[^"]+"[^>]*><\/script>/gi, '')
      .replace(/<script[^>]*>\s*await import\("https:\/\/cdn\.shopify\.com\/[^"]+"\)[\s\S]*?<\/script>/gi, '');

    if (out.includes('</head>')) {
      out = out.replace('</head>', `${themeCss}\n</head>`);
    }
    if (out.includes('</body>')) {
      out = out.replace('</body>', `<script src="/mt-bridge.js" defer></script>\n</body>`);
    }
    return out;
  }

  function renderDynamicProductPage(tenant, product, variants, warehouses, stockMap) {
    const first = variants[0];
    const totalAvail = variants.reduce(
      (sum, v) => sum + warehouses.reduce((s, w) => s + (stockMap.get(`${w.id}:${v.id}`)?.available ?? 0), 0),
      0
    );
    const tc = tenant.theme_config || {};
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${product.title} — ${tenant.name}</title>
  <link rel="stylesheet" href="/cdn/shop/t/3/assets/theme.css">
  <link rel="stylesheet" href="/mt-bridge.css">
</head>
<body style="font-family:Poppins,sans-serif;background:${tc.background || '#f5f5f5'};color:#111;margin:0">
  <main style="max-width:1040px;margin:90px auto 40px;padding:24px;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.06);display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:32px">
    <div style="border-radius:12px;overflow:hidden;background:#f4f4f4;aspect-ratio:1/1">
      <img src="${product.image || '/cdn/shop/files/trove-logo.jpg'}" alt="${product.title}" style="width:100%;height:100%;object-fit:cover">
    </div>
    <div>
      <a href="/" style="font-size:13px;color:${tc.primary || '#cb321e'};text-decoration:none">← Back to ${tenant.name}</a>
      <div style="margin-top:8px;font-size:12px;text-transform:uppercase;color:#64748b">${product.category}</div>
      <h1 style="margin:6px 0 12px;font-size:28px">${product.title}</h1>
      <div style="font-size:22px;font-weight:700;margin-bottom:12px">${formatMoney(first?.price_cents || 0, tenant.currency)}</div>
      <p style="color:#475569;line-height:1.6">${product.description || 'Fresh quality product.'}</p>
      <div style="margin:18px 0;padding:14px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0">
        <div style="font-weight:600;font-size:13px;margin-bottom:8px">Multi-Warehouse Stock (${totalAvail} total available)</div>
        ${warehouses
          .map(w => {
            const avail = first ? stockMap.get(`${w.id}:${first.id}`)?.available ?? 0 : 0;
            return `<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0"><span>${w.name} (${w.city})</span><strong style="color:${avail > 0 ? '#15803d' : '#b91c1c'}">${avail > 0 ? `${avail} in stock` : 'Out of stock'}</strong></div>`;
          })
          .join('')}
      </div>
      <form method="post" action="/cart/add" style="display:flex;gap:10px;flex-wrap:wrap">
        <select name="id" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;flex:1">
          ${variants.map(v => `<option value="${v.shopify_variant_id || v.id}">${v.title} — ${formatMoney(v.price_cents, tenant.currency)}</option>`).join('')}
        </select>
        <input type="number" name="quantity" value="1" min="1" style="width:76px;padding:10px;border:1px solid #cbd5e1;border-radius:8px">
        <button type="button" class="mt-btn-primary" onclick="window.__MT_ADD_AND_OPEN__(this.form)">Add to Cart</button>
      </form>
    </div>
  </main>
</body>
</html>`;
    return injectStorefrontBridge(html, tenant, warehouses);
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = decodeURIComponent(url.pathname);
      const method = req.method.toUpperCase();

      // Periodic expiry check on API/checkout reads
      if (pathname.startsWith('/api/')) expireStaleOrders(db);

      // -----------------------------------------------------------------------
      // Health & Tenant Directory
      // -----------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      }

      if (method === 'GET' && pathname === '/api/tenants') {
        const rows = db.sqlite
          .prepare(`SELECT id, slug, name, status, currency, theme_config FROM tenants WHERE status = 'active' ORDER BY created_at ASC`)
          .all()
          .map(r => ({ ...r, theme_config: parseJson(r.theme_config, {}) }));
        return sendJson(res, 200, { tenants: rows });
      }

      if (method === 'POST' && pathname === '/api/tenants/signup') {
        const body = await readBody(req);
        const slug = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!slug || slug.length < 3 || !name || !email || password.length < 6) {
          return sendJson(res, 400, { error: 'slug (min 3 chars), name, email, and password (min 6 chars) are required' });
        }
        const exists = db.sqlite.prepare(`SELECT id FROM tenants WHERE slug = ?`).get(slug);
        if (exists) return sendJson(res, 409, { error: 'Store slug already exists' });

        const now = new Date().toISOString();
        const tenantId = randomId('ten');
        const userId = randomId('usr');
        const warehouseId = randomId('wh');

        db.transaction(() => {
          db.sqlite
            .prepare(`INSERT INTO tenants (id, slug, name, status, currency, locale, theme_config, settings, created_at) VALUES (?, ?, ?, 'pending', ?, 'en-US', ?, ?, ?)`)
            .run(
              tenantId,
              slug,
              name,
              body.currency === 'IDR' ? 'IDR' : 'USD',
              JSON.stringify({ primary: body.primary || '#0f766e', accent: body.accent || '#f59e0b', announcement: `Welcome to ${name}` }),
              JSON.stringify({ routing_strategy: 'nearest_single', free_shipping_cents: 10000, pay_minutes: 60, pickup_enabled: true }),
              now
            );
          db.sqlite
            .prepare(`INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)`)
            .run(userId, tenantId, email, body.owner_name || name + ' Owner', hashPassword(password), now);
          db.sqlite
            .prepare(`INSERT INTO warehouses (id, tenant_id, code, name, address, city, postal_code, lat, lng, priority, pickup_enabled, active, created_at) VALUES (?, ?, 'MAIN', ?, ?, ?, ?, ?, ?, 10, 1, 1, ?)`)
            .run(warehouseId, tenantId, body.warehouse_name || 'Main Warehouse', body.address || '100 Main St', body.city || 'New York', body.postal_code || '10001', Number(body.lat ?? 40.73), Number(body.lng ?? -73.99), now);
        });

        return sendJson(res, 201, {
          ok: true,
          tenant: { id: tenantId, slug, name, status: 'pending' },
          message: 'Store created in pending status. Await platform super-admin approval to go live publicly.'
        });
      }

      // -----------------------------------------------------------------------
      // Auth Endpoints
      // -----------------------------------------------------------------------
      if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await readBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const storeSlug = body.store ? String(body.store).trim().toLowerCase() : null;

        let user = null;
        if (!storeSlug) {
          user = db.sqlite.prepare(`SELECT * FROM users WHERE tenant_id IS NULL AND email = ?`).get(email);
        } else {
          const t = db.sqlite.prepare(`SELECT id FROM tenants WHERE slug = ?`).get(storeSlug);
          if (!t) return sendJson(res, 404, { error: 'Store not found' });
          user = db.sqlite.prepare(`SELECT * FROM users WHERE tenant_id = ? AND email = ?`).get(t.id, email);
        }
        if (!user || !verifyPassword(password, user.password_hash)) {
          return sendJson(res, 401, { error: 'Invalid credentials' });
        }
        const token = signToken({ uid: user.id, tid: user.tenant_id, role: user.role, exp: Date.now() + 7 * 86400 * 1000 }, SESSION_SECRET);
        return sendJson(
          res,
          200,
          { ok: true, token, user: { id: user.id, tenant_id: user.tenant_id, email: user.email, name: user.name, role: user.role } },
          { 'Set-Cookie': `mt_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` }
        );
      }

      if (method === 'POST' && pathname === '/api/auth/logout') {
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `mt_session=; Path=/; HttpOnly; Max-Age=0` });
      }

      if (method === 'GET' && pathname === '/api/auth/me') {
        const user = getAuthUser(req);
        if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
        const tenant = user.tenant_id ? hydrateTenant(db.sqlite.prepare(`SELECT * FROM tenants WHERE id = ?`).get(user.tenant_id)) : null;
        return sendJson(res, 200, { user, tenant });
      }

      // -----------------------------------------------------------------------
      // Super Admin Endpoints
      // -----------------------------------------------------------------------
      if (pathname.startsWith('/api/super/')) {
        const user = getAuthUser(req);
        if (!user || user.role !== 'super') return sendJson(res, 403, { error: 'Super-admin access required' });

        if (method === 'GET' && pathname === '/api/super/tenants') {
          const rows = db.sqlite.prepare(`SELECT * FROM tenants ORDER BY created_at DESC`).all().map(t => {
            const whCount = db.sqlite.prepare(`SELECT COUNT(*) AS c FROM warehouses WHERE tenant_id = ?`).get(t.id).c;
            const prodCount = db.sqlite.prepare(`SELECT COUNT(*) AS c FROM products WHERE tenant_id = ?`).get(t.id).c;
            const ordCount = db.sqlite.prepare(`SELECT COUNT(*) AS c FROM orders WHERE tenant_id = ?`).get(t.id).c;
            return { ...hydrateTenant(t), stats: { warehouses: whCount, products: prodCount, orders: ordCount } };
          });
          return sendJson(res, 200, { tenants: rows });
        }

        const statusMatch = pathname.match(/^\/api\/super\/tenants\/([^/]+)\/status$/);
        if (method === 'POST' && statusMatch) {
          const body = await readBody(req);
          if (!['active', 'pending', 'suspended'].includes(body.status)) {
            return sendJson(res, 400, { error: 'Invalid status' });
          }
          const info = db.sqlite.prepare(`UPDATE tenants SET status = ? WHERE id = ?`).run(body.status, statusMatch[1]);
          if (!info.changes) return sendJson(res, 404, { error: 'Tenant not found' });
          return sendJson(res, 200, { ok: true, id: statusMatch[1], status: body.status });
        }

        const domMatch = pathname.match(/^\/api\/super\/tenants\/([^/]+)\/domain$/);
        if (method === 'POST' && domMatch) {
          const body = await readBody(req);
          const dom = body.custom_domain ? String(body.custom_domain).trim().toLowerCase() : null;
          db.sqlite.prepare(`UPDATE tenants SET custom_domain = ? WHERE id = ?`).run(dom, domMatch[1]);
          return sendJson(res, 200, { ok: true, id: domMatch[1], custom_domain: dom });
        }

        return sendJson(res, 404, { error: 'Not found' });
      }

      // -----------------------------------------------------------------------
      // Tenant Resolution for Storefront + Store API + Tenant Admin API
      // -----------------------------------------------------------------------
      const { tenant, querySlug } = resolveTenant(req, url);
      const authUser = getAuthUser(req);

      if (!tenant) return sendJson(res, 404, { error: 'Store not found' });

      const canAccessPending =
        authUser && (authUser.role === 'super' || authUser.tenant_id === tenant.id);
      if (tenant.status === 'suspended' && authUser?.role !== 'super') {
        return sendJson(res, 403, { error: 'This store is suspended' });
      }
      if (tenant.status === 'pending' && !canAccessPending) {
        return sendJson(res, 403, { error: 'Store is pending platform approval' });
      }

      const storeCookieHeader = querySlug
        ? { 'Set-Cookie': `mt_store=${encodeURIComponent(tenant.slug)}; Path=/; SameSite=Lax; Max-Age=2592000` }
        : {};

      // -----------------------------------------------------------------------
      // Storefront Public API
      // -----------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/store') {
        const warehouses = rankWarehouses(db, tenant.id);
        const zones = db.sqlite.prepare(`SELECT * FROM courier_zones WHERE tenant_id = ? AND active = 1 ORDER BY max_km ASC`).all(tenant.id);
        return sendJson(res, 200, { tenant, warehouses, zones }, storeCookieHeader);
      }

      if (method === 'GET' && pathname === '/api/warehouses') {
        const lat = url.searchParams.get('lat');
        const lng = url.searchParams.get('lng');
        const warehouses = rankWarehouses(db, tenant.id, { lat: lat ? Number(lat) : null, lng: lng ? Number(lng) : null });
        return sendJson(res, 200, { warehouses });
      }

      if (method === 'GET' && pathname === '/api/products') {
        const category = url.searchParams.get('category');
        const search = url.searchParams.get('q');
        const products = listCatalogProducts(tenant.id, { category, search });
        return sendJson(res, 200, { tenant_slug: tenant.slug, products });
      }

      if (method === 'POST' && pathname === '/api/quote') {
        const body = await readBody(req);
        const q = computeQuote(tenant, body);
        if (!q.ok) return sendJson(res, q.status, { error: q.error, detail: q.detail });
        return sendJson(res, 200, q);
      }

      if (method === 'POST' && pathname === '/api/checkout') {
        const body = await readBody(req);
        const customerName = String(body.customer_name || '').trim();
        if (!customerName) return sendJson(res, 400, { error: 'Customer name is required' });

        const q = computeQuote(tenant, body);
        if (!q.ok) return sendJson(res, q.status, { error: q.error, detail: q.detail });

        const orderNo = newOrderNo(tenant.slug);
        const orderId = randomId('ord');
        const now = new Date();
        const payMins = Number(tenant.settings?.pay_minutes || 60);
        const expiresAt = new Date(now.getTime() + payMins * 60 * 1000).toISOString();
        const paymentMethod = ['card_sim', 'bank_transfer', 'cod', 'wallet'].includes(body.payment_method) ? body.payment_method : 'card_sim';

        const created = db.transaction(() => {
          reserveAllocations(db, tenant.id, q.allocations, orderNo);

          if (q.coupon_code) {
            const cpn = db.sqlite.prepare(`SELECT * FROM coupons WHERE tenant_id = ? AND UPPER(code) = ?`).get(tenant.id, q.coupon_code);
            if (cpn && cpn.max_uses > 0 && cpn.used_count >= cpn.max_uses) {
              throw Object.assign(new Error('Coupon usage limit reached'), { code: 'bad_request' });
            }
            db.sqlite.prepare(`UPDATE coupons SET used_count = used_count + 1 WHERE tenant_id = ? AND UPPER(code) = ?`).run(tenant.id, q.coupon_code);
          }

          db.sqlite
            .prepare(`
              INSERT INTO orders (
                id, tenant_id, order_no, status, payment_method, payment_status, fulfillment_type,
                warehouse_id, allocations_json, customer_name, customer_email, customer_phone,
                shipping_address, lat, lng, distance_km, zone_name,
                subtotal_cents, discount_cents, shipping_cents, total_cents, coupon_code, note, expires_at, created_at
              ) VALUES (?, ?, ?, 'pending', ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              orderId,
              tenant.id,
              orderNo,
              paymentMethod,
              q.fulfillment_type,
              q.warehouse.id,
              JSON.stringify(q.allocations),
              customerName,
              String(body.customer_email || '').trim(),
              String(body.customer_phone || '').trim(),
              String(body.shipping_address || '').trim(),
              body.lat != null ? Number(body.lat) : null,
              body.lng != null ? Number(body.lng) : null,
              q.distance_km,
              q.zone_name,
              q.subtotal_cents,
              q.discount_cents,
              q.shipping_cents,
              q.total_cents,
              q.coupon_code,
              String(body.note || '').trim(),
              expiresAt,
              now.toISOString()
            );

          const insItem = db.sqlite.prepare(`
            INSERT INTO order_items (id, tenant_id, order_id, product_id, variant_id, warehouse_id, title, variant_title, sku, qty, unit_price_cents, line_total_cents)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const a of q.allocations) {
            const it = q.items.find(x => x.variant_id === a.variant_id);
            insItem.run(
              randomId('oit'),
              tenant.id,
              orderId,
              it.product_id,
              it.variant_id,
              a.warehouse_id,
              it.title,
              it.variant_title,
              it.sku,
              a.qty,
              it.unit_price_cents,
              it.unit_price_cents * a.qty
            );
          }

          if (body.clear_cart) {
            const cookies = parseCookies(req.headers.cookie);
            if (cookies.mt_cart) {
              const cart = db.sqlite.prepare(`SELECT id FROM carts WHERE tenant_id = ? AND token = ?`).get(tenant.id, cookies.mt_cart);
              if (cart) {
                db.sqlite.prepare(`DELETE FROM cart_items WHERE cart_id = ?`).run(cart.id);
                db.sqlite.prepare(`UPDATE carts SET discount_code = '', note = '' WHERE id = ?`).run(cart.id);
              }
            }
          }

          return db.sqlite.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
        });

        return sendJson(res, 201, {
          ok: true,
          order: {
            ...created,
            allocations: q.allocations,
            warehouse_name: q.warehouse.name,
            warehouse_code: q.warehouse.code
          }
        });
      }

      const ordPayMatch = pathname.match(/^\/api\/orders\/([^/]+)\/pay$/);
      if (method === 'POST' && ordPayMatch) {
        const orderNo = decodeURIComponent(ordPayMatch[1]);
        const order = db.sqlite.prepare(`SELECT * FROM orders WHERE tenant_id = ? AND order_no = ?`).get(tenant.id, orderNo);
        if (!order) return sendJson(res, 404, { error: 'Order not found' });
        if (order.payment_status === 'paid') return sendJson(res, 200, { ok: true, already_paid: true, order });
        if (order.status === 'cancelled' || order.status === 'expired') {
          return sendJson(res, 409, { error: `Cannot pay an order in status: ${order.status}` });
        }

        const allocs = parseJson(order.allocations_json, []);
        const now = new Date().toISOString();
        db.transaction(() => {
          commitAllocations(db, tenant.id, allocs, order.order_no);
          db.sqlite.prepare(`UPDATE orders SET status = 'paid', payment_status = 'paid', paid_at = ? WHERE id = ?`).run(now, order.id);
        });
        const updated = db.sqlite.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id);
        return sendJson(res, 200, { ok: true, order: updated });
      }

      const ordGetMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (method === 'GET' && ordGetMatch) {
        const orderNo = decodeURIComponent(ordGetMatch[1]);
        const order = db.sqlite
          .prepare(`
            SELECT o.*, w.name AS warehouse_name, w.code AS warehouse_code, w.address AS warehouse_address, w.city AS warehouse_city
            FROM orders o
            LEFT JOIN warehouses w ON w.id = o.warehouse_id
            WHERE o.tenant_id = ? AND o.order_no = ?
          `)
          .get(tenant.id, orderNo);
        if (!order) return sendJson(res, 404, { error: 'Order not found' });
        const items = db.sqlite.prepare(`SELECT * FROM order_items WHERE tenant_id = ? AND order_id = ?`).all(tenant.id, order.id);
        return sendJson(res, 200, { order: { ...order, allocations: parseJson(order.allocations_json, []), items } });
      }

      // -----------------------------------------------------------------------
      // Tenant Admin Back Office API (/api/admin/*)
      // -----------------------------------------------------------------------
      if (pathname.startsWith('/api/admin/')) {
        if (!authUser) return sendJson(res, 401, { error: 'Authentication required' });
        if (authUser.role !== 'super' && authUser.tenant_id !== tenant.id) {
          return sendJson(res, 403, { error: 'Forbidden: cross-tenant access denied' });
        }

        const isOwner = authUser.role === 'owner' || authUser.role === 'super';

        if (method === 'GET' && pathname === '/api/admin/store') {
          return sendJson(res, 200, { tenant });
        }
        if (method === 'PUT' && pathname === '/api/admin/store') {
          if (!isOwner) return sendJson(res, 403, { error: 'Owner role required' });
          const body = await readBody(req);
          const nextName = body.name ? String(body.name).trim() : tenant.name;
          const nextTheme = { ...tenant.theme_config, ...(body.theme_config || {}) };
          const nextSettings = { ...tenant.settings, ...(body.settings || {}) };
          db.sqlite
            .prepare(`UPDATE tenants SET name = ?, theme_config = ?, settings = ? WHERE id = ?`)
            .run(nextName, JSON.stringify(nextTheme), JSON.stringify(nextSettings), tenant.id);
          const updated = hydrateTenant(db.sqlite.prepare(`SELECT * FROM tenants WHERE id = ?`).get(tenant.id));
          return sendJson(res, 200, { ok: true, tenant: updated });
        }

        // Warehouses CRUD
        if (method === 'GET' && pathname === '/api/admin/warehouses') {
          const warehouses = db.sqlite.prepare(`SELECT * FROM warehouses WHERE tenant_id = ? ORDER BY priority DESC, name ASC`).all(tenant.id);
          return sendJson(res, 200, { warehouses });
        }
        if (method === 'POST' && pathname === '/api/admin/warehouses') {
          if (!isOwner) return sendJson(res, 403, { error: 'Owner role required' });
          const body = await readBody(req);
          const code = String(body.code || '').trim().toUpperCase();
          const name = String(body.name || '').trim();
          if (!code || !name) return sendJson(res, 400, { error: 'code and name are required' });
          const id = randomId('wh');
          db.sqlite
            .prepare(`INSERT INTO warehouses (id, tenant_id, code, name, address, city, postal_code, lat, lng, priority, pickup_enabled, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, tenant.id, code, name, body.address || '', body.city || '', body.postal_code || '', Number(body.lat ?? 0), Number(body.lng ?? 0), Number(body.priority ?? 0), body.pickup_enabled === false ? 0 : 1, body.active === false ? 0 : 1, new Date().toISOString());
          return sendJson(res, 201, { ok: true, warehouse: db.sqlite.prepare(`SELECT * FROM warehouses WHERE id = ?`).get(id) });
        }
        const whMatch = pathname.match(/^\/api\/admin\/warehouses\/([^/]+)$/);
        if (whMatch && whMatch[1] !== 'transfer') {
          const whId = whMatch[1];
          const existing = db.sqlite.prepare(`SELECT * FROM warehouses WHERE id = ? AND tenant_id = ?`).get(whId, tenant.id);
          if (!existing) return sendJson(res, 404, { error: 'Warehouse not found' });
          if (method === 'PUT') {
            if (!isOwner) return sendJson(res, 403, { error: 'Owner role required' });
            const body = await readBody(req);
            db.sqlite
              .prepare(`UPDATE warehouses SET name = ?, address = ?, city = ?, postal_code = ?, lat = ?, lng = ?, priority = ?, pickup_enabled = ?, active = ? WHERE id = ? AND tenant_id = ?`)
              .run(
                body.name ?? existing.name,
                body.address ?? existing.address,
                body.city ?? existing.city,
                body.postal_code ?? existing.postal_code,
                body.lat != null ? Number(body.lat) : existing.lat,
                body.lng != null ? Number(body.lng) : existing.lng,
                body.priority != null ? Number(body.priority) : existing.priority,
                body.pickup_enabled != null ? (body.pickup_enabled ? 1 : 0) : existing.pickup_enabled,
                body.active != null ? (body.active ? 1 : 0) : existing.active,
                whId,
                tenant.id
              );
            return sendJson(res, 200, { ok: true, warehouse: db.sqlite.prepare(`SELECT * FROM warehouses WHERE id = ?`).get(whId) });
          }
          if (method === 'DELETE') {
            if (!isOwner) return sendJson(res, 403, { error: 'Owner role required' });
            db.sqlite.prepare(`UPDATE warehouses SET active = 0 WHERE id = ? AND tenant_id = ?`).run(whId, tenant.id);
            return sendJson(res, 200, { ok: true });
          }
        }

        // Warehouse-to-warehouse atomic stock transfer
        if (method === 'POST' && pathname === '/api/admin/warehouses/transfer') {
          const body = await readBody(req);
          try {
            const result = transferStock(db, tenant.id, {
              fromWarehouseId: body.from_warehouse_id,
              toWarehouseId: body.to_warehouse_id,
              variantId: body.variant_id,
              qty: body.qty,
              note: body.note || ''
            });
            return sendJson(res, 200, result);
          } catch (e) {
            return sendJson(res, e.code === 'not_found' ? 404 : e.code === 'out_of_stock' ? 409 : 400, { error: e.message });
          }
        }

        // Stock adjustments & matrix
        if (method === 'GET' && pathname === '/api/admin/stock') {
          const rows = db.sqlite
            .prepare(`
              SELECT ws.*, w.name AS warehouse_name, w.code AS warehouse_code, v.title AS variant_title, v.sku, p.title AS product_title, p.handle
              FROM warehouse_stock ws
              JOIN warehouses w ON w.id = ws.warehouse_id
              JOIN variants v ON v.id = ws.variant_id
              JOIN products p ON p.id = v.product_id
              WHERE ws.tenant_id = ?
              ORDER BY p.sort_order ASC, w.priority DESC
            `)
            .all(tenant.id);
          return sendJson(res, 200, { stock: rows });
        }

        if (method === 'PUT' && pathname === '/api/admin/stock') {
          const body = await readBody(req);
          const wh = db.sqlite.prepare(`SELECT id FROM warehouses WHERE id = ? AND tenant_id = ?`).get(body.warehouse_id, tenant.id);
          const vr = db.sqlite.prepare(`SELECT id FROM variants WHERE id = ? AND tenant_id = ?`).get(body.variant_id, tenant.id);
          if (!wh || !vr) return sendJson(res, 404, { error: 'Warehouse or variant not found for tenant' });
          const newQty = Math.max(0, Math.floor(Number(body.qty ?? 0)));
          const now = new Date().toISOString();

          db.transaction(() => {
            const cur = db.sqlite.prepare(`SELECT qty FROM warehouse_stock WHERE tenant_id = ? AND warehouse_id = ? AND variant_id = ?`).get(tenant.id, wh.id, vr.id);
            const delta = newQty - (cur?.qty ?? 0);
            db.sqlite
              .prepare(`INSERT INTO warehouse_stock (tenant_id, warehouse_id, variant_id, qty, reserved, reorder_point, updated_at)
                        VALUES (?, ?, ?, ?, 0, ?, ?)
                        ON CONFLICT(warehouse_id, variant_id) DO UPDATE SET qty = excluded.qty, reorder_point = excluded.reorder_point, updated_at = excluded.updated_at`)
              .run(tenant.id, wh.id, vr.id, newQty, Math.max(0, Number(body.reorder_point ?? 5)), now);
            db.sqlite
              .prepare(`INSERT INTO stock_movements (id, tenant_id, warehouse_id, variant_id, type, delta_qty, note, created_at) VALUES (?, ?, ?, ?, 'adjust', ?, ?, ?)`)
              .run(randomId('mov'), tenant.id, wh.id, vr.id, delta, body.note || 'Manual stock adjustment', now);
          });
          return sendJson(res, 200, { ok: true, warehouse_id: wh.id, variant_id: vr.id, qty: newQty });
        }

        if (method === 'GET' && pathname === '/api/admin/movements') {
          const rows = db.sqlite
            .prepare(`
              SELECT m.*, w.name AS warehouse_name, w.code AS warehouse_code, p.title AS product_title, v.title AS variant_title
              FROM stock_movements m
              JOIN warehouses w ON w.id = m.warehouse_id
              JOIN variants v ON v.id = m.variant_id
              JOIN products p ON p.id = v.product_id
              WHERE m.tenant_id = ?
              ORDER BY m.created_at DESC
              LIMIT 100
            `)
            .all(tenant.id);
          return sendJson(res, 200, { movements: rows });
        }

        // Products & Variants
        if (method === 'GET' && pathname === '/api/admin/products') {
          return sendJson(res, 200, { products: listCatalogProducts(tenant.id) });
        }
        if (method === 'POST' && pathname === '/api/admin/products') {
          const body = await readBody(req);
          const title = String(body.title || '').trim();
          if (!title) return sendJson(res, 400, { error: 'Product title is required' });
          const handle = String(body.handle || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + randomId('').slice(0, 4);
          const pid = randomId('prd');
          const vid = randomId('var');
          const shopifyVid = String(46810000000000 + Math.floor(Math.random() * 899999999));
          const now = new Date().toISOString();

          db.transaction(() => {
            db.sqlite
              .prepare(`INSERT INTO products (id, tenant_id, handle, title, category, description, image, vendor, sort_order, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`)
              .run(pid, tenant.id, handle, title, body.category || 'Groceries', body.description || '', body.image || '/cdn/shop/files/trove-logo.jpg', tenant.name, now);
            db.sqlite
              .prepare(`INSERT INTO variants (id, tenant_id, product_id, shopify_variant_id, sku, title, price_cents, weight_g, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
              .run(vid, tenant.id, pid, shopifyVid, body.sku || `SKU-${shopifyVid.slice(-5)}`, body.variant_title || 'Standard', Math.max(0, Math.round(Number(body.price_cents ?? 999))), Number(body.weight_g ?? 450), now);

            const whs = db.sqlite.prepare(`SELECT id FROM warehouses WHERE tenant_id = ? AND active = 1`).all(tenant.id);
            const initQty = Math.max(0, Math.floor(Number(body.initial_qty ?? 10)));
            for (const w of whs) {
              db.sqlite
                .prepare(`INSERT INTO warehouse_stock (tenant_id, warehouse_id, variant_id, qty, reserved, reorder_point, updated_at) VALUES (?, ?, ?, ?, 0, 5, ?)`)
                .run(tenant.id, w.id, vid, initQty, now);
            }
          });
          return sendJson(res, 201, { ok: true, product_id: pid, variant_id: vid, handle });
        }

        // Courier zones
        if (method === 'GET' && pathname === '/api/admin/zones') {
          return sendJson(res, 200, { zones: db.sqlite.prepare(`SELECT * FROM courier_zones WHERE tenant_id = ? ORDER BY max_km ASC`).all(tenant.id) });
        }
        if (method === 'POST' && pathname === '/api/admin/zones') {
          const body = await readBody(req);
          const id = randomId('zon');
          db.sqlite
            .prepare(`INSERT INTO courier_zones (id, tenant_id, name, max_km, fee_cents, eta, active) VALUES (?, ?, ?, ?, ?, ?, 1)`)
            .run(id, tenant.id, body.name || 'Zone', Number(body.max_km || 15), Math.max(0, Number(body.fee_cents || 0)), body.eta || 'Same day');
          return sendJson(res, 201, { ok: true, id });
        }

        // Coupons
        if (method === 'GET' && pathname === '/api/admin/coupons') {
          return sendJson(res, 200, { coupons: db.sqlite.prepare(`SELECT * FROM coupons WHERE tenant_id = ?`).all(tenant.id) });
        }
        if (method === 'POST' && pathname === '/api/admin/coupons') {
          const body = await readBody(req);
          const code = String(body.code || '').trim().toUpperCase();
          if (!code) return sendJson(res, 400, { error: 'Coupon code required' });
          const id = randomId('cpn');
          db.sqlite
            .prepare(`INSERT INTO coupons (id, tenant_id, code, type, value, min_purchase_cents, max_uses, used_count, expires_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`)
            .run(id, tenant.id, code, body.type === 'amt' ? 'amt' : 'pct', Number(body.value || 10), Number(body.min_purchase_cents || 0), Number(body.max_uses || 0), body.expires_at || null);
          return sendJson(res, 201, { ok: true, id, code });
        }

        // Orders & fulfillment status workflow
        if (method === 'GET' && pathname === '/api/admin/orders') {
          const orders = db.sqlite
            .prepare(`
              SELECT o.*, w.name AS warehouse_name, w.code AS warehouse_code
              FROM orders o
              LEFT JOIN warehouses w ON w.id = o.warehouse_id
              WHERE o.tenant_id = ?
              ORDER BY o.created_at DESC
              LIMIT 100
            `)
            .all(tenant.id)
            .map(o => ({ ...o, allocations: parseJson(o.allocations_json, []) }));
          return sendJson(res, 200, { orders });
        }

        const ordStatusMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
        if (method === 'POST' && ordStatusMatch) {
          const orderNo = decodeURIComponent(ordStatusMatch[1]);
          const body = await readBody(req);
          const next = String(body.status || '');
          const allowed = ['paid', 'packing', 'shipped', 'delivered', 'cancelled'];
          if (!allowed.includes(next)) return sendJson(res, 400, { error: 'Invalid status' });

          const order = db.sqlite.prepare(`SELECT * FROM orders WHERE tenant_id = ? AND order_no = ?`).get(tenant.id, orderNo);
          if (!order) return sendJson(res, 404, { error: 'Order not found' });

          const allocs = parseJson(order.allocations_json, []);
          db.transaction(() => {
            if (next === 'paid' && order.payment_status === 'unpaid') {
              commitAllocations(db, tenant.id, allocs, order.order_no);
              db.sqlite.prepare(`UPDATE orders SET status = 'paid', payment_status = 'paid', paid_at = ? WHERE id = ?`).run(new Date().toISOString(), order.id);
            } else if (next === 'cancelled' && order.status === 'pending' && order.payment_status === 'unpaid') {
              releaseAllocations(db, tenant.id, allocs, order.order_no, `Cancelled ${order.order_no}`);
              if (order.coupon_code) {
                db.sqlite.prepare(`UPDATE coupons SET used_count = MAX(used_count - 1, 0) WHERE tenant_id = ? AND UPPER(code) = ?`).run(tenant.id, order.coupon_code.toUpperCase());
              }
              db.sqlite.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).run(order.id);
            } else {
              db.sqlite.prepare(`UPDATE orders SET status = ? WHERE id = ?`).run(next, order.id);
            }
          });
          return sendJson(res, 200, { ok: true, order: db.sqlite.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id) });
        }

        // Integration secrets (encrypted at rest, masked on read)
        if (method === 'GET' && pathname === '/api/admin/secrets') {
          if (!isOwner) return sendJson(res, 403, { error: 'Owner role required' });
          const rows = db.sqlite.prepare(`SELECT provider, updated_at FROM tenant_secrets WHERE tenant_id = ?`).all(tenant.id);
          return sendJson(res, 200, { configured: rows });
        }
        const secMatch = pathname.match(/^\/api\/admin\/secrets\/([^/]+)$/);
        if (method === 'PUT' && secMatch) {
          if (!isOwner) return sendJson(res, 403, { error: 'Owner role required' });
          const body = await readBody(req);
          const enc = encryptSecret(JSON.stringify(body), MASTER_KEY);
          db.sqlite
            .prepare(`INSERT INTO tenant_secrets (tenant_id, provider, encrypted_payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, provider) DO UPDATE SET encrypted_payload = excluded.encrypted_payload, updated_at = excluded.updated_at`)
            .run(tenant.id, secMatch[1], enc, new Date().toISOString());
          return sendJson(res, 200, { ok: true, provider: secMatch[1] });
        }

        return sendJson(res, 404, { error: 'Admin endpoint not found' });
      }

      // -----------------------------------------------------------------------
      // Shopify-Compatible Storefront AJAX & Section Routes
      // -----------------------------------------------------------------------
      const { cartToken, setCookie: cartCookie } = ensureCartCookie(req, tenant.slug);
      const extraHeaders = { ...storeCookieHeader, ...(cartCookie ? { 'Set-Cookie': cartCookie } : {}) };

      if (method === 'GET' && (pathname === '/cart.js' || pathname === '/cart.json' || (pathname === '/cart' && String(req.headers.accept || '').includes('application/json')))) {
        return sendJson(res, 200, getCartState(db, tenant, cartToken), extraHeaders);
      }

      if (method === 'POST' && (pathname === '/cart/add' || pathname === '/cart/add.js')) {
        const body = await readBody(req);
        const itemsReq = Array.isArray(body.items) ? body.items : [{ id: body.id, quantity: body.quantity ?? 1 }];
        const cart = getOrCreateCart(db, tenant.id, cartToken);
        const now = new Date().toISOString();
        let lastAdded = null;

        for (const reqItem of itemsReq) {
          const qty = Math.max(1, Math.floor(Number(reqItem.quantity ?? 1)));
          const variant = resolveVariant(db, tenant.id, reqItem.id);
          if (!variant) return sendJson(res, 404, { status: 404, message: 'Product variant not found', description: 'Variant not available for this store.' });

          const whStock = db.sqlite
            .prepare(`SELECT SUM(MAX(qty - reserved, 0)) AS avail FROM warehouse_stock WHERE tenant_id = ? AND variant_id = ?`)
            .get(tenant.id, variant.id);
          const totalAvail = whStock?.avail ?? 0;
          const existing = db.sqlite.prepare(`SELECT qty FROM cart_items WHERE cart_id = ? AND variant_id = ?`).get(cart.id, variant.id);
          const nextQty = (existing?.qty ?? 0) + qty;
          if (nextQty > totalAvail) {
            return sendJson(res, 422, { status: 422, message: 'Not enough stock', description: `Only ${totalAvail} in stock across warehouses.` });
          }

          db.sqlite
            .prepare(`INSERT INTO cart_items (cart_id, variant_id, qty) VALUES (?, ?, ?) ON CONFLICT(cart_id, variant_id) DO UPDATE SET qty = excluded.qty`)
            .run(cart.id, variant.id, nextQty);
          lastAdded = variant;
        }
        db.sqlite.prepare(`UPDATE carts SET updated_at = ? WHERE id = ?`).run(now, cart.id);

        const state = getCartState(db, tenant, cartToken);
        const sectionsList = typeof body.sections === 'string' ? body.sections.split(',') : Array.isArray(body.sections) ? body.sections : [];
        const sections = renderCartSections(state, sectionsList);
        const addedItem = state.items.find(i => i.variant_id === lastAdded?.id) || state.items[0] || {};
        return sendJson(res, 200, { ...addedItem, ...state, sections }, extraHeaders);
      }

      if (method === 'POST' && (pathname === '/cart/change' || pathname === '/cart/change.js')) {
        const body = await readBody(req);
        const cart = getOrCreateCart(db, tenant.id, cartToken);
        const stateBefore = getCartState(db, tenant, cartToken);
        const line = Number(body.line);
        const qty = Math.max(0, Math.floor(Number(body.quantity ?? 0)));

        let targetVarId = null;
        if (Number.isFinite(line) && line >= 1 && line <= stateBefore.items.length) {
          targetVarId = stateBefore.items[line - 1].variant_id;
        } else if (body.id) {
          const v = resolveVariant(db, tenant.id, String(body.id).split(':')[0]);
          targetVarId = v?.id || null;
        }

        if (targetVarId) {
          if (qty === 0) {
            db.sqlite.prepare(`DELETE FROM cart_items WHERE cart_id = ? AND variant_id = ?`).run(cart.id, targetVarId);
          } else {
            const whStock = db.sqlite.prepare(`SELECT SUM(MAX(qty - reserved, 0)) AS avail FROM warehouse_stock WHERE tenant_id = ? AND variant_id = ?`).get(tenant.id, targetVarId);
            if (qty > (whStock?.avail ?? 0)) {
              return sendJson(res, 422, { errors: `Only ${whStock?.avail ?? 0} available across warehouses` });
            }
            db.sqlite.prepare(`UPDATE cart_items SET qty = ? WHERE cart_id = ? AND variant_id = ?`).run(qty, cart.id, targetVarId);
          }
        }
        const state = getCartState(db, tenant, cartToken);
        const sections = renderCartSections(state, Array.isArray(body.sections) ? body.sections : []);
        return sendJson(res, 200, { ...state, sections }, extraHeaders);
      }

      if (method === 'POST' && (pathname === '/cart/update' || pathname === '/cart/update.js')) {
        const body = await readBody(req);
        const cart = getOrCreateCart(db, tenant.id, cartToken);
        const now = new Date().toISOString();
        if (body.note !== undefined) {
          db.sqlite.prepare(`UPDATE carts SET note = ?, updated_at = ? WHERE id = ?`).run(String(body.note), now, cart.id);
        }
        if (body.discount !== undefined) {
          db.sqlite.prepare(`UPDATE carts SET discount_code = ?, updated_at = ? WHERE id = ?`).run(String(body.discount).toUpperCase(), now, cart.id);
        }
        const state = getCartState(db, tenant, cartToken);
        const sectionsList = typeof body.sections === 'string' ? body.sections.split(',') : Array.isArray(body.sections) ? body.sections : [];
        return sendJson(res, 200, { ...state, sections: renderCartSections(state, sectionsList) }, extraHeaders);
      }

      if (method === 'POST' && pathname === '/cart/clear.js') {
        const cart = getOrCreateCart(db, tenant.id, cartToken);
        db.sqlite.prepare(`DELETE FROM cart_items WHERE cart_id = ?`).run(cart.id);
        return sendJson(res, 200, getCartState(db, tenant, cartToken), extraHeaders);
      }

      if (method === 'GET' && pathname === '/cart/shipping_rates.json') {
        const zones = db.sqlite.prepare(`SELECT * FROM courier_zones WHERE tenant_id = ? AND active = 1 ORDER BY max_km ASC`).all(tenant.id);
        const rates = zones.map(z => ({
          name: z.name,
          presentment_name: `${z.name} (${z.eta})`,
          price: (z.fee_cents / 100).toFixed(2),
          currency: tenant.currency
        }));
        return sendJson(res, 200, { shipping_rates: rates });
      }

      if (method === 'GET' && pathname === '/search/suggest') {
        return sendHtml(res, 200, renderPredictiveSearchHtml(db, tenant, url.searchParams.get('q') || ''));
      }

      const varPickupMatch = pathname.match(/^\/variants\/([^/]+)\/?$/);
      if (method === 'GET' && varPickupMatch && url.searchParams.get('section_id') === 'pickup-availability') {
        return sendHtml(res, 200, renderPickupAvailabilityHtml(db, tenant, varPickupMatch[1]));
      }

      const prodMatch = pathname.match(/^\/products\/([^/.]+?)(\.js)?\/?$/);
      if (method === 'GET' && prodMatch) {
        const handle = prodMatch[1];
        if (prodMatch[2] === '.js') {
          const prod = db.sqlite.prepare(`SELECT * FROM products WHERE tenant_id = ? AND handle = ? AND active = 1`).get(tenant.id, handle);
          if (!prod) return sendJson(res, 404, { error: 'Product not found' });
          const variants = db.sqlite.prepare(`SELECT * FROM variants WHERE tenant_id = ? AND product_id = ? AND active = 1`).all(tenant.id, prod.id);
          return sendJson(res, 200, { ...prod, variants });
        }
        if (url.searchParams.has('section_id')) {
          const html = renderQuickViewHtml(db, tenant, handle);
          if (html) return sendHtml(res, 200, html);
        }
      }

      // -----------------------------------------------------------------------
      // Static Assets, Admin UI, & Storefront HTML Pages
      // -----------------------------------------------------------------------
      if (method === 'GET' || method === 'HEAD') {
        // Admin back office route
        if (pathname === '/admin' || pathname === '/admin/') {
          const adminHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8');
          return sendHtml(res, 200, adminHtml);
        }

        // Check public/ assets first (/mt-bridge.js, /mt-bridge.css, /admin.js, /admin.css)
        const relClean = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\/+/, '');
        const publicFile = path.join(PUBLIC_DIR, relClean);
        if (relClean && fs.existsSync(publicFile) && fs.statSync(publicFile).isFile()) {
          const ext = path.extname(publicFile).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
          if (method === 'HEAD') return res.end();
          return fs.createReadStream(publicFile).pipe(res);
        }

        // Check unzipped storefront files
        let target = path.join(rootDir, relClean);
        if (!relClean) target = path.join(rootDir, 'index.html');
        else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          target = path.join(target, 'index.html');
        } else if (!fs.existsSync(target) && fs.existsSync(path.join(rootDir, relClean, 'index.html'))) {
          target = path.join(rootDir, relClean, 'index.html');
        }

        // Dynamic fallback for newly created products in admin that don't have static HTML files
        if ((!fs.existsSync(target) || !fs.statSync(target).isFile()) && prodMatch) {
          const prod = db.sqlite.prepare(`SELECT * FROM products WHERE tenant_id = ? AND handle = ? AND active = 1`).get(tenant.id, prodMatch[1]);
          if (prod) {
            const variants = db.sqlite.prepare(`SELECT * FROM variants WHERE tenant_id = ? AND product_id = ? AND active = 1`).all(tenant.id, prod.id);
            const warehouses = rankWarehouses(db, tenant.id);
            const stockMap = getStockMap(db, tenant.id, variants.map(v => v.id));
            return sendHtml(res, 200, renderDynamicProductPage(tenant, prod, variants, warehouses, stockMap), storeCookieHeader);
          }
        }

        if (fs.existsSync(target) && fs.statSync(target).isFile()) {
          const ext = path.extname(target).toLowerCase();
          if (ext === '.html' && path.basename(target) !== 'preview.html') {
            const rawHtml = fs.readFileSync(target, 'utf8');
            const warehouses = rankWarehouses(db, tenant.id);
            const bridged = injectStorefrontBridge(rawHtml, tenant, warehouses);
            return sendHtml(res, 200, bridged, storeCookieHeader);
          }
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
          if (method === 'HEAD') return res.end();
          return fs.createReadStream(target).pipe(res);
        }
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[multitheme error]', err);
      return sendJson(res, err.status || 500, { error: err.message || 'Internal server error' });
    }
  };
}
