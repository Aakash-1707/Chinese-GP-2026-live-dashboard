// ============================================================
// DATA LAYER
// ============================================================
// ----- Supabase + EmailJS: add keys from dashboard (see SETUP_EMAIL_SUPABASE.txt) -----
const RRM_SUPABASE_URL = 'https://ilxjsxinpxvifwtfqabc.supabase.co';
const RRM_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlseGpzeGlucHh2aWZ3dGZxYWJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyODg5NDksImV4cCI6MjA4OTg2NDk0OX0.2DUG3rdpSTtUORus-jBNWIiclnKj0RZNNVMzmJQsHHs';
const EMAILJS_PUBLIC_KEY = 'E5HSiaNg7K6cV6zFs';
const EMAILJS_SERVICE_ID = 'service_79h6rxt';
const EMAILJS_TEMPLATE_ORDER = 'template_oi72fpv';
/** Customer confirmation — EmailJS; set To Email to {{to_email}} */
const EMAILJS_TEMPLATE_ORDER_CONFIRM = 'template_m9wxdp8';
const EMAILJS_TEMPLATE_CONTACT = '';
/** Optional: EmailJS template id — merchant alert when order reduces inventory (set in dashboard; leave '' to skip). */
const EMAILJS_TEMPLATE_STOCK_ALERT = '';
const MERCHANT_NOTIFY_EMAIL = 'preservingmemories2022@gmail.com';
const MIN_ORDER_AMOUNT_RS = 200;
const PRODUCT_IMAGE_BUCKET = 'product-images';
const PRODUCT_IMAGE_MAX_BYTES = 1024 * 1024; // 1 MB

let sbClient = null;
let authSession = null;
let catalogFromRemote = false;
let productsCache = [];
let ordersCache = [];
let contactMessageCache = [];
let pendingProductImageFile = null;
let categoryImageOverrides = null;
let categoriesCache = [];
let categoriesFromRemote = false;

function getSb() {
  const u = (RRM_SUPABASE_URL || '').trim();
  const k = (RRM_SUPABASE_ANON_KEY || '').trim();
  if (!u || !k || typeof window.supabase === 'undefined') return null;
  if (!sbClient) sbClient = window.supabase.createClient(u, k);
  return sbClient;
}

function adminRemoteSession() {
  return !!(getSb() && authSession && authSession.user);
}

async function syncAuth() {
  const sb = getSb();
  if (!sb) return;
  const { data } = await sb.auth.getSession();
  authSession = data.session;
  sb.auth.onAuthStateChange(function (_evt, s) {
    authSession = s;
  });
}

function parseVariantsFromRow(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return normalizeVariantsArray(raw);
  if (typeof raw === 'string') {
    try {
      return normalizeVariantsArray(JSON.parse(raw));
    } catch (_e) {
      return [];
    }
  }
  return [];
}

function normalizeVariantsArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(function (v) {
      const label = v && v.label != null ? String(v.label).trim() : '';
      const price = Number(v && v.price);
      const stockQty = Number.isFinite(Number(v && v.stockQty)) ? Math.max(0, Math.floor(Number(v.stockQty))) : 0;
      const wRaw = v && v.weightKg != null && v.weightKg !== '' ? Number(v.weightKg) : NaN;
      const weightKg = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : null;
      const exRaw = v && v.extraShippingRs != null && v.extraShippingRs !== '' ? Number(v.extraShippingRs) : NaN;
      const vx = Number.isFinite(exRaw) && exRaw > 0 ? Math.round(exRaw * 100) / 100 : 0;
      const pr = Number.isFinite(price) ? Math.round(price * 100) / 100 : 0;
      return { label: label, price: pr, stockQty: stockQty, weightKg: weightKg, extraShippingRs: vx };
    })
    .filter(function (v) {
      return v.label && Number.isFinite(v.price) && v.price >= 0;
    });
}

function hasVariants(p) {
  return !!(p && Array.isArray(p.variants) && p.variants.length);
}

function findVariantByLabel(p, label) {
  const lab = String(label || '').trim();
  if (!hasVariants(p) || !lab) return null;
  return (
    p.variants.find(function (v) {
      return String(v.label).trim() === lab;
    }) || null
  );
}

function syncVariantAggregateFields(p) {
  if (!p || !hasVariants(p)) return;
  const prices = p.variants
    .map(function (v) {
      return Number(v.price);
    })
    .filter(function (x) {
      return Number.isFinite(x);
    });
  if (prices.length) p.price = Math.min.apply(null, prices);
  p.stockQty = p.variants.reduce(function (s, v) {
    return s + (Number(v.stockQty) || 0);
  }, 0);
  p.inStock = p.variants.some(function (v) {
    return (Number(v.stockQty) || 0) > 0;
  });
}

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function parseExtraCategoriesFromRow(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) {
    return raw
      .map(function (x) {
        return String(x == null ? '' : x).trim();
      })
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) return parseExtraCategoriesFromRow(j);
    } catch (_e) {}
    return raw
      .split(/[,;]/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }
  return [];
}

function rowToProduct(r) {
  const em = {
    Resin: '🧴',
    Molds: '🔷',
    Pigments: '🎨',
    Tools: '🔧',
    Accessories: '✨',
    'UV Resin': '💡',
    'Glitter & Embellishments': '✨'
  };
  const w = r.weight_kg != null && r.weight_kg !== '' ? Number(r.weight_kg) : NaN;
  const stockQtyRaw = r.stock_qty != null && r.stock_qty !== '' ? Number(r.stock_qty) : NaN;
  const stockQty = Number.isFinite(stockQtyRaw) ? Math.max(0, Math.floor(stockQtyRaw)) : (r.in_stock ? 1 : 0);
  const compareRaw = r.compare_at_price != null && r.compare_at_price !== '' ? Number(r.compare_at_price) : NaN;
  const compareAt = Number.isFinite(compareRaw) && compareRaw > 0 ? compareRaw : null;
  const exShipRaw = r.extra_shipping_rs != null && r.extra_shipping_rs !== '' ? Number(r.extra_shipping_rs) : NaN;
  const extraShippingRs = Number.isFinite(exShipRaw) && exShipRaw >= 0 ? exShipRaw : 0;
  const variants = parseVariantsFromRow(r.variants);
  const extraCategories = parseExtraCategoriesFromRow(r.extra_categories);
  const featRaw = r.is_featured;
  const featured =
    featRaw === true ||
    featRaw === 'true' ||
    featRaw === 1 ||
    featRaw === '1' ||
    featRaw === 't';
  const p = {
    id: r.id,
    name: r.name,
    category: r.category,
    price: Number(r.price),
    desc: r.description || '',
    img: r.image || '',
    emoji: em[r.category] || '📦',
    inStock: stockQty > 0,
    stockQty: stockQty,
    compareAtPrice: compareAt,
    weightKg: isFinite(w) && w > 0 ? w : 0.5,
    extraShippingRs: extraShippingRs,
    variants: variants,
    extraCategories: extraCategories,
    featured: featured
  };
  syncVariantAggregateFields(p);
  return p;
}

function productToRow(p) {
  const w = p.weightKg != null ? Number(p.weightKg) : 0.5;
  const stockQty = Number.isFinite(Number(p.stockQty)) ? Math.max(0, Math.floor(Number(p.stockQty))) : 0;
  const compareRaw = p.compareAtPrice != null && p.compareAtPrice !== '' ? Number(p.compareAtPrice) : NaN;
  const compareAt = Number.isFinite(compareRaw) && compareRaw > 0 ? compareRaw : null;
  let img = p.img && String(p.img).trim() ? String(p.img).trim() : null;
  if (img && img.length > 120000) {
    img = null;
  }
  return {
    id: String(p.id),
    name: p.name,
    category: p.category,
    price: Number(p.price),
    in_stock: stockQty > 0,
    stock_qty: stockQty,
    description: p.desc != null ? String(p.desc) : '',
    image: img,
    compare_at_price: compareAt,
    weight_kg: isFinite(w) && w > 0 ? w : 0.5,
    extra_shipping_rs: p.extraShippingRs != null && Number.isFinite(Number(p.extraShippingRs)) && Number(p.extraShippingRs) > 0
      ? Number(p.extraShippingRs)
      : 0,
    extra_categories: Array.isArray(p.extraCategories) ? p.extraCategories : [],
    variants: hasVariants(p) ? p.variants : [],
    is_featured: !!p.featured
  };
}

function productInStock(p) {
  if (!p) return false;
  if (hasVariants(p)) {
    return p.variants.some(function (v) {
      return (Number(v.stockQty) || 0) > 0;
    });
  }
  return (Number(p.stockQty) || 0) > 0;
}

function effectiveUnitPriceForCartLine(p, variantLabel) {
  if (hasVariants(p)) {
    const v = findVariantByLabel(p, variantLabel);
    return v ? Number(v.price) : productSalePrice(p);
  }
  return productSalePrice(p);
}

function maxQtyForCartLine(p, variantLabel) {
  if (hasVariants(p)) {
    const v = findVariantByLabel(p, variantLabel);
    return v ? Math.max(0, Math.floor(Number(v.stockQty) || 0)) : 0;
  }
  return Math.max(0, Math.floor(Number(p.stockQty) || 0));
}

function lineWeightKgForCart(p, variantLabel) {
  const def = productWeightKg(p);
  if (hasVariants(p) && String(variantLabel || '').trim()) {
    const v = findVariantByLabel(p, variantLabel);
    if (v && v.weightKg != null && Number.isFinite(Number(v.weightKg)) && Number(v.weightKg) > 0) {
      return Number(v.weightKg);
    }
  }
  return def;
}

function lineExtraShippingPerUnit(p, variantLabel) {
  const base = Number(p.extraShippingRs);
  const baseEx = Number.isFinite(base) && base > 0 ? base : 0;
  if (hasVariants(p) && String(variantLabel || '').trim()) {
    const v = findVariantByLabel(p, variantLabel);
    const vx = v && Number(v.extraShippingRs);
    const vEx = Number.isFinite(vx) && vx > 0 ? vx : 0;
    return baseEx + vEx;
  }
  return baseEx;
}

/** Extra on top of weight-based shipping: single largest line extra (per-unit × qty), not a sum across lines. */
function cartExtraShippingRs(cart, products) {
  let maxLineExtra = 0;
  cart.forEach(function (item) {
    const p = products.find(function (x) {
      return x.id === item.id;
    });
    if (!p) return;
    const vl = item.variantLabel != null ? String(item.variantLabel).trim() : '';
    const perUnit = lineExtraShippingPerUnit(p, vl);
    const q = Math.max(0, Math.floor(Number(item.qty) || 0));
    const lineExtra = perUnit * q;
    if (lineExtra > maxLineExtra) maxLineExtra = lineExtra;
  });
  return maxLineExtra;
}

const RRM_COUPON_SESSION = 'rrm_checkout_coupon';
const RRM_COUPONS_LOCAL_KEY = 'rrm_coupons_local';
const RRM_COUPON_USES_LOCAL_KEY = 'rrm_coupon_uses_local';
const RRM_INSTORE_SALES_LOCAL_KEY = 'rrm_instore_sales';

function parseExcludedProductIds(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) {
    return raw
      .map(function (x) {
        return String(x == null ? '' : x).trim();
      })
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) return parseExcludedProductIds(j);
    } catch (_e) {}
  }
  return [];
}

function getAppliedCouponSnapshot() {
  try {
    const raw = sessionStorage.getItem(RRM_COUPON_SESSION);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.code || !o.kind) return null;
    const mdr = o.maxDiscountRs != null ? Number(o.maxDiscountRs) : null;
    return {
      code: String(o.code).toUpperCase(),
      kind: o.kind === 'fixed' ? 'fixed' : 'percent',
      amount: Number(o.amount),
      minSubtotal: Number(o.minSubtotal) || 0,
      maxDiscountRs: Number.isFinite(mdr) && mdr > 0 ? mdr : null,
      excludedProductIds: parseExcludedProductIds(o.excludedProductIds)
    };
  } catch (_e) {
    return null;
  }
}

function setAppliedCouponSnapshot(c) {
  if (!c) {
    sessionStorage.removeItem(RRM_COUPON_SESSION);
    return;
  }
  sessionStorage.setItem(RRM_COUPON_SESSION, JSON.stringify(c));
}

/** Subtotal of cart lines whose product id is not in the coupon exclude list. */
function cartSubtotalEligibleForCoupon(cart, products, excludedIds) {
  const ex = new Set(parseExcludedProductIds(excludedIds));
  let sum = 0;
  cart.forEach(function (item) {
    if (ex.has(String(item.id))) return;
    const p = products.find(function (x) {
      return x.id === item.id;
    });
    if (p) {
      const vl = item.variantLabel != null ? String(item.variantLabel).trim() : '';
      sum += effectiveUnitPriceForCartLine(p, vl) * item.qty;
    }
  });
  return sum;
}

function computeCouponDiscountRs(eligibleMerchSubtotal, snap) {
  const sub = Number(eligibleMerchSubtotal);
  if (!snap || !Number.isFinite(sub) || sub <= 0) return 0;
  if (sub < (snap.minSubtotal || 0)) return 0;
  const cap =
    snap.maxDiscountRs != null && Number.isFinite(Number(snap.maxDiscountRs)) && Number(snap.maxDiscountRs) > 0
      ? roundPrice(Number(snap.maxDiscountRs))
      : null;
  if (snap.kind === 'percent') {
    const pct = Math.min(95, Math.max(0, Number(snap.amount)));
    let d = roundPrice((sub * pct) / 100);
    d = Math.min(sub, d);
    if (cap != null) d = Math.min(d, cap);
    return d;
  }
  if (snap.kind === 'fixed') {
    const f = Math.max(0, Number(snap.amount));
    let d = Math.min(sub, roundPrice(f));
    if (cap != null) d = Math.min(d, cap);
    return d;
  }
  return 0;
}

function readLocalCouponsList() {
  try {
    const raw = localStorage.getItem(RRM_COUPONS_LOCAL_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

function writeLocalCouponsList(arr) {
  try {
    localStorage.setItem(RRM_COUPONS_LOCAL_KEY, JSON.stringify(arr || []));
  } catch (_e) {}
}

function readLocalCouponUsesMap() {
  try {
    const raw = localStorage.getItem(RRM_COUPON_USES_LOCAL_KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (_e) {
    return {};
  }
}

function writeLocalCouponUsesMap(map) {
  try {
    localStorage.setItem(RRM_COUPON_USES_LOCAL_KEY, JSON.stringify(map || {}));
  } catch (_e) {}
}

function getLocalCouponUseCount(normCode) {
  const m = readLocalCouponUsesMap();
  const n = Number(m[String(normCode || '').trim().toUpperCase()]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function recordLocalCouponUse(normCode) {
  const c = String(normCode || '')
    .trim()
    .toUpperCase();
  if (!c) return;
  const m = readLocalCouponUsesMap();
  m[c] = (Number(m[c]) || 0) + 1;
  writeLocalCouponUsesMap(m);
}

async function lookupCouponDefinition(code) {
  const norm = String(code || '')
    .trim()
    .toUpperCase();
  if (!norm) return null;
  const sb = getSb();
  if (sb) {
    const r = await sb.rpc('validate_store_coupon', { p_code: norm });
    if (!r.error && r.data && r.data.length) {
      const row = r.data[0];
      const mdr = row.max_discount_rs != null ? Number(row.max_discount_rs) : null;
      return {
        code: norm,
        kind: row.kind === 'fixed' ? 'fixed' : 'percent',
        amount: Number(row.amount),
        minSubtotal: Number(row.min_subtotal) || 0,
        maxDiscountRs: Number.isFinite(mdr) && mdr > 0 ? mdr : null,
        excludedProductIds: parseExcludedProductIds(row.excluded_product_ids)
      };
    }
  }
  const local = readLocalCouponsList();
  const hit = local.find(function (c) {
    return String(c.code || '')
      .trim()
      .toUpperCase() === norm && c.active !== false;
  });
  if (!hit) return null;
  const maxUses =
    hit.max_uses != null ? Number(hit.max_uses) : hit.maxUses != null ? Number(hit.maxUses) : null;
  if (Number.isFinite(maxUses) && maxUses > 0 && getLocalCouponUseCount(norm) >= maxUses) {
    return null;
  }
  const mdrLocal =
    hit.max_discount_rs != null ? Number(hit.max_discount_rs) : hit.maxDiscountRs != null ? Number(hit.maxDiscountRs) : null;
  return {
    code: norm,
    kind: hit.kind === 'fixed' ? 'fixed' : 'percent',
    amount: Number(hit.amount),
    minSubtotal: Number(hit.min_subtotal) || Number(hit.minSubtotal) || 0,
    maxDiscountRs: Number.isFinite(mdrLocal) && mdrLocal > 0 ? mdrLocal : null,
    excludedProductIds: parseExcludedProductIds(hit.excluded_product_ids || hit.excludedProductIds)
  };
}

async function applyCheckoutCoupon() {
  const input = document.getElementById('co-coupon-input');
  const raw = input ? String(input.value || '').trim() : '';
  if (!raw) {
    showToast('Enter a coupon code.');
    return;
  }
  const def = await lookupCouponDefinition(raw);
  if (!def) {
    showToast('Invalid or inactive coupon.');
    return;
  }
  const cart = getCart();
  const products = getProducts();
  const elig = cartSubtotalEligibleForCoupon(cart, products, def.excludedProductIds);
  if (cart.length > 0 && elig <= 0) {
    showToast('This coupon does not apply to the products in your cart.');
    return;
  }
  setAppliedCouponSnapshot(def);
  showToast('Coupon applied.');
  refreshCheckoutTotals();
}

function clearCheckoutCoupon() {
  setAppliedCouponSnapshot(null);
  const input = document.getElementById('co-coupon-input');
  if (input) input.value = '';
  refreshCheckoutTotals();
}

/** Merch subtotal, coupon discount, shipping = weight-based rate + largest line extra (per-unit×qty per line, then max). */
function computeCheckoutMoney(cart, products, stateVal, couponSnap) {
  let subtotal = 0;
  cart.forEach(function (item) {
    const p = products.find(function (x) {
      return x.id === item.id;
    });
    if (p) {
      const vl = item.variantLabel != null ? String(item.variantLabel).trim() : '';
      subtotal += effectiveUnitPriceForCartLine(p, vl) * item.qty;
    }
  });
  const weightKg = cartTotalWeightKg(cart, products);
  const inTN = isTamilNaduState(stateVal);
  const baseShip = shippingForWeightKg(weightKg, inTN).shipping;
  const extraShip = cartExtraShippingRs(cart, products);
  const shipping = baseShip + extraShip;
  const eligibleSub = cartSubtotalEligibleForCoupon(cart, products, couponSnap ? couponSnap.excludedProductIds : []);
  const discount = computeCouponDiscountRs(eligibleSub, couponSnap);
  const afterDiscount = Math.max(0, roundPrice(subtotal - discount));
  const total = roundPrice(afterDiscount + shipping);
  return {
    subtotal: subtotal,
    discount: discount,
    afterDiscount: afterDiscount,
    weightKg: weightKg,
    shipping: shipping,
    shippingBase: baseShip,
    shippingExtra: extraShip,
    total: total,
    inTN: inTN
  };
}

const ORDER_ID_PREFIX = 'PM-';
const ORDER_ID_START = 3190;

/** Max numeric segment among PM-* ids from local list + optional server max (avoids duplicate orders_pkey across devices). */
function computeNextOrderId(remoteMaxNum) {
  let maxNum = ORDER_ID_START - 1;
  const re = /^PM-(\d+)$/i;
  function consider(id) {
    const m = String(id || '').match(re);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  }
  JSON.parse(localStorage.getItem('rrm_orders') || '[]').forEach(function (o) {
    consider(o.id);
  });
  if (ordersCache && ordersCache.length) {
    ordersCache.forEach(function (o) {
      consider(o.id);
    });
  }
  if (remoteMaxNum != null && Number.isFinite(remoteMaxNum)) {
    maxNum = Math.max(maxNum, Math.floor(remoteMaxNum));
  }
  const next = Math.max(ORDER_ID_START, maxNum + 1);
  return ORDER_ID_PREFIX + next;
}

function nextSiteOrderId() {
  return computeNextOrderId(null);
}

/** Largest PM-* number in Supabase (RPC works for anonymous checkout; RLS blocks anon `select` on orders). */
async function fetchMaxPmOrderNumberFromSupabase(sb) {
  if (!sb) return null;
  const rpc = await sb.rpc('max_pm_order_number');
  if (!rpc.error && rpc.data !== null && rpc.data !== undefined) {
    const n = typeof rpc.data === 'number' ? rpc.data : Number(rpc.data);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  if (rpc.error) {
    console.warn('max_pm_order_number RPC (add supabase-migration-max-pm-order-rpc.sql?)', rpc.error);
  }
  const re = /^PM-(\d+)$/i;
  let maxNum = ORDER_ID_START - 1;
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const r = await sb.from('orders').select('id').range(from, from + pageSize - 1);
    if (r.error) {
      return null;
    }
    const rows = r.data || [];
    rows.forEach(function (row) {
      const m = String(row.id || '').match(re);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    });
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return maxNum;
}

function isDuplicateOrdersPkeyError(err) {
  if (!err) return false;
  if (String(err.code) === '23505') return true;
  const m = String(err.message || '').toLowerCase();
  return m.includes('duplicate') && (m.includes('orders_pkey') || m.includes('key (id)'));
}

function formatRemainingStockLine(p, orderItem) {
  if (!p) return '';
  let n = Math.max(0, Math.floor(Number(p.stockQty) || 0));
  const vl = variantLabelFromOrderItem(orderItem, p);
  if (hasVariants(p) && vl) {
    const v = findVariantByLabel(p, vl);
    if (v) n = Math.max(0, Math.floor(Number(v.stockQty) || 0));
  }
  return (orderItem.name || p.name) + ' — ' + n + ' left';
}

async function sendMerchantStockAlertEmail(order) {
  if (!EMAILJS_TEMPLATE_STOCK_ALERT || !EMAILJS_PUBLIC_KEY || !EMAILJS_SERVICE_ID || typeof emailjs === 'undefined') return;
  const products = getProducts();
  const lines = [];
  order.items.forEach(function (item) {
    const p = products.find(function (x) {
      return String(x.id) === String(item.id);
    });
    if (p) lines.push(formatRemainingStockLine(p, item));
  });
  if (!lines.length) return;
  try {
    await emailjs.send(
      EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_STOCK_ALERT,
      {
        merchant_email: MERCHANT_NOTIFY_EMAIL,
        order_id: String(order.id),
        stock_lines: lines.join('\n'),
        customer_name: order.name || '—',
        reply_to: MERCHANT_NOTIFY_EMAIL
      },
      { publicKey: EMAILJS_PUBLIC_KEY }
    );
  } catch (e) {
    console.error('Stock alert email', e);
  }
}

function formatSupabaseError(err) {
  if (!err) return 'Unknown error';
  return [err.message, err.details, err.hint].filter(Boolean).join(' — ');
}

async function uploadProductImageToSupabase(file, productIdHint) {
  const sb = getSb();
  if (!sb || !adminRemoteSession()) {
    throw new Error('Sign in with Supabase admin before uploading product images.');
  }
  if (!file) return null;
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
    throw new Error('Image must be under 1 MB.');
  }
  const safeExt = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = String(productIdHint || 'product').replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = 'products/' + base + '-' + Date.now() + '.' + safeExt;
  const up = await sb.storage.from(PRODUCT_IMAGE_BUCKET).upload(filePath, file, {
    cacheControl: '3600',
    upsert: true
  });
  if (up.error) throw new Error(formatSupabaseError(up.error) || 'Image upload failed.');
  const pub = sb.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(filePath);
  const url = pub && pub.data ? pub.data.publicUrl : '';
  if (!url) throw new Error('Image uploaded but public URL could not be generated.');
  return url;
}

/** Older DBs may not have weight_kg; retry without it. */
async function supabaseSaveProductRow(sb, row, isUpdate, editId) {
  function hasMissingColumnError(errorObj, colName) {
    const blob = (String(errorObj && errorObj.message || '') + ' ' + String(errorObj && errorObj.details || '')).toLowerCase();
    return blob.includes(colName.toLowerCase()) || blob.includes('schema cache') || blob.includes('does not exist');
  }

  function stripMissingOptionalColumns(payload, errorObj) {
    if (!payload || !errorObj) return payload;
    const out = Object.assign({}, payload);
    if (hasMissingColumnError(errorObj, 'weight_kg')) delete out.weight_kg;
    if (hasMissingColumnError(errorObj, 'stock_qty')) delete out.stock_qty;
    if (hasMissingColumnError(errorObj, 'compare_at_price')) delete out.compare_at_price;
    if (hasMissingColumnError(errorObj, 'variants')) delete out.variants;
    if (hasMissingColumnError(errorObj, 'extra_shipping_rs')) delete out.extra_shipping_rs;
    if (hasMissingColumnError(errorObj, 'extra_categories')) delete out.extra_categories;
    if (hasMissingColumnError(errorObj, 'is_featured')) delete out.is_featured;
    return out;
  }

  if (isUpdate) {
    const id = String(editId);
    const patch = Object.assign({}, row);
    delete patch.id;
    let res = await sb.from('products').update(patch).eq('id', id);
    if (res.error) {
      const retryPatch = stripMissingOptionalColumns(patch, res.error);
      const changed = JSON.stringify(retryPatch) !== JSON.stringify(patch);
      if (changed) {
        res = await sb.from('products').update(retryPatch).eq('id', id);
      }
    }
    return res;
  }
  let res = await sb.from('products').insert(row);
  if (res.error) {
    const lean = stripMissingOptionalColumns(row, res.error);
    const changed = JSON.stringify(lean) !== JSON.stringify(row);
    if (changed) {
      res = await sb.from('products').insert(lean);
    }
  }
  return res;
}

function orderFromSupabaseRow(row) {
  const c = row.customer || {};
  const items = (row.order_items || []).map(function (it) {
    const vl = it.variant_label != null && String(it.variant_label).trim() ? String(it.variant_label).trim() : '';
    return { id: it.product_id, name: it.name, price: Number(it.price), qty: it.qty, variantLabel: vl };
  });
  const shipCol = row.shipping_amount != null && row.shipping_amount !== '' ? Number(row.shipping_amount) : NaN;
  const shipCust = c.shipping_amount != null && c.shipping_amount !== '' ? Number(c.shipping_amount) : NaN;
  const ship = Number.isFinite(shipCol) ? shipCol : Number.isFinite(shipCust) ? shipCust : 0;
  const tot = row.total != null ? Number(row.total) : Number(row.subtotal) + ship;
  const wCol = row.total_weight_kg != null && row.total_weight_kg !== '' ? Number(row.total_weight_kg) : NaN;
  const wCust = c.total_weight_kg != null && c.total_weight_kg !== '' ? Number(c.total_weight_kg) : NaN;
  const totalW = Number.isFinite(wCol) ? wCol : Number.isFinite(wCust) ? wCust : null;
  const discRaw = c.discount_amount != null && c.discount_amount !== '' ? Number(c.discount_amount) : NaN;
  const discount = Number.isFinite(discRaw) && discRaw > 0 ? discRaw : 0;
  const couponCode = c.coupon_code != null && String(c.coupon_code).trim() ? String(c.coupon_code).trim() : '';
  return {
    id: row.id,
    name: c.name || '—',
    phone: c.phone || '—',
    email: c.email || '',
    address: c.address || [c.address1, c.city, c.state, c.pin].filter(Boolean).join(', ') || '—',
    items: items,
    subtotal: Number(row.subtotal),
    discount: discount,
    couponCode: couponCode,
    shipping: ship,
    total: tot,
    totalWeightKg: totalW,
    paymentRef: (row.payment_reference != null && row.payment_reference !== '') ? String(row.payment_reference) : (c.payment_reference != null ? String(c.payment_reference) : ''),
    payMethod: row.payment_method || 'razorpay',
    date: row.created_at ? new Date(row.created_at).toLocaleDateString('en-IN') : '',
    createdAt: row.created_at ? String(row.created_at) : '',
    status: row.status || 'Pending'
  };
}

/** DB created before shipping/payment columns existed — insert without them and stash in customer JSON. */
function orderInsertMissingColumnError(err) {
  if (!err) return false;
  const blob = String(err.message || '') + String(err.details || '') + String(err.hint || '') + String(err.code || '');
  return (
    err.code === '42703' ||
    /shipping_amount|payment_reference|total_weight_kg|column.*orders|does not exist/i.test(blob)
  );
}

function getLocalProductCategoryRows() {
  try {
    const raw = localStorage.getItem('rrm_product_categories');
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(function (x) { return x && typeof x.name === 'string' && String(x.name).trim(); })
      .map(function (x) { return { name: String(x.name).trim(), image_url: x.image_url ? String(x.image_url) : '' }; });
  } catch (_e) {
    return [];
  }
}

function saveLocalProductCategoryRows(rows) {
  try {
    localStorage.setItem('rrm_product_categories', JSON.stringify(rows || []));
  } catch (_e) {}
}

function getCategoryImageUrl(catName) {
  const name = String(catName || '').trim();
  if (!name) return '';
  if (categoriesFromRemote && categoriesCache && categoriesCache.length) {
    const hit = categoriesCache.find(function (c) { return String(c.name) === name; });
    return hit && hit.image_url ? String(hit.image_url) : '';
  }
  const local = getLocalProductCategoryRows().find(function (c) { return String(c.name) === name; });
  if (local && local.image_url) return String(local.image_url);
  // Backward compatibility: earlier versions stored per-category images in localStorage.
  try {
    const ov = typeof getCategoryImageOverrides === 'function' ? getCategoryImageOverrides() : null;
    if (ov && ov[name] && String(ov[name]).trim()) return String(ov[name]).trim();
  } catch (_e) {}
  return '';
}

function categoriesDerivedFromProducts(products) {
  const set = new Set();
  (products || []).forEach(function (p) {
    const prim = String(p && p.category != null ? p.category : '').trim();
    if (prim) set.add(prim);
    (p && p.extraCategories ? p.extraCategories : []).forEach(function (x) {
      const t = String(x || '').trim();
      if (t) set.add(t);
    });
  });
  return Array.from(set);
}

function productMatchesCategory(p, cat) {
  const c = String(cat || '').trim();
  if (!c || c === 'All') return true;
  if (String(p.category || '').trim() === c) return true;
  const extras = p.extraCategories || [];
  return extras.some(function (x) {
    return String(x || '').trim() === c;
  });
}

function getCategoriesList() {
  const products = getProducts();
  const fromProducts = categoriesDerivedFromProducts(products);
  if (categoriesFromRemote && categoriesCache && categoriesCache.length) {
    const names = categoriesCache
      .map(function (c) { return String(c.name || '').trim(); })
      .filter(Boolean);
    const merged = [...new Set(names.concat(fromProducts))];
    return merged.sort(function (a, b) {
      return a.localeCompare(b);
    });
  }
  const local = getLocalProductCategoryRows().map(function (c) { return c.name; });
  const merged = [...new Set(local.concat(fromProducts))];
  return merged
    .filter(Boolean)
    .sort(function (a, b) {
      return a.localeCompare(b);
    });
}

function paintCategoryDatalist() {
  const sel = document.getElementById('pm-cat');
  if (sel && sel.tagName === 'SELECT') {
    const list = getCategoriesList();
    const keep = String(sel.value || '').trim();
    sel.innerHTML = list.length
      ? list
          .map(function (c) {
            return '<option value="' + escAttr(c) + '">' + escHtml(c) + '</option>';
          })
          .join('')
      : '<option value="Resin">Resin</option>';
    if (keep && Array.prototype.some.call(sel.options, function (o) { return o.value === keep; })) {
      sel.value = keep;
    }
    return;
  }
  const dl = document.getElementById('pm-cat-datalist');
  if (!dl) return;
  const list = getCategoriesList();
  dl.innerHTML = list.map(function (c) { return `<option value="${escHtml(c)}"></option>`; }).join('');
}

function paintFooterCategoryLinks() {
  const wrap = document.getElementById('footer-categories-links');
  if (!wrap) return;
  const cats = getCategoriesList();
  if (!cats.length) {
    wrap.innerHTML =
      '<span style="font-size:13px;color:rgba(255,255,255,0.45);">No categories yet.</span>';
    return;
  }
  wrap.innerHTML = cats
    .map(function (cat) {
      const enc = encodeURIComponent(cat);
      return (
        '<a onclick="openCategoryFromHome(\'' +
        enc.replace(/\\/g, '\\\\').replace(/'/g, "\\'") +
        '\')">' +
        escHtml(cat) +
        '</a>'
      );
    })
    .join('');
}

async function refreshCategoriesCache() {
  const sb = getSb();
  if (!sb) {
    categoriesFromRemote = false;
    categoriesCache = [];
    paintCategoryDatalist();
    paintFooterCategoryLinks();
    return;
  }
  const r = await sb.from('product_categories').select('name, image_url').order('name', { ascending: true });
  if (r.error) {
    // Table may not exist yet — fall back to local + products derived categories.
    console.warn(r.error);
    categoriesFromRemote = false;
    categoriesCache = [];
    paintCategoryDatalist();
    paintFooterCategoryLinks();
    return;
  }
  categoriesCache = (r.data || []).map(function (row) {
    return {
      name: String(row.name || '').trim(),
      image_url: row.image_url ? String(row.image_url) : ''
    };
  }).filter(function (c) { return c.name; });
  categoriesFromRemote = true;
  paintCategoryDatalist();
  paintFooterCategoryLinks();
}

async function refreshCatalog() {
  const sb = getSb();
  if (!sb) {
    catalogFromRemote = false;
    return;
  }
  const r = await sb.from('products').select('*').order('created_at', { ascending: true });
  if (r.error) {
    console.error(r.error);
    catalogFromRemote = false;
    return;
  }
  productsCache = (r.data || []).map(rowToProduct);
  catalogFromRemote = true;
  await refreshCategoriesCache();
  const ids = {};
  productsCache.forEach(function (p) {
    ids[p.id] = true;
  });
  const cart = getCart();
  let changed = false;
  const capped = cart
    .map(function (i) {
      if (!ids[i.id]) {
        changed = true;
        return null;
      }
      const p = productsCache.find(function (x) { return x.id === i.id; });
      const vl = i.variantLabel != null ? String(i.variantLabel).trim() : '';
      if (p && hasVariants(p) && !vl) {
        changed = true;
        return null;
      }
      const maxQty = p ? maxQtyForCartLine(p, vl) : 0;
      const nextQty = Math.max(0, Math.min(Number(i.qty) || 0, maxQty));
      if (nextQty !== i.qty) changed = true;
      if (nextQty <= 0) return null;
      return { id: i.id, qty: nextQty, variantLabel: vl };
    })
    .filter(Boolean);
  const mergeKey = {};
  capped.forEach(function (line) {
    const k = JSON.stringify([line.id, String(line.variantLabel || '').trim()]);
    mergeKey[k] = (mergeKey[k] || 0) + line.qty;
  });
  const nextCart = Object.keys(mergeKey).map(function (k) {
    let id;
    let vl;
    try {
      const parsed = JSON.parse(k);
      id = parsed[0];
      vl = parsed[1];
    } catch (_e) {
      return null;
    }
    const p = productsCache.find(function (x) { return x.id === id; });
    const maxQty = p ? maxQtyForCartLine(p, vl) : 0;
    const q = Math.min(mergeKey[k], maxQty);
    return q > 0 ? { id: id, qty: q, variantLabel: vl } : null;
  }).filter(Boolean);
  if (capped.length !== nextCart.length) changed = true;
  if (changed) {
    saveCart(nextCart);
    showToast('Cart quantities were updated to match current stock.');
  }
}

async function refreshOrdersCache() {
  const sb = getSb();
  if (!sb || !authSession || !authSession.user) {
    ordersCache = [];
    return;
  }
  const r = await sb.from('orders').select('*, order_items(*)').order('created_at', { ascending: false });
  if (r.error) {
    console.error(r.error);
    ordersCache = [];
    return;
  }
  ordersCache = (r.data || []).map(orderFromSupabaseRow);
}

async function refreshContactCache() {
  const sb = getSb();
  if (!sb || !authSession || !authSession.user) {
    contactMessageCache = [];
    return;
  }
  const r = await sb.from('contact_inquiries').select('*').order('created_at', { ascending: false });
  if (r.error) {
    console.error(r.error);
    contactMessageCache = [];
    return;
  }
  contactMessageCache = r.data || [];
}

function emailJsOrderReady() {
  return !!(EMAILJS_PUBLIC_KEY && EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ORDER && typeof emailjs !== 'undefined');
}

function emailJsOrderCustomerReady() {
  return !!(
    EMAILJS_PUBLIC_KEY &&
    EMAILJS_SERVICE_ID &&
    EMAILJS_TEMPLATE_ORDER_CONFIRM &&
    typeof emailjs !== 'undefined'
  );
}

function emailJsContactReady() {
  return !!(EMAILJS_PUBLIC_KEY && EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_CONTACT && typeof emailjs !== 'undefined');
}

async function sendOrderEmail(order) {
  if (!emailJsOrderReady()) return;
  try {
    const lines = order.items
      .map(function (i) {
        return i.name + ' ×' + i.qty + ' — ₹' + i.price * i.qty;
      })
      .join('\n');
    await emailjs.send(
      EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_ORDER,
      {
        merchant_email: MERCHANT_NOTIFY_EMAIL,
        order_id: String(order.id),
        customer_name: order.name,
        phone: order.phone,
        email: order.email || '',
        address: order.address,
        payment: order.payMethod,
        total: String(order.total != null ? order.total : order.subtotal),
        subtotal: String(order.subtotal),
        discount_amount: String(order.discount != null && order.discount > 0 ? order.discount : 0),
        coupon_code: order.couponCode || '—',
        shipping_amount: String(order.shipping != null ? order.shipping : 0),
        payment_reference: order.paymentRef || '—',
        order_status: order.status || 'Pending',
        items_detail: lines,
        reply_to: order.email || MERCHANT_NOTIFY_EMAIL
      },
      { publicKey: EMAILJS_PUBLIC_KEY }
    );
  } catch (e) {
    console.error('EmailJS order', e);
  }
}

async function sendOrderConfirmationToCustomer(order) {
  const to = (order.email || '').trim();
  if (!to || !emailJsOrderCustomerReady()) return;
  try {
    const lines = order.items
      .map(function (i) {
        return i.name + ' ×' + i.qty + ' — ₹' + i.price * i.qty;
      })
      .join('\n');
    await emailjs.send(
      EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_ORDER_CONFIRM,
      {
        to_email: to,
        order_id: String(order.id),
        customer_name: order.name,
        phone: order.phone,
        email: to,
        address: order.address,
        payment: order.payMethod,
        total: String(order.total != null ? order.total : order.subtotal),
        discount_amount: String(Number(order.discount) > 0 ? order.discount : 0),
        coupon_code: order.couponCode || '—',
        items_detail: lines,
        order_status: order.status || 'Pending',
        store_url: typeof window !== 'undefined' && window.location ? window.location.origin : '',
        store_name: 'Preserving Memories Resin Materials',
        shipping_amount: String(order.shipping != null ? order.shipping : 0),
        tax_amount: '—',
        reply_to: MERCHANT_NOTIFY_EMAIL,
      },
      { publicKey: EMAILJS_PUBLIC_KEY }
    );
  } catch (e) {
    console.error('EmailJS customer order confirm', e);
  }
}

async function sendContactEmail(row) {
  if (!emailJsContactReady()) return;
  try {
    await emailjs.send(
      EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_CONTACT,
      {
        merchant_email: MERCHANT_NOTIFY_EMAIL,
        name: row.name,
        email: row.email,
        phone: row.phone || '',
        message: row.message,
        reply_to: row.email || MERCHANT_NOTIFY_EMAIL
      },
      { publicKey: EMAILJS_PUBLIC_KEY }
    );
  } catch (e) {
    console.error('EmailJS contact', e);
  }
}


const DEFAULT_PRODUCTS = [
  { id:'p1', name:'Crystal Clear Epoxy Resin', category:'Resin', extraCategories:[], price:450, compareAtPrice:499, stockQty:10, weightKg:0.5, desc:'Premium A+B epoxy resin with high clarity and zero yellowing. Ideal for jewelry, coasters, and artwork.', img:'', emoji:'🧴', inStock:true },
  { id:'p2', name:'Silicone Mold Set — Geometric', category:'Molds', extraCategories:[], price:320, compareAtPrice:360, stockQty:8, weightKg:0.3, desc:'Set of 6 geometric silicone molds. Hexagon, circle, square, diamond, teardrop, and oval shapes.', img:'', emoji:'🔷', inStock:true },
  { id:'p3', name:'Resin Pigment Powder Set', category:'Pigments', extraCategories:[], price:280, compareAtPrice:null, stockQty:15, weightKg:0.2, desc:'12-color mica pigment powder set. High shimmer, fade-resistant, and compatible with all resin types.', img:'', emoji:'🎨', inStock:true },
  { id:'p4', name:'UV Resin (100ml)', category:'UV Resin', extraCategories:[], price:380, compareAtPrice:null, stockQty:0, weightKg:0.15, desc:'Fast-curing UV resin for small crafts and jewelry. Cures in 2–3 minutes under UV lamp.', img:'', emoji:'💡', inStock:false },
  { id:'p5', name:'Resin Mixing Tools Kit', category:'Tools', extraCategories:[], price:150, compareAtPrice:199, stockQty:20, weightKg:0.25, desc:'Complete kit: 2 mixing cups, 5 mixing sticks, 2 silicone spatulas. Reusable and easy to clean.', img:'', emoji:'🔧', inStock:true },
  { id:'p6', name:'Glitter Flakes Assorted Pack', category:'Glitter & Embellishments', extraCategories:[], price:120, compareAtPrice:null, stockQty:12, weightKg:0.1, desc:'Assorted holographic and metallic glitter flakes. 8 colors included. Works with resin and nail art.', img:'', emoji:'✨', inStock:true },
];

function normalizeProductShape(p) {
  const variants = normalizeVariantsArray(parseVariantsFromRow(p.variants));
  const cRaw = p && p.compareAtPrice != null && p.compareAtPrice !== '' ? Number(p.compareAtPrice) : NaN;
  const compareAt = Number.isFinite(cRaw) && cRaw > 0 ? cRaw : null;
  const exRaw = p && p.extraShippingRs != null ? Number(p.extraShippingRs) : NaN;
  const extraShippingRs = Number.isFinite(exRaw) && exRaw >= 0 ? exRaw : 0;
  const base = Object.assign({}, p, {
    compareAtPrice: compareAt,
    weightKg: productWeightKg(p),
    extraShippingRs: extraShippingRs,
    variants: variants,
    extraCategories: parseExtraCategoriesFromRow(p.extraCategories != null ? p.extraCategories : p.extra_categories),
    featured: !!(p.featured || p.is_featured)
  });
  if (variants.length) {
    syncVariantAggregateFields(base);
  } else {
    const qRaw = p && p.stockQty != null ? Number(p.stockQty) : NaN;
    const qty = Number.isFinite(qRaw) ? Math.max(0, Math.floor(qRaw)) : (p && p.inStock ? 1 : 0);
    base.stockQty = qty;
    base.inStock = qty > 0;
  }
  return base;
}

function getProducts() {
  if (catalogFromRemote) return productsCache;
  const d = localStorage.getItem('rrm_products');
  if (!d) {
    const seeded = DEFAULT_PRODUCTS.map(normalizeProductShape);
    localStorage.setItem('rrm_products', JSON.stringify(seeded));
    return seeded;
  }
  return JSON.parse(d).map(normalizeProductShape);
}

function getCategoryImageOverrides() {
  if (categoryImageOverrides) return categoryImageOverrides;
  try {
    const raw = localStorage.getItem('rrm_category_images');
    const parsed = raw ? JSON.parse(raw) : {};
    categoryImageOverrides = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_e) {
    categoryImageOverrides = {};
  }
  return categoryImageOverrides;
}

function saveCategoryImageOverrides(map) {
  categoryImageOverrides = map && typeof map === 'object' ? map : {};
  localStorage.setItem('rrm_category_images', JSON.stringify(categoryImageOverrides));
}
function saveProducts(p) {
  if (catalogFromRemote) productsCache = p.slice ? p.slice() : p;
  localStorage.setItem('rrm_products', JSON.stringify(p));
}
function getOrders() {
  if (adminRemoteSession()) return ordersCache;
  return JSON.parse(localStorage.getItem('rrm_orders') || '[]');
}
function saveOrders(o) {
  localStorage.setItem('rrm_orders', JSON.stringify(o));
}
function getInstoreSales() {
  if (adminRemoteSession()) return instoreSalesCache;
  return JSON.parse(localStorage.getItem(RRM_INSTORE_SALES_LOCAL_KEY) || '[]');
}
function saveInstoreSales(rows) {
  if (adminRemoteSession()) instoreSalesCache = rows.slice ? rows.slice() : rows;
  localStorage.setItem(RRM_INSTORE_SALES_LOCAL_KEY, JSON.stringify(rows || []));
}
function getCart() { return JSON.parse(localStorage.getItem('rrm_cart') || '[]'); }
function saveCart(c) { localStorage.setItem('rrm_cart', JSON.stringify(c)); updateCartCount(); }

function productWeightKg(p) {
  const w = p && p.weightKg != null ? Number(p.weightKg) : NaN;
  return isFinite(w) && w > 0 ? w : 0.5;
}

function cartTotalWeightKg(cart, products) {
  let sum = 0;
  cart.forEach(function (item) {
    const p = products.find(function (x) { return x.id === item.id; });
    if (!p) return;
    const vl = item.variantLabel != null ? String(item.variantLabel).trim() : '';
    sum += lineWeightKgForCart(p, vl) * item.qty;
  });
  return sum;
}

function isTamilNaduState(stateStr) {
  const t = (stateStr || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return t === 'tamil nadu' || t === 'tamilnadu' || t === 'tn';
}

/**
 * Billable kg = ceil(totalKg), minimum 1.
 * TN: exactly 1 billable kg → ₹70; more than 1 → ₹60 × billable kg.
 * Other states: 1 kg → ₹100; more than 1 → ₹90 × billable kg.
 */
function shippingForWeightKg(totalKg, inTamilNadu) {
  const w = Number(totalKg);
  const billableKg = !isFinite(w) || w <= 0 ? 1 : Math.max(1, Math.ceil(w));
  if (billableKg === 1) {
    return { billableKg: 1, shipping: inTamilNadu ? 70 : 100 };
  }
  const rate = inTamilNadu ? 60 : 90;
  return { billableKg: billableKg, shipping: billableKg * rate };
}

function getCheckoutTotals() {
  const cart = getCart();
  const products = getProducts();
  const stateEl = document.getElementById('co-state');
  const stateVal = stateEl ? stateEl.value : 'Tamil Nadu';
  const snap = getAppliedCouponSnapshot();
  const m = computeCheckoutMoney(cart, products, stateVal, snap);
  if (m.subtotal < MIN_ORDER_AMOUNT_RS) {
    showToast('Minimum order (before coupon, excluding shipping) is ₹' + MIN_ORDER_AMOUNT_RS + '. Add more items to continue.');
    return;
  }
  return {
    subtotal: m.subtotal,
    discount: m.discount,
    couponCode: snap ? snap.code : '',
    weightKg: m.weightKg,
    shipping: m.shipping,
    shippingBase: m.shippingBase,
    shippingExtra: m.shippingExtra,
    total: m.total,
    inTN: m.inTN
  };
}

function refreshCheckoutTotals() {
  const cart = getCart();
  const products = getProducts();
  const stateEl = document.getElementById('co-state');
  const stateVal = stateEl ? stateEl.value : 'Tamil Nadu';
  const snap = getAppliedCouponSnapshot();
  const m = computeCheckoutMoney(cart, products, stateVal, snap);
  const subEl = document.getElementById('co-subtotal');
  const discRow = document.getElementById('co-discount-row');
  const discEl = document.getElementById('co-discount');
  const shipEl = document.getElementById('co-shipping');
  const totEl = document.getElementById('co-total');
  const wEl = document.getElementById('co-weight-note');
  if (subEl) subEl.textContent = '₹' + m.subtotal;
  if (discRow && discEl) {
    if (m.discount > 0) {
      discRow.style.display = 'flex';
      discEl.textContent = '−₹' + m.discount + (snap ? ' (' + snap.code + ')' : '');
    } else {
      discRow.style.display = 'none';
      discEl.textContent = '₹0';
    }
  }
  if (shipEl) shipEl.textContent = '₹' + m.shipping;
  if (totEl) totEl.textContent = '₹' + m.total;
  if (wEl) {
    wEl.textContent = 'Estimated shipping = ₹' + m.shipping;
  }
}

// ============================================================
// NAVIGATION
// ============================================================
let currentPage = 'home';
let pendingShopFilter = null;
function navigate(page) {
  if (page === 'admin') { showAdmin(); return; }
  document.body.classList.remove('mobile-nav-open');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('site-header').style.display = 'flex';
  document.getElementById('site-footer').style.display = 'block';
  const policyFab = document.getElementById('policy-fab');
  if (policyFab) policyFab.style.display = 'inline-flex';
  document.getElementById('admin-login').style.display = 'none';
  document.getElementById('admin-panel').style.display = 'none';

  const el = document.getElementById('page-' + page);
  if (el) { el.classList.add('active'); currentPage = page; }
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  const na = document.getElementById('nav-' + page);
  if (na) na.classList.add('active');
  window.scrollTo(0,0);

  if (page === 'shop') {
    currentFilter = pendingShopFilter || 'All';
    pendingShopFilter = null;
    currentSearchQuery = '';
    shopCatalogPage = 1;
    void renderShop();
  }
  if (page === 'home') void renderFeatured();
  if (page === 'cart') void renderCart();
  if (page === 'checkout') void renderCheckout();
  if (page === 'contact') {
    const m = document.getElementById('contact-success-msg');
    if (m) m.classList.remove('show');
  }
}

function showAdmin() {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('site-header').style.display = 'none';
  document.getElementById('site-footer').style.display = 'none';
  const policyFab = document.getElementById('policy-fab');
  if (policyFab) policyFab.style.display = 'none';
  document.getElementById('admin-panel').style.display = 'none';
  document.getElementById('admin-login').style.display = 'flex';
}

function toggleMobileMenu() {
  document.body.classList.toggle('mobile-nav-open');
}

function closeMobileMenu() {
  document.body.classList.remove('mobile-nav-open');
}

function openPolicyModal() {
  openModal('policy-modal');
}

function promptPolicyBeforeCheckout() {
  navigate('checkout');
  openPolicyModal();
}


document.addEventListener('click', function (e) {
  if (!document.body.classList.contains('mobile-nav-open')) return;
  const header = document.getElementById('site-header');
  if (!header) return;
  if (!header.contains(e.target)) closeMobileMenu();
});


async function submitContactForm(e) {
  e.preventDefault();
  const name = document.getElementById('cf-name').value.trim();
  const email = document.getElementById('cf-email').value.trim();
  const phone = document.getElementById('cf-phone').value.trim();
  const message = document.getElementById('cf-msg').value.trim();
  const msgId = 'MSG-' + Date.now();
  const sb = getSb();
  if (sb) {
    const ins = await sb.from('contact_inquiries').insert({
      id: msgId,
      name: name,
      email: email,
      phone: phone,
      message: message
    });
    if (ins.error) console.error(ins.error);
  }
  const list = JSON.parse(localStorage.getItem('rrm_contact_inquiries') || '[]');
  list.unshift({ id: msgId, date: new Date().toISOString(), name, email, phone, message });
  localStorage.setItem('rrm_contact_inquiries', JSON.stringify(list));
  await sendContactEmail({ name, email, phone, message });
  const okMsg = document.getElementById('contact-success-msg');
  if (okMsg) okMsg.classList.add('show');
  e.target.reset();
  showToast('Message sent — we will get back to you!');
}

// ============================================================
// PRODUCT RENDERING
// ============================================================
let currentFilter = 'All';
let currentSearchQuery = '';
let shopCatalogPage = 1;
let shopSort = 'name-asc';
const SHOP_PAGE_SIZE = 10;
/** Max products marked featured for the home grid (admin enforces). */
const FEATURED_PRODUCTS_MAX = 10;
let adminProductListQ = '';
let adminProductSort = 'name-asc';
let adminProductPage = 1;
const ADMIN_PRODUCTS_PAGE = 10;
let detailProductId = null;
let detailQty = 1;

function productMinVariantPrice(p) {
  if (!hasVariants(p)) return productSalePrice(p);
  const prices = p.variants.map(function (v) {
    return Number(v.price);
  }).filter(function (x) {
    return Number.isFinite(x);
  });
  return prices.length ? Math.min.apply(null, prices) : 0;
}

function productSalePrice(p) {
  const v = Number(p.price);
  return Number.isFinite(v) ? v : 0;
}

function productCompareAtPrice(p) {
  const v = p && p.compareAtPrice != null ? Number(p.compareAtPrice) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

function productDiscountPercent(p) {
  if (hasVariants(p)) return 0;
  const mrp = productCompareAtPrice(p);
  const sale = productSalePrice(p);
  if (!mrp || mrp <= sale || sale < 0) return 0;
  return Math.round(((mrp - sale) / mrp) * 100);
}

function roundPrice(v) {
  return Math.round(Number(v) * 100) / 100;
}

function salePriceFromPercent(basePrice, pct) {
  const b = Number(basePrice);
  const d = Number(pct);
  if (!Number.isFinite(b) || b < 0) return 0;
  if (!Number.isFinite(d) || d <= 0) return roundPrice(b);
  const p = Math.min(95, Math.max(0, d));
  return roundPrice(b * (1 - p / 100));
}

function formatProductPriceHTML(p) {
  if (hasVariants(p)) {
    const fromP = productMinVariantPrice(p);
    return `<span class="price-sale">From ₹${fromP}</span>`;
  }
  const sale = productSalePrice(p);
  const mrp = productCompareAtPrice(p);
  if (mrp && mrp > sale) {
    return `<span class="price-strike">₹${mrp}</span><span class="price-sale">₹${sale}</span>`;
  }
  return `<span class="price-sale">₹${sale}</span>`;
}

function productCardHTML(p) {
  const imgContent = p.img
    ? `<img src="${p.img}" alt="${p.name}" onerror="this.style.display='none';this.parentElement.querySelector('.emoji-fallback').style.display='block'"><span class="emoji-fallback" style="display:none;font-size:48px;">${p.emoji}</span>`
    : `<span style="font-size:48px;">${p.emoji}</span>`;
  const stockBadge = p.inStock
    ? `<span class="stock-badge in-stock">In stock</span>`
    : `<span class="stock-badge out-stock">Out of stock</span>`;
  const discountPct = productDiscountPercent(p);
  const discountBadge = discountPct > 0 ? `<span class="discount-badge">${discountPct}% OFF</span>` : '';
  const canBuy = productInStock(p);
  const btnOnclick = hasVariants(p)
    ? `event.stopPropagation();viewProduct('${p.id}')`
    : `event.stopPropagation();addToCart('${p.id}')`;
  const btnLabel = !canBuy ? 'Out of stock' : hasVariants(p) ? 'Select size' : 'Add to Cart';
  return `
    <div class="product-card" onclick="viewProduct('${p.id}')">
      <div class="product-img">${imgContent}${stockBadge}${discountBadge}</div>
      <div class="product-info">
        <div class="product-category">${p.category}</div>
        <div class="product-name">${p.name}</div>
        <div class="product-desc">${p.desc}</div>
        <div class="product-footer">
          <div class="product-price">${formatProductPriceHTML(p)}</div>
          <button class="add-to-cart" ${!canBuy ? 'disabled' : ''} onclick="${btnOnclick}">
            ${btnLabel}
          </button>
        </div>
      </div>
    </div>`;
}

function paintHomeCategoryGrid() {
  const el = document.getElementById('home-category-grid');
  if (!el) return;
  const products = getProducts();
  const categories = getCategoriesList();
  if (!categories.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = categories.map(function (cat) {
    const sample = products.find(function (p) { return productMatchesCategory(p, cat); }) || {};
    const emoji = sample.emoji || '📦';
    const imageSrc = getCategoryImageUrl(cat) || (sample.img || '');
    const image = imageSrc ? `<img src="${imageSrc}" alt="${escHtml(cat)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline';">` : '';
    const fallbackStyle = imageSrc ? 'display:none;' : '';
    const encoded = encodeURIComponent(cat);
    return `<button type="button" class="home-cat-card" onclick="openCategoryFromHome('${encoded}')">
      <div class="home-cat-card-media">${image}<span class="home-cat-card-emoji" style="${fallbackStyle}">${emoji}</span></div>
      <div class="home-cat-card-label">${escHtml(cat)}</div>
    </button>`;
  }).join('');
}

function openCategoryFromHome(encodedCategory) {
  const cat = decodeURIComponent(encodedCategory || '');
  pendingShopFilter = cat || 'All';
  navigate('shop');
}

function countFeaturedProductsInCatalog() {
  return getProducts().filter(function (p) {
    return p.featured === true;
  }).length;
}

function paintFeaturedGrid() {
  const all = getProducts();
  const picked = all
    .filter(function (p) {
      return p.featured === true;
    })
    .sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''));
    })
    .slice(0, FEATURED_PRODUCTS_MAX);
  const list =
    picked.length > 0
      ? picked
      : all
          .filter(function (p) {
            return p.inStock;
          })
          .slice(0, 6);
  const el = document.getElementById('featured-grid');
  if (el) el.innerHTML = list.map(productCardHTML).join('');
  paintHomeCategoryGrid();
}

async function renderFeatured() {
  await refreshCatalog();
  paintFeaturedGrid();
}

function paintShopGrid() {
  const products = getProducts();
  const categories = ['All', ...new Set(getCategoriesList())];
  const fb = document.getElementById('filter-btns');
  const sg = document.getElementById('shop-grid');
  const si = document.getElementById('shop-search-input');
  if (si && si.value !== currentSearchQuery) si.value = currentSearchQuery;
  if (fb) {
    fb.innerHTML = categories.map(c =>
      `<button class="filter-btn ${c === currentFilter ? 'active' : ''}" onclick="setFilter('${c}')">${c}</button>`
    ).join('');
  }
  if (sg) {
    const byCategory =
      currentFilter === 'All' ? products : products.filter(function (p) { return productMatchesCategory(p, currentFilter); });
    const q = (currentSearchQuery || '').trim().toLowerCase();
    const filtered = !q
      ? byCategory
      : byCategory.filter(function (p) {
          const extras = (p.extraCategories || []).join(' ');
          const blob = (p.name + ' ' + p.category + ' ' + extras + ' ' + (p.desc || '')).toLowerCase();
          return blob.includes(q);
        });
    const sorted = filtered.slice().sort(function (a, b) {
      return productSortCompare(a, b, shopSort);
    });
    const total = sorted.length;
    const pages = Math.max(1, Math.ceil(total / SHOP_PAGE_SIZE));
    if (shopCatalogPage > pages) shopCatalogPage = pages;
    const start = (shopCatalogPage - 1) * SHOP_PAGE_SIZE;
    const pageItems = sorted.slice(start, start + SHOP_PAGE_SIZE);
    sg.innerHTML = pageItems.map(productCardHTML).join('');
    const pagEl = document.getElementById('shop-pagination');
    if (pagEl) {
      if (pages <= 1) {
        pagEl.innerHTML =
          total > 0
            ? '<div style="font-size:13px;color:var(--text-muted);margin-top:14px;text-align:center;">Showing all ' +
              total +
              ' product(s).</div>'
            : '';
      } else {
        pagEl.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:16px;flex-wrap:wrap;">' +
          '<button type="button" class="pagination-btn" ' +
          (shopCatalogPage <= 1 ? 'disabled' : '') +
          ' onclick="shopGoToPage(' +
          (shopCatalogPage - 1) +
          ')">Previous</button>' +
          '<span style="font-size:13px;color:var(--text-muted);">Page ' +
          shopCatalogPage +
          ' of ' +
          pages +
          ' · ' +
          total +
          ' items</span>' +
          '<button type="button" class="pagination-btn" ' +
          (shopCatalogPage >= pages ? 'disabled' : '') +
          ' onclick="shopGoToPage(' +
          (shopCatalogPage + 1) +
          ')">Next</button></div>';
      }
    }
  }
  const sortSel = document.getElementById('shop-sort-select');
  if (sortSel) sortSel.value = shopSort;
  paintFooterCategoryLinks();
}

function onShopSortChange(v) {
  shopSort = v || 'name-asc';
  shopCatalogPage = 1;
  paintShopGrid();
}
window.onShopSortChange = onShopSortChange;

function shopGoToPage(n) {
  shopCatalogPage = Math.max(1, Math.floor(Number(n) || 1));
  paintShopGrid();
}
window.shopGoToPage = shopGoToPage;

async function renderShop() {
  await refreshCatalog();
  paintShopGrid();
}

function setFilter(cat) {
  currentFilter = cat;
  shopCatalogPage = 1;
  paintShopGrid();
}

function setSearchQuery(v) {
  currentSearchQuery = v || '';
  shopCatalogPage = 1;
  paintShopGrid();
}

function onDetailVariantChange() {
  if (!detailProductId) return;
  const p = getProducts().find(function (x) {
    return x.id === detailProductId;
  });
  if (!p || !hasVariants(p)) return;
  const sel = document.getElementById('detail-variant');
  const lab = sel ? String(sel.value || '').trim() : '';
  const unit = effectiveUnitPriceForCartLine(p, lab);
  document.getElementById('detail-price').innerHTML = '<span class="price-sale">₹' + unit + '</span>';
  const maxQ = maxQtyForCartLine(p, lab);
  const inSt = maxQ > 0;
  document.getElementById('detail-stock-badge').innerHTML = inSt
    ? '<span class="stock-badge in-stock" style="position:static;">In stock</span>'
    : '<span class="stock-badge out-stock" style="position:static;">Out of stock</span>';
  const btn = document.getElementById('detail-add-btn');
  btn.disabled = !inSt;
  btn.textContent = inSt ? 'Add to Cart' : 'Out of stock';
  detailQty = Math.min(detailQty, Math.max(1, maxQ || 1));
  document.getElementById('detail-qty').textContent = detailQty;
}

function viewProduct(id) {
  const p = getProducts().find(x => x.id === id);
  if (!p) return;
  detailProductId = id;
  detailQty = 1;
  const imgEl = document.getElementById('detail-img');
  imgEl.innerHTML = p.img
    ? `<img src="${p.img}" alt="${p.name}" onerror="this.style.display='none';this.parentElement.innerHTML='<span style=font-size:80px>${p.emoji}</span>'">`
    : `<span style="font-size:80px;">${p.emoji}</span>`;
  {
    const also = (p.extraCategories || []).filter(Boolean);
    document.getElementById('detail-cat').textContent =
      also.length > 0 ? p.category + ' · Also in: ' + also.join(', ') : p.category;
  }
  document.getElementById('detail-name').textContent = p.name;
  document.getElementById('detail-desc').textContent = p.desc;
  document.getElementById('detail-qty').textContent = 1;
  const wrap = document.getElementById('detail-variant-wrap');
  const sel = document.getElementById('detail-variant');
  if (hasVariants(p) && wrap && sel) {
    wrap.style.display = 'block';
    sel.innerHTML = p.variants
      .map(function (v) {
        return (
          '<option value="' +
          escAttr(v.label) +
          '">' +
          escHtml(v.label) +
          ' — ₹' +
          v.price +
          '</option>'
        );
      })
      .join('');
    sel.value = p.variants[0].label;
    onDetailVariantChange();
  } else {
    if (wrap) wrap.style.display = 'none';
    document.getElementById('detail-price').innerHTML = formatProductPriceHTML(p);
    document.getElementById('detail-stock-badge').innerHTML = p.inStock
      ? `<span class="stock-badge in-stock" style="position:static;">In stock</span>`
      : `<span class="stock-badge out-stock" style="position:static;">Out of stock</span>`;
    const btn = document.getElementById('detail-add-btn');
    btn.disabled = !p.inStock;
    btn.textContent = p.inStock ? 'Add to Cart' : 'Out of stock';
  }
  navigate('detail');
}

function changeDetailQty(delta) {
  const p = detailProductId ? getProducts().find(x => x.id === detailProductId) : null;
  let maxQ = 9999;
  if (p) {
    const vl =
      hasVariants(p) && document.getElementById('detail-variant')
        ? String(document.getElementById('detail-variant').value || '').trim()
        : '';
    maxQ = Math.max(1, maxQtyForCartLine(p, vl));
  }
  const next = detailQty + delta;
  if (delta > 0 && next > maxQ) {
    showToast('Only ' + maxQ + ' left in stock.');
    return;
  }
  detailQty = Math.max(1, Math.min(maxQ, next));
  document.getElementById('detail-qty').textContent = detailQty;
}

function addDetailToCart() {
  if (!detailProductId) return;
  const p = getProducts().find(x => x.id === detailProductId);
  if (!p || !productInStock(p)) return;
  const variantLabel = hasVariants(p) && document.getElementById('detail-variant')
    ? String(document.getElementById('detail-variant').value || '').trim()
    : '';
  if (hasVariants(p) && !variantLabel) {
    showToast('Please select a size.');
    return;
  }
  const maxQ = maxQtyForCartLine(p, variantLabel);
  if (detailQty > maxQ) {
    showToast('Only ' + maxQ + ' left in stock.');
    return;
  }
  addToCart(detailProductId, false, detailQty, variantLabel);
  showToast(`${p.name} (x${detailQty}) added to cart!`);
}

// ============================================================
// CART
// ============================================================
function updateCartCount() {
  const cart = getCart();
  const total = cart.reduce((s, i) => s + i.qty, 0);
  document.getElementById('cart-count').textContent = total;
}

function addToCart(productId, toast, addQty, variantLabel) {
  if (toast === undefined) toast = true;
  const qtyToAdd = Number(addQty) > 0 ? Math.floor(Number(addQty)) : 1;
  const vl = String(variantLabel || '').trim();
  const products = getProducts();
  const p = products.find(x => x.id === productId);
  if (!p || !productInStock(p)) return;
  if (hasVariants(p) && !vl) {
    showToast('Open the product page to choose a size.');
    return;
  }
  const cart = getCart();
  const existing = cart.find(function (i) {
    return i.id === productId && String(i.variantLabel || '').trim() === vl;
  });
  const currentQty = existing ? existing.qty : 0;
  const maxQty = maxQtyForCartLine(p, vl);
  if (currentQty + qtyToAdd > maxQty) {
    showToast('Only ' + maxQty + ' left in stock.');
    return;
  }
  if (existing) existing.qty += qtyToAdd;
  else cart.push({ id: productId, qty: qtyToAdd, variantLabel: vl });
  saveCart(cart);
  if (toast) showToast(`${p.name}${vl ? ' (' + vl + ')' : ''} added to cart!`);
}

async function renderCart() {
  await refreshCatalog();
  const cart = getCart();
  const products = getProducts();
  const list = document.getElementById('cart-items-list');
  const panel = document.getElementById('cart-summary-panel');

  if (!cart.length) {
    list.innerHTML = `<div class="empty-cart"><div class="empty-icon">🛒</div><h3>Your cart is empty</h3><p>Browse our products and add items to get started.</p><button class="btn-primary" onclick="navigate('shop')" style="margin-top:16px;">Shop Now</button></div>`;
    panel.innerHTML = '';
    return;
  }

  let subtotal = 0;
  list.innerHTML = cart
    .map(function (item, idx) {
      const p = products.find(x => x.id === item.id);
      if (!p) return '';
      const vl = String(item.variantLabel || '').trim();
      const unit = effectiveUnitPriceForCartLine(p, vl);
      const line = unit * item.qty;
      subtotal += line;
      const variantLine = vl ? `<div class="cart-item-cat" style="margin-top:2px;">${escHtml(vl)}</div>` : '';
      const imgContent = p.img
        ? `<img src="${p.img}" alt="${p.name}" onerror="this.style.display='none'">`
        : `<span style="font-size:28px;">${p.emoji}</span>`;
      return `<div class="cart-item">
      <div class="cart-item-img">${imgContent}</div>
      <div class="cart-item-info">
        <div class="cart-item-cat">${p.category}</div>
        <div class="cart-item-name">${p.name}</div>
        ${variantLine}
        <div class="cart-item-price">₹${unit} × ${item.qty} = ₹${line}</div>
      </div>
      <div class="cart-item-actions">
        <div class="qty-ctrl">
          <button onclick="updateCartQty(${idx},-1)">−</button>
          <span>${item.qty}</span>
          <button onclick="updateCartQty(${idx},1)">+</button>
        </div>
        <button class="remove-btn" onclick="removeFromCart(${idx})">🗑</button>
      </div>
    </div>`;
    })
    .join('');

  const extraEst = cartExtraShippingRs(cart, products);
  const wKg = cartTotalWeightKg(cart, products);
  const shipTn = shippingForWeightKg(wKg, true).shipping + extraEst;
  const shipLine =
    '<div class="summary-row"><span>Est. shipping</span><span>₹' + shipTn + '</span></div>';
  panel.innerHTML = `<div class="order-summary">
    <h3>Order Summary</h3>
    <div class="summary-row"><span>${cart.reduce((s,i)=>s+i.qty,0)} item(s)</span><span>₹${subtotal}</span></div>
    ${shipLine}
    <div class="summary-row total"><span>Subtotal</span><span>₹${subtotal}</span></div>
    <button class="btn-checkout" onclick="promptPolicyBeforeCheckout()">Proceed to Checkout →</button>
  </div>`;
}

function updateCartQty(lineIndex, delta) {
  const products = getProducts();
  const cart = getCart();
  const item = cart[lineIndex];
  if (!item) return;
  const p = products.find(function (x) {
    return x.id === item.id;
  });
  const vl = String(item.variantLabel || '').trim();
  const maxQty = p ? maxQtyForCartLine(p, vl) : 0;
  const next = item.qty + delta;
  if (delta > 0 && next > maxQty) {
    showToast('Only ' + maxQty + ' left in stock.');
    return;
  }
  if (next <= 0) {
    cart.splice(lineIndex, 1);
  } else {
    item.qty = Math.min(maxQty, next);
  }
  saveCart(cart);
  void renderCart();
}

function removeFromCart(lineIndex) {
  const cart = getCart();
  if (lineIndex < 0 || lineIndex >= cart.length) return;
  cart.splice(lineIndex, 1);
  saveCart(cart);
  void renderCart();
}

// ============================================================
// CHECKOUT
// ============================================================
async function renderCheckout() {
  await refreshCatalog();
  const cart = getCart();
  const products = getProducts();
  let subtotal = 0;
  let itemsHTML = '';
  cart.forEach(item => {
    const p = products.find(x => x.id === item.id);
    if (!p) return;
    const vl = String(item.variantLabel || '').trim();
    const unit = effectiveUnitPriceForCartLine(p, vl);
    subtotal += unit * item.qty;
    const label = vl ? p.name + ' (' + vl + ')' : p.name;
    itemsHTML += `<div class="summary-row"><span>${escHtml(label)} ×${item.qty}</span><span>₹${unit * item.qty}</span></div>`;
  });
  document.getElementById('checkout-items-summary').innerHTML = itemsHTML;
  refreshCheckoutTotals();
  const st = document.getElementById('co-state');
  if (st && !st.dataset.rrmShipListen) {
    st.dataset.rrmShipListen = '1';
    st.addEventListener('input', refreshCheckoutTotals);
    st.addEventListener('change', refreshCheckoutTotals);
  }
}

function renderConfirmPage(order, items) {
  document.getElementById('confirm-order-id').textContent = '#' + order.id;
  const details = document.getElementById('confirm-details-block');
  const payLabel = order.payMethod === 'razorpay' ? 'Razorpay' : String(order.payMethod || '—').toUpperCase();
  const ship = order.shipping != null ? order.shipping : 0;
  const grand = order.total != null ? order.total : order.subtotal + ship;
  const refLine =
    order.paymentRef
      ? `<div class="confirm-row"><span>Payment ID</span><strong>${escHtml(order.paymentRef)}</strong></div>`
      : '';
  const paid = order.status === 'Paid' || order.status === 'Confirmed';
  const footNote = paid
    ? '<p style="font-size:13px;color:var(--text-muted);margin-top:14px;line-height:1.5;">Your payment was received. We will email you a confirmation and process your order.</p>'
    : '<p style="font-size:13px;color:var(--text-muted);margin-top:14px;line-height:1.5;">Your order is <strong>pending payment</strong>. Complete payment from checkout or contact us if you need help.</p>';
  details.innerHTML = `<h4>Order Summary</h4>
    ${items.map(function (i) {
      return `<div class="confirm-row"><span>${i.name} ×${i.qty}</span><strong>₹${i.price * i.qty}</strong></div>`;
    }).join('')}
    <div class="confirm-row"><span>Subtotal</span><strong>₹${order.subtotal}</strong></div>
    ${
      Number(order.discount) > 0
        ? '<div class="confirm-row"><span>Discount' +
          (order.couponCode ? ' (' + escHtml(order.couponCode) + ')' : '') +
          '</span><strong>−₹' +
          Number(order.discount) +
          '</strong></div>'
        : ''
    }
    <div class="confirm-row"><span>Shipping</span><strong>₹${ship}</strong></div>
    <div class="confirm-row"><span>Total paid</span><strong>₹${grand}</strong></div>
    <div class="confirm-row"><span>Payment</span><strong>${escHtml(payLabel)}</strong></div>
    ${refLine}
    <div class="confirm-row"><span>Delivery to</span><strong>${escHtml(order.address)}</strong></div>
    ${footNote}`;
}

function ensureRazorpayScript() {
  return new Promise(function (resolve, reject) {
    if (typeof Razorpay !== 'undefined') {
      resolve();
      return;
    }
    const existing = document.querySelector('script[data-rrm-razorpay]');
    if (existing) {
      existing.addEventListener('load', function () { resolve(); });
      existing.addEventListener('error', function () { reject(new Error('Razorpay load failed')); });
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.async = true;
    s.dataset.rrmRazorpay = '1';
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('Razorpay load failed')); };
    document.head.appendChild(s);
  });
}

async function rollbackPendingOrder(orderId, sb) {
  if (sb) {
    await sb.from('order_items').delete().eq('order_id', orderId);
    await sb.from('orders').delete().eq('id', orderId);
  }
  const ordersLocal = JSON.parse(localStorage.getItem('rrm_orders') || '[]');
  saveOrders(ordersLocal.filter(function (o) { return o.id !== orderId; }));
}

async function handleRazorpayPaid(response, order, items) {
  const vr = await fetch('/.netlify/functions/razorpay-verify-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      razorpay_order_id: response.razorpay_order_id,
      razorpay_payment_id: response.razorpay_payment_id,
      razorpay_signature: response.razorpay_signature
    })
  });
  let json = {};
  try {
    json = await vr.json();
  } catch (e) {
    json = {};
  }
  if (!vr.ok || !json.ok) {
    showToast((json && json.error) || 'Payment verification failed. If money was debited, contact us with your order ID.');
    return;
  }
  const paymentRef = response.razorpay_payment_id || '';
  const sb = getSb();
  if (sb) {
    const upd = await sb
      .from('orders')
      .update({ status: 'Confirmed', payment_reference: paymentRef || 'Razorpay paid' })
      .eq('id', order.id);
    if (upd.error) {
      console.warn('orders status update after payment', upd.error);
      await sb.from('orders').update({ status: 'Confirmed' }).eq('id', order.id);
    }
  }
  const paidOrder = Object.assign({}, order, {
    status: 'Confirmed',
    payMethod: 'razorpay',
    paymentRef: paymentRef
  });
  const ordersLocal = JSON.parse(localStorage.getItem('rrm_orders') || '[]');
  const idx = ordersLocal.findIndex(function (o) { return o.id === order.id; });
  if (idx >= 0) {
    ordersLocal[idx] = paidOrder;
  } else {
    ordersLocal.unshift(paidOrder);
  }
  saveOrders(ordersLocal);
  saveCart([]);
  if (paidOrder.couponCode && !getSb()) {
    recordLocalCouponUse(paidOrder.couponCode);
  }
  setAppliedCouponSnapshot(null);
  await sendOrderEmail(paidOrder);
  await sendOrderConfirmationToCustomer(paidOrder);
  renderConfirmPage(paidOrder, items);
  navigate('confirm');
  showToast('Payment successful — order confirmed!');
}

async function placeOrder() {
  const name = document.getElementById('co-name').value.trim();
  const phone = document.getElementById('co-phone').value.trim();
  const addr = document.getElementById('co-addr1').value.trim();
  const city = document.getElementById('co-city').value.trim();
  const pin = document.getElementById('co-pin').value.trim();
  const emailVal = document.getElementById('co-email').value.trim();
  const policyAck = document.getElementById('co-policy-ack');
  if (!name || !phone || !emailVal || !addr || !city || !pin) { showToast('Please fill all required fields!'); return; }
  if (!policyAck || !policyAck.checked) {
    showToast('Please confirm you have read the order policy.');
    openPolicyModal();
    return;
  }
  const cart = getCart();
  if (!cart.length) { showToast('Your cart is empty!'); return; }
  const products = getProducts();
  const payMethod = 'razorpay';
  let subtotal = 0;
  const items = cart
    .map(function (item) {
      const p = products.find(x => x.id === item.id);
      if (!p) return null;
      const vl = String(item.variantLabel || '').trim();
      const unit = effectiveUnitPriceForCartLine(p, vl);
      const displayName = vl ? p.name + ' (' + vl + ')' : p.name;
      subtotal += unit * item.qty;
      return { id: item.id, name: displayName, price: unit, qty: item.qty, variantLabel: vl };
    })
    .filter(Boolean);
  const badLine = cart.find(function (item) {
    const p = products.find(function (x) {
      return x.id === item.id;
    });
    if (!p) return true;
    const vl = String(item.variantLabel || '').trim();
    return item.qty > maxQtyForCartLine(p, vl);
  });
  if (badLine) {
    const p = products.find(function (x) {
      return x.id === badLine.id;
    });
    const maxQ = p ? maxQtyForCartLine(p, badLine.variantLabel) : 0;
    showToast(
      (p ? 'Only ' + maxQ + ' left in stock for ' + p.name + '.' : 'Stock changed.') +
        ' Please review your cart.'
    );
    void renderCart();
    return;
  }
  const stateVal = document.getElementById('co-state').value;
  const snap = getAppliedCouponSnapshot();
  const m = computeCheckoutMoney(cart, products, stateVal, snap);
  const weightKg = m.weightKg;
  const shipping = m.shipping;
  const discount = m.discount;
  const total = m.total;
  const couponCode = snap ? snap.code : '';
  if (m.subtotal < MIN_ORDER_AMOUNT_RS) {
    showToast('Minimum order (before coupon, excluding shipping) is ₹' + MIN_ORDER_AMOUNT_RS + '. Add more items to continue.');
    return;
  }
  const amountPaise = Math.round(total * 100);
  if (!Number.isFinite(amountPaise) || amountPaise < 100) {
    showToast('Invalid order total.');
    return;
  }
  const sb = getSb();
  let orderId;
  if (sb) {
    const remoteMax = await fetchMaxPmOrderNumberFromSupabase(sb);
    orderId = computeNextOrderId(remoteMax);
  } else {
    orderId = nextSiteOrderId();
  }
  const order = {
    id: orderId, name, phone,
    email: emailVal,
    address: `${addr}, ${city}, ${stateVal} - ${pin}`,
    items,
    subtotal: subtotal,
    discount: discount,
    couponCode: couponCode,
    shipping: shipping,
    total: total,
    totalWeightKg: weightKg,
    paymentRef: '',
    payMethod,
    date: new Date().toLocaleDateString('en-IN'),
    createdAt: new Date().toISOString(),
    status: 'Pending payment'
  };
  if (sb) {
    const customerBase = {
      name,
      phone,
      email: emailVal,
      address: order.address,
      discount_amount: discount > 0 ? discount : undefined,
      coupon_code: couponCode || undefined
    };
    let ins = await sb.from('orders').insert({
      id: orderId,
      customer: customerBase,
      subtotal: subtotal,
      total: total,
      payment_method: payMethod,
      payment_label: 'Razorpay',
      status: 'Pending payment',
      shipping_amount: shipping,
      total_weight_kg: weightKg,
      payment_reference: 'Pending Razorpay'
    });
    if (ins.error && orderInsertMissingColumnError(ins.error)) {
      const customer = Object.assign({}, customerBase, {
        shipping_amount: shipping,
        total_weight_kg: weightKg,
        payment_reference: 'Pending Razorpay'
      });
      ins = await sb.from('orders').insert({
        id: orderId,
        customer: customer,
        subtotal: subtotal,
        total: total,
        payment_method: payMethod,
        payment_label: 'Razorpay',
        status: 'Pending payment'
      });
    }
    if (ins.error && isDuplicateOrdersPkeyError(ins.error)) {
      const remoteMax2 = await fetchMaxPmOrderNumberFromSupabase(sb);
      orderId = computeNextOrderId(remoteMax2);
      order.id = orderId;
      ins = await sb.from('orders').insert({
        id: orderId,
        customer: customerBase,
        subtotal: subtotal,
        total: total,
        payment_method: payMethod,
        payment_label: 'Razorpay',
        status: 'Pending payment',
        shipping_amount: shipping,
        total_weight_kg: weightKg,
        payment_reference: 'Pending Razorpay'
      });
      if (ins.error && orderInsertMissingColumnError(ins.error)) {
        const customer2 = Object.assign({}, customerBase, {
          shipping_amount: shipping,
          total_weight_kg: weightKg,
          payment_reference: 'Pending Razorpay'
        });
        ins = await sb.from('orders').insert({
          id: orderId,
          customer: customer2,
          subtotal: subtotal,
          total: total,
          payment_method: payMethod,
          payment_label: 'Razorpay',
          status: 'Pending payment'
        });
      }
    }
    if (ins.error) {
      console.error(ins.error);
      showToast(formatSupabaseError(ins.error) || 'Could not save your order. Please try again or contact us.');
      return;
    }
    let rows = items.map(function (i) {
      const row = {
        order_id: orderId,
        product_id: String(i.id),
        name: i.name,
        price: i.price,
        qty: i.qty
      };
      if (i.variantLabel) row.variant_label = String(i.variantLabel);
      return row;
    });
    let ins2 = await sb.from('order_items').insert(rows);
    if (ins2.error && String(ins2.error.message || '').toLowerCase().includes('variant_label')) {
      rows = items.map(function (i) {
        return {
          order_id: orderId,
          product_id: String(i.id),
          name: i.name,
          price: i.price,
          qty: i.qty
        };
      });
      ins2 = await sb.from('order_items').insert(rows);
    }
    if (ins2.error) {
      console.error(ins2.error);
      await sb.from('orders').delete().eq('id', orderId);
      showToast('Order could not be completed. Please contact us.');
      return;
    }
  }

  const ordersLocal = JSON.parse(localStorage.getItem('rrm_orders') || '[]');
  ordersLocal.unshift(order);
  saveOrders(ordersLocal);

  try {
    await ensureRazorpayScript();
  } catch (e) {
    console.error(e);
    await rollbackPendingOrder(orderId, sb);
    showToast('Payment could not load. Check your connection and try again.');
    return;
  }

  let createData;
  try {
    const createRes = await fetch('/.netlify/functions/razorpay-create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountPaise: amountPaise, siteOrderId: orderId, currency: 'INR' })
    });
    createData = await createRes.json().catch(function () { return {}; });
    if (!createRes.ok) {
      throw new Error((createData && createData.error) || 'Could not start payment');
    }
  } catch (e) {
    console.error(e);
    await rollbackPendingOrder(orderId, sb);
    showToast(e.message || 'Could not start payment. Deploy on Netlify with Razorpay keys configured.');
    return;
  }

  const rzp = new Razorpay({
    key: createData.keyId,
    order_id: createData.orderId,
    currency: createData.currency || 'INR',
    name: 'Preserving Memories',
    description: 'Order ' + orderId,
    theme: { color: '#1A4A8A' },
    prefill: { name: name, email: emailVal, contact: phone },
    handler: function (response) {
      void handleRazorpayPaid(response, order, items);
    },
    modal: {
      ondismiss: function () {
        showToast('Payment window closed. Your order is still pending — tap Pay again to complete.');
      }
    }
  });
  rzp.on('payment.failed', function (response) {
    const desc = response && response.error && response.error.description;
    showToast(desc || 'Payment failed. You can try again from checkout.');
  });
  rzp.open();
}

// ============================================================
// ADMIN
// ============================================================
let adminLoggedIn = false;
let deleteTargetId = null;
let editingProductId = null;
let selectedSaleProductIds = new Set();
let instoreSalesCache = [];

/** Live storefront reads from Supabase when this is true. Legacy admin login cannot update the DB. */
function storeUsesSupabaseCatalog() {
  return !!(getSb() && catalogFromRemote);
}

function blockLegacyAdminWhenLiveCatalog() {
  if (storeUsesSupabaseCatalog() && !adminRemoteSession()) {
    showToast(
      'Sign in with your Supabase admin email and password to change prices for all shoppers. The admin / resin2024 login only works when the store is offline.'
    );
    return true;
  }
  return false;
}

async function doLogin() {
  const u = document.getElementById('admin-user').value.trim();
  const p = document.getElementById('admin-pass').value;
  const err = document.getElementById('login-error');
  err.style.display = 'none';
  const sb = getSb();
  if (sb) {
    const res = await sb.auth.signInWithPassword({ email: u, password: p });
    if (!res.error) {
      const sess = await sb.auth.getSession();
      authSession = sess.data.session;
      adminLoggedIn = true;
      document.getElementById('admin-login').style.display = 'none';
      document.getElementById('admin-panel').style.display = 'block';
      await refreshOrdersCache();
      void loadAdminDashboard();
      return;
    }
  }
  if (u === 'admin' && p === 'resin2024') {
    adminLoggedIn = true;
    document.getElementById('admin-login').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
    void loadAdminDashboard();
  } else {
    err.style.display = 'block';
  }
}

async function adminLogout() {
  adminLoggedIn = false;
  const sb = getSb();
  if (sb && authSession) await sb.auth.signOut();
  authSession = null;
  ordersCache = [];
  document.getElementById('admin-panel').style.display = 'none';
  navigate('home');
}

function adminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.classList.toggle('active', t.getAttribute('data-admin-tab') === tab);
  });
  document.querySelectorAll('.admin-tab-content').forEach(el => {
    el.classList.toggle('active', el.id === 'admin-' + tab);
  });
  if (tab === 'dashboard') void loadAdminDashboard();
  if (tab === 'products') loadAdminProducts();
  if (tab === 'orders') void loadAdminOrders();
  if (tab === 'messages') void loadAdminMessages();
  if (tab === 'coupons') void loadAdminCoupons();
  if (tab === 'instore') void loadAdminInstore();
}

function orderPlacedAtDate(o) {
  if (o && o.createdAt) {
    const ms = Date.parse(String(o.createdAt));
    if (Number.isFinite(ms)) return new Date(ms);
  }
  if (o && o.date) {
    const parts = String(o.date)
      .trim()
      .split(/[\/\-]/);
    if (parts.length === 3) {
      const a = Number(parts[0]);
      const b = Number(parts[1]);
      const c = Number(parts[2]);
      if (c >= 1900 && b >= 1 && b <= 12 && a >= 1 && a <= 31) {
        const t = new Date(c, b - 1, a);
        if (Number.isFinite(t.getTime())) return t;
      }
    }
  }
  return null;
}

function orderMatchesRevenuePeriod(o, period, dayStr, monthStr, yearStr) {
  if (!period || period === 'all') return true;
  const d = orderPlacedAtDate(o);
  if (!d) return false;
  if (period === 'day') {
    if (!dayStr || !String(dayStr).trim()) return true;
    const p = String(dayStr).split('-').map(Number);
    if (p.length !== 3 || !p.every(function (n) { return Number.isFinite(n); })) return true;
    return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
  }
  if (period === 'month') {
    if (!monthStr || !String(monthStr).trim()) return true;
    const p = String(monthStr).split('-').map(Number);
    if (p.length !== 2 || !p.every(function (n) { return Number.isFinite(n); })) return true;
    return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1;
  }
  if (period === 'year') {
    const y = Number(yearStr);
    if (!Number.isFinite(y) || y < 1900) return true;
    return d.getFullYear() === y;
  }
  return true;
}

function orderMatchesRevenueStatusFilter(o, statusFilter) {
  const st = o.status || '';
  const key = String(statusFilter || '__pipeline__');
  if (key === '__pipeline__') {
    return !!{ Confirmed: true, Paid: true, Shipped: true, Delivered: true }[st];
  }
  if (key === '__any__') return true;
  return st === key;
}

function computeFilteredRevenue(orders) {
  const periodEl = document.getElementById('admin-revenue-period');
  const dayEl = document.getElementById('admin-revenue-day');
  const monthEl = document.getElementById('admin-revenue-month');
  const yearEl = document.getElementById('admin-revenue-year');
  const statusEl = document.getElementById('admin-revenue-status');
  const period = periodEl ? periodEl.value : 'all';
  const dayStr = dayEl ? dayEl.value : '';
  const monthStr = monthEl ? monthEl.value : '';
  const yearStr = yearEl ? yearEl.value : '';
  const statusFilter = statusEl ? statusEl.value : '__pipeline__';
  let count = 0;
  const sum = orders.reduce(function (s, o) {
    if (!orderMatchesRevenuePeriod(o, period, dayStr, monthStr, yearStr)) return s;
    if (!orderMatchesRevenueStatusFilter(o, statusFilter)) return s;
    count += 1;
    return s + (o.total != null ? o.total : o.subtotal + (o.shipping || 0));
  }, 0);
  return { sum: sum, count: count, period: period, statusFilter: statusFilter };
}

function syncAdminRevenueFilterInputs() {
  const periodEl = document.getElementById('admin-revenue-period');
  const dayWrap = document.getElementById('admin-revenue-day-wrap');
  const monthWrap = document.getElementById('admin-revenue-month-wrap');
  const yearWrap = document.getElementById('admin-revenue-year-wrap');
  const dayEl = document.getElementById('admin-revenue-day');
  const monthEl = document.getElementById('admin-revenue-month');
  const yearEl = document.getElementById('admin-revenue-year');
  if (!periodEl) return;
  const period = periodEl.value;
  const showDay = period === 'day';
  const showMonth = period === 'month';
  const showYear = period === 'year';
  if (dayWrap) dayWrap.style.display = showDay ? '' : 'none';
  if (monthWrap) monthWrap.style.display = showMonth ? '' : 'none';
  if (yearWrap) yearWrap.style.display = showYear ? '' : 'none';
  const now = new Date();
  if (dayEl && showDay && !dayEl.value) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    dayEl.value = y + '-' + m + '-' + d;
  }
  if (monthEl && showMonth && !monthEl.value) {
    monthEl.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  }
  if (yearEl && showYear && (yearEl.value === '' || !Number(yearEl.value))) {
    yearEl.value = String(now.getFullYear());
  }
}

function updateAdminRevenueDisplay() {
  const orders = getOrders();
  syncAdminRevenueFilterInputs();
  const r = computeFilteredRevenue(orders);
  const valEl = document.getElementById('admin-revenue-value');
  const subEl = document.getElementById('admin-revenue-sub');
  const countEl = document.getElementById('admin-revenue-count');
  if (valEl) valEl.textContent = '₹' + r.sum.toLocaleString('en-IN');
  if (countEl) countEl.textContent = String(r.count) + ' order' + (r.count === 1 ? '' : 's');
  if (subEl) {
    const periodNames = { all: 'All dates', day: 'Selected day', month: 'Selected month', year: 'Selected year' };
    const st = r.statusFilter === '__pipeline__' ? 'Confirmed / Paid / Shipped / Delivered' : r.statusFilter === '__any__' ? 'Any status' : r.statusFilter;
    subEl.textContent = (periodNames[r.period] || '') + ' · ' + st;
  }
}

function onAdminRevenueFilterChange() {
  syncAdminRevenueFilterInputs();
  updateAdminRevenueDisplay();
}

async function loadAdminDashboard() {
  if (adminRemoteSession()) await refreshOrdersCache();
  const products = getProducts();
  const orders = getOrders();
  const today = new Date().toLocaleDateString('en-IN');
  const todayOrders = orders.filter(o => o.date === today).length;
  document.getElementById('stat-cards').innerHTML = `
    <div class="stat-card"><div class="stat-label">Total Products</div><div class="stat-value">${products.length}</div><div class="stat-sub">${products.filter(p=>p.inStock).length} in stock</div></div>
    <div class="stat-card"><div class="stat-label">Total Orders</div><div class="stat-value">${orders.length}</div><div class="stat-sub">All time</div></div>
    <div class="stat-card"><div class="stat-label">Orders Today</div><div class="stat-value">${todayOrders}</div><div class="stat-sub">${today}</div></div>`;
  syncAdminRevenueFilterInputs();
  updateAdminRevenueDisplay();
  const tbody = document.getElementById('recent-orders-body');
  tbody.innerHTML = orders.slice(0,5).map(o => `
    <tr><td><code style="font-size:12px;">#${o.id}</code></td><td>${o.name}</td><td>${o.items.length} item(s)</td>
    <td>₹${o.total != null ? o.total : o.subtotal}</td><td style="text-transform:uppercase;font-size:12px;">${o.payMethod}</td>
    <td><span style="background:${statusColor(o.status)};padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;">${o.status}</span></td></tr>
  `).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px;">No orders yet.</td></tr>`;
}

async function applyBulkSaleDiscount() {
  if (blockLegacyAdminWhenLiveCatalog()) return;
  const selectedIds = Array.from(selectedSaleProductIds);
  if (!selectedIds.length) {
    showToast('Select at least one product to apply sale.');
    return;
  }
  const pctRaw = Number((document.getElementById('bulk-sale-pct') || {}).value);
  if (!Number.isFinite(pctRaw) || pctRaw <= 0 || pctRaw >= 100) {
    showToast('Enter a valid sale % (1 to 95).');
    return;
  }
  const pct = Math.min(95, Math.max(1, Math.floor(pctRaw)));
  const products = getProducts();
  products.forEach(function (p) {
    if (!selectedSaleProductIds.has(String(p.id))) return;
    const base = (p.compareAtPrice != null && Number(p.compareAtPrice) > Number(p.price))
      ? Number(p.compareAtPrice)
      : Number(p.price);
    p.compareAtPrice = roundPrice(base);
    p.price = salePriceFromPercent(base, pct);
  });
  if (adminRemoteSession()) {
    const sb = getSb();
    for (const p of products) {
      const row = productToRow(p);
      const payload = Object.assign({}, row);
      delete payload.id;
      const { error } = await sb.from('products').update(payload).eq('id', String(p.id));
      if (error) {
        console.error(error);
        showToast(formatSupabaseError(error) || 'Could not apply bulk sale.');
        await refreshCatalog();
        loadAdminProducts();
        return;
      }
    }
    await refreshCatalog();
  } else {
    saveProducts(products);
  }
  loadAdminProducts();
  paintShopGrid();
  paintFeaturedGrid();
  showToast('Sale applied to selected products.');
}

async function clearBulkSaleDiscount() {
  if (blockLegacyAdminWhenLiveCatalog()) return;
  const selectedIds = Array.from(selectedSaleProductIds);
  if (!selectedIds.length) {
    showToast('Select at least one product to clear sale.');
    return;
  }
  const products = getProducts();
  products.forEach(function (p) {
    if (!selectedSaleProductIds.has(String(p.id))) return;
    const mrp = p.compareAtPrice != null ? Number(p.compareAtPrice) : NaN;
    if (Number.isFinite(mrp) && mrp > Number(p.price)) {
      p.price = roundPrice(mrp);
    }
    p.compareAtPrice = null;
  });
  if (adminRemoteSession()) {
    const sb = getSb();
    for (const p of products) {
      const row = productToRow(p);
      const payload = Object.assign({}, row);
      delete payload.id;
      const { error } = await sb.from('products').update(payload).eq('id', String(p.id));
      if (error) {
        console.error(error);
        showToast(formatSupabaseError(error) || 'Could not clear bulk sale.');
        await refreshCatalog();
        loadAdminProducts();
        return;
      }
    }
    await refreshCatalog();
  } else {
    saveProducts(products);
  }
  loadAdminProducts();
  paintShopGrid();
  paintFeaturedGrid();
  showToast('Sale cleared for selected products.');
}

function toggleSaleSelection(productId, checked) {
  const id = String(productId);
  if (checked) selectedSaleProductIds.add(id);
  else selectedSaleProductIds.delete(id);
  const allBoxes = document.querySelectorAll('.product-sale-checkbox');
  const checkedBoxes = document.querySelectorAll('.product-sale-checkbox:checked');
  const allToggle = document.getElementById('products-select-all');
  if (allToggle) allToggle.checked = allBoxes.length > 0 && allBoxes.length === checkedBoxes.length;
}

function toggleAllSaleSelection(checked) {
  document.querySelectorAll('.product-sale-checkbox').forEach(function (box) {
    box.checked = !!checked;
    const id = String(box.getAttribute('data-id') || '');
    if (!id) return;
    if (checked) selectedSaleProductIds.add(id);
    else selectedSaleProductIds.delete(id);
  });
}

function categoryImageUploadInputId(category) {
  return 'cat-img-file-' + encodeURIComponent(category);
}

function categoryImageUrlInputId(category) {
  return 'cat-img-url-' + encodeURIComponent(category);
}

function loadAdminCategoryImages() {
  const wrap = document.getElementById('admin-category-images-list');
  if (!wrap) return;
  const categories = getCategoriesList();
  if (!categories.length) {
    wrap.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">No categories yet.</div>';
    return;
  }
  wrap.innerHTML = categories.map(function (cat) {
    const safeCat = escHtml(cat);
    const encoded = encodeURIComponent(cat);
    const fileId = categoryImageUploadInputId(cat);
    const urlId = categoryImageUrlInputId(cat);
    const current = getCategoryImageUrl(cat);
    return `<div style="display:grid;grid-template-columns:minmax(120px,180px) 1fr auto auto auto;gap:10px;align-items:center;padding:10px;border:1px solid var(--border);border-radius:10px;margin-bottom:10px;">
      <div style="font-size:13px;font-weight:600;color:var(--ocean-dark);">${safeCat}</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <input type="text" id="${urlId}" value="${escHtml(current)}" placeholder="Paste image URL (https://...)"
          style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;">
        <input type="file" id="${fileId}" accept="image/*" style="font-size:12px;">
      </div>
      <button type="button" class="action-btn edit-btn" style="height:34px;" onclick="void saveCategoryImage('${encoded}')">Save</button>
      <button type="button" class="action-btn delete-btn" style="height:34px;" onclick="clearCategoryImage('${encoded}')">Clear img</button>
      <button type="button" class="action-btn delete-btn" style="height:34px;background:#8a97a8;" onclick="void deleteProductCategoryRow('${encoded}')">Delete</button>
    </div>`;
  }).join('');
}

async function saveCategoryImage(encodedCategory) {
  const category = decodeURIComponent(encodedCategory || '');
  if (!category) return;
  if (blockLegacyAdminWhenLiveCatalog()) return;
  const urlInput = document.getElementById(categoryImageUrlInputId(category));
  const fileInput = document.getElementById(categoryImageUploadInputId(category));
  let imgUrl = urlInput ? String(urlInput.value || '').trim() : '';
  const file = fileInput && fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
  if (!imgUrl && !file) {
    showToast('Add an image URL or choose a file first.');
    return;
  }
  try {
    if (file) {
      // Reuse existing uploader so admin can store category images in Supabase Storage.
      const uploaded = await uploadProductImageToSupabase(file, 'category-' + category.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
      imgUrl = uploaded || imgUrl;
      if (urlInput) urlInput.value = imgUrl;
      if (fileInput) fileInput.value = '';
    }
    const sb = getSb();
    if (!sb) {
      showToast('Supabase is not configured.');
      return;
    }
    const { error } = await sb.from('product_categories').upsert(
      { name: category, image_url: imgUrl || null },
      { onConflict: 'name' }
    );
    if (error) throw error;

    await refreshCategoriesCache();
    loadAdminCategoryImages();
    paintHomeCategoryGrid();
    showToast('Category image updated for ' + category + '.');
  } catch (e) {
    console.error(e);
    showToast(e.message || 'Could not save category image.');
  }
}

function clearCategoryImage(encodedCategory) {
  const category = decodeURIComponent(encodedCategory || '');
  if (!category) return;
  void (async function () {
    if (blockLegacyAdminWhenLiveCatalog()) return;
    const sb = getSb();
    if (!sb) {
      showToast('Supabase is not configured.');
      return;
    }
    try {
      const { error } = await sb.from('product_categories').upsert(
        { name: category, image_url: null },
        { onConflict: 'name' }
      );
      if (error) throw error;
      await refreshCategoriesCache();
      loadAdminCategoryImages();
      paintHomeCategoryGrid();
      showToast('Category image cleared for ' + category + '.');
    } catch (e) {
      console.error(e);
      showToast(e.message || 'Could not clear category image.');
    }
  })();
}

async function deleteProductCategoryRow(encoded) {
  const category = decodeURIComponent(encoded || '');
  if (!category) return;
  if (
    !confirm(
      'Remove "' +
        category +
        '" from the category list? Product records are not changed — edit products if they should use another category.'
    )
  ) {
    return;
  }
  if (blockLegacyAdminWhenLiveCatalog()) return;
  const sb = getSb();
  if (!sb) {
    showToast('Supabase is not configured.');
    return;
  }
  try {
    const { error } = await sb.from('product_categories').delete().eq('name', category);
    if (error) throw error;
    await refreshCategoriesCache();
    loadAdminCategoryImages();
    paintHomeCategoryGrid();
    paintShopGrid();
    paintFeaturedGrid();
    paintCategoryDatalist();
    showToast('Category removed from list.');
  } catch (e) {
    console.error(e);
    showToast(e.message || 'Could not delete category.');
  }
}

async function addNewCategory() {
  if (blockLegacyAdminWhenLiveCatalog()) return;
  const nameEl = document.getElementById('new-category-name');
  const urlEl = document.getElementById('new-category-img-url');
  const fileEl = document.getElementById('new-category-img-file');
  const name = nameEl ? String(nameEl.value || '').trim() : '';
  let imgUrl = urlEl ? String(urlEl.value || '').trim() : '';
  const file = fileEl && fileEl.files && fileEl.files[0] ? fileEl.files[0] : null;
  if (!name) {
    showToast('Enter a category name.');
    return;
  }
  if (!imgUrl && !file) {
    imgUrl = '';
  }
  try {
    if (file) {
      imgUrl = await uploadProductImageToSupabase(
        file,
        'category-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      ) || imgUrl;
      if (urlEl) urlEl.value = imgUrl || '';
      if (fileEl) fileEl.value = '';
    }
    const sb = getSb();
    if (!sb) {
      showToast('Supabase is not configured.');
      return;
    }
    const { error } = await sb.from('product_categories').upsert(
      { name: name, image_url: imgUrl || null },
      { onConflict: 'name' }
    );
    if (error) throw error;

    await refreshCategoriesCache();
    loadAdminCategoryImages();
    paintHomeCategoryGrid();
    paintShopGrid();
    paintFeaturedGrid();

    if (nameEl) nameEl.value = '';
    if (urlEl) urlEl.value = '';
  } catch (e) {
    console.error(e);
    showToast(e.message || 'Could not add category.');
  }
}

function productSortCompare(a, b, sortMode) {
  const mode = sortMode || 'name-asc';
  switch (mode) {
    case 'name-desc':
      return String(b.name).localeCompare(String(a.name));
    case 'price-asc': {
      const d = productSalePrice(a) - productSalePrice(b);
      return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
    }
    case 'price-desc': {
      const d2 = productSalePrice(b) - productSalePrice(a);
      return d2 !== 0 ? d2 : String(a.name).localeCompare(String(b.name));
    }
    case 'stock-asc': {
      const d3 = (Number(a.stockQty) || 0) - (Number(b.stockQty) || 0);
      return d3 !== 0 ? d3 : String(a.name).localeCompare(String(b.name));
    }
    case 'stock-desc': {
      const d4 = (Number(b.stockQty) || 0) - (Number(a.stockQty) || 0);
      return d4 !== 0 ? d4 : String(a.name).localeCompare(String(b.name));
    }
    case 'cat-asc': {
      const d5 = String(a.category || '').localeCompare(String(b.category || ''));
      return d5 !== 0 ? d5 : String(a.name).localeCompare(String(b.name));
    }
    default:
      return String(a.name).localeCompare(String(b.name));
  }
}

function adminProductSortCompare(a, b) {
  return productSortCompare(a, b, adminProductSort);
}

function onAdminProductSearchInput(v) {
  adminProductListQ = String(v || '')
    .trim()
    .toLowerCase();
  adminProductPage = 1;
  loadAdminProducts();
}

function onAdminProductSortChange(v) {
  adminProductSort = v || 'name-asc';
  adminProductPage = 1;
  loadAdminProducts();
}

function adminProductsGoToPage(n) {
  adminProductPage = Math.max(1, Math.floor(Number(n) || 1));
  loadAdminProducts();
}

async function toggleProductFeatured(productId) {
  if (blockLegacyAdminWhenLiveCatalog()) return;
  const products = getProducts();
  const p = products.find(function (x) {
    return String(x.id) === String(productId);
  });
  if (!p) return;
  const turningOn = !p.featured;
  if (turningOn) {
    const n = countFeaturedProductsInCatalog();
    if (n >= FEATURED_PRODUCTS_MAX) {
      showToast('You can feature at most ' + FEATURED_PRODUCTS_MAX + ' products. Remove one from featured first.');
      return;
    }
  }
  p.featured = turningOn;
  if (adminRemoteSession()) {
    const sb = getSb();
    const res = await sb.from('products').update({ is_featured: turningOn }).eq('id', String(productId));
    if (res.error) {
      p.featured = !turningOn;
      console.error(res.error);
      const blob = (String(res.error.message || '') + ' ' + String(res.error.details || '')).toLowerCase();
      const missingCol = blob.includes('is_featured') || blob.includes('column') || blob.includes('does not exist');
      showToast(
        missingCol
          ? 'Add the is_featured column: run supabase-migration-products-is-featured.sql in Supabase SQL Editor.'
          : formatSupabaseError(res.error) || 'Could not update featured flag.'
      );
      await refreshCatalog();
      loadAdminProducts();
      return;
    }
    await refreshCatalog();
  } else {
    saveProducts(products);
  }
  loadAdminProducts();
  paintFeaturedGrid();
  paintShopGrid();
}

/**
 * Quick stock adjust from admin table. Single-SKU: updates product stockQty.
 * Multi-size: +1 adds to first variant; −1 removes from first variant with stock (then next). Use Edit for precise sizes.
 */
async function adjustAdminProductStock(productId, delta) {
  const d = Math.trunc(Number(delta) || 0);
  if (d === 0) return;
  if (blockLegacyAdminWhenLiveCatalog()) return;
  const products = getProducts();
  const p = products.find(function (x) {
    return String(x.id) === String(productId);
  });
  if (!p) return;

  const prevTotal = Math.max(0, Math.floor(Number(p.stockQty) || 0));

  if (hasVariants(p)) {
    if (!p.variants || !p.variants.length) return;
    if (d > 0) {
      const v = p.variants[0];
      v.stockQty = Math.max(0, Math.floor(Number(v.stockQty) || 0) + d);
    } else {
      let left = -d;
      for (let i = 0; i < p.variants.length && left > 0; i++) {
        const cur = Math.max(0, Math.floor(Number(p.variants[i].stockQty) || 0));
        if (cur <= 0) continue;
        const take = Math.min(cur, left);
        p.variants[i].stockQty = cur - take;
        left -= take;
      }
    }
    syncVariantAggregateFields(p);
  } else {
    const cur = Math.max(0, Math.floor(Number(p.stockQty) || 0));
    p.stockQty = Math.max(0, cur + d);
    p.inStock = productInStock(p);
  }

  const newTotal = Math.max(0, Math.floor(Number(p.stockQty) || 0));
  if (d < 0 && newTotal === prevTotal) {
    showToast('Stock is already zero.');
    return;
  }

  if (adminRemoteSession()) {
    const sb = getSb();
    let payload = {
      stock_qty: newTotal,
      in_stock: productInStock(p)
    };
    if (hasVariants(p)) payload.variants = p.variants;
    let res = await sb.from('products').update(payload).eq('id', String(productId));
    if (res.error && String(res.error.message || '').toLowerCase().includes('variants')) {
      delete payload.variants;
      res = await sb.from('products').update(payload).eq('id', String(productId));
    }
    if (res.error) {
      console.error(res.error);
      showToast(formatSupabaseError(res.error) || 'Could not update stock.');
      await refreshCatalog();
      loadAdminProducts();
      return;
    }
    await refreshCatalog();
  } else {
    saveProducts(products);
  }
  loadAdminProducts();
  paintShopGrid();
  paintFeaturedGrid();
}

function loadAdminProducts() {
  let products = getProducts().slice();
  const validIds = new Set(products.map(function (p) { return String(p.id); }));
  selectedSaleProductIds.forEach(function (id) {
    if (!validIds.has(id)) selectedSaleProductIds.delete(id);
  });
  const q = adminProductListQ;
  if (q) {
    products = products.filter(function (p) {
      const extras = (p.extraCategories || []).join(' ');
      return (p.name + ' ' + p.category + ' ' + extras).toLowerCase().includes(q);
    });
  }
  products.sort(adminProductSortCompare);
  const total = products.length;
  const pages = Math.max(1, Math.ceil(total / ADMIN_PRODUCTS_PAGE));
  if (adminProductPage > pages) adminProductPage = pages;
  const start = (adminProductPage - 1) * ADMIN_PRODUCTS_PAGE;
  const slice = products.slice(start, start + ADMIN_PRODUCTS_PAGE);
  const sortSel = document.getElementById('admin-product-sort');
  if (sortSel) sortSel.value = adminProductSort;
  const infoEl = document.getElementById('admin-products-page-info');
  if (infoEl) {
    const featLine =
      total === 0 ? '' : ' · Home featured: ' + countFeaturedProductsInCatalog() + '/' + FEATURED_PRODUCTS_MAX;
    infoEl.textContent =
      total === 0
        ? 'No products match.'
        : 'Showing ' +
          (start + 1) +
          '–' +
          Math.min(start + slice.length, total) +
          ' of ' +
          total +
          ' (page ' +
          adminProductPage +
          ' / ' +
          pages +
          ')' +
          featLine;
  }
  const pagWrap = document.getElementById('admin-products-pagination');
  if (pagWrap) {
    if (pages <= 1) {
      pagWrap.innerHTML = '';
    } else {
      pagWrap.innerHTML =
        '<button type="button" class="pagination-btn" ' +
        (adminProductPage <= 1 ? 'disabled' : '') +
        ' onclick="adminProductsGoToPage(' +
        (adminProductPage - 1) +
        ')">Previous</button>' +
        '<span style="font-size:13px;color:var(--text-muted);">Page ' +
        adminProductPage +
        ' / ' +
        pages +
        '</span>' +
        '<button type="button" class="pagination-btn" ' +
        (adminProductPage >= pages ? 'disabled' : '') +
        ' onclick="adminProductsGoToPage(' +
        (adminProductPage + 1) +
        ')">Next</button>';
    }
  }
  document.getElementById('products-tbody').innerHTML = slice
    .map(function (p) {
      const idJs = JSON.stringify(String(p.id));
      const imgContent = p.img
        ? `<img src="${escAttr(p.img)}" alt="${escHtml(p.name)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'">`
        : `<span>${p.emoji}</span>`;
      const sale = productSalePrice(p);
      const mrp = productCompareAtPrice(p);
      const pct = productDiscountPercent(p);
      const priceHtml =
        mrp && mrp > sale
          ? `<div><strong>₹${sale}</strong> <span style="text-decoration:line-through;color:var(--text-muted);font-size:12px;">₹${mrp}</span> <span style="font-size:11px;color:#A12222;font-weight:700;">${pct}% OFF</span></div>`
          : `<strong>₹${sale}</strong>`;
      const checked = selectedSaleProductIds.has(String(p.id)) ? 'checked' : '';
      const sizeHint = hasVariants(p)
        ? ' <span style="font-size:11px;font-weight:600;color:var(--ocean-dark);">· sizes</span>'
        : '';
      const xn = p.extraCategories && p.extraCategories.length;
      const catHtml =
        '<span style="font-size:12px;background:var(--sand);padding:3px 10px;border-radius:20px;">' +
        escHtml(p.category) +
        '</span>' +
        (xn ? ' <span style="font-size:10px;color:var(--text-muted);">+' + xn + '</span>' : '');
      const stockN = Math.max(0, Math.floor(Number(p.stockQty) || 0));
      const stockMinusDisabled = stockN <= 0 ? ' disabled' : '';
      const multiTitle = hasVariants(p)
        ? ' title="' +
          escAttr('Multiple sizes: + adds to first size; − removes from first in-stock size. Use Edit for full control.') +
          '"'
        : '';
      const stockCell =
        '<div class="admin-stock-ctrl"' +
        multiTitle +
        '>' +
        '<button type="button"' +
        stockMinusDisabled +
        ' aria-label="Decrease stock" onclick=\'void adjustAdminProductStock(' +
        idJs +
        ',-1)\'>−</button>' +
        '<span class="admin-stock-val">' +
        stockN +
        '</span>' +
        '<button type="button" aria-label="Increase stock" onclick=\'void adjustAdminProductStock(' +
        idJs +
        ',1)\'>+</button>' +
        '</div>';
      const featCell = p.featured
        ? '<button type="button" class="action-btn edit-btn" onclick=\'void toggleProductFeatured(' +
          idJs +
          ')\' title="Remove from home featured row">★ Featured</button>'
        : '<button type="button" class="action-btn" style="background:var(--sand);color:var(--ocean-dark);border:1px solid var(--border);" onclick=\'void toggleProductFeatured(' +
          idJs +
          ')\' title="Add to home featured (max ' +
          FEATURED_PRODUCTS_MAX +
          ')">+ Feature</button>';
      return `<tr>
      <td><input type="checkbox" class="product-sale-checkbox" data-id="${escAttr(String(p.id))}" ${checked} onchange='toggleSaleSelection(${idJs}, this.checked)'></td>
      <td><div class="table-img">${imgContent}</div></td>
      <td><strong>${escHtml(p.name)}</strong>${sizeHint}</td>
      <td>${catHtml}</td>
      <td>${priceHtml}</td>
      <td>${stockCell}</td>
      <td style="vertical-align:middle;">${featCell}</td>
      <td style="display:flex;gap:6px;padding-top:18px;">
        <button class="action-btn edit-btn" onclick='openProductModal(${idJs})'>Edit</button>
        <button class="action-btn delete-btn" onclick='openDeleteModal(${idJs})'>Delete</button>
      </td>
    </tr>`;
    })
    .join('');
  const allToggle = document.getElementById('products-select-all');
  if (allToggle) {
    const allBoxes = document.querySelectorAll('.product-sale-checkbox');
    const checkedBoxes = document.querySelectorAll('.product-sale-checkbox:checked');
    allToggle.checked = allBoxes.length > 0 && allBoxes.length === checkedBoxes.length;
  }
  loadAdminCategoryImages();
}

function renderCouponExcludeProductPicker() {
  const wrap = document.getElementById('coupon-form-excluded-list');
  if (!wrap) return;
  const products = getProducts()
    .slice()
    .sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  wrap.innerHTML = products.length
    ? products
        .map(function (p) {
          const id = String(p.id);
          return (
            '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;margin-bottom:6px;cursor:pointer;line-height:1.35;">' +
            '<input type="checkbox" class="coupon-exclude-cb" value="' +
            escAttr(id) +
            '" style="margin-top:2px;flex-shrink:0;">' +
            '<span>' +
            escHtml(p.name) +
            '</span></label>'
          );
        })
        .join('')
    : '<span style="font-size:12px;color:var(--text-muted);">No products in catalog.</span>';
}

function collectCouponFormExcludedProductIds() {
  const ids = [];
  document.querySelectorAll('.coupon-exclude-cb:checked').forEach(function (cb) {
    const v = String(cb.value || '').trim();
    if (v) ids.push(v);
  });
  return ids;
}

async function loadAdminCoupons() {
  const tb = document.getElementById('coupons-tbody');
  if (!tb) return;
  renderCouponExcludeProductPicker();
  let rows = [];
  let useRedemptionCounts = false;
  const redemptionCounts = {};
  if (adminRemoteSession()) {
    const sb = getSb();
    const r = await sb.from('store_coupons').select('*').order('code', { ascending: true });
    if (!r.error && r.data) {
      rows = r.data;
      useRedemptionCounts = true;
      const redR = await sb.from('coupon_redemptions').select('coupon_code');
      if (redR.error) {
        console.warn('coupon_redemptions', redR.error);
      } else if (redR.data) {
        redR.data.forEach(function (rec) {
          const k = String(rec.coupon_code || '')
            .trim()
            .toUpperCase();
          if (k) redemptionCounts[k] = (redemptionCounts[k] || 0) + 1;
        });
      }
    } else {
      if (r.error) console.warn('store_coupons', r.error);
      rows = readLocalCouponsList();
    }
  } else {
    rows = readLocalCouponsList();
  }
  tb.innerHTML = rows.length
    ? rows
        .map(function (row) {
          const code = String(row.code || '');
          const codeKey = code.trim().toUpperCase();
          const kind = row.kind === 'fixed' ? 'fixed' : 'percent';
          const amt = Number(row.amount);
          const minS = Number(row.min_subtotal != null ? row.min_subtotal : row.minSubtotal) || 0;
          const act = row.active !== false;
          const maxU =
            row.max_uses != null
              ? Number(row.max_uses)
              : row.maxUses != null
                ? Number(row.maxUses)
                : null;
          const used = useRedemptionCounts
            ? redemptionCounts[codeKey] || 0
            : getLocalCouponUseCount(codeKey);
          let usesDisp;
          if (Number.isFinite(maxU) && maxU > 0) {
            usesDisp = used + ' / ' + maxU;
          } else if (used > 0) {
            usesDisp = String(used);
          } else {
            usesDisp = '—';
          }
          const amtDisp = kind === 'percent' ? escHtml(String(amt)) + '%' : '₹' + escHtml(String(amt));
          const capRaw =
            row.max_discount_rs != null ? Number(row.max_discount_rs) : row.maxDiscountRs != null ? Number(row.maxDiscountRs) : null;
          const capDisp =
            Number.isFinite(capRaw) && capRaw > 0 ? '₹' + escHtml(String(Math.round(capRaw))) : '—';
          const excl = parseExcludedProductIds(row.excluded_product_ids || row.excludedProductIds);
          const exclDisp = excl.length ? escHtml(String(excl.length)) : '—';
          return (
            '<tr>' +
            '<td><strong>' +
            escHtml(code) +
            '</strong></td>' +
            '<td>' +
            (kind === 'percent' ? 'Percent' : 'Fixed ₹') +
            '</td>' +
            '<td>' +
            amtDisp +
            '</td>' +
            '<td>₹' +
            minS +
            '</td>' +
            '<td>' +
            capDisp +
            '</td>' +
            '<td>' +
            exclDisp +
            '</td>' +
            '<td>' +
            (act ? 'Yes' : 'No') +
            '</td>' +
            '<td>' +
            escHtml(usesDisp) +
            '</td>' +
            '<td style="display:flex;gap:6px;align-items:center;">' +
            '<button type="button" class="action-btn" style="background:var(--sand);color:var(--ocean-dark);border:1px solid var(--border);" onclick=\'void toggleCouponActiveAdmin(' +
            JSON.stringify(code) +
            ',' +
            (act ? 'false' : 'true') +
            ')\'>'
            + (act ? 'Disable' : 'Enable') +
            '</button>' +
            '<button type="button" class="action-btn delete-btn" onclick=\'void deleteCouponAdmin(' +
            JSON.stringify(code) +
            ')\'>Delete</button></td>' +
            '</tr>'
          );
        })
        .join('')
    : '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:24px;">No coupons yet. Add one above.</td></tr>';
}

async function saveCouponFromAdminForm() {
  if (blockLegacyAdminWhenLiveCatalog()) return;
  const codeEl = document.getElementById('coupon-form-code');
  const kindEl = document.getElementById('coupon-form-kind');
  const amtEl = document.getElementById('coupon-form-amount');
  const minEl = document.getElementById('coupon-form-min');
  const maxUsesEl = document.getElementById('coupon-form-max-uses');
  const maxDiscCapEl = document.getElementById('coupon-form-max-discount-rs');
  const actEl = document.getElementById('coupon-form-active');
  const code = codeEl ? String(codeEl.value || '').trim().toUpperCase() : '';
  const kind = kindEl && kindEl.value === 'fixed' ? 'fixed' : 'percent';
  const amount = amtEl ? Number(amtEl.value) : NaN;
  const minS = minEl && minEl.value !== '' ? Number(minEl.value) : 0;
  const active = actEl ? actEl.checked : true;
  let maxUses = null;
  if (maxUsesEl && String(maxUsesEl.value || '').trim() !== '') {
    const mu = Number(maxUsesEl.value);
    if (!Number.isFinite(mu) || mu < 1 || Math.floor(mu) !== mu) {
      showToast('Max uses must be a positive whole number or left blank for unlimited.');
      return;
    }
    maxUses = mu;
  }
  let maxDiscountRs = null;
  if (maxDiscCapEl && String(maxDiscCapEl.value || '').trim() !== '') {
    const cap = Number(maxDiscCapEl.value);
    if (!Number.isFinite(cap) || cap <= 0) {
      showToast('Max discount (₹) must be a positive amount or left blank.');
      return;
    }
    maxDiscountRs = roundPrice(cap);
  }
  const excludedProductIds = collectCouponFormExcludedProductIds();
  if (!code) {
    showToast('Enter a coupon code.');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast('Enter a valid amount.');
    return;
  }
  if (kind === 'percent' && amount > 95) {
    showToast('Percent off cannot exceed 95.');
    return;
  }
  const payload = {
    code: code,
    kind: kind,
    amount: amount,
    min_subtotal: Number.isFinite(minS) ? Math.max(0, minS) : 0,
    active: active,
    max_uses: maxUses,
    max_discount_rs: maxDiscountRs,
    excluded_product_ids: excludedProductIds.length ? excludedProductIds : []
  };
  if (adminRemoteSession()) {
    const sb = getSb();
    const { error } = await sb.from('store_coupons').upsert(payload, { onConflict: 'code' });
    if (error) {
      console.error(error);
      showToast(
        formatSupabaseError(error) ||
          'Could not save coupon (run coupon migrations, including supabase-migration-coupon-cap-exclusions.sql).'
      );
      const list = readLocalCouponsList().filter(function (c) {
        return String(c.code).toUpperCase() !== code;
      });
      list.push(
        Object.assign({}, payload, {
          minSubtotal: payload.min_subtotal,
          max_uses: payload.max_uses,
          max_discount_rs: payload.max_discount_rs,
          excluded_product_ids: payload.excluded_product_ids
        })
      );
      writeLocalCouponsList(list);
      await loadAdminCoupons();
      return;
    }
  } else {
    const list = readLocalCouponsList().filter(function (c) {
      return String(c.code).toUpperCase() !== code;
    });
    list.push(
      Object.assign({}, payload, {
        minSubtotal: payload.min_subtotal,
        max_uses: payload.max_uses,
        max_discount_rs: payload.max_discount_rs,
        excluded_product_ids: payload.excluded_product_ids
      })
    );
    writeLocalCouponsList(list);
  }
  if (codeEl) codeEl.value = '';
  if (amtEl) amtEl.value = '';
  if (minEl) minEl.value = '';
  if (maxUsesEl) maxUsesEl.value = '';
  if (maxDiscCapEl) maxDiscCapEl.value = '';
  document.querySelectorAll('.coupon-exclude-cb').forEach(function (cb) {
    cb.checked = false;
  });
  showToast('Coupon saved.');
  await loadAdminCoupons();
}

async function deleteCouponAdmin(code) {
  const c = String(code || '').trim();
  if (!c || !confirm('Delete coupon ' + c + '?')) return;
  if (blockLegacyAdminWhenLiveCatalog()) return;
  if (adminRemoteSession()) {
    const sb = getSb();
    const { error } = await sb.from('store_coupons').delete().eq('code', c);
    if (error) console.warn(error);
  }
  const list = readLocalCouponsList().filter(function (x) {
    return String(x.code).toUpperCase() !== c.toUpperCase();
  });
  writeLocalCouponsList(list);
  await loadAdminCoupons();
  showToast('Coupon removed.');
}

async function toggleCouponActiveAdmin(code, nextActive) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return;
  if (blockLegacyAdminWhenLiveCatalog()) return;
  if (adminRemoteSession()) {
    const sb = getSb();
    const { error } = await sb.from('store_coupons').update({ active: !!nextActive }).eq('code', c);
    if (error) console.warn(error);
  }
  const list = readLocalCouponsList();
  const idx = list.findIndex(function (x) {
    return String(x.code || '').trim().toUpperCase() === c;
  });
  if (idx >= 0) list[idx].active = !!nextActive;
  writeLocalCouponsList(list);
  await loadAdminCoupons();
  showToast('Coupon ' + c + ' ' + (nextActive ? 'enabled.' : 'disabled.'));
}

async function refreshInstoreSalesCache() {
  const sb = getSb();
  if (!sb) {
    instoreSalesCache = [];
    return;
  }
  const r = await sb.from('instore_pickup_sales').select('*').order('created_at', { ascending: false });
  if (r.error) {
    console.warn('instore_pickup_sales', r.error);
    instoreSalesCache = [];
    return;
  }
  instoreSalesCache = (r.data || []).map(function (row) {
    return {
      id: row.id,
      productId: row.product_id != null ? String(row.product_id) : '',
      productName: String(row.product_name || ''),
      qty: Math.max(1, Math.floor(Number(row.qty) || 1)),
      unitPrice: Number(row.unit_price) || 0,
      lineTotal: Number(row.line_total) || 0,
      createdAt: row.created_at || new Date().toISOString()
    };
  });
}

function populateInstoreProductPicker() {
  const sel = document.getElementById('instore-product');
  if (!sel) return;
  const options = getProducts()
    .slice()
    .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); })
    .map(function (p) {
      return '<option value="' + escAttr(String(p.id)) + '">' + escHtml(p.name) + '</option>';
    })
    .join('');
  sel.innerHTML = options || '<option value="">No products</option>';
}

function onInstoreProductChange() {
  const sel = document.getElementById('instore-product');
  const priceEl = document.getElementById('instore-price');
  if (!sel || !priceEl) return;
  const pid = String(sel.value || '');
  const p = getProducts().find(function (x) { return String(x.id) === pid; });
  if (!p) return;
  priceEl.value = String(Math.max(0, Math.round(Number(p.price) || 0)));
}

async function loadAdminInstore() {
  if (adminRemoteSession()) await refreshInstoreSalesCache();
  populateInstoreProductPicker();
  onInstoreProductChange();
  const rows = getInstoreSales();
  const tb = document.getElementById('instore-tbody');
  const sumEl = document.getElementById('instore-total-sum');
  if (sumEl) {
    const total = rows.reduce(function (s, r) { return s + (Number(r.lineTotal) || 0); }, 0);
    sumEl.textContent = '₹' + roundPrice(total);
  }
  if (!tb) return;
  tb.innerHTML = rows.length
    ? rows.map(function (r) {
        return '<tr>' +
          '<td>' + escHtml(new Date(r.createdAt || Date.now()).toLocaleString('en-IN')) + '</td>' +
          '<td>' + escHtml(r.productName || '—') + '</td>' +
          '<td>' + escHtml(String(r.qty || 0)) + '</td>' +
          '<td>₹' + escHtml(String(r.unitPrice || 0)) + '</td>' +
          '<td><strong>₹' + escHtml(String(r.lineTotal || 0)) + '</strong></td>' +
          '<td><button type="button" class="action-btn delete-btn" onclick=\'void deleteInstoreSaleEntry(' + JSON.stringify(String(r.id || '')) + ')\'>Delete</button></td>' +
          '</tr>';
      }).join('')
    : '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px;">No in-store entries yet.</td></tr>';
}

async function addInstoreSaleEntry() {
  if (blockLegacyAdminWhenLiveCatalog()) return;
  const productSel = document.getElementById('instore-product');
  const qtyEl = document.getElementById('instore-qty');
  const priceEl = document.getElementById('instore-price');
  const pid = productSel ? String(productSel.value || '') : '';
  const qty = qtyEl ? Math.floor(Number(qtyEl.value) || 0) : 0;
  const unitPrice = priceEl ? roundPrice(Number(priceEl.value) || 0) : 0;
  const p = getProducts().find(function (x) { return String(x.id) === pid; });
  if (!p || qty < 1 || unitPrice < 0) {
    showToast('Select product, quantity, and valid price.');
    return;
  }
  const entry = {
    id: 'IS-' + Date.now(),
    productId: String(p.id),
    productName: String(p.name || ''),
    qty: qty,
    unitPrice: unitPrice,
    lineTotal: roundPrice(unitPrice * qty),
    createdAt: new Date().toISOString()
  };
  if (adminRemoteSession()) {
    const sb = getSb();
    const { error } = await sb.from('instore_pickup_sales').insert({
      id: entry.id,
      product_id: entry.productId,
      product_name: entry.productName,
      qty: entry.qty,
      unit_price: entry.unitPrice,
      line_total: entry.lineTotal
    });
    if (error) {
      console.error(error);
      showToast('Could not save in-store entry. Run in-store migration first.');
      return;
    }
    await refreshInstoreSalesCache();
  } else {
    const rows = getInstoreSales();
    rows.unshift(entry);
    saveInstoreSales(rows);
  }
  if (qtyEl) qtyEl.value = '1';
  onInstoreProductChange();
  await loadAdminInstore();
  showToast('In-store entry saved.');
}

async function deleteInstoreSaleEntry(id) {
  const sid = String(id || '').trim();
  if (!sid) return;
  if (!confirm('Delete this in-store entry?')) return;
  if (blockLegacyAdminWhenLiveCatalog()) return;
  if (adminRemoteSession()) {
    const sb = getSb();
    const { error } = await sb.from('instore_pickup_sales').delete().eq('id', sid);
    if (error) {
      console.error(error);
      showToast('Delete failed.');
      return;
    }
    await refreshInstoreSalesCache();
  } else {
    const rows = getInstoreSales().filter(function (r) { return String(r.id) !== sid; });
    saveInstoreSales(rows);
  }
  await loadAdminInstore();
  showToast('In-store entry deleted.');
}

async function loadAdminOrders() {
  if (adminRemoteSession()) await refreshOrdersCache();
  const orders = getOrders();
  document.getElementById('orders-tbody').innerHTML = orders.map(o => `
    <tr>
      <td><code style="font-size:12px;">#${o.id}</code></td>
      <td>${o.name}</td><td>${o.phone}</td><td>₹${o.total != null ? o.total : o.subtotal}</td>
      <td style="text-transform:uppercase;font-size:12px;">${o.payMethod}</td>
      <td>${o.date}</td>
      <td>
        <select class="order-status-select" onchange="void updateOrderStatus('${o.id}',this.value)">
          ${['Pending payment','Pending','Paid','Confirmed','Shipped','Delivered','Cancelled'].map(s=>`<option ${s===o.status?'selected':''}>${s}</option>`).join('')}
        </select>
      </td>
      <td><button class="action-btn edit-btn" onclick="viewOrderDetail('${o.id}')">View</button></td>
    </tr>
  `).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:24px;">No orders yet.</td></tr>`;
}

function isConfirmedLikeStatus(s) {
  return s === 'Confirmed' || s === 'Paid';
}

function variantLabelFromOrderItem(item, p) {
  if (item && item.variantLabel != null && String(item.variantLabel).trim()) {
    return String(item.variantLabel).trim();
  }
  if (!hasVariants(p) || !item || !item.name) return '';
  const base = p.name;
  const n = String(item.name);
  const prefix = base + ' (';
  if (n.startsWith(prefix) && n.endsWith(')')) {
    return n.slice(prefix.length, -1).trim();
  }
  return '';
}

function deductStockForLineItem(p, item) {
  const q = Math.max(0, Math.floor(Number(item.qty) || 0));
  if (!p || q <= 0) return;
  const vlabel = variantLabelFromOrderItem(item, p);
  if (hasVariants(p) && vlabel) {
    const vi = p.variants.findIndex(function (v) {
      return String(v.label).trim() === vlabel;
    });
    if (vi >= 0) {
      p.variants[vi].stockQty = Math.max(0, Math.floor(Number(p.variants[vi].stockQty) || 0) - q);
    }
  } else {
    const currentQty = Number.isFinite(Number(p.stockQty)) ? Number(p.stockQty) : 0;
    p.stockQty = Math.max(0, currentQty - q);
  }
  if (hasVariants(p)) syncVariantAggregateFields(p);
  else p.inStock = productInStock(p);
}

async function applyStockDeductionForOrder(order) {
  if (!order || !order.items || !order.items.length) return;
  const products = getProducts();
  const touched = new Set();
  order.items.forEach(function (item) {
    const p = products.find(function (x) {
      return String(x.id) === String(item.id);
    });
    if (!p) return;
    deductStockForLineItem(p, item);
    touched.add(String(p.id));
  });
  if (adminRemoteSession()) {
    const sb = getSb();
    for (const pid of touched) {
      const p = products.find(function (x) {
        return String(x.id) === pid;
      });
      if (!p) continue;
      let payload = {
        stock_qty: Math.max(0, Math.floor(Number(p.stockQty) || 0)),
        in_stock: productInStock(p)
      };
      if (hasVariants(p)) payload.variants = p.variants;
      let res = await sb.from('products').update(payload).eq('id', pid);
      if (res.error && String(res.error.message || '').toLowerCase().includes('variants')) {
        delete payload.variants;
        res = await sb.from('products').update(payload).eq('id', pid);
      }
      if (res.error) {
        console.error(res.error);
        showToast('Stock deduction failed. Check products table columns (stock_qty, variants).');
        return;
      }
    }
    await refreshCatalog();
    await sendMerchantStockAlertEmail(order);
    return;
  }
  saveProducts(products);
  await sendMerchantStockAlertEmail(order);
}

async function updateOrderStatus(id, status) {
  let prevStatus = '';
  let orderForEmail = null;
  if (adminRemoteSession()) {
    await refreshOrdersCache();
    const before = getOrders().find(function (x) { return x.id === id; });
    prevStatus = before ? before.status : '';
    const sb = getSb();
    const { error } = await sb.from('orders').update({ status: status }).eq('id', id);
    if (error) console.error(error);
    await refreshOrdersCache();
    orderForEmail = getOrders().find(function (x) { return x.id === id; });
    void loadAdminOrders();
  } else {
    const orders = getOrders();
    const o = orders.find(x => x.id === id);
    if (o) {
      prevStatus = o.status;
      o.status = status;
      orderForEmail = o;
      saveOrders(orders);
    }
  }
  const wasPendingPay = prevStatus === 'Pending payment' || prevStatus === 'Pending';
  const nowConfirmed = status === 'Paid' || status === 'Confirmed';
  const crossedIntoConfirmed = !isConfirmedLikeStatus(prevStatus) && isConfirmedLikeStatus(status);
  if (orderForEmail && crossedIntoConfirmed) {
    await applyStockDeductionForOrder(orderForEmail);
    loadAdminProducts();
    paintShopGrid();
    paintFeaturedGrid();
  }
  if (orderForEmail && wasPendingPay && nowConfirmed && orderForEmail.email) {
    orderForEmail.status = status;
    await sendOrderConfirmationToCustomer(orderForEmail);
  }
}

function viewOrderDetail(id) {
  const o = getOrders().find(x => x.id === id);
  if (!o) return;
  document.getElementById('order-modal-content').innerHTML = `
    <div class="order-detail-row"><span>Order ID</span><strong>#${o.id}</strong></div>
    <div class="order-detail-row"><span>Customer</span><strong>${o.name}</strong></div>
    <div class="order-detail-row"><span>Phone</span><strong>${o.phone}</strong></div>
    <div class="order-detail-row"><span>Email</span><strong>${o.email||'—'}</strong></div>
    <div class="order-detail-row"><span>Address</span><strong>${o.address}</strong></div>
    <div class="order-detail-row"><span>Payment</span><strong style="text-transform:uppercase;">${o.payMethod}</strong></div>
    <div class="order-detail-row"><span>Payment ref</span><strong>${escHtml(o.paymentRef || '—')}</strong></div>
    <div class="order-detail-row"><span>Date</span><strong>${o.date}</strong></div>
    <div class="order-detail-row"><span>Status</span><strong>${o.status}</strong></div>
    <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px;">
      <strong style="font-size:14px;display:block;margin-bottom:10px;">Items Ordered</strong>
      ${o.items.map(i=>`<div class="order-detail-row"><span>${i.name} ×${i.qty}</span><strong>₹${i.price*i.qty}</strong></div>`).join('')}
      <div class="order-detail-row"><span>Subtotal</span><strong>₹${o.subtotal}</strong></div>
      ${
        Number(o.discount) > 0
          ? '<div class="order-detail-row"><span>Discount' +
            (o.couponCode ? ' (' + escHtml(o.couponCode) + ')' : '') +
            '</span><strong>−₹' +
            Number(o.discount) +
            '</strong></div>'
          : ''
      }
      <div class="order-detail-row"><span>Shipping</span><strong>₹${o.shipping != null ? o.shipping : 0}</strong></div>
      <div class="order-detail-row" style="font-weight:700;"><span>Grand total</span><strong>₹${o.total != null ? o.total : o.subtotal + (o.shipping || 0)}</strong></div>
    </div>`;
  openModal('order-modal');
}

async function toggleStock(id, val) {
  if (blockLegacyAdminWhenLiveCatalog()) return;
  if (adminRemoteSession()) {
    const sb = getSb();
    const { error } = await sb.from('products').update({ in_stock: val }).eq('id', id);
    if (error) {
      console.error(error);
      showToast(error.message || 'Could not update stock.');
      await refreshCatalog();
      loadAdminProducts();
      return;
    }
    await refreshCatalog();
    loadAdminProducts();
    paintShopGrid();
    paintFeaturedGrid();
    return;
  }
  const products = getProducts();
  const p = products.find(x => x.id === id);
  if (p) {
    p.inStock = val;
    saveProducts(products);
  }
  loadAdminProducts();
  paintShopGrid();
  paintFeaturedGrid();
}

function pmClearSizeRows() {
  const c = document.getElementById('pm-size-rows');
  if (c) c.innerHTML = '';
}

function pmAddSizeRow(pref) {
  const c = document.getElementById('pm-size-rows');
  if (!c) return;
  const row = document.createElement('div');
  row.className = 'pm-size-row';
  row.style.cssText =
    'display:grid;grid-template-columns:minmax(100px,1fr) 56px 52px 56px 56px 28px;gap:6px;align-items:center;margin-bottom:8px;font-size:12px;';
  const lab = pref && pref.label != null ? escAttr(pref.label) : '';
  const pr = pref && pref.price != null ? escAttr(pref.price) : '';
  const st = pref && pref.stockQty != null ? escAttr(pref.stockQty) : '';
  const wg = pref && pref.weightKg != null ? escAttr(pref.weightKg) : '';
  const ex = pref && pref.extraShippingRs ? escAttr(pref.extraShippingRs) : '';
  row.innerHTML =
    '<input type="text" class="pm-sz-label" placeholder="e.g. 500 ml" value="' +
    lab +
    '">' +
    '<input type="number" class="pm-sz-price" min="0" step="1" placeholder="₹" value="' +
    pr +
    '">' +
    '<input type="number" class="pm-sz-stock" min="0" step="1" placeholder="Qty" value="' +
    st +
    '">' +
    '<input type="number" class="pm-sz-weight" min="0.01" step="0.01" placeholder="kg" title="Shipping weight (blank = product weight)" value="' +
    wg +
    '">' +
    '<input type="number" class="pm-sz-extra" min="0" step="1" placeholder="+₹" title="Extra ₹/unit on top of weight-based rate" value="' +
    ex +
    '">' +
    '<button type="button" class="pm-sz-remove" onclick="window.pmRemoveSizeRow(this)" style="border:none;background:var(--sand);border-radius:6px;cursor:pointer;font-size:16px;line-height:1;" title="Remove">×</button>';
  c.appendChild(row);
}

function pmRemoveSizeRow(btn) {
  const row = btn && btn.closest ? btn.closest('.pm-size-row') : null;
  if (row) row.remove();
}

function pmToggleSizesEditor() {
  const cb = document.getElementById('pm-has-sizes');
  const wrap = document.getElementById('pm-sizes-editor-wrap');
  const stockEl = document.getElementById('pm-stock-qty');
  const discEl = document.getElementById('pm-discount-pct');
  if (!cb || !wrap) return;
  const on = cb.checked;
  wrap.style.display = on ? 'block' : 'none';
  if (stockEl) {
    stockEl.disabled = on;
    stockEl.title = on ? 'Stock is set per size in the table below.' : '';
  }
  if (on && discEl) discEl.value = '';
  if (on && document.getElementById('pm-size-rows') && !document.querySelector('#pm-size-rows .pm-size-row')) {
    pmAddSizeRow(null);
  }
}

function collectPmSizeRows() {
  const rows = document.querySelectorAll('.pm-size-row');
  const out = [];
  rows.forEach(function (row) {
    const label = (row.querySelector('.pm-sz-label') || {}).value;
    const price = parseFloat((row.querySelector('.pm-sz-price') || {}).value);
    const stock = parseInt((row.querySelector('.pm-sz-stock') || {}).value, 10);
    const wRaw = parseFloat((row.querySelector('.pm-sz-weight') || {}).value);
    const exRaw = parseFloat((row.querySelector('.pm-sz-extra') || {}).value);
    if (!String(label || '').trim()) return;
    if (!Number.isFinite(price) || price < 0) return;
    out.push({
      label: String(label).trim(),
      price: roundPrice(price),
      stockQty: Number.isFinite(stock) ? Math.max(0, stock) : 0,
      weightKg: Number.isFinite(wRaw) && wRaw > 0 ? wRaw : null,
      extraShippingRs: Number.isFinite(exRaw) && exRaw > 0 ? roundPrice(exRaw) : 0
    });
  });
  return normalizeVariantsArray(out);
}

window.pmRemoveSizeRow = pmRemoveSizeRow;
window.pmToggleSizesEditor = pmToggleSizesEditor;
window.pmAddSizeRowBlank = function () {
  pmAddSizeRow(null);
};

function ensurePmCategoryOption(cat) {
  const sel = document.getElementById('pm-cat');
  if (!sel || sel.tagName !== 'SELECT') return;
  const v = String(cat || '').trim();
  if (!v) return;
  const exists = Array.prototype.some.call(sel.options, function (o) {
    return o.value === v;
  });
  if (!exists) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  }
}

function paintPmExtraCategoryCheckboxes(selectedSet) {
  const wrap = document.getElementById('pm-extra-cats-wrap');
  const sel = document.getElementById('pm-cat');
  if (!wrap) return;
  const primary = sel ? String(sel.value || '').trim() : '';
  const list = getCategoriesList().filter(function (c) {
    return c !== primary;
  });
  const chosen = selectedSet instanceof Set ? selectedSet : new Set(selectedSet || []);
  if (!list.length) {
    wrap.innerHTML =
      '<span style="font-size:12px;color:var(--text-muted);">No other categories yet. Add categories in the block below, then reopen this form.</span>';
    return;
  }
  wrap.innerHTML = list
    .map(function (c) {
      const checked = chosen.has(c) ? ' checked' : '';
      return (
        '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" class="pm-extra-cat-cb" data-cat="' +
        escAttr(c) +
        '"' +
        checked +
        '> ' +
        escHtml(c) +
        '</label>'
      );
    })
    .join('');
}

function openProductModal(id=null) {
  editingProductId = id;
  pendingProductImageFile = null;
  document.getElementById('product-modal-title').textContent = id ? 'Edit Product' : 'Add New Product';
  document.getElementById('pm-img-preview').style.display = 'none';
  document.getElementById('pm-img-icon').style.display = 'block';
  const cbSizes = document.getElementById('pm-has-sizes');
  pmClearSizeRows();
  paintCategoryDatalist();
  if (id) {
    const p = getProducts().find(x => x.id === id);
    if (!p) {
      showToast('That product is not in the catalog. Open Shop to refresh, then try again.');
      return;
    }
    document.getElementById('pm-id').value = p.id;
    document.getElementById('pm-name').value = p.name;
    ensurePmCategoryOption(p.category);
    document.getElementById('pm-cat').value = p.category;
    document.getElementById('pm-price').value = p.price;
    document.getElementById('pm-compare-price').value = p.compareAtPrice != null ? p.compareAtPrice : '';
    document.getElementById('pm-discount-pct').value = hasVariants(p) ? '' : productDiscountPercent(p) || '';
    document.getElementById('pm-stock-qty').value = Number(p.stockQty) || 0;
    document.getElementById('pm-weight').value = productWeightKg(p);
    document.getElementById('pm-desc').value = p.desc;
    const exEl = document.getElementById('pm-extra-shipping');
    if (exEl) exEl.value = p.extraShippingRs != null && Number(p.extraShippingRs) > 0 ? String(p.extraShippingRs) : '';
    if (cbSizes) cbSizes.checked = hasVariants(p);
    if (hasVariants(p)) {
      p.variants.forEach(function (v) {
        pmAddSizeRow(v);
      });
    }
    const wrap = document.getElementById('pm-sizes-editor-wrap');
    if (wrap) wrap.style.display = hasVariants(p) ? 'block' : 'none';
    const stockEl = document.getElementById('pm-stock-qty');
    if (stockEl) {
      stockEl.disabled = hasVariants(p);
      stockEl.title = hasVariants(p) ? 'Stock is set per size in the table below.' : '';
    }
    document.getElementById('pm-img-url').value = p.img || '';
    if (p.img) {
      document.getElementById('pm-img-preview').src = p.img;
      document.getElementById('pm-img-preview').style.display = 'block';
      document.getElementById('pm-img-icon').style.display = 'none';
    }
    paintPmExtraCategoryCheckboxes(
      new Set(
        (p.extraCategories || []).map(function (x) {
          return String(x || '').trim();
        })
      )
    );
  } else {
    document.getElementById('pm-id').value = '';
    document.getElementById('pm-name').value = '';
    const cl = getCategoriesList();
    document.getElementById('pm-cat').value = cl.indexOf('Resin') >= 0 ? 'Resin' : cl.length ? cl[0] : 'Resin';
    document.getElementById('pm-price').value = '';
    document.getElementById('pm-compare-price').value = '';
    document.getElementById('pm-discount-pct').value = '';
    document.getElementById('pm-stock-qty').value = '0';
    document.getElementById('pm-stock-qty').disabled = false;
    document.getElementById('pm-weight').value = '0.5';
    document.getElementById('pm-desc').value = '';
    document.getElementById('pm-img-url').value = '';
    document.getElementById('pm-img-file').value = '';
    const exNew = document.getElementById('pm-extra-shipping');
    if (exNew) exNew.value = '';
    if (cbSizes) cbSizes.checked = false;
    const wrapN = document.getElementById('pm-sizes-editor-wrap');
    if (wrapN) wrapN.style.display = 'none';
    paintPmExtraCategoryCheckboxes(new Set());
  }
  openModal('product-modal');
}
window.paintPmExtraCategoryCheckboxes = paintPmExtraCategoryCheckboxes;

function onPmPrimaryCategoryChange() {
  const kept = new Set();
  document.querySelectorAll('.pm-extra-cat-cb:checked').forEach(function (cb) {
    const c = String(cb.getAttribute('data-cat') || '').trim();
    if (c) kept.add(c);
  });
  const primary = String(document.getElementById('pm-cat').value || '').trim();
  kept.delete(primary);
  paintPmExtraCategoryCheckboxes(kept);
}
window.onPmPrimaryCategoryChange = onPmPrimaryCategoryChange;

function previewProductImg(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
    showToast('Image must be under 1 MB.');
    e.target.value = '';
    pendingProductImageFile = null;
    return;
  }
  pendingProductImageFile = file;
  const reader = new FileReader();
  reader.onload = function(ev) {
    const img = document.getElementById('pm-img-preview');
    img.src = ev.target.result;
    img.style.display = 'block';
    document.getElementById('pm-img-icon').style.display = 'none';
    document.getElementById('pm-img-url').value = '';
  };
  reader.readAsDataURL(file);
}

async function saveProduct() {
  const name = document.getElementById('pm-name').value.trim();
  const categoryVal = document.getElementById('pm-cat').value.trim();
  const priceRaw = document.getElementById('pm-price').value;
  let price = parseFloat(priceRaw);
  const compareRaw = document.getElementById('pm-compare-price').value;
  let compareAtPrice = compareRaw === '' ? null : Number(compareRaw);
  const discountPctRaw = document.getElementById('pm-discount-pct').value;
  const discountPct = discountPctRaw === '' ? 0 : Number(discountPctRaw);
  const stockQtyRaw = Number(document.getElementById('pm-stock-qty').value);
  let stockQty = Number.isFinite(stockQtyRaw) ? Math.max(0, Math.floor(stockQtyRaw)) : 0;
  const wRaw = parseFloat(document.getElementById('pm-weight').value);
  const weightKg = isFinite(wRaw) && wRaw > 0 ? wRaw : 0.5;
  const extraShipEl = document.getElementById('pm-extra-shipping');
  const extraShipParse = extraShipEl ? parseFloat(extraShipEl.value) : 0;
  const extraShippingRs = Number.isFinite(extraShipParse) && extraShipParse > 0 ? roundPrice(extraShipParse) : 0;
  const sizesOn = document.getElementById('pm-has-sizes') && document.getElementById('pm-has-sizes').checked;
  let variants = sizesOn ? collectPmSizeRows() : [];
  if (!name) {
    showToast('Product name is required.');
    return;
  }
  if (!categoryVal) {
    showToast('Category is required.');
    return;
  }
  const allowedCats = new Set(getCategoriesList());
  if (allowedCats.size > 0 && !allowedCats.has(categoryVal)) {
    showToast('Choose a category from the dropdown. Add new categories under Home Categories in Admin first.');
    return;
  }
  const extraCategories = [];
  document.querySelectorAll('.pm-extra-cat-cb:checked').forEach(function (cb) {
    const c = String(cb.getAttribute('data-cat') || '').trim();
    if (c && c !== categoryVal) extraCategories.push(c);
  });
  if (sizesOn && !variants.length) {
    showToast('Add at least one size with a name and price, or turn off "Multiple sizes".');
    return;
  }
  if (variants.length && discountPct > 0) {
    showToast('Clear Discount % when using multiple sizes (set each size price in the table).');
    return;
  }
  if (variants.length) {
    const prices = variants.map(function (v) {
      return v.price;
    });
    price = Math.min.apply(null, prices);
    stockQty = variants.reduce(function (s, v) {
      return s + (Number(v.stockQty) || 0);
    }, 0);
    const maxV = Math.max.apply(null, prices);
    if (compareAtPrice != null && compareAtPrice <= maxV) {
      showToast('Display MRP must be greater than your highest size price.');
      return;
    }
  } else if (!Number.isFinite(price) || price < 0) {
    showToast('Enter a valid price (₹).');
    return;
  }
  if (compareAtPrice != null && (!Number.isFinite(compareAtPrice) || compareAtPrice <= 0)) {
    showToast('Display MRP must be a valid amount.');
    return;
  }
  if (discountPct && (!Number.isFinite(discountPct) || discountPct < 0 || discountPct >= 100)) {
    showToast('Discount % must be between 0 and 95.');
    return;
  }
  if (discountPct > 0 && !variants.length) {
    // Use Display MRP when set — otherwise first-time save used Price as MRP. If we always used Price here,
    // after the first save Price holds the *sale* (e.g. 45) and re-saving would wrongly treat 45 as MRP → 40.5.
    let mrp;
    if (compareAtPrice != null && Number.isFinite(compareAtPrice) && compareAtPrice > 0) {
      mrp = roundPrice(compareAtPrice);
    } else {
      mrp = roundPrice(price);
    }
    compareAtPrice = mrp;
    price = salePriceFromPercent(mrp, discountPct);
  }
  if (compareAtPrice != null && compareAtPrice <= price) {
    showToast('Display MRP should be greater than selling price to show discount.');
    return;
  }
  if (blockLegacyAdminWhenLiveCatalog()) return;
  const products = getProducts();
  let imgVal = (document.getElementById('pm-img-url').value || '').trim();
  if (imgVal && /^data:/i.test(imgVal)) {
    showToast('Please upload image file (stored in Supabase) or provide normal URL. Base64 images are disabled.');
    return;
  }
  const isEdit = !!editingProductId;
  let row;
  if (isEdit) {
    const p = products.find(x => x.id === editingProductId);
    if (!p) {
      showToast('Product not found. Refresh the admin products list and try again.');
      return;
    }
    p.name = name;
    p.category = categoryVal;
    p.extraCategories = extraCategories;
    p.price = price;
    p.compareAtPrice = compareAtPrice;
    p.stockQty = stockQty;
    p.weightKg = weightKg;
    p.desc = document.getElementById('pm-desc').value;
    p.img = imgVal;
    p.extraShippingRs = extraShippingRs;
    p.variants = variants;
    if (variants.length) syncVariantAggregateFields(p);
    else p.variants = [];
    p.inStock = productInStock(p);
    row = productToRow(p);
  } else {
    const newId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? 'p-' + crypto.randomUUID()
        : 'p' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const np = {
      id: newId,
      name,
      category: categoryVal,
      extraCategories: extraCategories,
      price,
      compareAtPrice: compareAtPrice,
      stockQty: stockQty,
      weightKg: weightKg,
      desc: document.getElementById('pm-desc').value,
      img: imgVal,
      emoji: '📦',
      extraShippingRs: extraShippingRs,
      variants: variants,
      inStock: false
    };
    if (variants.length) syncVariantAggregateFields(np);
    else np.variants = [];
    np.inStock = productInStock(np);
    products.push(np);
    row = productToRow(np);
  }
  const saveBtn = document.querySelector('#product-modal .btn-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    if (pendingProductImageFile) {
      const uploadHintId = isEdit ? editingProductId : (row && row.id ? row.id : 'product');
      imgVal = await uploadProductImageToSupabase(pendingProductImageFile, uploadHintId);
      if (isEdit) {
        const p = products.find(x => x.id === editingProductId);
        if (p) p.img = imgVal;
      } else {
        const latest = products[products.length - 1];
        if (latest) latest.img = imgVal;
      }
      row.image = imgVal;
      pendingProductImageFile = null;
    }
    if (adminRemoteSession()) {
      const sb = getSb();
      const { error } = await supabaseSaveProductRow(sb, row, isEdit, editingProductId);
      if (error) {
        console.error(error);
        showToast(formatSupabaseError(error) || 'Could not save to database.');
        await refreshCatalog();
        loadAdminProducts();
        return;
      }
      await refreshCatalog();
    } else {
      saveProducts(products);
    }
  } catch (err) {
    console.error(err);
    showToast(err && err.message ? err.message : 'Image upload failed. Check Supabase Storage bucket/policies.');
    return;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
  closeModal('product-modal');
  pendingProductImageFile = null;
  loadAdminProducts();
  paintShopGrid();
  paintFeaturedGrid();
  showToast('Product saved!');
}

function openDeleteModal(id) {
  deleteTargetId = id;
  openModal('delete-modal');
}

async function confirmDelete() {
  if (!deleteTargetId) return;
  if (blockLegacyAdminWhenLiveCatalog()) return;
  const id = deleteTargetId;
  if (adminRemoteSession()) {
    const sb = getSb();
    const { error } = await sb.from('products').delete().eq('id', id);
    if (error) {
      console.error(error);
      showToast(error.message || 'Could not delete product.');
      await refreshCatalog();
      loadAdminProducts();
      deleteTargetId = null;
      closeModal('delete-modal');
      return;
    }
    await refreshCatalog();
  } else {
    saveProducts(getProducts().filter(p => p.id !== id));
  }
  deleteTargetId = null;
  closeModal('delete-modal');
  loadAdminProducts();
  paintShopGrid();
  paintFeaturedGrid();
  showToast('Product deleted.');
}


function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

async function loadAdminMessages() {
  if (adminRemoteSession()) await refreshContactCache();
  let rows;
  if (adminRemoteSession() && contactMessageCache.length) {
    rows = contactMessageCache.map(m => ({
      id: m.id,
      date: m.created_at,
      name: m.name,
      email: m.email,
      phone: m.phone,
      message: m.message
    }));
  } else {
    rows = JSON.parse(localStorage.getItem('rrm_contact_inquiries') || '[]').map(m => ({
      id: m.id,
      date: m.date,
      name: m.name,
      email: m.email,
      phone: m.phone,
      message: m.message
    }));
  }
  const tb = document.getElementById('messages-tbody');
  if (!tb) return;
  tb.innerHTML = rows.length
    ? rows.map(m => `<tr><td><code style="font-size:11px;">${escHtml(m.id)}</code></td><td>${escHtml(new Date(m.date).toLocaleString('en-IN'))}</td><td>${escHtml(m.name)}</td><td>${escHtml(m.email)}</td><td>${escHtml(m.phone || '—')}</td><td style="max-width:240px;white-space:pre-wrap;font-size:13px;">${escHtml(m.message)}</td></tr>`).join('')
    : '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px;">No messages yet.</td></tr>';
}

function statusColor(s) {
  return {'Pending payment':'#FFE4B5',Pending:'#FFF3CD',Paid:'#D4EDDA',Confirmed:'#D4EDDA',Shipped:'#CCE5FF',Delivered:'#D4EDDA',Cancelled:'#F8D7DA'}[s]||'#f0f0f0';
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});

// ============================================================
// TOAST
// ============================================================
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ============================================================
// ADMIN ROUTE (via URL hash)
// ============================================================
if (window.location.hash === '#admin') showAdmin();

// ============================================================
// INIT
// ============================================================
async function bootStore() {
  if (typeof emailjs !== "undefined" && EMAILJS_PUBLIC_KEY && !window.__rrmEmailjsInit) {
    emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
    window.__rrmEmailjsInit = true;
  }
  await syncAuth();
  await refreshCatalog();
  updateCartCount();
  paintFeaturedGrid();
  paintFooterCategoryLinks();
  if (window.location.hash !== '#admin') {
    setTimeout(function () {
      openPolicyModal();
    }, 350);
  }
}
void bootStore();

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === 'A') showAdmin();
});

window.applyCheckoutCoupon = applyCheckoutCoupon;
window.clearCheckoutCoupon = clearCheckoutCoupon;
window.onAdminProductSearchInput = onAdminProductSearchInput;
window.onAdminProductSortChange = onAdminProductSortChange;
window.adminProductsGoToPage = adminProductsGoToPage;
window.adjustAdminProductStock = adjustAdminProductStock;
window.toggleProductFeatured = toggleProductFeatured;
window.onInstoreProductChange = onInstoreProductChange;
window.addInstoreSaleEntry = addInstoreSaleEntry;
window.deleteInstoreSaleEntry = deleteInstoreSaleEntry;
window.toggleCouponActiveAdmin = toggleCouponActiveAdmin;
window.saveCouponFromAdminForm = saveCouponFromAdminForm;
window.deleteCouponAdmin = deleteCouponAdmin;
window.onAdminRevenueFilterChange = onAdminRevenueFilterChange;