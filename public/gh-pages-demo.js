/* In-browser Multi-Tenant & Multi-Warehouse Demo Backend for GitHub Pages */
(() => {
  const BASE = (window.__MT_BASE__ || '').replace(/\/$/, '');
  const STORE_KEY = 'mt_gh_demo_state_v1';
  const origFetch = window.fetch.bind(window);

  const money = (cents, cur = 'USD') => {
    const v = Number(cents || 0) / 100;
    return cur === 'IDR' ? 'Rp ' + Math.round(v * 100).toLocaleString('id-ID') : '$' + v.toFixed(2);
  };
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const distKm = (a, b, c, d) => {
    if ([a, b, c, d].some(v => v == null || Number.isNaN(Number(v)))) return null;
    const rad = x => (Number(x) * Math.PI) / 180;
    const R = 6371, dLat = rad(c - a), dLng = rad(d - b);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 100) / 100;
  };

  let statePromise = null;

  async function loadState() {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) {
      try { return JSON.parse(saved); } catch {}
    }
    const res = await origFetch(`${BASE}/data/seed-catalog.json`);
    const catalog = res.ok ? await res.json() : [];

    const s = {
      session: null,
      cart: { note: '', discount_code: '', items: [] },
      tenants: [
        {
          id: 'ten_trove_market', slug: 'trove-market', name: 'Trove Market', status: 'active', currency: 'USD',
          theme_config: { primary: '#cb321e', accent: '#fec61f', announcement: 'Free Express Shipping on orders $120+ · Multi-Warehouse Same-Day Delivery' },
          settings: { routing_strategy: 'nearest_single', free_shipping_cents: 12000, pay_minutes: 60 }
        },
        {
          id: 'ten_fresh_harvest', slug: 'fresh-harvest', name: 'Fresh Harvest Organic', status: 'active', currency: 'USD',
          theme_config: { primary: '#146c43', accent: '#f59e0b', announcement: 'Farm-to-door organic harvest · 15% off with code FRESH15' },
          settings: { routing_strategy: 'nearest_single', free_shipping_cents: 8000, pay_minutes: 60 }
        },
        {
          id: 'ten_urban_pantry', slug: 'urban-pantry', name: 'Urban Pantry Express', status: 'active', currency: 'USD',
          theme_config: { primary: '#1e293b', accent: '#3b82f6', announcement: '30-minute dark-store dispatch across Midtown & Harbor hubs' },
          settings: { routing_strategy: 'split_nearest', free_shipping_cents: 6000, pay_minutes: 45 }
        }
      ],
      warehouses: [
        { id: 'wh_trove_dt', tenant_id: 'ten_trove_market', code: 'NYC-DT', name: 'Downtown Manhattan Hub', address: '245 Mercer St', city: 'New York', postal_code: '10012', lat: 40.7282, lng: -73.9962, priority: 10, pickup_enabled: true, active: true },
        { id: 'wh_trove_bk', tenant_id: 'ten_trove_market', code: 'NYC-BK', name: 'Brooklyn Cold Storage', address: '88 Wythe Ave', city: 'Brooklyn', postal_code: '11249', lat: 40.7216, lng: -73.9598, priority: 8, pickup_enabled: true, active: true },
        { id: 'wh_trove_nj', tenant_id: 'ten_trove_market', code: 'NJ-WB', name: 'Westside Jersey Depot', address: '1200 Harbor Blvd', city: 'Weehawken', postal_code: '07086', lat: 40.7662, lng: -74.0176, priority: 5, pickup_enabled: true, active: true },
        { id: 'wh_fh_north', tenant_id: 'ten_fresh_harvest', code: 'FH-NTH', name: 'North Farm Depot', address: '420 Orchard Lane', city: 'Hudson', postal_code: '12534', lat: 42.2529, lng: -73.791, priority: 10, pickup_enabled: true, active: true },
        { id: 'wh_fh_city', tenant_id: 'ten_fresh_harvest', code: 'FH-CTY', name: 'Central Market Hub', address: '15 Union Square', city: 'New York', postal_code: '10003', lat: 40.7359, lng: -73.9911, priority: 8, pickup_enabled: true, active: true },
        { id: 'wh_up_mid', tenant_id: 'ten_urban_pantry', code: 'UP-MID', name: 'Midtown Dark Store', address: '501 Lexington Ave', city: 'New York', postal_code: '10017', lat: 40.7549, lng: -73.9742, priority: 10, pickup_enabled: true, active: true },
        { id: 'wh_up_hrb', tenant_id: 'ten_urban_pantry', code: 'UP-HRB', name: 'Harbor Fulfillment Center', address: '77 Hudson St', city: 'Jersey City', postal_code: '07302', lat: 40.7155, lng: -74.0345, priority: 7, pickup_enabled: true, active: true }
      ],
      products: [],
      variants: [],
      stock: [],
      movements: [],
      zones: [
        { id: 'z1', tenant_id: 'ten_trove_market', name: 'Local Express (0-5 km)', max_km: 5, fee_cents: 499, eta: '45-60 mins', active: 1 },
        { id: 'z2', tenant_id: 'ten_trove_market', name: 'Metro Same-Day (5-25 km)', max_km: 25, fee_cents: 899, eta: 'Same day', active: 1 },
        { id: 'z3', tenant_id: 'ten_trove_market', name: 'Regional Next-Day (25-150 km)', max_km: 150, fee_cents: 1499, eta: 'Next day', active: 1 },
        { id: 'z4', tenant_id: 'ten_fresh_harvest', name: 'Local Green Bike (0-10 km)', max_km: 10, fee_cents: 399, eta: '60 mins', active: 1 },
        { id: 'z5', tenant_id: 'ten_urban_pantry', name: 'Dark-Store 30m Rider (0-6 km)', max_km: 6, fee_cents: 299, eta: '30 mins', active: 1 }
      ],
      coupons: [
        { id: 'c1', tenant_id: 'ten_trove_market', code: 'WELCOME10', type: 'pct', value: 10, min_purchase_cents: 2000, used_count: 0, active: 1 },
        { id: 'c2', tenant_id: 'ten_trove_market', code: 'SAVE5', type: 'amt', value: 500, min_purchase_cents: 3000, used_count: 0, active: 1 },
        { id: 'c3', tenant_id: 'ten_fresh_harvest', code: 'FRESH15', type: 'pct', value: 15, min_purchase_cents: 1500, used_count: 0, active: 1 },
        { id: 'c4', tenant_id: 'ten_urban_pantry', code: 'URBAN10', type: 'pct', value: 10, min_purchase_cents: 1000, used_count: 0, active: 1 }
      ],
      orders: []
    };

    const addCatalog = (tenantId, list, whIds) => {
      list.forEach((p, idx) => {
        const pid = `${tenantId}_p_${idx}`;
        s.products.push({
          id: pid, tenant_id: tenantId, handle: p.handle, title: tenantId === 'ten_fresh_harvest' ? `Organic ${p.title}` : p.title,
          category: p.category || 'Groceries', description: p.description || '', image: p.image ? `${BASE}${p.image}` : `${BASE}/cdn/shop/files/trove-logo.jpg`, active: 1
        });
        const vs = p.variants?.length ? p.variants : [{ shopify_variant_id: null, title: 'Standard', price_cents: 999 }];
        vs.forEach((v, vi) => {
          const vid = `${tenantId}_v_${idx}_${vi}`;
          s.variants.push({
            id: vid, tenant_id: tenantId, product_id: pid,
            shopify_variant_id: v.shopify_variant_id || `${idx}${vi}`,
            sku: v.sku || `SKU-${idx}-${vi}`, title: v.title || 'Standard', price_cents: Number(v.price_cents || 999), active: 1
          });
          whIds.forEach((wid, wi) => {
            const qty = wi === 0 && idx % 5 === 0 ? 3 : 25 + wi * 10;
            s.stock.push({ tenant_id: tenantId, warehouse_id: wid, variant_id: vid, qty, reserved: 0, reorder_point: 5 });
          });
        });
      });
    };

    addCatalog('ten_trove_market', catalog, ['wh_trove_dt', 'wh_trove_bk', 'wh_trove_nj']);
    addCatalog('ten_fresh_harvest', catalog.filter(p => ['Vegetables & Fruits', 'Bread & Cake', 'Dairy & Egg', 'On Sale'].includes(p.category)).slice(0, 24), ['wh_fh_north', 'wh_fh_city']);
    addCatalog('ten_urban_pantry', catalog.filter(p => ['Beverages', 'Meat & Seafood', 'Groceries'].includes(p.category)).slice(0, 20), ['wh_up_mid', 'wh_up_hrb']);

    localStorage.setItem(STORE_KEY, JSON.stringify(s));
    return s;
  }

  function getState() {
    if (!statePromise) statePromise = loadState();
    return statePromise;
  }
  function saveState(s) {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  }

  function activeTenantSlug(headers) {
    const h = headers?.['X-Tenant'] || headers?.['x-tenant'];
    if (h) return String(h).toLowerCase();
    const q = new URLSearchParams(location.search).get('store');
    if (q) { sessionStorage.setItem('mt_store', q); return q.toLowerCase(); }
    return sessionStorage.getItem('mt_store') || 'trove-market';
  }

  function jsonRes(status, data) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  }
  function htmlRes(status, html) {
    return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  function buildProducts(s, tenantId, q = '') {
    const whs = s.warehouses.filter(w => w.tenant_id === tenantId && w.active);
    let prods = s.products.filter(p => p.tenant_id === tenantId && p.active);
    if (q) {
      const ql = q.toLowerCase();
      prods = prods.filter(p => p.title.toLowerCase().includes(ql) || p.category.toLowerCase().includes(ql));
    }
    return prods.map(p => {
      const vs = s.variants.filter(v => v.tenant_id === tenantId && v.product_id === p.id).map(v => {
        const ws = whs.map(w => {
          const st = s.stock.find(x => x.warehouse_id === w.id && x.variant_id === v.id);
          const avail = st ? Math.max(0, st.qty - st.reserved) : 0;
          return { warehouse_id: w.id, warehouse_code: w.code, warehouse_name: w.name, qty: st?.qty ?? 0, reserved: st?.reserved ?? 0, available: avail };
        });
        return { ...v, total_available: ws.reduce((a, b) => a + b.available, 0), warehouse_stock: ws };
      });
      return { ...p, min_price_cents: vs[0]?.price_cents || 0, total_available: vs.reduce((a, b) => a + b.total_available, 0), variants: vs };
    });
  }

  function computeQuote(s, tenant, body) {
    const items = (body.items || []).map(it => {
      const v = s.variants.find(x => x.tenant_id === tenant.id && (x.id === it.variant_id || x.shopify_variant_id === String(it.variant_id || it.id)));
      const p = v ? s.products.find(x => x.id === v.product_id) : null;
      return v ? { variant_id: v.id, product_id: v.product_id, title: p?.title || 'Item', variant_title: v.title, sku: v.sku, qty: Number(it.qty || it.quantity || 1), unit_price_cents: v.price_cents, line_total_cents: v.price_cents * Number(it.qty || it.quantity || 1) } : null;
    }).filter(Boolean);
    if (!items.length) return { ok: false, error: 'Cart is empty' };

    const whs = s.warehouses
      .filter(w => w.tenant_id === tenant.id && w.active)
      .map(w => ({ ...w, distance_km: distKm(body.lat, body.lng, w.lat, w.lng) }))
      .sort((a, b) => (a.distance_km != null && b.distance_km != null ? a.distance_km - b.distance_km : b.priority - a.priority));

    const avail = (wid, vid) => {
      const st = s.stock.find(x => x.warehouse_id === wid && x.variant_id === vid);
      return st ? Math.max(0, st.qty - st.reserved) : 0;
    };

    const ordered = body.warehouse_id ? [...whs.filter(w => w.id === body.warehouse_id), ...whs.filter(w => w.id !== body.warehouse_id)] : whs;
    let chosen = ordered.find(w => items.every(it => avail(w.id, it.variant_id) >= it.qty));
    let allocations = chosen ? items.map(it => ({ warehouse_id: chosen.id, warehouse_name: chosen.name, variant_id: it.variant_id, qty: it.qty })) : null;
    let split = false;

    if (!allocations && tenant.settings?.routing_strategy === 'split_nearest') {
      allocations = [];
      for (const it of items) {
        let rem = it.qty;
        for (const w of ordered) {
          const h = avail(w.id, it.variant_id);
          if (h > 0) {
            const take = Math.min(h, rem);
            allocations.push({ warehouse_id: w.id, warehouse_name: w.name, variant_id: it.variant_id, qty: take });
            rem -= take;
            if (rem === 0) break;
          }
        }
        if (rem > 0) return { ok: false, error: 'Out of stock across warehouses' };
      }
      chosen = ordered[0];
      split = new Set(allocations.map(a => a.warehouse_id)).size > 1;
    }
    if (!allocations) return { ok: false, error: 'Insufficient stock in warehouses' };

    const subtotal = items.reduce((a, b) => a + b.line_total_cents, 0);
    let discount = 0, couponCode = null;
    if (body.coupon_code) {
      const code = String(body.coupon_code).trim().toUpperCase();
      const cpn = s.coupons.find(c => c.tenant_id === tenant.id && c.code === code && c.active);
      if (!cpn) return { ok: false, error: `Invalid coupon ${code}` };
      discount = cpn.type === 'pct' ? Math.round((subtotal * cpn.value) / 100) : Math.min(subtotal, cpn.value);
      couponCode = cpn.code;
    }

    const zones = s.zones.filter(z => z.tenant_id === tenant.id).sort((a, b) => a.max_km - b.max_km);
    let shipping = 0, zoneName = 'Store Pickup (Free)', eta = 'Ready in 1 hour';
    if (body.fulfillment_type !== 'pickup') {
      const freeTh = Number(tenant.settings?.free_shipping_cents || 0);
      if (freeTh > 0 && subtotal - discount >= freeTh) {
        shipping = 0; zoneName = 'Free Express Shipping'; eta = 'Same day';
      } else if (zones.length) {
        const z = chosen.distance_km != null ? zones.find(x => chosen.distance_km <= x.max_km) || zones[zones.length - 1] : zones[0];
        shipping = z.fee_cents; zoneName = z.name; eta = z.eta;
      }
    }

    return {
      ok: true, items, fulfillment_type: body.fulfillment_type || 'delivery', warehouse: chosen, split_shipment: split,
      allocations, distance_km: chosen.distance_km, zone_name: zoneName, eta,
      subtotal_cents: subtotal, discount_cents: discount, coupon_code: couponCode, shipping_cents: shipping,
      total_cents: Math.max(0, subtotal - discount + shipping), currency: tenant.currency
    };
  }

  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const u = new URL(rawUrl, location.origin);
    let p = u.pathname;
    if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length) || '/';

    const isHandled =
      p.startsWith('/api/') || p.startsWith('/cart') || p.startsWith('/search/suggest') ||
      (p.startsWith('/products/') && (u.searchParams.has('section_id') || p.endsWith('.js'))) ||
      (p.startsWith('/variants/') && u.searchParams.get('section_id') === 'pickup-availability');

    if (!isHandled) return origFetch(input, init);

    const s = await getState();
    const method = (init.method || 'GET').toUpperCase();
    let body = {};
    if (init.body) {
      if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch {} }
      else if (init.body instanceof FormData) { init.body.forEach((v, k) => { body[k] = v; }); }
    }
    const slug = activeTenantSlug(init.headers);
    const tenant = s.tenants.find(t => t.slug === slug) || s.tenants[0];

    if (p === '/api/health') return jsonRes(200, { ok: true, mode: 'github-pages-demo' });
    if (p === '/api/tenants') return jsonRes(200, { tenants: s.tenants.filter(t => t.status === 'active') });
    if (p === '/api/tenants/signup' && method === 'POST') {
      const tSlug = String(body.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
      const id = 'ten_' + Date.now();
      s.tenants.push({ id, slug: tSlug, name: body.name, status: 'pending', currency: 'USD', theme_config: { primary: '#0f766e', accent: '#f59e0b' }, settings: { routing_strategy: 'nearest_single', free_shipping_cents: 10000 } });
      s.warehouses.push({ id: 'wh_' + Date.now(), tenant_id: id, code: 'MAIN', name: body.warehouse_name || 'Main Warehouse', address: '100 Main St', city: body.city || 'New York', postal_code: '10001', lat: 40.73, lng: -73.99, priority: 10, pickup_enabled: true, active: true });
      saveState(s);
      return jsonRes(201, { ok: true, tenant: { id, slug: tSlug, name: body.name, status: 'pending' }, message: 'Store created in pending status (demo mode). Log in as Platform Super-Admin to approve!' });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      const t = body.store ? s.tenants.find(x => x.slug === body.store) : null;
      s.session = { id: 'u1', tenant_id: t ? t.id : null, email: body.email, name: body.store ? `${body.store} Owner` : 'Platform Super Admin', role: body.store ? 'owner' : 'super' };
      saveState(s);
      return jsonRes(200, { ok: true, token: 'demo-token', user: s.session });
    }
    if (p === '/api/auth/logout' && method === 'POST') { s.session = null; saveState(s); return jsonRes(200, { ok: true }); }
    if (p === '/api/auth/me') return s.session ? jsonRes(200, { user: s.session, tenant: s.session.tenant_id ? s.tenants.find(x => x.id === s.session.tenant_id) : null }) : jsonRes(401, { error: 'Not authenticated' });

    if (p === '/api/super/tenants') return jsonRes(200, { tenants: s.tenants.map(t => ({ ...t, stats: { warehouses: s.warehouses.filter(w => w.tenant_id === t.id).length, products: s.products.filter(x => x.tenant_id === t.id).length, orders: s.orders.filter(o => o.tenant_id === t.id).length } })) });
    const supMatch = p.match(/^\/api\/super\/tenants\/([^/]+)\/status$/);
    if (supMatch && method === 'POST') { const t = s.tenants.find(x => x.id === supMatch[1]); if (t) t.status = body.status; saveState(s); return jsonRes(200, { ok: true }); }

    if (p === '/api/store' || p === '/api/admin/store') {
      if (method === 'PUT') {
        tenant.name = body.name || tenant.name;
        tenant.theme_config = { ...tenant.theme_config, ...(body.theme_config || {}) };
        tenant.settings = { ...tenant.settings, ...(body.settings || {}) };
        saveState(s);
      }
      return jsonRes(200, { tenant, warehouses: s.warehouses.filter(w => w.tenant_id === tenant.id && w.active), zones: s.zones.filter(z => z.tenant_id === tenant.id) });
    }
    if (p === '/api/warehouses' || p === '/api/admin/warehouses') {
      if (method === 'POST') {
        const w = { id: 'wh_' + Date.now(), tenant_id: tenant.id, code: String(body.code || 'WH').toUpperCase(), name: body.name, address: body.address || '', city: body.city || '', postal_code: '', lat: Number(body.lat || 40.73), lng: Number(body.lng || -73.99), priority: Number(body.priority || 5), pickup_enabled: true, active: true };
        s.warehouses.push(w); saveState(s);
        return jsonRes(201, { ok: true, warehouse: w });
      }
      return jsonRes(200, { warehouses: s.warehouses.filter(w => w.tenant_id === tenant.id) });
    }
    if (p === '/api/admin/warehouses/transfer' && method === 'POST') {
      const src = s.stock.find(x => x.tenant_id === tenant.id && x.warehouse_id === body.from_warehouse_id && x.variant_id === body.variant_id);
      const q = Number(body.qty || 0);
      if (!src || src.qty - src.reserved < q) return jsonRes(409, { error: 'Insufficient available stock to transfer' });
      src.qty -= q;
      let dst = s.stock.find(x => x.tenant_id === tenant.id && x.warehouse_id === body.to_warehouse_id && x.variant_id === body.variant_id);
      if (!dst) { dst = { tenant_id: tenant.id, warehouse_id: body.to_warehouse_id, variant_id: body.variant_id, qty: 0, reserved: 0, reorder_point: 5 }; s.stock.push(dst); }
      dst.qty += q;
      s.movements.unshift({ created_at: new Date().toISOString(), tenant_id: tenant.id, type: 'transfer', warehouse_code: body.from_warehouse_id, product_title: body.variant_id, delta_qty: q, note: body.note || 'Transfer' });
      saveState(s);
      return jsonRes(200, { ok: true, transferred: q, from: body.from_warehouse_id, to: body.to_warehouse_id });
    }
    if (p === '/api/products' || p === '/api/admin/products') {
      if (method === 'POST') {
        const pid = 'prd_' + Date.now(), vid = 'var_' + Date.now(), handle = String(body.title || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        s.products.unshift({ id: pid, tenant_id: tenant.id, handle, title: body.title, category: body.category || 'Groceries', description: '', image: `${BASE}/cdn/shop/files/trove-logo.jpg`, active: 1 });
        s.variants.push({ id: vid, tenant_id: tenant.id, product_id: pid, shopify_variant_id: String(Date.now()), sku: 'NEW-1', title: 'Standard', price_cents: Number(body.price_cents || 999), active: 1 });
        s.warehouses.filter(w => w.tenant_id === tenant.id).forEach(w => s.stock.push({ tenant_id: tenant.id, warehouse_id: w.id, variant_id: vid, qty: Number(body.initial_qty || 10), reserved: 0, reorder_point: 5 }));
        saveState(s);
        return jsonRes(201, { ok: true, product_id: pid });
      }
      return jsonRes(200, { tenant_slug: tenant.slug, products: buildProducts(s, tenant.id, u.searchParams.get('q') || '') });
    }
    if (p === '/api/admin/stock') {
      if (method === 'PUT') {
        let st = s.stock.find(x => x.warehouse_id === body.warehouse_id && x.variant_id === body.variant_id);
        if (!st) { st = { tenant_id: tenant.id, warehouse_id: body.warehouse_id, variant_id: body.variant_id, qty: 0, reserved: 0, reorder_point: 5 }; s.stock.push(st); }
        st.qty = Number(body.qty || 0);
        saveState(s);
        return jsonRes(200, { ok: true });
      }
      const rows = s.stock.filter(x => x.tenant_id === tenant.id).map(x => {
        const w = s.warehouses.find(a => a.id === x.warehouse_id);
        const v = s.variants.find(a => a.id === x.variant_id);
        const pr = v ? s.products.find(a => a.id === v.product_id) : null;
        return { ...x, warehouse_name: w?.name || '', warehouse_code: w?.code || '', variant_title: v?.title || '', product_title: pr?.title || '' };
      });
      return jsonRes(200, { stock: rows });
    }
    if (p === '/api/admin/movements') return jsonRes(200, { movements: s.movements.filter(m => m.tenant_id === tenant.id) });
    if (p === '/api/admin/zones') {
      if (method === 'POST') { s.zones.push({ id: 'z_' + Date.now(), tenant_id: tenant.id, name: body.name, max_km: Number(body.max_km || 15), fee_cents: Number(body.fee_cents || 0), eta: 'Same day' }); saveState(s); }
      return jsonRes(200, { zones: s.zones.filter(z => z.tenant_id === tenant.id) });
    }
    if (p === '/api/admin/coupons') {
      if (method === 'POST') { s.coupons.push({ id: 'c_' + Date.now(), tenant_id: tenant.id, code: String(body.code).toUpperCase(), type: body.type, value: Number(body.value), min_purchase_cents: 0, used_count: 0, active: 1 }); saveState(s); }
      return jsonRes(200, { coupons: s.coupons.filter(c => c.tenant_id === tenant.id) });
    }
    if (p === '/api/admin/orders') return jsonRes(200, { orders: s.orders.filter(o => o.tenant_id === tenant.id) });
    if (p === '/api/quote' && method === 'POST') {
      const q = computeQuote(s, tenant, body);
      return q.ok ? jsonRes(200, q) : jsonRes(409, { error: q.error });
    }
    if (p === '/api/checkout' && method === 'POST') {
      const q = computeQuote(s, tenant, body);
      if (!q.ok) return jsonRes(409, { error: q.error });
      q.allocations.forEach(a => { const st = s.stock.find(x => x.warehouse_id === a.warehouse_id && x.variant_id === a.variant_id); if (st) st.reserved += a.qty; });
      const ord = {
        id: 'ord_' + Date.now(), tenant_id: tenant.id, order_no: `${tenant.slug.slice(0, 4).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        status: 'pending', payment_status: 'unpaid', fulfillment_type: q.fulfillment_type, warehouse_id: q.warehouse.id,
        warehouse_name: q.warehouse.name, warehouse_code: q.warehouse.code, distance_km: q.distance_km,
        allocations: q.allocations, items: q.items, customer_name: body.customer_name, customer_phone: body.customer_phone || '',
        subtotal_cents: q.subtotal_cents, discount_cents: q.discount_cents, shipping_cents: q.shipping_cents, total_cents: q.total_cents,
        created_at: new Date().toISOString()
      };
      s.orders.unshift(ord);
      if (body.clear_cart) s.cart.items = [];
      saveState(s);
      return jsonRes(201, { ok: true, order: ord });
    }
    const payMatch = p.match(/^\/api\/orders\/([^/]+)\/pay$/);
    if (payMatch && method === 'POST') {
      const ord = s.orders.find(o => o.tenant_id === tenant.id && o.order_no === decodeURIComponent(payMatch[1]));
      if (!ord) return jsonRes(404, { error: 'Order not found' });
      if (ord.payment_status !== 'paid') {
        ord.allocations.forEach(a => { const st = s.stock.find(x => x.warehouse_id === a.warehouse_id && x.variant_id === a.variant_id); if (st) { st.qty = Math.max(0, st.qty - a.qty); st.reserved = Math.max(0, st.reserved - a.qty); } });
        ord.status = 'paid'; ord.payment_status = 'paid'; saveState(s);
      }
      return jsonRes(200, { ok: true, order: ord });
    }
    const ordMatch = p.match(/^\/api\/orders\/([^/]+)$/);
    if (ordMatch) {
      const ord = s.orders.find(o => o.tenant_id === tenant.id && o.order_no === decodeURIComponent(ordMatch[1]));
      return ord ? jsonRes(200, { order: ord }) : jsonRes(404, { error: 'Order not found' });
    }

    // Cart compatibility
    if (p === '/cart/add' || p === '/cart/add.js') {
      const reqs = Array.isArray(body.items) ? body.items : [{ id: body.id, quantity: body.quantity || 1 }];
      for (const r of reqs) {
        const v = s.variants.find(x => x.tenant_id === tenant.id && (x.id === r.id || x.shopify_variant_id === String(r.id)));
        if (!v) return jsonRes(404, { message: 'Variant not found' });
        const ex = s.cart.items.find(i => i.variant_id === v.id);
        if (ex) ex.qty += Number(r.quantity || 1);
        else s.cart.items.push({ variant_id: v.id, qty: Number(r.quantity || 1) });
      }
      saveState(s);
    }
    if (p === '/cart/change' || p === '/cart/change.js') {
      const line = Number(body.line), qty = Number(body.quantity ?? 0);
      if (line >= 1 && line <= s.cart.items.length) {
        if (qty <= 0) s.cart.items.splice(line - 1, 1);
        else s.cart.items[line - 1].qty = qty;
        saveState(s);
      }
    }
    if (p === '/cart/clear.js') { s.cart.items = []; saveState(s); }

    if (p.startsWith('/cart')) {
      const items = s.cart.items.map((ci, idx) => {
        const v = s.variants.find(x => x.id === ci.variant_id);
        const pr = v ? s.products.find(x => x.id === v.product_id) : null;
        return { id: v?.shopify_variant_id || ci.variant_id, variant_id: ci.variant_id, key: `${ci.variant_id}:${idx + 1}`, title: pr?.title || 'Item', product_title: pr?.title || 'Item', variant_title: v?.title || 'Standard', quantity: ci.qty, price: v?.price_cents || 0, line_price: (v?.price_cents || 0) * ci.qty, image: pr?.image || `${BASE}/cdn/shop/files/trove-logo.jpg`, url: `${BASE}/products/${pr?.handle || ''}` };
      });
      const total = items.reduce((a, b) => a + b.line_price, 0);
      const count = items.reduce((a, b) => a + b.quantity, 0);
      return jsonRes(200, { item_count: count, items_subtotal_price: total, total_price: total, items, currency: tenant.currency, sections: {} });
    }

    if (p === '/search/suggest') {
      const matches = buildProducts(s, tenant.id, u.searchParams.get('q') || '').slice(0, 8);
      return htmlRes(200, `<div id="PredictiveSearchResults-sections--19692152914149__header"><div data-total-results="${matches.length}" style="padding:12px">${matches.map(m => `<a href="${BASE}/products/${esc(m.handle)}" style="display:flex;gap:10px;padding:8px;text-decoration:none;color:inherit"><img src="${esc(m.image)}" style="width:44px;height:44px;object-fit:cover;border-radius:6px"><div><strong>${esc(m.title)}</strong><div>${esc(money(m.min_price_cents))}</div></div></a>`).join('') || 'No results'}</div></div>`);
    }

    return jsonRes(200, { ok: true });
  };
})();
