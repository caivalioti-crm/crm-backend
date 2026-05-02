const { supabase } = require('../supabaseClient');
const express = require('express');
const router = express.Router();

const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];

// Customers list
router.get('/customers', async (req, res) => {
  try {
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const salesmanCode = isRep ? req.user.salesman_code : null;

    let query = supabase
      .from('vw_crm_customers')
      .select('*')
      .eq('is_active', true)
      .limit(5000);

    if (salesmanCode) {
      query = query.eq('salesman_code', salesmanCode);
    }

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
    .select('findoc, trndate, series, seriesnum')
    .eq('trdr', String(trdrId))
    .eq('company', 1000)
    .in('series', series)
    .order('trndate', { ascending: false });

  if (from) query = query.gte('trndate', from);
  if (to) query = query.lte('trndate', to);

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

const SERIES_NAMES = {
  7062: 'ΤΔΑ', 7061: 'ΤΠΑ', 7080: 'ΤΔΑ',
  7063: 'ΠΙΣ', 7064: 'ΠΙΣ', 9962: 'ΑΚΥ',
  7021: 'ΠΑΡ', 7025: 'ΠΡΟ', 7026: 'ΔΕΛ', 7027: 'ΠΑΡ',
};

const SERIES_TYPE = {
  7021: 'order', 7025: 'order', 7026: 'order', 7027: 'order',
  7061: 'invoice', 7062: 'invoice', 7080: 'invoice',
  7063: 'credit', 7064: 'credit', 9962: 'credit',
};

const CREDIT_SERIES = [7063, 7064, 9962];
const INVOICE_SERIES = [7061, 7062, 7080, 7063, 7064, 9962];
const ALL_SERIES = [7021, 7025, 7026, 7027, 7061, 7062, 7080, 7063, 7064, 9962];

// Customer sales — monthly grouped (for Sales Overview chart)
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

// Customer documents — individual records with doc numbers (for Orders & Invoices section)
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

  const { findocs, netamntMap } = await fetchCustomerFindocs(customer.trdr_id, ALL_SERIES, from, to);
  if (!findocs.length) return res.json([]);

  const result = findocs.map(row => {
    const year = (row.trndate ?? '').slice(0, 4);
    const seriesName = SERIES_NAMES[row.series] ?? String(row.series);
    const docNum = `${seriesName}-${year}-${String(row.seriesnum).padStart(4, '0')}`;
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
    };
  });

  res.json(result);
});

// Sales summary (dashboard)
router.get('/sales', async (req, res) => {
  try {
    const { from, to } = req.query;
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const salesmanCode = isRep ? req.user.salesman_code : null;

    const { data, error } = await supabase.rpc('get_sales_summary', {
      p_from: from || '2022-01-01',
      p_to: to || new Date().toISOString().split('T')[0],
      p_salesman_code: salesmanCode,
    });

    if (error) {
      console.error('Supabase sales error:', error);
      return res.status(500).json({ error: error.message });
    }

    const mapped = (data || []).map(row => ({
      customerCode: String(row.trdr),
      netAmount: Number(row.total_netamnt ?? 0),
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
    const salesmanCode = isRep ? req.user.salesman_code : null;

    const [current, compare] = await Promise.all([
      supabase.rpc('get_sales_by_area', {
        p_from: from || '2022-01-01',
        p_to: to || new Date().toISOString().split('T')[0],
        p_salesman_code: salesmanCode,
      }),
      supabase.rpc('get_sales_by_area', {
        p_from: compareFrom || '2022-01-01',
        p_to: compareTo || new Date().toISOString().split('T')[0],
        p_salesman_code: salesmanCode,
      })
    ]);

    if (current.error) return res.status(500).json({ error: current.error.message });
    if (compare.error) return res.status(500).json({ error: compare.error.message });

    const compareMap = new Map(
      (compare.data || []).map(r => [r.area, Number(r.total_netamnt)])
    );

    const result = (current.data || []).map(row => {
      const currentAmt = Number(row.total_netamnt);
      const compareAmt = compareMap.get(row.area) ?? 0;
      const growth = compareAmt > 0 ? ((currentAmt - compareAmt) / compareAmt) * 100 : null;

      return {
        area: row.area,
        netAmount: currentAmt,
        customerCount: Number(row.customer_count),
        compareAmount: compareAmt,
        growth,
      };
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
    const salesmanCode = isRep ? req.user.salesman_code : null;

    const [current, compare] = await Promise.all([
      supabase.rpc('get_sales_by_city', {
        p_from: from || '2022-01-01',
        p_to: to || new Date().toISOString().split('T')[0],
        p_area: area || null,
        p_salesman_code: salesmanCode,
      }),
      supabase.rpc('get_sales_by_city', {
        p_from: compareFrom || '2022-01-01',
        p_to: compareTo || new Date().toISOString().split('T')[0],
        p_area: area || null,
        p_salesman_code: salesmanCode,
      })
    ]);

    if (current.error) return res.status(500).json({ error: current.error.message });
    if (compare.error) return res.status(500).json({ error: compare.error.message });

    const compareMap = new Map(
      (compare.data || []).map(r => [`${r.area}|${r.city}`, Number(r.total_netamnt)])
    );

    const result = (current.data || []).map(row => {
      const currentAmt = Number(row.total_netamnt);
      const compareAmt = compareMap.get(`${row.area}|${row.city}`) ?? 0;
      const growth = compareAmt > 0 ? ((currentAmt - compareAmt) / compareAmt) * 100 : null;

      return {
        area: row.area,
        city: row.city,
        netAmount: currentAmt,
        customerCount: Number(row.customer_count),
        compareAmount: compareAmt,
        growth,
      };
    });

    res.json(result);

  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// GET /api/erp/customers/:code/sales-by-category
router.get('/customers/:code/sales-by-category', async (req, res) => {
  try {
    const { code } = req.params;
    const { from, to } = req.query;

    let query = supabase
      .from('mv_crm_sales_by_category')
      .select('*')
      .eq('customer_code', code)
      .order('net_revenue', { ascending: false });

    if (from) query = query.gte('last_invoice_date', from);
    if (to)   query = query.lte('last_invoice_date', to);

    const { data, error } = await query;
    if (error) throw error;

    // Group by L1 parent for frontend consumption
    const l1Map = new Map();
    for (const row of data) {
      const l1Code = row.parent_code?.split('.')[0] ?? row.category_code?.split('.')[0];
      if (!l1Map.has(l1Code)) {
        l1Map.set(l1Code, {
          l1_code: l1Code,
          categories: [],
          total_revenue: 0,
          total_qty: 0,
          invoice_count: 0,
        });
      }
      const group = l1Map.get(l1Code);
      group.categories.push(row);
      group.total_revenue += parseFloat(row.net_revenue ?? 0);
      group.total_qty     += parseFloat(row.total_qty ?? 0);
      group.invoice_count += parseInt(row.invoice_count ?? 0);
    }

    const grouped = Array.from(l1Map.values())
      .sort((a, b) => b.total_revenue - a.total_revenue);

    res.json({ flat: data, grouped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;