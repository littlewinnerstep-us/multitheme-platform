import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, randomId } from './crypto.mjs';

/** Seed default platform admin, multi-tenant stores, warehouses, products, stock, zones, and coupons. */
export function seedDatabase(db, rootDir) {
  const existing = db.sqlite.prepare(`SELECT COUNT(*) AS cnt FROM tenants`).get();
  if (existing && existing.cnt > 0) return;

  const catalogPath = path.join(rootDir, 'data', 'seed-catalog.json');
  const catalog = fs.existsSync(catalogPath)
    ? JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
    : [];

  const now = new Date().toISOString();

  db.transaction(() => {
    // Platform Super Admin
    db.sqlite
      .prepare(`INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at) VALUES (?, NULL, ?, ?, 'super', ?, ?)`)
      .run(randomId('usr'), 'admin@platform.test', 'Platform Super Admin', hashPassword('demo-admin-pass'), now);

    // -------------------------------------------------------------------------
    // Tenant 1: Hyper Trove Market (Default Storefront)
    // -------------------------------------------------------------------------
    const t1Id = 'ten_trove_market';
    db.sqlite
      .prepare(`INSERT INTO tenants (id, slug, name, status, currency, locale, theme_config, settings, created_at) VALUES (?, ?, ?, 'active', 'USD', 'en-US', ?, ?, ?)`)
      .run(
        t1Id,
        'trove-market',
        'Trove Market',
        JSON.stringify({
          primary: '#cb321e',
          accent: '#fec61f',
          background: '#f5f5f5',
          surface: '#ffffff',
          announcement: 'Free Express Shipping on orders $120+ · Multi-Warehouse Same-Day Delivery',
          tagline: 'Fresh groceries, meat, bakery & beverages routed from your nearest hub.'
        }),
        JSON.stringify({
          routing_strategy: 'nearest_single',
          free_shipping_cents: 12000,
          pay_minutes: 60,
          pickup_enabled: true,
          payment_methods: ['card_sim', 'bank_transfer', 'cod']
        }),
        now
      );

    db.sqlite
      .prepare(`INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)`)
      .run(randomId('usr'), t1Id, 'owner@trove-market.test', 'Trove Owner', hashPassword('demo-password-1'), now);

    const t1Warehouses = [
      { id: 'wh_trove_dt', code: 'NYC-DT', name: 'Downtown Manhattan Hub', address: '245 Mercer St', city: 'New York', postal_code: '10012', lat: 40.7282, lng: -73.9962, priority: 10 },
      { id: 'wh_trove_bk', code: 'NYC-BK', name: 'Brooklyn Cold Storage', address: '88 Wythe Ave', city: 'Brooklyn', postal_code: '11249', lat: 40.7216, lng: -73.9598, priority: 8 },
      { id: 'wh_trove_nj', code: 'NJ-WB', name: 'Westside Jersey Depot', address: '1200 Harbor Blvd', city: 'Weehawken', postal_code: '07086', lat: 40.7662, lng: -74.0176, priority: 5 }
    ];
    for (const w of t1Warehouses) {
      db.sqlite
        .prepare(`INSERT INTO warehouses (id, tenant_id, code, name, address, city, postal_code, lat, lng, priority, pickup_enabled, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`)
        .run(w.id, t1Id, w.code, w.name, w.address, w.city, w.postal_code, w.lat, w.lng, w.priority, now);
    }

    const insertProd = db.sqlite.prepare(`INSERT INTO products (id, tenant_id, handle, shopify_id, title, category, description, image, vendor, sort_order, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
    const insertVar = db.sqlite.prepare(`INSERT INTO variants (id, tenant_id, product_id, shopify_variant_id, sku, title, price_cents, compare_at_cents, weight_g, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
    const insertStock = db.sqlite.prepare(`INSERT INTO warehouse_stock (tenant_id, warehouse_id, variant_id, qty, reserved, reorder_point, updated_at) VALUES (?, ?, ?, ?, 0, 5, ?)`);

    catalog.forEach((p, idx) => {
      const pid = randomId('prd');
      insertProd.run(pid, t1Id, p.handle, p.shopify_id || null, p.title, p.category || 'Groceries', p.description || '', p.image || '', 'Trove Market', idx, now);
      const variants = p.variants?.length ? p.variants : [{ shopify_variant_id: null, title: 'Standard', price_cents: 999, compare_at_cents: null, weight_g: 450, sku: `TRV-${idx}` }];
      variants.forEach((v, vIdx) => {
        const vid = randomId('var');
        insertVar.run(vid, t1Id, pid, v.shopify_variant_id || null, v.sku || `TRV-${idx}-${vIdx}`, v.title || 'Standard', Number(v.price_cents || 999), v.compare_at_cents ?? null, Number(v.weight_g || 450), now);
        // Distribute stock realistically across the 3 warehouses (some items low/0 in Downtown so Brooklyn/Jersey routing triggers!)
        const qDt = idx % 7 === 0 ? 0 : idx % 5 === 0 ? 3 : 28;
        const qBk = idx % 6 === 0 ? 4 : 36;
        const qNj = 45;
        insertStock.run(t1Id, t1Warehouses[0].id, vid, qDt, now);
        insertStock.run(t1Id, t1Warehouses[1].id, vid, qBk, now);
        insertStock.run(t1Id, t1Warehouses[2].id, vid, qNj, now);
      });
    });

    db.sqlite.prepare(`INSERT INTO courier_zones (id, tenant_id, name, max_km, fee_cents, eta, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run(randomId('zon'), t1Id, 'Local Express (0–5 km)', 5, 499, '45–60 mins');
    db.sqlite.prepare(`INSERT INTO courier_zones (id, tenant_id, name, max_km, fee_cents, eta, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run(randomId('zon'), t1Id, 'Metro Same-Day (5–25 km)', 25, 899, 'Same day');
    db.sqlite.prepare(`INSERT INTO courier_zones (id, tenant_id, name, max_km, fee_cents, eta, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run(randomId('zon'), t1Id, 'Regional Next-Day (25–150 km)', 150, 1499, 'Next day');

    db.sqlite.prepare(`INSERT INTO coupons (id, tenant_id, code, type, value, min_purchase_cents, max_uses, used_count, active) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)`).run(randomId('cpn'), t1Id, 'WELCOME10', 'pct', 10, 2000, 500);
    db.sqlite.prepare(`INSERT INTO coupons (id, tenant_id, code, type, value, min_purchase_cents, max_uses, used_count, active) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)`).run(randomId('cpn'), t1Id, 'SAVE5', 'amt', 500, 3000, 200);

    // -------------------------------------------------------------------------
    // Tenant 2: Fresh Harvest Organic
    // -------------------------------------------------------------------------
    const t2Id = 'ten_fresh_harvest';
    db.sqlite
      .prepare(`INSERT INTO tenants (id, slug, name, status, currency, locale, theme_config, settings, created_at) VALUES (?, ?, ?, 'active', 'USD', 'en-US', ?, ?, ?)`)
      .run(
        t2Id,
        'fresh-harvest',
        'Fresh Harvest Organic',
        JSON.stringify({
          primary: '#146c43',
          accent: '#f59e0b',
          background: '#f3f7f4',
          surface: '#ffffff',
          announcement: 'Farm-to-door organic harvest · 15% off with code FRESH15',
          tagline: 'Certified organic produce, artisan breads & farmstead dairy.'
        }),
        JSON.stringify({
          routing_strategy: 'nearest_single',
          free_shipping_cents: 8000,
          pay_minutes: 60,
          pickup_enabled: true,
          payment_methods: ['card_sim', 'bank_transfer']
        }),
        now
      );

    db.sqlite
      .prepare(`INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)`)
      .run(randomId('usr'), t2Id, 'owner@fresh-harvest.test', 'Fresh Harvest Owner', hashPassword('demo-password-1'), now);

    const t2Wh = [
      { id: 'wh_fh_north', code: 'FH-NTH', name: 'North Farm Depot', address: '420 Orchard Lane', city: 'Hudson', postal_code: '12534', lat: 42.2529, lng: -73.791, priority: 10 },
      { id: 'wh_fh_city', code: 'FH-CTY', name: 'Central Market Hub', address: '15 Union Square', city: 'New York', postal_code: '10003', lat: 40.7359, lng: -73.9911, priority: 8 }
    ];
    for (const w of t2Wh) {
      db.sqlite
        .prepare(`INSERT INTO warehouses (id, tenant_id, code, name, address, city, postal_code, lat, lng, priority, pickup_enabled, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`)
        .run(w.id, t2Id, w.code, w.name, w.address, w.city, w.postal_code, w.lat, w.lng, w.priority, now);
    }

    const organicSubset = catalog.filter(p => ['Vegetables & Fruits', 'Bread & Cake', 'Dairy & Egg', 'On Sale'].includes(p.category)).slice(0, 24);
    organicSubset.forEach((p, idx) => {
      const pid = randomId('prd');
      insertProd.run(pid, t2Id, p.handle, p.shopify_id || null, `Organic ${p.title}`, p.category, p.description, p.image, 'Fresh Harvest Farms', idx, now);
      const v0 = p.variants?.[0] || { shopify_variant_id: null, title: 'Standard', price_cents: 899, weight_g: 450, sku: `FH-${idx}` };
      const vid = randomId('var');
      insertVar.run(vid, t2Id, pid, v0.shopify_variant_id || null, `FH-${idx}`, v0.title || 'Standard', Math.round((v0.price_cents || 899) * 1.1), null, v0.weight_g || 450, now);
      insertStock.run(t2Id, t2Wh[0].id, vid, 25, now);
      insertStock.run(t2Id, t2Wh[1].id, vid, idx % 4 === 0 ? 2 : 18, now);
    });

    db.sqlite.prepare(`INSERT INTO courier_zones (id, tenant_id, name, max_km, fee_cents, eta, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run(randomId('zon'), t2Id, 'Local Green Bike (0–10 km)', 10, 399, '60 mins');
    db.sqlite.prepare(`INSERT INTO courier_zones (id, tenant_id, name, max_km, fee_cents, eta, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run(randomId('zon'), t2Id, 'Chilled Van (10–60 km)', 60, 999, 'Same day');
    db.sqlite.prepare(`INSERT INTO coupons (id, tenant_id, code, type, value, min_purchase_cents, max_uses, used_count, active) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)`).run(randomId('cpn'), t2Id, 'FRESH15', 'pct', 15, 1500, 300);

    // -------------------------------------------------------------------------
    // Tenant 3: Urban Pantry Express
    // -------------------------------------------------------------------------
    const t3Id = 'ten_urban_pantry';
    db.sqlite
      .prepare(`INSERT INTO tenants (id, slug, name, status, currency, locale, theme_config, settings, created_at) VALUES (?, ?, ?, 'active', 'USD', 'en-US', ?, ?, ?)`)
      .run(
        t3Id,
        'urban-pantry',
        'Urban Pantry Express',
        JSON.stringify({
          primary: '#1e293b',
          accent: '#3b82f6',
          background: '#f1f5f9',
          surface: '#ffffff',
          announcement: '30-minute dark-store dispatch across Midtown & Harbor hubs',
          tagline: 'Curated beverages, gourmet proteins & pantry essentials.'
        }),
        JSON.stringify({
          routing_strategy: 'split_nearest',
          free_shipping_cents: 6000,
          pay_minutes: 45,
          pickup_enabled: true,
          payment_methods: ['card_sim', 'cod']
        }),
        now
      );

    db.sqlite
      .prepare(`INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)`)
      .run(randomId('usr'), t3Id, 'owner@urban-pantry.test', 'Urban Pantry Owner', hashPassword('demo-password-1'), now);

    const t3Wh = [
      { id: 'wh_up_mid', code: 'UP-MID', name: 'Midtown Dark Store', address: '501 Lexington Ave', city: 'New York', postal_code: '10017', lat: 40.7549, lng: -73.9742, priority: 10 },
      { id: 'wh_up_hrb', code: 'UP-HRB', name: 'Harbor Fulfillment Center', address: '77 Hudson St', city: 'Jersey City', postal_code: '07302', lat: 40.7155, lng: -74.0345, priority: 7 }
    ];
    for (const w of t3Wh) {
      db.sqlite
        .prepare(`INSERT INTO warehouses (id, tenant_id, code, name, address, city, postal_code, lat, lng, priority, pickup_enabled, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`)
        .run(w.id, t3Id, w.code, w.name, w.address, w.city, w.postal_code, w.lat, w.lng, w.priority, now);
    }

    const urbanSubset = catalog.filter(p => ['Beverages', 'Meat & Seafood', 'Groceries'].includes(p.category)).slice(0, 20);
    urbanSubset.forEach((p, idx) => {
      const pid = randomId('prd');
      insertProd.run(pid, t3Id, p.handle, p.shopify_id || null, p.title, p.category, p.description, p.image, 'Urban Pantry', idx, now);
      const v0 = p.variants?.[0] || { shopify_variant_id: null, title: 'Standard', price_cents: 1199, weight_g: 500, sku: `UP-${idx}` };
      const vid = randomId('var');
      insertVar.run(vid, t3Id, pid, v0.shopify_variant_id || null, `UP-${idx}`, v0.title || 'Standard', v0.price_cents || 1199, null, v0.weight_g || 500, now);
      insertStock.run(t3Id, t3Wh[0].id, vid, idx % 3 === 0 ? 0 : 15, now);
      insertStock.run(t3Id, t3Wh[1].id, vid, 22, now);
    });

    db.sqlite.prepare(`INSERT INTO courier_zones (id, tenant_id, name, max_km, fee_cents, eta, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run(randomId('zon'), t3Id, 'Dark-Store 30m Rider (0–6 km)', 6, 299, '30 mins');
    db.sqlite.prepare(`INSERT INTO courier_zones (id, tenant_id, name, max_km, fee_cents, eta, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).run(randomId('zon'), t3Id, 'Metro Courier (6–30 km)', 30, 799, '2 hours');
    db.sqlite.prepare(`INSERT INTO coupons (id, tenant_id, code, type, value, min_purchase_cents, max_uses, used_count, active) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)`).run(randomId('cpn'), t3Id, 'URBAN10', 'pct', 10, 1000, 300);
  });
}
