const state = { user: null, tenant: null, activeTenantSlug: 'trove-market', tab: 'overview' };

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (cents, cur = state.tenant?.currency || 'USD') => {
  const v = Number(cents || 0) / 100;
  return cur === 'IDR' ? 'Rp ' + Math.round(v * 100).toLocaleString('id-ID') : '$' + v.toFixed(2);
};

async function api(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.activeTenantSlug) headers['X-Tenant'] = state.activeTenantSlug;
  const res = await fetch(url, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Auth tab switching
document.querySelectorAll('[data-auth-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-auth-tab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const isLogin = btn.dataset.authTab === 'login';
    document.getElementById('login-form').hidden = !isLogin;
    document.getElementById('signup-form').hidden = isLogin;
  });
});

document.querySelectorAll('[data-demo]').forEach(btn => {
  btn.addEventListener('click', () => {
    const [store, email, pass] = btn.dataset.demo.split('|');
    document.getElementById('l-store').value = store;
    document.getElementById('l-email').value = email;
    document.getElementById('l-pass').value = pass;
    document.getElementById('login-form').requestSubmit();
  });
});

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = document.getElementById('login-err');
  errEl.hidden = true;
  try {
    const store = document.getElementById('l-store').value.trim();
    const email = document.getElementById('l-email').value.trim();
    const password = document.getElementById('l-pass').value;
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ store: store || null, email, password }) });
    if (store) state.activeTenantSlug = store;
    await bootApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

document.getElementById('signup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = document.getElementById('signup-err');
  const okEl = document.getElementById('signup-msg');
  errEl.hidden = true; okEl.hidden = true;
  try {
    const res = await api('/api/tenants/signup', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('s-name').value.trim(),
        slug: document.getElementById('s-slug').value.trim(),
        email: document.getElementById('s-email').value.trim(),
        password: document.getElementById('s-pass').value,
        warehouse_name: document.getElementById('s-wh').value.trim(),
        city: document.getElementById('s-city').value.trim()
      })
    });
    okEl.textContent = res.message;
    okEl.hidden = false;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
});

document.querySelectorAll('#nav-tabs .nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#nav-tabs .nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.tab = btn.dataset.tab;
    renderTab();
  });
});

async function bootApp() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    if (me.tenant) {
      state.tenant = me.tenant;
      state.activeTenantSlug = me.tenant.slug;
    } else {
      const s = await api('/api/admin/store');
      state.tenant = s.tenant;
    }
  } catch {
    document.getElementById('auth-screen').hidden = false;
    document.getElementById('app-shell').hidden = true;
    return;
  }

  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app-shell').hidden = false;
  document.getElementById('hdr-title').textContent = `${state.tenant.name} — Back Office`;
  document.getElementById('hdr-badge').textContent = `${state.user.role.toUpperCase()} · ${state.tenant.slug}`;
  document.getElementById('open-shop-link').href = `/?store=${encodeURIComponent(state.tenant.slug)}`;

  const superNav = document.getElementById('nav-super');
  const superPicker = document.getElementById('super-tenant-picker');
  if (state.user.role === 'super') {
    superNav.hidden = false;
    superPicker.hidden = false;
    const { tenants } = await api('/api/super/tenants');
    superPicker.innerHTML = tenants.map(t => `<option value="${esc(t.slug)}" ${t.slug === state.activeTenantSlug ? 'selected' : ''}>${esc(t.name)} (${t.status})</option>`).join('');
    superPicker.onchange = async () => {
      state.activeTenantSlug = superPicker.value;
      const s = await api('/api/admin/store');
      state.tenant = s.tenant;
      document.getElementById('hdr-title').textContent = `${state.tenant.name} — Back Office`;
      document.getElementById('open-shop-link').href = `/?store=${encodeURIComponent(state.tenant.slug)}`;
      renderTab();
    };
  }
  renderTab();
}

async function renderTab() {
  const el = document.getElementById('tab-content');
  el.innerHTML = '<div class="card">Loading...</div>';
  try {
    if (state.tab === 'overview') return await renderOverview(el);
    if (state.tab === 'warehouses') return await renderWarehouses(el);
    if (state.tab === 'stock') return await renderStock(el);
    if (state.tab === 'products') return await renderProducts(el);
    if (state.tab === 'orders') return await renderOrders(el);
    if (state.tab === 'marketing') return await renderMarketing(el);
    if (state.tab === 'settings') return await renderSettings(el);
    if (state.tab === 'super') return await renderSuper(el);
  } catch (err) {
    el.innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
  }
}

async function renderOverview(el) {
  const [{ warehouses }, { products }, { orders }, { stock }] = await Promise.all([
    api('/api/admin/warehouses'),
    api('/api/admin/products'),
    api('/api/admin/orders'),
    api('/api/admin/stock')
  ]);
  const lowStock = stock.filter(s => s.qty - s.reserved <= s.reorder_point);
  const rev = orders.filter(o => o.payment_status === 'paid').reduce((s, o) => s + o.total_cents, 0);

  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Active Tenant</div><div class="kpi-val" style="font-size:18px">${esc(state.tenant.name)}</div></div>
      <div class="kpi"><div class="kpi-label">Warehouses</div><div class="kpi-val">${warehouses.filter(w => w.active).length}</div></div>
      <div class="kpi"><div class="kpi-label">Catalog Products</div><div class="kpi-val">${products.length}</div></div>
      <div class="kpi"><div class="kpi-label">Orders</div><div class="kpi-val">${orders.length}</div></div>
      <div class="kpi"><div class="kpi-label">Paid Revenue</div><div class="kpi-val">${esc(money(rev))}</div></div>
      <div class="kpi"><div class="kpi-label">Low Stock Alerts</div><div class="kpi-val" style="color:${lowStock.length ? '#b91c1c' : '#15803d'}">${lowStock.length}</div></div>
    </div>
    <div class="card">
      <h3>Multi-Warehouse Routing Strategy: <code>${esc(state.tenant.settings?.routing_strategy || 'nearest_single')}</code></h3>
      <p style="color:var(--muted)">Orders automatically select the nearest active warehouse with sufficient available stock (<code>qty - reserved</code>), reserve inventory atomically at checkout, and commit on payment.</p>
    </div>
    <div class="card">
      <h3>Low-Stock Alerts (Top 15)</h3>
      <table><thead><tr><th>Product</th><th>Warehouse</th><th>Qty</th><th>Reserved</th><th>Available</th></tr></thead><tbody>
        ${lowStock.slice(0, 15).map(s => `<tr><td>${esc(s.product_title)} (${esc(s.variant_title)})</td><td>${esc(s.warehouse_name)}</td><td>${s.qty}</td><td>${s.reserved}</td><td><strong>${s.qty - s.reserved}</strong></td></tr>`).join('') || '<tr><td colspan="5">All warehouses healthy!</td></tr>'}
      </tbody></table>
    </div>
  `;
}

async function renderWarehouses(el) {
  const [{ warehouses }, { products }] = await Promise.all([api('/api/admin/warehouses'), api('/api/admin/products')]);
  const variantOpts = products.flatMap(p => (p.variants || []).map(v => `<option value="${esc(v.id)}">${esc(p.title)} — ${esc(v.title)}</option>`)).join('');
  const whOpts = warehouses.filter(w => w.active).map(w => `<option value="${esc(w.id)}">${esc(w.name)} (${esc(w.code)})</option>`).join('');

  el.innerHTML = `
    <div class="card">
      <h2>Warehouses (${warehouses.length})</h2>
      <table><thead><tr><th>Code</th><th>Name</th><th>City</th><th>Coordinates</th><th>Priority</th><th>Pickup</th><th>Status</th></tr></thead><tbody>
        ${warehouses.map(w => `<tr><td><strong>${esc(w.code)}</strong></td><td>${esc(w.name)}<br><small>${esc(w.address)}</small></td><td>${esc(w.city)} ${esc(w.postal_code)}</td><td>${w.lat}, ${w.lng}</td><td>${w.priority}</td><td>${w.pickup_enabled ? 'Yes' : 'No'}</td><td><span class="badge ${w.active ? 'badge-ok' : ''}">${w.active ? 'Active' : 'Inactive'}</span></td></tr>`).join('')}
      </tbody></table>
    </div>

    <div class="grid-2">
      <div class="card">
        <h3>Add New Warehouse</h3>
        <form id="add-wh-form">
          <div class="grid-2">
            <div class="field"><label>Code *</label><input id="wh-code" placeholder="NYC-QNS" required></div>
            <div class="field"><label>Name *</label><input id="wh-name" placeholder="Queens Hub" required></div>
          </div>
          <div class="grid-2">
            <div class="field"><label>Address</label><input id="wh-addr" placeholder="100 Queens Blvd"></div>
            <div class="field"><label>City</label><input id="wh-city" placeholder="Queens"></div>
          </div>
          <div class="grid-3">
            <div class="field"><label>Lat</label><input id="wh-lat" type="number" step="0.0001" value="40.7282"></div>
            <div class="field"><label>Lng</label><input id="wh-lng" type="number" step="0.0001" value="-73.85"></div>
            <div class="field"><label>Priority</label><input id="wh-pri" type="number" value="5"></div>
          </div>
          <button type="submit" class="btn btn-primary">Create Warehouse</button>
        </form>
      </div>

      <div class="card">
        <h3>Atomic Inter-Warehouse Stock Transfer</h3>
        <form id="transfer-form">
          <div class="grid-2">
            <div class="field"><label>From Warehouse</label><select id="tr-from">${whOpts}</select></div>
            <div class="field"><label>To Warehouse</label><select id="tr-to">${whOpts}</select></div>
          </div>
          <div class="field"><label>Product Variant</label><select id="tr-var">${variantOpts}</select></div>
          <div class="grid-2">
            <div class="field"><label>Quantity</label><input id="tr-qty" type="number" min="1" value="5" required></div>
            <div class="field"><label>Note</label><input id="tr-note" placeholder="Rebalance stock"></div>
          </div>
          <div id="tr-msg"></div>
          <button type="submit" class="btn btn-primary">Transfer Stock</button>
        </form>
      </div>
    </div>
  `;

  document.getElementById('add-wh-form').onsubmit = async e => {
    e.preventDefault();
    await api('/api/admin/warehouses', {
      method: 'POST',
      body: JSON.stringify({
        code: document.getElementById('wh-code').value,
        name: document.getElementById('wh-name').value,
        address: document.getElementById('wh-addr').value,
        city: document.getElementById('wh-city').value,
        lat: Number(document.getElementById('wh-lat').value),
        lng: Number(document.getElementById('wh-lng').value),
        priority: Number(document.getElementById('wh-pri').value)
      })
    });
    renderTab();
  };

  document.getElementById('transfer-form').onsubmit = async e => {
    e.preventDefault();
    const msg = document.getElementById('tr-msg');
    msg.innerHTML = '';
    try {
      const r = await api('/api/admin/warehouses/transfer', {
        method: 'POST',
        body: JSON.stringify({
          from_warehouse_id: document.getElementById('tr-from').value,
          to_warehouse_id: document.getElementById('tr-to').value,
          variant_id: document.getElementById('tr-var').value,
          qty: Number(document.getElementById('tr-qty').value),
          note: document.getElementById('tr-note').value
        })
      });
      msg.innerHTML = `<div class="ok-box">Transferred ${r.transferred} units (${esc(r.from)} → ${esc(r.to)})</div>`;
    } catch (err) {
      msg.innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
    }
  };
}

async function renderStock(el) {
  const [{ stock }, { movements }] = await Promise.all([api('/api/admin/stock'), api('/api/admin/movements')]);
  el.innerHTML = `
    <div class="card">
      <h2>Warehouse Stock Matrix (First 60 rows)</h2>
      <table><thead><tr><th>Product</th><th>Warehouse</th><th>On Hand</th><th>Reserved</th><th>Available</th><th>Update Qty</th></tr></thead><tbody>
        ${stock.slice(0, 60).map(s => `
          <tr>
            <td>${esc(s.product_title)}<br><small>${esc(s.variant_title)}</small></td>
            <td>${esc(s.warehouse_code)} — ${esc(s.warehouse_name)}</td>
            <td>${s.qty}</td>
            <td>${s.reserved}</td>
            <td><strong>${s.qty - s.reserved}</strong></td>
            <td style="display:flex;gap:6px">
              <input type="number" min="0" value="${s.qty}" id="sq-${esc(s.warehouse_id)}-${esc(s.variant_id)}" style="width:70px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:6px">
              <button class="btn btn-sm" data-save-stock="${esc(s.warehouse_id)}|${esc(s.variant_id)}">Save</button>
            </td>
          </tr>`).join('')}
      </tbody></table>
    </div>
    <div class="card">
      <h3>Recent Stock Movements Audit Log</h3>
      <table><thead><tr><th>Time</th><th>Type</th><th>Warehouse</th><th>Item</th><th>Delta</th><th>Note</th></tr></thead><tbody>
        ${movements.slice(0, 30).map(m => `<tr><td><small>${esc(m.created_at.slice(0,19).replace('T',' '))}</small></td><td><code>${esc(m.type)}</code></td><td>${esc(m.warehouse_code)}</td><td>${esc(m.product_title)}</td><td><strong>${m.delta_qty > 0 ? '+' + m.delta_qty : m.delta_qty}</strong></td><td>${esc(m.note)}</td></tr>`).join('') || '<tr><td colspan="6">No movements recorded yet.</td></tr>'}
      </tbody></table>
    </div>
  `;

  el.querySelectorAll('[data-save-stock]').forEach(btn => {
    btn.onclick = async () => {
      const [whId, varId] = btn.dataset.saveStock.split('|');
      const qty = Number(document.getElementById(`sq-${whId}-${varId}`).value);
      await api('/api/admin/stock', { method: 'PUT', body: JSON.stringify({ warehouse_id: whId, variant_id: varId, qty }) });
      renderTab();
    };
  });
}

async function renderProducts(el) {
  const { products } = await api('/api/admin/products');
  el.innerHTML = `
    <div class="card">
      <h3>Create New Product</h3>
      <form id="new-prod-form" class="grid-3">
        <div class="field"><label>Title *</label><input id="p-title" required placeholder="Artisan Sourdough Loaf"></div>
        <div class="field"><label>Category</label><input id="p-cat" value="Bread & Cake"></div>
        <div class="field"><label>Price (cents)</label><input id="p-price" type="number" value="850"></div>
        <div class="field"><label>Initial Stock / Warehouse</label><input id="p-qty" type="number" value="25"></div>
        <div class="field"><label>Image URL</label><input id="p-img" value="/cdn/shop/files/trove-logo.jpg"></div>
        <div class="field" style="justify-content:flex-end"><button type="submit" class="btn btn-primary">Add Product</button></div>
      </form>
    </div>
    <div class="card">
      <h2>Catalog (${products.length} products)</h2>
      <table><thead><tr><th>Title</th><th>Category</th><th>Price</th><th>Total Avail</th><th>Per-Warehouse</th></tr></thead><tbody>
        ${products.slice(0, 60).map(p => {
          const v = p.variants?.[0];
          const whSummary = (v?.warehouse_stock || []).map(w => `${w.warehouse_code}:${w.available}`).join(' · ');
          return `<tr><td><a href="/products/${esc(p.handle)}?store=${esc(state.activeTenantSlug)}" target="_blank">${esc(p.title)}</a></td><td>${esc(p.category)}</td><td>${esc(money(p.min_price_cents))}</td><td><strong>${p.total_available}</strong></td><td><small>${esc(whSummary)}</small></td></tr>`;
        }).join('')}
      </tbody></table>
    </div>
  `;
  document.getElementById('new-prod-form').onsubmit = async e => {
    e.preventDefault();
    await api('/api/admin/products', {
      method: 'POST',
      body: JSON.stringify({
        title: document.getElementById('p-title').value,
        category: document.getElementById('p-cat').value,
        price_cents: Number(document.getElementById('p-price').value),
        initial_qty: Number(document.getElementById('p-qty').value),
        image: document.getElementById('p-img').value
      })
    });
    renderTab();
  };
}

async function renderOrders(el) {
  const { orders } = await api('/api/admin/orders');
  el.innerHTML = `
    <div class="card">
      <h2>Orders & Warehouse Fulfillment (${orders.length})</h2>
      <table><thead><tr><th>Order No</th><th>Customer</th><th>Warehouse</th><th>Type</th><th>Total</th><th>Status / Payment</th><th>Actions</th></tr></thead><tbody>
        ${orders.map(o => `
          <tr>
            <td><strong>${esc(o.order_no)}</strong><br><small>${esc(o.created_at.slice(0,16).replace('T',' '))}</small></td>
            <td>${esc(o.customer_name)}<br><small>${esc(o.customer_phone)}</small></td>
            <td>${esc(o.warehouse_name || o.warehouse_id)} (${esc(o.warehouse_code || '')})${o.distance_km != null ? `<br><small>${o.distance_km} km</small>` : ''}</td>
            <td>${esc(o.fulfillment_type)}</td>
            <td><strong>${esc(money(o.total_cents))}</strong></td>
            <td><span class="badge ${o.payment_status === 'paid' ? 'badge-ok' : 'badge-warn'}">${esc(o.status)} / ${esc(o.payment_status)}</span></td>
            <td style="display:flex;gap:4px;flex-wrap:wrap">
              ${o.payment_status === 'unpaid' && o.status === 'pending' ? `<button class="btn btn-sm" data-ord="${esc(o.order_no)}" data-st="paid">Mark Paid</button>` : ''}
              ${o.status === 'paid' ? `<button class="btn btn-sm" data-ord="${esc(o.order_no)}" data-st="packing">Pack</button>` : ''}
              ${o.status === 'packing' ? `<button class="btn btn-sm" data-ord="${esc(o.order_no)}" data-st="shipped">Ship</button>` : ''}
              ${o.status === 'shipped' ? `<button class="btn btn-sm" data-ord="${esc(o.order_no)}" data-st="delivered">Deliver</button>` : ''}
              ${o.status === 'pending' ? `<button class="btn btn-sm" data-ord="${esc(o.order_no)}" data-st="cancelled">Cancel</button>` : ''}
            </td>
          </tr>`).join('') || '<tr><td colspan="7">No orders yet. Place one from the storefront!</td></tr>'}
      </tbody></table>
    </div>
  `;
  el.querySelectorAll('[data-ord]').forEach(btn => {
    btn.onclick = async () => {
      await api(`/api/admin/orders/${encodeURIComponent(btn.dataset.ord)}/status`, { method: 'POST', body: JSON.stringify({ status: btn.dataset.st }) });
      renderTab();
    };
  });
}

async function renderMarketing(el) {
  const [{ zones }, { coupons }] = await Promise.all([api('/api/admin/zones'), api('/api/admin/coupons')]);
  el.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <h3>Courier Zones</h3>
        <table><thead><tr><th>Name</th><th>Max km</th><th>Fee</th><th>ETA</th></tr></thead><tbody>
          ${zones.map(z => `<tr><td>${esc(z.name)}</td><td>${z.max_km} km</td><td>${esc(money(z.fee_cents))}</td><td>${esc(z.eta)}</td></tr>`).join('')}
        </tbody></table>
        <form id="add-zone-form" class="grid-2" style="margin-top:12px">
          <input id="zn-name" placeholder="Zone name" required style="padding:8px;border:1px solid #cbd5e1;border-radius:8px">
          <input id="zn-km" type="number" placeholder="Max km" value="40" style="padding:8px;border:1px solid #cbd5e1;border-radius:8px">
          <input id="zn-fee" type="number" placeholder="Fee cents" value="1200" style="padding:8px;border:1px solid #cbd5e1;border-radius:8px">
          <button type="submit" class="btn btn-primary">Add Zone</button>
        </form>
      </div>
      <div class="card">
        <h3>Coupons</h3>
        <table><thead><tr><th>Code</th><th>Type</th><th>Value</th><th>Min</th><th>Used</th></tr></thead><tbody>
          ${coupons.map(c => `<tr><td><strong>${esc(c.code)}</strong></td><td>${c.type}</td><td>${c.type === 'pct' ? c.value + '%' : money(c.value)}</td><td>${esc(money(c.min_purchase_cents))}</td><td>${c.used_count}</td></tr>`).join('')}
        </tbody></table>
        <form id="add-cpn-form" class="grid-2" style="margin-top:12px">
          <input id="cp-code" placeholder="CODE20" required style="padding:8px;border:1px solid #cbd5e1;border-radius:8px">
          <select id="cp-type" style="padding:8px;border:1px solid #cbd5e1;border-radius:8px"><option value="pct">Percent %</option><option value="amt">Fixed Cents</option></select>
          <input id="cp-val" type="number" value="20" style="padding:8px;border:1px solid #cbd5e1;border-radius:8px">
          <button type="submit" class="btn btn-primary">Add Coupon</button>
        </form>
      </div>
    </div>
  `;
  document.getElementById('add-zone-form').onsubmit = async e => {
    e.preventDefault();
    await api('/api/admin/zones', { method: 'POST', body: JSON.stringify({ name: document.getElementById('zn-name').value, max_km: Number(document.getElementById('zn-km').value), fee_cents: Number(document.getElementById('zn-fee').value) }) });
    renderTab();
  };
  document.getElementById('add-cpn-form').onsubmit = async e => {
    e.preventDefault();
    await api('/api/admin/coupons', { method: 'POST', body: JSON.stringify({ code: document.getElementById('cp-code').value, type: document.getElementById('cp-type').value, value: Number(document.getElementById('cp-val').value) }) });
    renderTab();
  };
}

async function renderSettings(el) {
  const { tenant } = await api('/api/admin/store');
  state.tenant = tenant;
  const tc = tenant.theme_config || {};
  const st = tenant.settings || {};
  el.innerHTML = `
    <div class="card">
      <h2>Store Theme & Multi-Warehouse Routing Settings</h2>
      <form id="settings-form">
        <div class="grid-2">
          <div class="field"><label>Store Name</label><input id="st-name" value="${esc(tenant.name)}"></div>
          <div class="field"><label>Warehouse Routing Strategy</label>
            <select id="st-route">
              <option value="nearest_single" ${st.routing_strategy === 'nearest_single' ? 'selected' : ''}>Nearest Single Warehouse (fulfills entire order)</option>
              <option value="priority" ${st.routing_strategy === 'priority' ? 'selected' : ''}>Warehouse Priority Order</option>
              <option value="split_nearest" ${st.routing_strategy === 'split_nearest' ? 'selected' : ''}>Split Shipment Across Nearest Warehouses</option>
            </select>
          </div>
          <div class="field"><label>Primary Color</label><input id="st-pri" type="color" value="${esc(tc.primary || '#cb321e')}"></div>
          <div class="field"><label>Accent Color</label><input id="st-acc" type="color" value="${esc(tc.accent || '#fec61f')}"></div>
        </div>
        <div class="field"><label>Announcement Banner</label><input id="st-ann" value="${esc(tc.announcement || '')}"></div>
        <div class="field"><label>Free Shipping Threshold (cents)</label><input id="st-free" type="number" value="${Number(st.free_shipping_cents || 0)}"></div>
        <div id="st-msg"></div>
        <button type="submit" class="btn btn-primary">Save Store Settings</button>
      </form>
    </div>
  `;
  document.getElementById('settings-form').onsubmit = async e => {
    e.preventDefault();
    const res = await api('/api/admin/store', {
      method: 'PUT',
      body: JSON.stringify({
        name: document.getElementById('st-name').value,
        theme_config: { primary: document.getElementById('st-pri').value, accent: document.getElementById('st-acc').value, announcement: document.getElementById('st-ann').value },
        settings: { routing_strategy: document.getElementById('st-route').value, free_shipping_cents: Number(document.getElementById('st-free').value) }
      })
    });
    state.tenant = res.tenant;
    document.getElementById('st-msg').innerHTML = '<div class="ok-box">Store settings saved!</div>';
  };
}

async function renderSuper(el) {
  const { tenants } = await api('/api/super/tenants');
  el.innerHTML = `
    <div class="card">
      <h2>Platform Tenants (${tenants.length})</h2>
      <table><thead><tr><th>Slug</th><th>Name</th><th>Status</th><th>Warehouses</th><th>Products</th><th>Orders</th><th>Actions</th></tr></thead><tbody>
        ${tenants.map(t => `
          <tr>
            <td><code>${esc(t.slug)}</code></td>
            <td>${esc(t.name)}</td>
            <td><span class="badge ${t.status === 'active' ? 'badge-ok' : 'badge-warn'}">${esc(t.status)}</span></td>
            <td>${t.stats.warehouses}</td>
            <td>${t.stats.products}</td>
            <td>${t.stats.orders}</td>
            <td style="display:flex;gap:6px">
              ${t.status !== 'active' ? `<button class="btn btn-sm" data-tid="${esc(t.id)}" data-tstat="active">Approve</button>` : ''}
              ${t.status === 'active' ? `<button class="btn btn-sm" data-tid="${esc(t.id)}" data-tstat="suspended">Suspend</button>` : ''}
            </td>
          </tr>`).join('')}
      </tbody></table>
    </div>
  `;
  el.querySelectorAll('[data-tid]').forEach(btn => {
    btn.onclick = async () => {
      await api(`/api/super/tenants/${encodeURIComponent(btn.dataset.tid)}/status`, { method: 'POST', body: JSON.stringify({ status: btn.dataset.tstat }) });
      renderTab();
    };
  });
}

bootApp();
