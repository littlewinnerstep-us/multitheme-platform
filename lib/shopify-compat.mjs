import { randomId } from './crypto.mjs';
import { rankWarehouses, getStockMap } from './warehouse.mjs';

const CART_SECTION_ID = 'sections--19692154126565__cart-drawer';
const MAIN_CART_SECTION_ID = 'template--19692159959269__main-cart';
const HEADER_SECTION_ID = 'sections--19692152914149__header';

const esc = s =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function formatMoney(cents, currency = 'USD') {
  const n = Number(cents || 0) / 100;
  if (currency === 'IDR') return 'Rp ' + Math.round(n * 100).toLocaleString('id-ID');
  return '$' + n.toFixed(2);
}

/** Resolve or create persistent cart row for (tenantId, cartToken). */
export function getOrCreateCart(db, tenantId, token) {
  let cart = db.sqlite.prepare(`SELECT * FROM carts WHERE tenant_id = ? AND token = ?`).get(tenantId, token);
  if (!cart) {
    const id = randomId('crt');
    const now = new Date().toISOString();
    db.sqlite.prepare(`INSERT INTO carts (id, tenant_id, token, note, discount_code, updated_at) VALUES (?, ?, ?, '', '', ?)`).run(id, tenantId, token, now);
    cart = db.sqlite.prepare(`SELECT * FROM carts WHERE id = ?`).get(id);
  }
  return cart;
}

/** Build full Shopify-compatible cart JSON object for a tenant cart. */
export function getCartState(db, tenant, cartToken) {
  const cart = getOrCreateCart(db, tenant.id, cartToken);
  const rows = db.sqlite
    .prepare(`
      SELECT ci.qty, v.id AS variant_id, v.shopify_variant_id, v.sku, v.title AS variant_title,
             v.price_cents, v.weight_g, p.id AS product_id, p.handle, p.shopify_id, p.title AS product_title, p.image, p.vendor
      FROM cart_items ci
      JOIN variants v ON v.id = ci.variant_id AND v.tenant_id = ?
      JOIN products p ON p.id = v.product_id AND p.tenant_id = ?
      WHERE ci.cart_id = ?
    `)
    .all(tenant.id, tenant.id, cart.id);

  let subtotalCents = 0;
  let itemCount = 0;
  let totalWeight = 0;

  const items = rows.map((r, idx) => {
    const lineCents = r.price_cents * r.qty;
    subtotalCents += lineCents;
    itemCount += r.qty;
    totalWeight += (r.weight_g || 0) * r.qty;
    const numericVid = Number(r.shopify_variant_id) || r.variant_id;
    return {
      id: numericVid,
      variant_id: r.variant_id,
      shopify_variant_id: r.shopify_variant_id,
      key: `${r.variant_id}:${idx + 1}`,
      product_id: Number(r.shopify_id) || r.product_id,
      title: r.variant_title && r.variant_title !== 'Standard' && r.variant_title !== 'Default Title'
        ? `${r.product_title} - ${r.variant_title}`
        : r.product_title,
      product_title: r.product_title,
      variant_title: r.variant_title,
      handle: r.handle,
      sku: r.sku,
      vendor: r.vendor || tenant.name,
      quantity: r.qty,
      price: r.price_cents,
      original_price: r.price_cents,
      final_price: r.price_cents,
      line_price: lineCents,
      original_line_price: lineCents,
      final_line_price: lineCents,
      grams: r.weight_g || 450,
      image: r.image || '/cdn/shop/files/trove-logo.jpg',
      featured_image: { url: r.image || '/cdn/shop/files/trove-logo.jpg', alt: r.product_title },
      url: `/products/${r.handle}?variant=${numericVid}`,
      options_with_values: [{ name: 'Option', value: r.variant_title || 'Standard' }],
      properties: {}
    };
  });

  // Apply discount code if stored on cart
  const discountCodes = [];
  let discountCents = 0;
  if (cart.discount_code) {
    for (const rawCode of cart.discount_code.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)) {
      const cpn = db.sqlite
        .prepare(`SELECT * FROM coupons WHERE tenant_id = ? AND UPPER(code) = ? AND active = 1`)
        .get(tenant.id, rawCode);
      const valid =
        cpn &&
        (!cpn.expires_at || cpn.expires_at > new Date().toISOString()) &&
        (!cpn.max_uses || cpn.used_count < cpn.max_uses) &&
        subtotalCents >= cpn.min_purchase_cents;
      if (valid && discountCents === 0) {
        discountCents = cpn.type === 'pct'
          ? Math.round((subtotalCents * cpn.value) / 100)
          : Math.min(subtotalCents, cpn.value);
        discountCodes.push({ code: rawCode, amount: discountCents, applicable: true });
      } else {
        discountCodes.push({ code: rawCode, amount: 0, applicable: false });
      }
    }
  }

  const totalCents = Math.max(0, subtotalCents - discountCents);

  return {
    token: cart.token,
    note: cart.note || '',
    preferred_warehouse_id: cart.preferred_warehouse_id || null,
    attributes: {},
    original_total_price: subtotalCents,
    items_subtotal_price: subtotalCents,
    total_price: totalCents,
    total_discount: discountCents,
    total_weight: totalWeight,
    item_count: itemCount,
    items,
    requires_shipping: true,
    currency: tenant.currency || 'USD',
    discount_codes: discountCodes,
    cart_level_discount_applications: discountCents > 0
      ? [{ title: discountCodes.find(d => d.applicable)?.code || 'DISCOUNT', total_allocated_amount: discountCents }]
      : []
  };
}

/** Find a tenant's variant by internal ID or Shopify numeric variant ID. */
export function resolveVariant(db, tenantId, idInput) {
  const idStr = String(idInput || '').trim();
  if (!idStr) return null;
  return (
    db.sqlite.prepare(`SELECT * FROM variants WHERE tenant_id = ? AND (id = ? OR shopify_variant_id = ?) AND active = 1`).get(tenantId, idStr, idStr) ||
    null
  );
}

/** Render Shopify CartDrawer & MainCart sections HTML so Hyper Trove's native CartDrawer updates smoothly. */
export function renderCartSections(cartState, requestedSections = []) {
  const cur = cartState.currency || 'USD';
  const itemsHtml = cartState.items
    .map((item, i) => {
      const line = i + 1;
      return `
      <div id="CartDrawer-Item-${line}" class="cart-item flex gap-3 py-4 border-b" data-line-key="${esc(item.key)}" data-line-quantity="${item.quantity}">
        <a href="${esc(item.url)}" class="cart-item__media shrink-0" style="width:72px;height:72px;overflow:hidden;border-radius:8px;background:#f4f4f4;display:block">
          <img src="${esc(item.image)}" alt="${esc(item.product_title)}" style="width:100%;height:100%;object-fit:cover">
        </a>
        <div class="cart-item__details flex-grow flex flex-col gap-1">
          <div class="flex justify-between gap-2">
            <a href="${esc(item.url)}" class="cart-item__title font-medium text-sm" style="text-decoration:none;color:inherit">${esc(item.product_title)}</a>
            <a is="cart-remove-item" href="/cart/change?line=${line}&quantity=0" data-index="${line}" class="text-xs opacity-60 hover:opacity-100" aria-label="Remove ${esc(item.product_title)}">✕</a>
          </div>
          ${item.variant_title && item.variant_title !== 'Standard' ? `<div class="text-xs opacity-70">${esc(item.variant_title)}</div>` : ''}
          <div class="flex items-center justify-between gap-2 mt-1">
            <quantity-input class="quantity flex items-center border rounded" style="display:inline-flex;align-items:center;border:1px solid #ddd;border-radius:6px">
              <button class="quantity__button px-2 py-1" name="minus" type="button" aria-label="Decrease quantity">−</button>
              <input class="quantity__input text-center text-sm" type="number" name="updates[]" value="${item.quantity}" min="0" data-index="${line}" style="width:36px;border:none;text-align:center;background:transparent">
              <button class="quantity__button px-2 py-1" name="plus" type="button" aria-label="Increase quantity">+</button>
            </quantity-input>
            <div class="font-semibold text-sm">${esc(formatMoney(item.line_price, cur))}</div>
          </div>
        </div>
      </div>`;
    })
    .join('');

  const discountsHtml = cartState.discount_codes.filter(d => d.applicable).length
    ? `<ul class="cart__discounts flex flex-wrap gap-2 mb-2" style="list-style:none;padding:0;margin:0 0 8px 0">${cartState.discount_codes
        .filter(d => d.applicable)
        .map(d => `<li class="discount text-xs px-2 py-1 rounded" data-discount-code="${esc(d.code)}" style="background:#fef3c7;color:#92400e;display:inline-flex;align-items:center;gap:6px"><span>${esc(d.code)} (-${esc(formatMoney(d.amount, cur))})</span><button is="cart-discount-remove" type="button" style="border:none;background:none;cursor:pointer">✕</button></li>`)
        .join('')}</ul>`
    : '';

  const drawerHtml = `
    <div id="CartDrawer-${CART_SECTION_ID}">
      <div id="CartDrawerEmpty-${CART_SECTION_ID}" class="${cartState.item_count > 0 ? 'hidden' : ''} text-center py-8">
        <p class="h4 mb-2">Your cart is currently empty.</p>
        <p class="text-sm opacity-75 mb-4">Browse fresh groceries & multi-warehouse stock.</p>
        <a href="/collections/all" class="btn btn--primary">Continue shopping</a>
      </div>
      <div id="CartDrawerBody-${CART_SECTION_ID}" class="${cartState.item_count === 0 ? 'hidden' : ''} flex flex-col gap-2">
        <cart-items data-section-id="${CART_SECTION_ID}">
          ${itemsHtml}
        </cart-items>
      </div>
      <div id="CartDrawerFooter-${CART_SECTION_ID}" class="${cartState.item_count === 0 ? 'hidden' : ''} pt-4 border-t">
        ${discountsHtml}
        <div class="flex justify-between items-center mb-2 text-sm">
          <span>Subtotal</span>
          <span class="font-bold text-base">${esc(formatMoney(cartState.total_price, cur))}</span>
        </div>
        <div class="flex gap-2 mt-3">
          <a href="/cart" class="btn btn--secondary flex-1 text-center">View cart</a>
          <button type="button" class="btn btn--primary flex-1" data-mt-checkout>Checkout (${cartState.item_count})</button>
        </div>
      </div>
    </div>`;

  const mainCartHtml = `
    <div id="MainCart-${MAIN_CART_SECTION_ID}">
      ${cartState.item_count === 0
        ? `<div class="text-center py-12"><h2 class="h3 mb-3">Your cart is empty</h2><a href="/collections/all" class="btn btn--primary">Shop All Products</a></div>`
        : `<cart-items data-section-id="${MAIN_CART_SECTION_ID}">${itemsHtml}</cart-items>
           <div class="mt-6 p-4 rounded border" style="background:#fff">
             ${discountsHtml}
             <div class="flex justify-between items-center text-lg font-bold mb-4">
               <span>Estimated Total</span>
               <span>${esc(formatMoney(cartState.total_price, cur))}</span>
             </div>
             <button type="button" class="btn btn--primary w-full" data-mt-checkout>Proceed to Multi-Warehouse Checkout</button>
           </div>`}
    </div>`;

  const sections = {
    [CART_SECTION_ID]: drawerHtml,
    [MAIN_CART_SECTION_ID]: mainCartHtml
  };
  for (const sid of requestedSections) {
    if (sid && !sections[sid]) {
      sections[sid] = sid.includes('main-cart') ? mainCartHtml : drawerHtml;
    }
  }
  return sections;
}

/** Render Quick View drawer HTML for `/products/:handle?section_id=...`. */
export function renderQuickViewHtml(db, tenant, handle) {
  const product = db.sqlite
    .prepare(`SELECT * FROM products WHERE tenant_id = ? AND handle = ? AND active = 1`)
    .get(tenant.id, handle);
  if (!product) return null;

  const variants = db.sqlite
    .prepare(`SELECT * FROM variants WHERE tenant_id = ? AND product_id = ? AND active = 1 ORDER BY price_cents ASC`)
    .all(tenant.id, product.id);
  const warehouses = rankWarehouses(db, tenant.id);
  const stockMap = getStockMap(db, tenant.id, variants.map(v => v.id));

  const firstVar = variants[0];
  const totalAvail = firstVar
    ? warehouses.reduce((sum, w) => sum + (stockMap.get(`${w.id}:${firstVar.id}`)?.available ?? 0), 0)
    : 0;

  const whBadges = warehouses
    .map(w => {
      const avail = firstVar ? stockMap.get(`${w.id}:${firstVar.id}`)?.available ?? 0 : 0;
      return `<li style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px dashed #e5e7eb"><span>${esc(w.name)} (${esc(w.city)})</span><strong style="color:${avail > 0 ? '#15803d' : '#b91c1c'}">${avail > 0 ? `${avail} in stock` : 'Out of stock'}</strong></li>`;
    })
    .join('');

  const cur = tenant.currency || 'USD';
  const variantOptions = variants
    .map(v => {
      const vid = v.shopify_variant_id || v.id;
      const tot = warehouses.reduce((s, w) => s + (stockMap.get(`${w.id}:${v.id}`)?.available ?? 0), 0);
      return `<option value="${esc(vid)}" data-price="${v.price_cents}">${esc(v.title)} — ${esc(formatMoney(v.price_cents, cur))} (${tot} avail)</option>`;
    })
    .join('');

  return `<!DOCTYPE html><html><body>
  <div class="shopify-section">
    <div class="quick-view__content p-4">
      <div class="flex flex-col gap-4">
        <div style="border-radius:12px;overflow:hidden;background:#f5f5f5;aspect-ratio:1/1;max-height:280px">
          <img src="${esc(product.image || '/cdn/shop/files/trove-logo.jpg')}" alt="${esc(product.title)}" style="width:100%;height:100%;object-fit:cover">
        </div>
        <div>
          <span style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666">${esc(tenant.name)} · ${esc(product.category)}</span>
          <h2 class="h3 mt-1 mb-2">${esc(product.title)}</h2>
          <div class="text-lg font-bold mb-2">${esc(formatMoney(firstVar?.price_cents || 0, cur))}</div>
          <p class="text-sm opacity-80 mb-3">${esc(product.description)}</p>
          <div class="mb-3 p-3 rounded" style="background:#f8fafc;border:1px solid #e2e8f0">
            <div style="font-size:12px;font-weight:600;margin-bottom:4px">Multi-Warehouse Availability (${totalAvail} total)</div>
            <ul style="list-style:none;margin:0;padding:0">${whBadges}</ul>
          </div>
          <form method="post" action="/cart/add" data-type="add-to-cart-form" class="flex flex-col gap-3">
            ${variants.length > 1
              ? `<label class="text-xs font-medium">Option<select name="id" class="form-control form-control--select mt-1">${variantOptions}</select></label>`
              : `<input type="hidden" name="id" value="${esc(firstVar?.shopify_variant_id || firstVar?.id || '')}">`}
            <div class="flex gap-2 items-center">
              <input type="number" name="quantity" value="1" min="1" max="${Math.max(1, totalAvail)}" class="form-control" style="width:80px">
              <button type="submit" name="add" class="btn btn--primary flex-1" ${totalAvail <= 0 ? 'disabled' : ''}>${totalAvail > 0 ? 'Add to cart' : 'Sold out'}</button>
            </div>
          </form>
          <a href="/products/${esc(product.handle)}" class="link text-sm mt-3 inline-block">View full details →</a>
        </div>
      </div>
    </div>
  </div>
  </body></html>`;
}

/** Render Pickup Availability HTML for `/variants/:id/?section_id=pickup-availability`. */
export function renderPickupAvailabilityHtml(db, tenant, variantInput) {
  const variant = resolveVariant(db, tenant.id, variantInput);
  const warehouses = rankWarehouses(db, tenant.id, { pickupOnly: true });
  const stockMap = variant ? getStockMap(db, tenant.id, [variant.id]) : new Map();

  const stocked = warehouses.filter(w => (stockMap.get(`${w.id}:${variant?.id}`)?.available ?? 0) > 0);
  const first = stocked[0];

  const listItems = warehouses
    .map(w => {
      const avail = variant ? stockMap.get(`${w.id}:${variant.id}`)?.available ?? 0 : 0;
      return `
        <li class="pickup-availability-list__item py-3 border-b">
          <h3 class="h5 mb-1">${esc(w.name)}</h3>
          <p class="pickup-availability-preview text-sm mb-1" style="color:${avail > 0 ? '#15803d' : '#b91c1c'}">
            ${avail > 0 ? `✓ Pickup ready (${avail} in stock) · Usually ready in 1 hour` : '✕ Currently out of stock at this location'}
          </p>
          <address class="text-xs opacity-75 not-italic">${esc(w.address)}, ${esc(w.city)} ${esc(w.postal_code)}</address>
        </li>`;
    })
    .join('');

  return `<!DOCTYPE html><html><body>
  <div class="shopify-section">
    ${first
      ? `<pickup-availability-preview class="pickup-availability-preview">
           <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 20" class="icon icon-tick" style="width:18px;height:18px;color:#15803d"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 10.5l4 4 8-9"/></svg>
           <div class="pickup-availability-info">
             <p class="caption-large">Pickup available at <strong>${esc(first.name)}</strong></p>
             <p class="caption">${stocked.length} warehouse${stocked.length > 1 ? 's' : ''} in stock · Usually ready in 1 hour</p>
             <button id="ShowPickupAvailabilityDrawer" class="pickup-availability-button link link--text underlined-link" aria-haspopup="dialog">Check availability at all ${warehouses.length} warehouses</button>
           </div>
         </pickup-availability-preview>
         <pickup-availability-drawer class="drawer modal" tabindex="-1" role="dialog" aria-modal="true" hidden>
           <div class="fixed-overlay" aria-controls="ShowPickupAvailabilityDrawer"></div>
           <div class="drawer__inner color-scheme-2 p-6">
             <div class="flex justify-between items-center mb-4">
               <h2 class="h4 m-0">Warehouse Pickup Availability</h2>
               <button type="button" class="btn btn--icon" onclick="this.closest('pickup-availability-drawer').hide?.();this.closest('pickup-availability-drawer').setAttribute('hidden','')">✕</button>
             </div>
             <ul class="list-unstyled" role="list">${listItems}</ul>
           </div>
         </pickup-availability-drawer>`
      : ''}
  </div>
  </body></html>`;
}

/** Render Predictive Search HTML for `/search/suggest`. */
export function renderPredictiveSearchHtml(db, tenant, query) {
  const q = String(query || '').replace(/^product_type:[^\s]+\s+AND\s+/i, '').trim();
  const like = `%${q}%`;
  const rows = q
    ? db.sqlite
        .prepare(`
          SELECT p.*, MIN(v.price_cents) AS min_price
          FROM products p
          LEFT JOIN variants v ON v.product_id = p.id AND v.active = 1
          WHERE p.tenant_id = ? AND p.active = 1 AND (p.title LIKE ? OR p.category LIKE ? OR p.description LIKE ?)
          GROUP BY p.id
          ORDER BY p.sort_order ASC
          LIMIT 10
        `)
        .all(tenant.id, like, like, like)
    : [];

  const cur = tenant.currency || 'USD';
  const cards = rows
    .map(
      r => `
      <a href="/products/${esc(r.handle)}" class="flex items-center gap-3 p-2 rounded hover:bg-gray-100" style="text-decoration:none;color:inherit;display:flex;align-items:center;gap:12px;padding:8px;border-bottom:1px solid #f1f5f9">
        <img src="${esc(r.image || '/cdn/shop/files/trove-logo.jpg')}" alt="${esc(r.title)}" style="width:48px;height:48px;object-fit:cover;border-radius:6px;flex-shrink:0">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.title)}</div>
          <div style="font-size:12px;opacity:.7">${esc(r.category)} · ${esc(formatMoney(r.min_price || 0, cur))}</div>
        </div>
      </a>`
    )
    .join('');

  return `<!DOCTYPE html><html><body>
    <div id="PredictiveSearchResults-${HEADER_SECTION_ID}">
      <div data-total-results="${rows.length}" style="padding:12px">
        ${rows.length
          ? `<div style="font-size:12px;font-weight:600;margin-bottom:8px;opacity:.7">Products in ${esc(tenant.name)} (${rows.length})</div>${cards}`
          : `<div style="padding:16px;text-align:center;opacity:.7">No products found for "${esc(q)}" in ${esc(tenant.name)}.</div>`}
      </div>
    </div>
  </body></html>`;
}
