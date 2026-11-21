import { randomId } from './crypto.mjs';

/** Calculate great-circle distance in kilometers between two lat/lng points. */
export function distanceKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v == null || Number.isNaN(Number(v)))) return null;
  const toRad = d => (Number(d) * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

/**
 * List active warehouses for a tenant sorted by distance from (lat, lng) when provided,
 * otherwise by priority DESC then name ASC.
 */
export function rankWarehouses(db, tenantId, { lat = null, lng = null, pickupOnly = false } = {}) {
  const rows = db.sqlite
    .prepare(`SELECT * FROM warehouses WHERE tenant_id = ? AND active = 1 ${pickupOnly ? 'AND pickup_enabled = 1' : ''}`)
    .all(tenantId);

  return rows
    .map(w => ({
      ...w,
      pickup_enabled: Boolean(w.pickup_enabled),
      active: Boolean(w.active),
      distance_km: lat != null && lng != null ? distanceKm(lat, lng, w.lat, w.lng) : null
    }))
    .sort((a, b) => {
      if (a.distance_km != null && b.distance_km != null && a.distance_km !== b.distance_km) {
        return a.distance_km - b.distance_km;
      }
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.name.localeCompare(b.name);
    });
}

/** Return per-warehouse stock map for a list of variant IDs within a tenant. */
export function getStockMap(db, tenantId, variantIds) {
  if (!variantIds.length) return new Map();
  const placeholders = variantIds.map(() => '?').join(',');
  const rows = db.sqlite
    .prepare(`SELECT warehouse_id, variant_id, qty, reserved, reorder_point FROM warehouse_stock WHERE tenant_id = ? AND variant_id IN (${placeholders})`)
    .all(tenantId, ...variantIds);
  const map = new Map();
  for (const r of rows) {
    const avail = Math.max(0, Number(r.qty) - Number(r.reserved));
    map.set(`${r.warehouse_id}:${r.variant_id}`, { ...r, available: avail });
  }
  return map;
}

/**
 * Compute fulfillment routing plan for requested items [{ variant_id, qty }].
 * Strategies:
 *  - 'nearest_single': nearest warehouse (or preferredWarehouseId) that can fulfill ALL items
 *  - 'priority': highest-priority warehouse that can fulfill ALL items
 *  - 'split_nearest': tries single warehouse first; if none has all items, splits across nearest warehouses
 */
export function planFulfillment(db, tenantId, items, {
  lat = null,
  lng = null,
  fulfillmentType = 'delivery',
  preferredWarehouseId = null,
  strategy = 'nearest_single'
} = {}) {
  const warehouses = rankWarehouses(db, tenantId, {
    lat: strategy === 'priority' ? null : lat,
    lng: strategy === 'priority' ? null : lng,
    pickupOnly: fulfillmentType === 'pickup'
  });

  if (!warehouses.length) {
    return { ok: false, error: 'no_active_warehouses' };
  }

  const variantIds = items.map(i => i.variant_id);
  const stockMap = getStockMap(db, tenantId, variantIds);
  const avail = (wid, vid) => stockMap.get(`${wid}:${vid}`)?.available ?? 0;

  // If customer explicitly picked a pickup warehouse (or preferred warehouse), try it first
  const ordered = preferredWarehouseId
    ? [...warehouses.filter(w => w.id === preferredWarehouseId), ...warehouses.filter(w => w.id !== preferredWarehouseId)]
    : warehouses;

  if (preferredWarehouseId && fulfillmentType === 'pickup') {
    const chosen = warehouses.find(w => w.id === preferredWarehouseId);
    if (!chosen) return { ok: false, error: 'warehouse_not_found' };
    const missing = items.filter(it => avail(chosen.id, it.variant_id) < it.qty);
    if (missing.length) {
      return { ok: false, error: 'insufficient_stock_in_warehouse', warehouse: chosen, missing };
    }
    return {
      ok: true,
      split: false,
      warehouse: chosen,
      allocations: items.map(it => ({ warehouse_id: chosen.id, warehouse_name: chosen.name, variant_id: it.variant_id, qty: it.qty }))
    };
  }

  for (const wh of ordered) {
    const canAll = items.every(it => avail(wh.id, it.variant_id) >= it.qty);
    if (canAll) {
      return {
        ok: true,
        split: false,
        warehouse: wh,
        allocations: items.map(it => ({ warehouse_id: wh.id, warehouse_name: wh.name, variant_id: it.variant_id, qty: it.qty }))
      };
    }
  }

  if (strategy === 'split_nearest' && fulfillmentType !== 'pickup') {
    const allocations = [];
    for (const it of items) {
      let remaining = it.qty;
      for (const wh of ordered) {
        const have = avail(wh.id, it.variant_id);
        if (have <= 0) continue;
        const take = Math.min(have, remaining);
        allocations.push({ warehouse_id: wh.id, warehouse_name: wh.name, variant_id: it.variant_id, qty: take });
        remaining -= take;
        if (remaining === 0) break;
      }
      if (remaining > 0) {
        return { ok: false, error: 'out_of_stock', variant_id: it.variant_id, short_by: remaining };
      }
    }
    const primary = ordered.find(w => w.id === allocations[0]?.warehouse_id) || ordered[0];
    return { ok: true, split: new Set(allocations.map(a => a.warehouse_id)).size > 1, warehouse: primary, allocations };
  }

  return { ok: false, error: 'out_of_stock' };
}

function logMovement(db, { tenantId, warehouseId, variantId, orderNo = null, type, deltaQty, note = '' }) {
  db.sqlite
    .prepare(`INSERT INTO stock_movements (id, tenant_id, warehouse_id, variant_id, order_no, type, delta_qty, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomId('mov'), tenantId, warehouseId, variantId, orderNo, type, deltaQty, note, new Date().toISOString());
}

/** Atomically reserve stock for allocations [{ warehouse_id, variant_id, qty }]. */
export function reserveAllocations(db, tenantId, allocations, orderNo) {
  return db.transaction(() => {
    const now = new Date().toISOString();
    for (const a of allocations) {
      const row = db.sqlite
        .prepare(`SELECT qty, reserved FROM warehouse_stock WHERE tenant_id = ? AND warehouse_id = ? AND variant_id = ?`)
        .get(tenantId, a.warehouse_id, a.variant_id);
      const available = row ? row.qty - row.reserved : 0;
      if (!row || available < a.qty) {
        throw Object.assign(new Error(`Insufficient stock for variant ${a.variant_id} in warehouse ${a.warehouse_id}`), { code: 'out_of_stock' });
      }
      db.sqlite
        .prepare(`UPDATE warehouse_stock SET reserved = reserved + ?, updated_at = ? WHERE tenant_id = ? AND warehouse_id = ? AND variant_id = ?`)
        .run(a.qty, now, tenantId, a.warehouse_id, a.variant_id);
      logMovement(db, { tenantId, warehouseId: a.warehouse_id, variantId: a.variant_id, orderNo, type: 'reserve', deltaQty: -a.qty, note: `Reserved for ${orderNo}` });
    }
  });
}

/** Commit reserved stock upon payment confirmation. */
export function commitAllocations(db, tenantId, allocations, orderNo) {
  return db.transaction(() => {
    const now = new Date().toISOString();
    for (const a of allocations) {
      db.sqlite
        .prepare(`UPDATE warehouse_stock SET qty = MAX(qty - ?, 0), reserved = MAX(reserved - ?, 0), updated_at = ? WHERE tenant_id = ? AND warehouse_id = ? AND variant_id = ?`)
        .run(a.qty, a.qty, now, tenantId, a.warehouse_id, a.variant_id);
      logMovement(db, { tenantId, warehouseId: a.warehouse_id, variantId: a.variant_id, orderNo, type: 'commit', deltaQty: -a.qty, note: `Committed on payment ${orderNo}` });
    }
  });
}

/** Release previously reserved stock upon cancellation or expiry. */
export function releaseAllocations(db, tenantId, allocations, orderNo, reason = 'Released') {
  return db.transaction(() => {
    const now = new Date().toISOString();
    for (const a of allocations) {
      db.sqlite
        .prepare(`UPDATE warehouse_stock SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE tenant_id = ? AND warehouse_id = ? AND variant_id = ?`)
        .run(a.qty, now, tenantId, a.warehouse_id, a.variant_id);
      logMovement(db, { tenantId, warehouseId: a.warehouse_id, variantId: a.variant_id, orderNo, type: 'release', deltaQty: a.qty, note: reason });
    }
  });
}

/** Atomically transfer available stock between two warehouses belonging to the SAME tenant. */
export function transferStock(db, tenantId, { fromWarehouseId, toWarehouseId, variantId, qty, note = '' }) {
  const amount = Math.floor(Number(qty));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('Quantity must be a positive integer'), { code: 'bad_request' });
  }
  if (fromWarehouseId === toWarehouseId) {
    throw Object.assign(new Error('Source and destination warehouses must differ'), { code: 'bad_request' });
  }
  return db.transaction(() => {
    const fromW = db.sqlite.prepare(`SELECT id, name FROM warehouses WHERE id = ? AND tenant_id = ?`).get(fromWarehouseId, tenantId);
    const toW = db.sqlite.prepare(`SELECT id, name FROM warehouses WHERE id = ? AND tenant_id = ?`).get(toWarehouseId, tenantId);
    if (!fromW || !toW) {
      throw Object.assign(new Error('Warehouse not found for tenant'), { code: 'not_found' });
    }
    const variant = db.sqlite.prepare(`SELECT id FROM variants WHERE id = ? AND tenant_id = ?`).get(variantId, tenantId);
    if (!variant) {
      throw Object.assign(new Error('Variant not found for tenant'), { code: 'not_found' });
    }
    const src = db.sqlite.prepare(`SELECT qty, reserved FROM warehouse_stock WHERE tenant_id = ? AND warehouse_id = ? AND variant_id = ?`).get(tenantId, fromWarehouseId, variantId);
    const avail = src ? src.qty - src.reserved : 0;
    if (avail < amount) {
      throw Object.assign(new Error(`Only ${avail} units available to transfer`), { code: 'out_of_stock' });
    }
    const now = new Date().toISOString();
    db.sqlite
      .prepare(`UPDATE warehouse_stock SET qty = qty - ?, updated_at = ? WHERE tenant_id = ? AND warehouse_id = ? AND variant_id = ?`)
      .run(amount, now, tenantId, fromWarehouseId, variantId);

    db.sqlite
      .prepare(`INSERT INTO warehouse_stock (tenant_id, warehouse_id, variant_id, qty, reserved, reorder_point, updated_at)
                VALUES (?, ?, ?, ?, 0, 5, ?)
                ON CONFLICT(warehouse_id, variant_id) DO UPDATE SET qty = qty + excluded.qty, updated_at = excluded.updated_at`)
      .run(tenantId, toWarehouseId, variantId, amount, now);

    const reason = note || `Transfer ${fromW.name} -> ${toW.name}`;
    logMovement(db, { tenantId, warehouseId: fromWarehouseId, variantId, type: 'transfer_out', deltaQty: -amount, note: reason });
    logMovement(db, { tenantId, warehouseId: toWarehouseId, variantId, type: 'transfer_in', deltaQty: amount, note: reason });
    return { ok: true, transferred: amount, from: fromW.name, to: toW.name };
  });
}
