(() => {
  const ctx = window.__MT_CONTEXT__ || { tenant: { slug: 'trove-market', name: 'Trove Market', currency: 'USD', theme_config: {} }, warehouses: [] };
  const tenant = ctx.tenant;
  const warehouses = ctx.warehouses || [];

  const money = (cents, cur = tenant.currency || 'USD') => {
    const v = Number(cents || 0) / 100;
    return cur === 'IDR' ? 'Rp ' + Math.round(v * 100).toLocaleString('id-ID') : '$' + v.toFixed(2);
  };

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Apply tenant announcement/title overrides on the static Hyper Trove header
  function applyTenantBranding() {
    const ann = tenant.theme_config?.announcement;
    if (ann) {
      document.querySelectorAll('.announcement-bar__message p, .announcement-bar__message').forEach(el => {
        if (!el.children.length) el.textContent = ann;
      });
    }
    if (tenant.slug !== 'trove-market') {
      document.title = `${tenant.name} — Multi-Tenant Storefront`;
    }
  }

  // Render Top Multi-Tenant & Multi-Warehouse Platform Bar
  function mountPlatformBar() {
    if (document.getElementById('mt-platform-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'mt-platform-bar';
    bar.innerHTML = `
      <div class="mt-bar-inner">
        <div class="mt-bar-group">
          <span class="mt-pill"><span class="mt-dot"></span> Tenant: <strong id="mt-tenant-name">${esc(tenant.name)}</strong></span>
          <select id="mt-tenant-switch" class="mt-select" title="Switch Store Tenant"></select>
          <span class="mt-pill" title="Active warehouses for this tenant">🏭 ${warehouses.length} Warehouse${warehouses.length === 1 ? '' : 's'} (${esc(tenant.settings?.routing_strategy || 'nearest_single')})</span>
        </div>
        <div class="mt-bar-group">
          <button type="button" class="mt-btn" id="mt-open-catalog">🛍️ Tenant Catalog</button>
          <button type="button" class="mt-btn" id="mt-open-tracker">📦 Track Order</button>
          <button type="button" class="mt-btn mt-btn-accent" id="mt-open-checkout">⚡ Checkout (<span id="mt-cart-count">0</span>)</button>
          <a class="mt-btn" href="/admin">⚙️ Back Office</a>
          <a class="mt-btn" href="/preview.html">📱 Preview</a>
        </div>
      </div>
    `;
    document.body.prepend(bar);

    fetch('/api/tenants')
      .then(r => r.json())
      .then(data => {
        const sel = document.getElementById('mt-tenant-switch');
        if (!sel || !data.tenants) return;
        sel.innerHTML = data.tenants
          .map(t => `<option value="${esc(t.slug)}" ${t.slug === tenant.slug ? 'selected' : ''}>${esc(t.name)} (${esc(t.slug)})</option>`)
          .join('');
        sel.addEventListener('change', () => {
          const url = new URL(window.location.href);
          url.searchParams.set('store', sel.value);
          window.location.href = url.toString();
        });
      })
      .catch(() => {});

    document.getElementById('mt-open-checkout').addEventListener('click', openCheckoutModal);
    document.getElementById('mt-open-tracker').addEventListener('click', openTrackerModal);
    document.getElementById('mt-open-catalog').addEventListener('click', openCatalogModal);
  }

  // Create shared modals container
  function ensureModals() {
    if (document.getElementById('mt-modals-root')) return;
    const root = document.createElement('div');
    root.id = 'mt-modals-root';
    root.innerHTML = `
      <div id="mt-checkout-backdrop" class="mt-modal-backdrop" hidden>
        <div class="mt-modal" role="dialog" aria-modal="true">
          <div class="mt-modal-head">
            <div>
              <strong style="font-size:16px">Multi-Warehouse Checkout</strong>
              <div style="font-size:12px;color:#64748b">${esc(tenant.name)} · Automatic nearest warehouse routing</div>
            </div>
            <button type="button" class="mt-btn" onclick="document.getElementById('mt-checkout-backdrop').hidden=true">✕ Close</button>
          </div>
          <div class="mt-modal-body" id="mt-checkout-body">Loading cart...</div>
        </div>
      </div>

      <div id="mt-tracker-backdrop" class="mt-modal-backdrop" hidden>
        <div class="mt-modal" role="dialog" aria-modal="true">
          <div class="mt-modal-head">
            <strong style="font-size:16px">Order & Warehouse Fulfillment Tracker</strong>
            <button type="button" class="mt-btn" onclick="document.getElementById('mt-tracker-backdrop').hidden=true">✕ Close</button>
          </div>
          <div class="mt-modal-body">
            <form id="mt-track-form" style="display:flex;gap:8px;margin-bottom:16px">
              <input type="text" id="mt-track-no" placeholder="Enter Order No (e.g. TROV-...)" style="flex:1;padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px">
              <button type="submit" class="mt-btn-primary">Track Order</button>
            </form>
            <div id="mt-track-result"></div>
          </div>
        </div>
      </div>

      <div id="mt-catalog-backdrop" class="mt-modal-backdrop" hidden>
        <div class="mt-modal" style="max-width:980px" role="dialog" aria-modal="true">
          <div class="mt-modal-head">
            <div>
              <strong style="font-size:16px">${esc(tenant.name)} — Live Multi-Warehouse Catalog</strong>
              <div style="font-size:12px;color:#64748b">Real-time inventory summed across ${warehouses.length} warehouse(s)</div>
            </div>
            <button type="button" class="mt-btn" onclick="document.getElementById('mt-catalog-backdrop').hidden=true">✕ Close</button>
          </div>
          <div class="mt-modal-body">
            <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
              <input type="search" id="mt-cat-search" placeholder="Search tenant products..." style="flex:1;min-width:200px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px">
              <button type="button" class="mt-btn-primary" id="mt-cat-search-btn">Search</button>
            </div>
            <div id="mt-cat-grid" class="mt-catalog-grid">Loading...</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    document.getElementById('mt-track-form').addEventListener('submit', e => {
      e.preventDefault();
      loadOrderStatus(document.getElementById('mt-track-no').value.trim());
    });
    document.getElementById('mt-cat-search-btn').addEventListener('click', () => {
      loadTenantCatalog(document.getElementById('mt-cat-search').value.trim());
    });
  }

  async function refreshCartBadge() {
    try {
      const cart = await (await fetch('/cart.js')).json();
      const el = document.getElementById('mt-cart-count');
      if (el) el.textContent = String(cart.item_count || 0);
      document.querySelectorAll('cart-count').forEach(cc => {
        cc.textContent = String(cart.item_count || 0);
        cc.hidden = (cart.item_count || 0) === 0;
      });
      return cart;
    } catch {
      return null;
    }
  }

  window.__MT_ADD_AND_OPEN__ = async function (formOrVariantId, qty = 1) {
    let variantId = formOrVariantId;
    if (formOrVariantId && formOrVariantId.tagName === 'FORM') {
      const fd = new FormData(formOrVariantId);
      variantId = fd.get('id');
      qty = Number(fd.get('quantity') || 1);
    }
    const r = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: variantId, quantity: qty, sections: ['sections--19692154126565__cart-drawer'] })
    });
    const data = await r.json();
    if (!r.ok) {
      alert(data.description || data.message || 'Unable to add item');
      return;
    }
    if (window.FoxTheme?.pubsub) {
      window.FoxTheme.pubsub.publish(window.FoxTheme.pubsub.PUB_SUB_EVENTS.cartUpdate, { cart: data });
    }
    await refreshCartBadge();
    const drawer = document.querySelector('cart-drawer');
    if (drawer?.show) drawer.show();
  };

  async function openCatalogModal() {
    ensureModals();
    document.getElementById('mt-catalog-backdrop').hidden = false;
    await loadTenantCatalog('');
  }

  async function loadTenantCatalog(q) {
    const grid = document.getElementById('mt-cat-grid');
    grid.innerHTML = 'Loading products...';
    const res = await fetch(`/api/products${q ? '?q=' + encodeURIComponent(q) : ''}`);
    const data = await res.json();
    const list = data.products || [];
    if (!list.length) {
      grid.innerHTML = '<p>No products found in this tenant.</p>';
      return;
    }
    grid.innerHTML = list
      .slice(0, 48)
      .map(p => {
        const v = p.variants?.[0];
        const whBadges = (v?.warehouse_stock || [])
          .map(w => `<span style="font-size:10px;padding:2px 5px;border-radius:4px;background:${w.available > 0 ? '#dcfce7;color:#166534' : '#fee2e2;color:#991b1b'}">${esc(w.warehouse_code)}: ${w.available}</span>`)
          .join(' ');
        return `
          <div class="mt-cat-card">
            <a href="/products/${esc(p.handle)}"><img src="${esc(p.image || '/cdn/shop/files/trove-logo.jpg')}" alt="${esc(p.title)}"></a>
            <div class="mt-cat-card-body">
              <span style="font-size:11px;color:#64748b">${esc(p.category)}</span>
              <a href="/products/${esc(p.handle)}" style="font-weight:600;font-size:13px;color:#0f172a;text-decoration:none">${esc(p.title)}</a>
              <div style="font-weight:700;font-size:14px">${esc(money(v?.price_cents || p.min_price_cents))}</div>
              <div style="display:flex;flex-wrap:wrap;gap:4px">${whBadges}</div>
              <button type="button" class="mt-btn-primary" style="margin-top:auto" ${p.total_available <= 0 ? 'disabled' : ''} data-mt-quick-add="${esc(v?.shopify_variant_id || v?.id || '')}">
                ${p.total_available > 0 ? 'Add to Cart' : 'Sold Out'}
              </button>
            </div>
          </div>`;
      })
      .join('');

    grid.querySelectorAll('[data-mt-quick-add]').forEach(btn => {
      btn.addEventListener('click', () => window.__MT_ADD_AND_OPEN__(btn.dataset.mtQuickAdd, 1));
    });
  }

  async function openCheckoutModal() {
    ensureModals();
    const backdrop = document.getElementById('mt-checkout-backdrop');
    const body = document.getElementById('mt-checkout-body');
    backdrop.hidden = false;
    body.innerHTML = 'Loading cart...';

    const cart = await (await fetch('/cart.js')).json();
    if (!cart.items || !cart.items.length) {
      body.innerHTML = `<div class="mt-alert mt-alert-err">Your cart is empty. Add items from the storefront or Tenant Catalog first.</div>`;
      return;
    }

    const whOpts = warehouses
      .map(w => `<option value="${esc(w.id)}">${esc(w.name)} — ${esc(w.city)} (${esc(w.code)})</option>`)
      .join('');

    body.innerHTML = `
      <div id="mt-chk-alert"></div>
      <div class="mt-grid-2">
        <div class="mt-field"><label>Customer Name *</label><input id="mt-c-name" value="Alex Rivera"></div>
        <div class="mt-field"><label>Phone / WhatsApp</label><input id="mt-c-phone" value="+1 555 0199"></div>
        <div class="mt-field"><label>Email</label><input id="mt-c-email" value="alex@example.com"></div>
        <div class="mt-field"><label>Fulfillment Type</label>
          <select id="mt-c-type">
            <option value="delivery">Delivery (Auto-Route Nearest Warehouse)</option>
            <option value="pickup">Warehouse Pickup (Free)</option>
          </select>
        </div>
      </div>
      <div class="mt-grid-2">
        <div class="mt-field"><label>Delivery Address</label><input id="mt-c-addr" value="350 5th Ave, New York, NY 10118"></div>
        <div class="mt-field"><label>Customer Location Preset (for distance routing)</label>
          <select id="mt-c-loc">
            <option value="40.7282,-73.9962">Downtown Manhattan (near NYC-DT)</option>
            <option value="40.7216,-73.9598">Williamsburg Brooklyn (near NYC-BK)</option>
            <option value="40.7662,-74.0176">Weehawken NJ (near NJ-WB)</option>
            <option value="42.25,-73.79">Hudson Valley NY</option>
          </select>
        </div>
      </div>
      <div class="mt-grid-2">
        <div class="mt-field"><label>Preferred Warehouse (optional / required for pickup)</label>
          <select id="mt-c-wh"><option value="">Auto-select nearest stocked warehouse</option>${whOpts}</select>
        </div>
        <div class="mt-field"><label>Coupon Code (try WELCOME10 / FRESH15 / URBAN10)</label>
          <input id="mt-c-coupon" value="${esc(cart.discount_codes?.[0]?.code || '')}" placeholder="Optional coupon">
        </div>
      </div>
      <div class="mt-field"><label>Payment Method</label>
        <select id="mt-c-pay">
          <option value="card_sim">Instant Card / QRIS Simulation</option>
          <option value="bank_transfer">Bank Transfer (Pending until paid)</option>
          <option value="cod">Cash on Delivery</option>
        </select>
      </div>

      <div id="mt-quote-preview" class="mt-quote-box">Calculating warehouse route & shipping quote...</div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button type="button" class="mt-btn" id="mt-recalc-quote">Refresh Warehouse Quote</button>
        <button type="button" class="mt-btn-primary" id="mt-submit-order">Place Order</button>
      </div>
    `;

    const quoteItems = cart.items.map(i => ({ variant_id: i.variant_id, qty: i.quantity }));

    async function refreshQuote() {
      const [lat, lng] = document.getElementById('mt-c-loc').value.split(',').map(Number);
      const payload = {
        items: quoteItems,
        fulfillment_type: document.getElementById('mt-c-type').value,
        warehouse_id: document.getElementById('mt-c-wh').value || null,
        coupon_code: document.getElementById('mt-c-coupon').value.trim() || null,
        lat,
        lng
      };
      const qBox = document.getElementById('mt-quote-preview');
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const q = await res.json();
      if (!res.ok) {
        qBox.innerHTML = `<div class="mt-alert mt-alert-err" style="margin:0">${esc(q.error || 'Could not quote')}</div>`;
        return null;
      }
      const allocList = (q.allocations || [])
        .map(a => `${a.qty}× via <strong>${esc(a.warehouse_name)}</strong>`)
        .join(', ');
      qBox.innerHTML = `
        <div class="mt-row"><span>Assigned Fulfillment Warehouse</span><strong>${esc(q.warehouse.name)} (${esc(q.warehouse.code)})${q.distance_km != null ? ` · ${q.distance_km} km` : ''}</strong></div>
        <div class="mt-row"><span>Allocation Plan ${q.split_shipment ? '(Split Shipment)' : '(Single Hub)'}</span><span>${allocList}</span></div>
        <div class="mt-row"><span>Shipping Zone (${esc(q.eta)})</span><span>${esc(q.zone_name)}</span></div>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:8px 0">
        <div class="mt-row"><span>Subtotal</span><span>${esc(money(q.subtotal_cents))}</span></div>
        ${q.discount_cents > 0 ? `<div class="mt-row" style="color:#15803d"><span>Discount (${esc(q.coupon_code)})</span><span>-${esc(money(q.discount_cents))}</span></div>` : ''}
        <div class="mt-row"><span>Shipping</span><span>${esc(money(q.shipping_cents))}</span></div>
        <div class="mt-row" style="font-size:16px;font-weight:700;margin-top:4px"><span>Total</span><span>${esc(money(q.total_cents))}</span></div>
      `;
      return payload;
    }

    ['mt-c-type', 'mt-c-loc', 'mt-c-wh'].forEach(id => {
      document.getElementById(id).addEventListener('change', refreshQuote);
    });
    document.getElementById('mt-recalc-quote').addEventListener('click', refreshQuote);
    await refreshQuote();

    document.getElementById('mt-submit-order').addEventListener('click', async () => {
      const alertEl = document.getElementById('mt-chk-alert');
      alertEl.innerHTML = '';
      const [lat, lng] = document.getElementById('mt-c-loc').value.split(',').map(Number);
      const payMethod = document.getElementById('mt-c-pay').value;
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: quoteItems,
          customer_name: document.getElementById('mt-c-name').value.trim(),
          customer_phone: document.getElementById('mt-c-phone').value.trim(),
          customer_email: document.getElementById('mt-c-email').value.trim(),
          shipping_address: document.getElementById('mt-c-addr').value.trim(),
          fulfillment_type: document.getElementById('mt-c-type').value,
          warehouse_id: document.getElementById('mt-c-wh').value || null,
          coupon_code: document.getElementById('mt-c-coupon').value.trim() || null,
          payment_method: payMethod,
          lat,
          lng,
          clear_cart: true
        })
      });
      const data = await res.json();
      if (!res.ok) {
        alertEl.innerHTML = `<div class="mt-alert mt-alert-err">${esc(data.error || 'Checkout failed')}</div>`;
        return;
      }
      const order = data.order;
      if (payMethod === 'card_sim') {
        await fetch(`/api/orders/${encodeURIComponent(order.order_no)}/pay`, { method: 'POST' });
      }
      await refreshCartBadge();
      document.getElementById('mt-checkout-backdrop').hidden = true;
      openTrackerModal(order.order_no);
    });
  }

  async function openTrackerModal(orderNo = '') {
    ensureModals();
    document.getElementById('mt-tracker-backdrop').hidden = false;
    if (orderNo) {
      document.getElementById('mt-track-no').value = orderNo;
      await loadOrderStatus(orderNo);
    }
  }

  async function loadOrderStatus(orderNo) {
    const out = document.getElementById('mt-track-result');
    if (!orderNo) return;
    out.innerHTML = 'Looking up order...';
    const res = await fetch(`/api/orders/${encodeURIComponent(orderNo)}`);
    const data = await res.json();
    if (!res.ok) {
      out.innerHTML = `<div class="mt-alert mt-alert-err">${esc(data.error || 'Order not found')}</div>`;
      return;
    }
    const o = data.order;
    out.innerHTML = `
      <div class="mt-alert mt-alert-ok">
        Order <strong>${esc(o.order_no)}</strong> · Status: <strong style="text-transform:uppercase">${esc(o.status)}</strong> · Payment: <strong>${esc(o.payment_status)}</strong>
      </div>
      <div class="mt-quote-box">
        <div class="mt-row"><span>Fulfilled From Warehouse</span><strong>${esc(o.warehouse_name || o.warehouse_id)} (${esc(o.warehouse_code || '')})</strong></div>
        <div class="mt-row"><span>Fulfillment Type</span><span>${esc(o.fulfillment_type)} ${o.distance_km != null ? `(${o.distance_km} km)` : ''}</span></div>
        <div class="mt-row"><span>Customer</span><span>${esc(o.customer_name)}</span></div>
        <div class="mt-row"><span>Total</span><strong>${esc(money(o.total_cents))}</strong></div>
      </div>
      <div style="margin-bottom:12px">
        ${(o.items || []).map(i => `<div class="mt-row"><span>${i.qty}× ${esc(i.title)} (${esc(i.variant_title)})</span><span>${esc(money(i.line_total_cents))}</span></div>`).join('')}
      </div>
      ${o.payment_status === 'unpaid' && o.status === 'pending'
        ? `<button type="button" class="mt-btn-primary" id="mt-pay-now-btn">Confirm / Simulate Payment Now</button>`
        : ''}
    `;
    const payBtn = document.getElementById('mt-pay-now-btn');
    if (payBtn) {
      payBtn.addEventListener('click', async () => {
        await fetch(`/api/orders/${encodeURIComponent(o.order_no)}/pay`, { method: 'POST' });
        await loadOrderStatus(o.order_no);
      });
    }
  }

  // Intercept Cart Drawer & Cart Page checkout buttons
  document.addEventListener('click', e => {
    const target = e.target.closest('[data-mt-checkout], button[name="checkout"], a[href*="/checkouts"]');
    if (target) {
      e.preventDefault();
      e.stopPropagation();
      openCheckoutModal();
    }
  }, true);

  document.addEventListener('cart:updated', refreshCartBadge);

  function init() {
    applyTenantBranding();
    mountPlatformBar();
    ensureModals();
    refreshCartBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
