import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  custom_domain TEXT UNIQUE,
  currency TEXT NOT NULL DEFAULT 'USD',
  locale TEXT NOT NULL DEFAULT 'en-US',
  theme_config TEXT NOT NULL DEFAULT '{}',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'staff',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email ON users(COALESCE(tenant_id, ''), email);

CREATE TABLE IF NOT EXISTS tenant_secrets (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider)
);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL DEFAULT 0,
  lng REAL NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  pickup_enabled INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_warehouses_tenant ON warehouses(tenant_id);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  handle TEXT NOT NULL,
  shopify_id TEXT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Groceries',
  description TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, handle)
);
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);

CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shopify_variant_id TEXT,
  sku TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT 'Standard',
  price_cents INTEGER NOT NULL DEFAULT 0,
  compare_at_cents INTEGER,
  weight_g INTEGER NOT NULL DEFAULT 450,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_tenant_shopify ON variants(tenant_id, shopify_variant_id) WHERE shopify_variant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS warehouse_stock (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER NOT NULL DEFAULT 5,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (warehouse_id, variant_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_tenant_variant ON warehouse_stock(tenant_id, variant_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  order_no TEXT,
  type TEXT NOT NULL,
  delta_qty INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_tenant ON stock_movements(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS courier_zones (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  max_km REAL NOT NULL DEFAULT 10,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  eta TEXT NOT NULL DEFAULT 'Same day',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_zones_tenant ON courier_zones(tenant_id);

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'pct',
  value INTEGER NOT NULL DEFAULT 0,
  min_purchase_cents INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS carts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  discount_code TEXT NOT NULL DEFAULT '',
  preferred_warehouse_id TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, token)
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (cart_id, variant_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_method TEXT NOT NULL DEFAULT 'card_sim',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  fulfillment_type TEXT NOT NULL DEFAULT 'delivery',
  warehouse_id TEXT REFERENCES warehouses(id),
  allocations_json TEXT NOT NULL DEFAULT '[]',
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  shipping_address TEXT NOT NULL DEFAULT '',
  lat REAL,
  lng REAL,
  distance_km REAL,
  zone_name TEXT NOT NULL DEFAULT '',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  coupon_code TEXT,
  note TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, order_no)
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  title TEXT NOT NULL,
  variant_title TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`;

/** Open or initialize a SQLite database (file path or ':memory:'). */
export function openDatabase(dbPath = ':memory:') {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec(SCHEMA_SQL);

  let txDepth = 0;

  /** Execute fn inside an IMMEDIATE SQLite transaction (uses SAVEPOINT when nested). */
  function transaction(fn) {
    const isOuter = txDepth === 0;
    const sp = `sp_${txDepth}`;
    txDepth += 1;
    sqlite.exec(isOuter ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    try {
      const result = fn();
      sqlite.exec(isOuter ? 'COMMIT' : `RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      try {
        sqlite.exec(isOuter ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
      } catch {}
      throw err;
    } finally {
      txDepth -= 1;
    }
  }

  return {
    sqlite,
    transaction,
    close() { sqlite.close(); }
  };
}

export function parseJson(str, fallback = {}) {
  try { return str ? JSON.parse(str) : fallback; } catch { return fallback; }
}
