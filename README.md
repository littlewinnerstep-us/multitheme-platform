# Hyper — Trove Preset (Shopify Theme Clone)

Local offline-ready static clone of the **Hyper (Trove preset)** food & grocery e-commerce theme from the Shopify Theme Store (`https://hyper-trove.myshopify.com/`).

## Quick Start (Local Server & Mobile/Desktop Preview)

Run a local HTTP server from this directory:

```bash
cd ~/hyper-trove-clone
python3 -m http.server 8080
```

- **Main Homepage**: `http://localhost:8080/`
- **Mobile + Desktop Split Preview Studio**: `http://localhost:8080/preview.html`

## Cloned Structure

- `index.html` — Homepage with all 23 Shopify sections (Announcement Bar, Sticky Header + Mega Menu, Category Banners, Featured Collections, Flash Sale Countdown Timer, Bundle Builder, Favorite Products, FAQ Collapsible Tabs, Newsletter, Cart Drawer, Quick View, Compare Drawer)
- `preview.html` — Interactive Mobile (`375×780`, `390×844`), Tablet (`768×900`), and Desktop (`1280×780`, `1440px`) side-by-side responsive preview tool
- `collections/` — Category & collection pages (`all`, `vegetables-fruits`, `meat-seafood`, `bread-cake`, `dairy-egg`, `beverages`, `on-sale`, `new-arrivals`)
- `products/` — Sample product detail pages (`premium-beef-short-ribs-bone-in-2-lb`, `bright-fresh-strawberry-clusters-1-lb`, `handcrafted-classic-french-croissants`, `smooth-buttery-avocado`, `almond-strawberry-milk-unsweet-vanilla-96-fl-oz-bottle`)
- `pages/` — Storefront pages (`about-us`, `contact-us`, `faqs`, `find-a-store`, `customer-care`)
- `blogs/news/` — Blog listing page
- `cart/` — Shopping cart page
- `cdn/` — All 524 local static assets (40 CSS files, 23 JS bundles, 16 Roboto/WOFF2/WOFF fonts, and 445 product/banner images)

## Responsive Breakpoints (Scanned)

| Breakpoint | Target Viewports | Rule Count | Key Layout Changes |
| :--- | :--- | :--- | :--- |
| `@media (max-width: 639.98px)` | Small Mobile | 12 | Single-column cards, compact hero typography, condensed spacing |
| `@media (max-width: 767.98px)` | Mobile Devices | 114 | Hamburger trigger (`<menu-drawer id="MenuDrawer">`), swipeable carousels, stacked banners |
| `@media (min-width: 768px)` | Tablet & Up | 73 | Multi-column product grids, horizontal category pills, expanded footer columns |
| `@media (min-width: 1024px)` | Desktop | 32 | Full horizontal mega-menu, sticky header controls, hover quick-actions (`@media (hover: hover)`) |
| `@media (min-width: 1280px)` | Widescreen Desktop | 17 | Maximum container width (`1440px`), 5–6 column product grids, side-by-side bundle builder |
