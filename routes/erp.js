const { supabase } = require('../supabaseClient');
const express = require('express');
const router = express.Router();
const multer = require('multer'); 

const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 10 * 1024 * 1024 } 
});

const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];

// Customers list
router.get('/customers', async (req, res) => {
  try {
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const salesmanCode = isRep ? req.user.salesman_code : null;

    let query = supabase
      .from('vw_crm_customers')
      .select('*')
      .limit(5000);

    if (salesmanCode) query = query.eq('salesman_code', salesmanCode);

    const { data, error } = await query;
    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ items: data ?? [] });
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// Helper: fetch findocs + netamnt for a customer
async function fetchCustomerFindocs(trdrId, series, from, to) {
  let query = supabase
    .from('stg_soft1_findoc')
    .select('findoc, trndate, series, seriesnum, fincode, disc1prc, sumamnt')
    .eq('trdr', String(trdrId))
    .eq('company', 1000)
    .in('series', series)
    .order('trndate', { ascending: false });

  if (from) query = query.gte('trndate', from);
  if (to)   query = query.lte('trndate', to);

  const { data: findocs, error } = await query;
  if (error || !findocs || findocs.length === 0) return { findocs: [], netamntMap: new Map() };

  const findocIds = findocs.map(f => f.findoc);
  const { data: netamnts } = await supabase
    .from('stg_soft1_findoc_netamnt')
    .select('findoc, netamnt')
    .in('findoc', findocIds)
    .eq('company', 1000);

  const netamntMap = new Map((netamnts ?? []).map(n => [n.findoc, Number(n.netamnt ?? 0)]));
  return { findocs, netamntMap };
}

// Helper: map findoc rows to document objects
function mapDoc(row, netamntMap) {
  const year = (row.trndate ?? '').slice(0, 4);
  const seriesName = SERIES_NAMES[row.series] ?? String(row.series);
  const fallbackNum = `${seriesName}-${year}-${String(row.seriesnum).padStart(4, '0')}`;
  const docNum = row.fincode || fallbackNum;
  const netamnt = netamntMap.get(row.findoc) ?? 0;
  const type = SERIES_TYPE[row.series] ?? 'other';
  const isCreditNote = CREDIT_SERIES.includes(row.series);
  return {
    findoc: row.findoc,
    doc_number: docNum,
    trndate: (row.trndate ?? '').slice(0, 10),
    series: row.series,
    type,
    netamnt: isCreditNote ? -netamnt : netamnt,
    disc1prc: row.disc1prc !== null ? Number(row.disc1prc) : null,
    sumamnt: row.sumamnt !== null ? Number(row.sumamnt) : null,
  };
}

const SERIES_NAMES = {
  7062: 'ΤΔΑ', 7061: 'ΤΠΑ', 7080: 'ΤΔΑ',
  7063: 'ΠΙΣ', 7064: 'ΠΙΣ', 9962: 'ΑΚΥ',
  7021: 'ΠΑΡ', 7025: 'ΠΡΟ', 7026: 'ΔΕΛ', 7027: 'ΠΑΡ',
};

const SERIES_TYPE = {
  7021: 'order', 7025: 'order', 7026: 'order', 7027: 'order',
  7061: 'invoice', 7062: 'invoice', 7080: 'invoice',
  7063: 'credit',  7064: 'credit',  9962: 'credit',
};

const CREDIT_SERIES  = [7063, 7064, 9962];
const INVOICE_SERIES = [7061, 7062, 7080];
const ORDER_SERIES   = [7021, 7025, 7026, 7027];
const ALL_SERIES     = [7021, 7025, 7026, 7027, 7061, 7062, 7080, 7063, 7064, 9962];

// Customer sales — monthly grouped
router.get('/customers/:code/sales', async (req, res) => {
  const { code } = req.params;
  const { from, to } = req.query;

  const { data: customer } = await supabase
    .from('stg_soft1_trdr')
    .select('trdr_id')
    .eq('trdr_code', code)
    .eq('company', 1000)
    .single();

  if (!customer) return res.json([]);

  const { findocs, netamntMap } = await fetchCustomerFindocs(customer.trdr_id, INVOICE_SERIES, from, to);
  if (!findocs.length) return res.json([]);

  const byMonth = {};
  findocs.forEach(row => {
    const month = (row.trndate ?? '').slice(0, 7);
    if (!month) return;
    const amount = netamntMap.get(row.findoc) ?? 0;
    const isCreditNote = CREDIT_SERIES.includes(row.series);
    byMonth[month] = (byMonth[month] ?? 0) + (isCreditNote ? -amount : amount);
  });

  const result = Object.entries(byMonth)
    .map(([month, netamnt]) => ({ month, netamnt }))
    .sort((a, b) => b.month.localeCompare(a.month));

  res.json(result);
});

// Customer documents — last 5 per type, using fincode where available
router.get('/customers/:code/documents', async (req, res) => {
  const { code } = req.params;
  const { from, to } = req.query;

  const { data: customer } = await supabase
    .from('stg_soft1_trdr')
    .select('trdr_id')
    .eq('trdr_code', code)
    .eq('company', 1000)
    .single();

  if (!customer) return res.json([]);

  // Fetch top 10 of each type in parallel
  const [invoiceResult, orderResult, creditResult] = await Promise.all([
    fetchCustomerFindocs(customer.trdr_id, [7061, 7062, 7080], from, to),
    fetchCustomerFindocs(customer.trdr_id, ORDER_SERIES, from, to),
    fetchCustomerFindocs(customer.trdr_id, CREDIT_SERIES, from, to),
  ]);

  const invoiceDocs = invoiceResult.findocs.slice(0, 10).map(r => mapDoc(r, invoiceResult.netamntMap));
  const orderDocs   = orderResult.findocs.slice(0, 10).map(r => mapDoc(r, orderResult.netamntMap));
  const creditDocs  = creditResult.findocs.slice(0, 10).map(r => mapDoc(r, creditResult.netamntMap));

  const result = [...invoiceDocs, ...orderDocs, ...creditDocs]
    .sort((a, b) => b.trndate.localeCompare(a.trndate));

  res.json(result);
});

// Customer balance
router.get('/customers/:code/balance', async (req, res) => {
  try {
    const { code } = req.params;

    const { data: balData, error: balError } = await supabase
      .from('stg_soft1_custbalance')
      .select('debit, credit')
      .eq('cuscode', parseInt(code));

    if (balError) throw balError;

    const balance = Math.round(
      (balData ?? []).reduce((sum, row) =>
        sum + Number(row.debit ?? 0) - Number(row.credit ?? 0), 0
      ) * 100
    ) / 100;

    const { data: entries, error: entError } = await supabase
      .from('stg_soft1_custbalance')
      .select('trndate, fincode, seira, debit, credit')
      .eq('cuscode', parseInt(code))
      .order('trndate', { ascending: false })
      .limit(10);

    if (entError) throw entError;

    res.json({ balance, entries: entries ?? [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Sales summary (dashboard)
router.get('/sales', async (req, res) => {
  try {
    const { from, to } = req.query;
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const salesmanCode = isRep ? req.user.salesman_code : null;

    const { data, error } = await supabase.rpc('get_sales_summary', {
      p_from: from || '2022-01-01',
      p_to:   to   || new Date().toISOString().split('T')[0],
      p_salesman_code: salesmanCode,
    });

    if (error) {
      console.error('Supabase sales error:', error);
      return res.status(500).json({ error: error.message });
    }

    const mapped = (data || []).map(row => ({
      customerCode: String(row.trdr),
      netAmount:    Number(row.total_netamnt ?? 0),
      invoiceCount: Number(row.invoice_count ?? 0),
    }));

    res.json(mapped);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// Categories purchased
router.get('/categories/purchased', async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('select_vw_crm_categories_purchased');
    if (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to load categories' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// Sales by area
router.get('/sales/by-area', async (req, res) => {
  try {
    const { from, to, compareFrom, compareTo } = req.query;
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const salesmanCode = isRep 
      ? req.user.salesman_code 
      : (req.query.salesmanCode || null);

    const [current, compare] = await Promise.all([
      supabase.rpc('get_sales_by_area', {
        p_from: from || '2022-01-01',
        p_to:   to   || new Date().toISOString().split('T')[0],
        p_salesman_code: salesmanCode,
      }),
      supabase.rpc('get_sales_by_area', {
        p_from: compareFrom || '2022-01-01',
        p_to:   compareTo   || new Date().toISOString().split('T')[0],
        p_salesman_code: salesmanCode,
      }),
    ]);

    if (current.error) return res.status(500).json({ error: current.error.message });
    if (compare.error) return res.status(500).json({ error: compare.error.message });

    const compareMap = new Map((compare.data || []).map(r => [r.area, Number(r.total_netamnt)]));

    const result = (current.data || []).map(row => {
      const currentAmt = Number(row.total_netamnt);
      const compareAmt = compareMap.get(row.area) ?? 0;
      const growth = compareAmt > 0 ? ((currentAmt - compareAmt) / compareAmt) * 100 : null;
      return { area: row.area, netAmount: currentAmt, customerCount: Number(row.customer_count), compareAmount: compareAmt, growth };
    });

    res.json(result);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// Sales by city
router.get('/sales/by-city', async (req, res) => {
  try {
    const { from, to, compareFrom, compareTo, area } = req.query;
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const salesmanCode = isRep 
      ? req.user.salesman_code 
      : (req.query.salesmanCode || null);

    const [current, compare] = await Promise.all([
      supabase.rpc('get_sales_by_city', {
        p_from: from || '2022-01-01',
        p_to:   to   || new Date().toISOString().split('T')[0],
        p_area: area || null,
        p_salesman_code: salesmanCode,
      }),
      supabase.rpc('get_sales_by_city', {
        p_from: compareFrom || '2022-01-01',
        p_to:   compareTo   || new Date().toISOString().split('T')[0],
        p_area: area || null,
        p_salesman_code: salesmanCode,
      }),
    ]);

    if (current.error) return res.status(500).json({ error: current.error.message });
    if (compare.error) return res.status(500).json({ error: compare.error.message });

    const compareMap = new Map((compare.data || []).map(r => [`${r.area}|${r.city}`, Number(r.total_netamnt)]));

    const result = (current.data || []).map(row => {
      const currentAmt = Number(row.total_netamnt);
      const compareAmt = compareMap.get(`${row.area}|${row.city}`) ?? 0;
      const growth = compareAmt > 0 ? ((currentAmt - compareAmt) / compareAmt) * 100 : null;
      return { area: row.area, city: row.city, netAmount: currentAmt, customerCount: Number(row.customer_count), compareAmount: compareAmt, growth };
    });

    res.json(result);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// ─── Helper: build proper L1 → L2 → L3 hierarchy ────────────────────────────
function buildHierarchy(rows) {
  const l2Rows = rows.filter(r => r.level === 2);
  const l3Rows = rows.filter(r => r.level === 3);

  const l2Map = new Map();
  for (const row of l2Rows) {
    const cur  = parseFloat(row.net_revenue ?? 0);
    const prev = parseFloat(row.prev_revenue ?? 0);
    l2Map.set(row.category_code, {
      ...row,
      net_revenue:   cur,
      prev_revenue:  prev,
      total_qty:     parseFloat(row.total_qty ?? 0),
      prev_qty:      parseFloat(row.prev_qty ?? 0),
      invoice_count: parseInt(row.invoice_count ?? 0),
      growth_pct:    prev > 0 ? ((cur - prev) / prev) * 100 : null,
      l3s: [],
    });
  }

  for (const row of l3Rows) {
    const l2Code = row.parent_code;
    const cur    = parseFloat(row.net_revenue ?? 0);
    const prev   = parseFloat(row.prev_revenue ?? 0);
    const enriched = {
      ...row,
      net_revenue:   cur,
      prev_revenue:  prev,
      total_qty:     parseFloat(row.total_qty ?? 0),
      prev_qty:      parseFloat(row.prev_qty ?? 0),
      invoice_count: parseInt(row.invoice_count ?? 0),
      growth_pct:    prev > 0 ? ((cur - prev) / prev) * 100 : null,
    };

    if (!l2Map.has(l2Code)) {
      l2Map.set(l2Code, {
        category_code: l2Code,
        parent_code:   l2Code.split('.')[0],
        level: 2,
        full_name: null,
        short_name: null,
        category_id: null,
        net_revenue:   0,
        prev_revenue:  0,
        total_qty:     0,
        prev_qty:      0,
        invoice_count: 0,
        growth_pct:    null,
        l3s: [],
      });
    }
    l2Map.get(l2Code).l3s.push(enriched);
  }

  for (const l2 of l2Map.values()) {
    if (l2.l3s.length > 0 && l2.net_revenue === 0 && l2.category_id === null) {
      l2.net_revenue   = l2.l3s.reduce((s, r) => s + r.net_revenue, 0);
      l2.prev_revenue  = l2.l3s.reduce((s, r) => s + r.prev_revenue, 0);
      l2.total_qty     = l2.l3s.reduce((s, r) => s + r.total_qty, 0);
      l2.prev_qty      = l2.l3s.reduce((s, r) => s + r.prev_qty, 0);
      l2.invoice_count = l2.l3s.reduce((s, r) => s + r.invoice_count, 0);
      l2.growth_pct    = l2.prev_revenue > 0 ? ((l2.net_revenue - l2.prev_revenue) / l2.prev_revenue) * 100 : null;
    }
    l2.l3s.sort((a, b) => b.net_revenue - a.net_revenue);
  }

  const l1Map = new Map();
  for (const l2 of l2Map.values()) {
    const l1Code = l2.parent_code?.split('.')[0] ?? l2.category_code.split('.')[0];
    if (!l1Map.has(l1Code)) {
      l1Map.set(l1Code, {
        l1_code: l1Code,
        l2s: [],
        total_revenue: 0,
        prev_revenue:  0,
        total_qty:     0,
        prev_qty:      0,
        invoice_count: 0,
        growth_pct:    null,
      });
    }
    const group = l1Map.get(l1Code);
    group.l2s.push(l2);
    group.total_revenue += l2.net_revenue;
    group.prev_revenue  += l2.prev_revenue;
    group.total_qty     += l2.total_qty;
    group.prev_qty      += l2.prev_qty;
    group.invoice_count += l2.invoice_count;
  }

  for (const group of l1Map.values()) {
    group.growth_pct = group.prev_revenue > 0
      ? ((group.total_revenue - group.prev_revenue) / group.prev_revenue) * 100
      : null;
    group.l2s.sort((a, b) => b.net_revenue - a.net_revenue);
  }

  return Array.from(l1Map.values()).sort((a, b) => b.total_revenue - a.total_revenue);
}

// GET /api/erp/customers/:code/sales-by-category
router.get('/customers/:code/sales-by-category', async (req, res) => {
  try {
    const { code } = req.params;
    const { from, to, prevFrom, prevTo } = req.query;

    const { data, error } = await supabase.rpc('get_category_sales', {
      p_from:           from     || '2026-01-01',
      p_to:             to       || new Date().toISOString().split('T')[0],
      p_prev_from:      prevFrom || '2025-01-01',
      p_prev_to:        prevTo   || '2025-12-31',
      p_salesman_code:  null,
      p_area:           null,
      p_city:           null,
      p_customer_code:  code,
    });

    if (error) throw error;

    const grouped = buildHierarchy(data ?? []);
    res.json({ grouped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/erp/customers/:code/skus-by-category
router.get('/customers/:code/skus-by-category', async (req, res) => {
  try {
    const { code } = req.params;
    const { from, to, categoryId } = req.query;

    let query = supabase
      .from('mv_crm_sku_sales')
      .select('mtrl_id, sku_code, sku_name, category_id, qty, netlineval')
      .eq('customer_code', code);

    if (categoryId) query = query.eq('category_id', categoryId);
    if (from) query = query.gte('trndate', from);
    if (to)   query = query.lte('trndate', to);

    const { data, error } = await query;
    if (error) throw error;

    const skuMap = new Map();
    for (const row of data ?? []) {
      const key = row.mtrl_id;
      if (!skuMap.has(key)) {
        skuMap.set(key, { mtrl_id: row.mtrl_id, sku_code: row.sku_code, sku_name: row.sku_name, category_id: row.category_id, revenue: 0, qty: 0 });
      }
      const sku = skuMap.get(key);
      sku.revenue += parseFloat(row.netlineval ?? 0);
      sku.qty     += parseFloat(row.qty ?? 0);
    }

    const byCat = new Map();
    for (const sku of skuMap.values()) {
      if (!byCat.has(sku.category_id)) byCat.set(sku.category_id, []);
      byCat.get(sku.category_id).push(sku);
    }

    const result = {};
    for (const [catId, skus] of byCat.entries()) {
      result[catId] = skus.sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/erp/sales-by-category (dashboard)
router.get('/sales-by-category', async (req, res) => {
  try {
    const { from, to, prevFrom, prevTo, area, city, salesmanCode: salesmanOverride } = req.query;
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const salesmanCode = isRep ? req.user.salesman_code : (salesmanOverride || null);

    const { data, error } = await supabase.rpc('get_category_sales', {
      p_from:          from     || '2026-01-01',
      p_to:            to       || new Date().toISOString().split('T')[0],
      p_prev_from:     prevFrom || '2025-01-01',
      p_prev_to:       prevTo   || '2025-12-31',
      p_salesman_code: salesmanCode,
      p_area:          area  || null,
      p_city:          city  || null,
      p_customer_code: null,
    });

    if (error) throw error;

    const grouped = buildHierarchy(data ?? []);
    res.json({ grouped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/erp/skus-by-category (dashboard)
router.get('/skus-by-category', async (req, res) => {
  try {
    const { from, to, area, city, categoryId } = req.query;
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const salesmanCode = isRep ? req.user.salesman_code : null;

    const { data, error } = await supabase.rpc('get_sku_sales', {
      p_from:          from || '2026-01-01',
      p_to:            to   || new Date().toISOString().split('T')[0],
      p_salesman_code: salesmanCode,
      p_area:          area       || null,
      p_city:          city       || null,
      p_category_id:   categoryId ? parseInt(categoryId) : null,
      p_customer_code: null,
    });

    if (error) throw error;

    const byCat = new Map();
    for (const row of data ?? []) {
      if (!byCat.has(row.category_id)) byCat.set(row.category_id, []);
      byCat.get(row.category_id).push({
        mtrl_id: row.mtrl_id, sku_code: row.sku_code, sku_name: row.sku_name,
        category_id: row.category_id, revenue: parseFloat(row.revenue ?? 0), qty: parseFloat(row.qty ?? 0),
      });
    }

    const result = {};
    for (const [catId, skus] of byCat.entries()) {
      result[catId] = skus.sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/erp/top-customers-by-category
router.get('/top-customers-by-category', async (req, res) => {
  try {
    const { from, to, prevFrom, prevTo, categoryId, area, city } = req.query;
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const salesmanCode = isRep ? req.user.salesman_code : null;

    const { data, error } = await supabase.rpc('get_top_customers_by_category', {
      p_from:          from     || '2026-01-01',
      p_to:            to       || new Date().toISOString().split('T')[0],
      p_prev_from:     prevFrom || '2025-01-01',
      p_prev_to:       prevTo   || '2025-12-31',
      p_category_id:   parseInt(categoryId),
      p_salesman_code: salesmanCode,
      p_area:          area || null,
      p_city:          city || null,
      p_limit:         10,
    });

    if (error) throw error;
    res.json(data ?? []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/erp/customer-category-rank
router.get('/customer-category-rank', async (req, res) => {
  try {
    const { from, to, customerCode, categoryId, area } = req.query;

    const { data, error } = await supabase.rpc('get_customer_category_rank', {
      p_from:          from || '2026-01-01',
      p_to:            to   || new Date().toISOString().split('T')[0],
      p_customer_code: customerCode,
      p_category_id:   parseInt(categoryId),
      p_area:          area || null,
    });

    if (error) throw error;
    res.json(data?.[0] ?? null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/erp/customers/:code/documents/:findoc/lines
router.get('/customers/:code/documents/:findoc/lines', async (req, res) => {
  try {
    const { findoc } = req.params;

    const { data: lines, error } = await supabase
    .from('stg_soft1_mtrlines')
    .select('mtrl, qty, netlineval, disc1prc, vatprc, price')
    .eq('findoc', parseInt(findoc))
    .eq('company', 1000);

    if (error) throw error;
    if (!lines || lines.length === 0) return res.json([]);

    const mtrlIds = lines.map(l => l.mtrl);
    const { data: mtrls } = await supabase
      .from('stg_soft1_mtrl')
      .select('mtrl, code, name')
      .in('mtrl', mtrlIds);

    const mtrlMap = new Map((mtrls ?? []).map(m => [m.mtrl, m]));

    const result = lines.map(row => ({
      mtrl:       row.mtrl,
      sku_code:   mtrlMap.get(row.mtrl)?.code ?? '',
      sku_name:   mtrlMap.get(row.mtrl)?.name ?? '',
      qty:        Number(row.qty ?? 0),
      netlineval: Number(row.netlineval ?? 0),
      disc1prc:   row.disc1prc !== null ? Number(row.disc1prc) : null,
      vatprc:     row.vatprc   !== null ? Number(row.vatprc)   : null,
      price: row.price !== null ? Number(row.price) : null,
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/erp/customers/:code/discounts
router.get('/customers/:code/discounts', async (req, res) => {
  try {
    const { code } = req.params;

    // Get trdr_id from code
    const { data: customer } = await supabase
      .from('stg_soft1_trdr')
      .select('trdr_id, prccategory')
      .eq('trdr_code', code)
      .eq('company', 1000)
      .single();

    if (!customer) return res.json({ general: null, categories: [], brands: [], prccategory: null });

    // Fetch all discount policies for this customer
    const { data: policies, error } = await supabase
      .from('stg_soft1_ccctimologiakestrdr')
      .select('prcrule, catname, mtrcategory, fld01')
      .eq('trdr', customer.trdr_id);

    if (error) throw error;

    // PRCRULE 101 = general customer discount
    const general = policies?.find(p => p.prcrule === 101);

    // PRCRULE 302 = per product category discount
    const categories = (policies ?? [])
      .filter(p => p.prcrule === 302 && p.fld01 > 0)
      .map(p => ({ category: p.catname, mtrcategory: p.mtrcategory, discount: p.fld01 }))
      .sort((a, b) => b.discount - a.discount);

    // PRCRULE 502 = per car brand discount
    const brands = (policies ?? [])
      .filter(p => p.prcrule === 502 && p.fld01 > 0)
      .map(p => ({ brand: p.catname, mtrcategory: p.mtrcategory, discount: p.fld01 }))
      .sort((a, b) => b.discount - a.discount);

    res.json({
      general: general ? general.fld01 : null,
      categories,
      brands,
      prccategory: customer.prccategory,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/last-sync-date', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('stg_soft1_findoc')
      .select('trndate')
      .eq('company', 1000)
      .order('trndate', { ascending: false })
      .limit(1)
      .single();
    if (error) throw error;
    res.json({ date: (data?.trndate ?? '').slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/last-invoice-date', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('stg_soft1_findoc')
      .select('trndate')
      .eq('company', 1000)
      .in('series', [7061, 7062, 7080, 7063, 7064, 9962, 9964, 7067])
      .order('trndate', { ascending: false })
      .limit(1)
      .single();
    if (error) throw error;
    res.json({ date: (data?.trndate ?? '').slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;