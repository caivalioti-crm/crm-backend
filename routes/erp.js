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

// Customer sales
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

  const INVOICE_SERIES = [7061, 7062, 7080, 7063, 7064, 9962];

  let query = supabase
    .from('stg_soft1_findoc')
    .select('findoc, trndate, series')
    .eq('trdr', String(customer.trdr_id))
    .eq('company', 1000)
    .in('series', INVOICE_SERIES)
    .order('trndate', { ascending: false });

  if (from) query = query.gte('trndate', from);
  if (to) query = query.lte('trndate', to);

  const { data: findocs, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  if (!findocs || findocs.length === 0) return res.json([]);

  // Fetch netamnt for these findocs
  const findocIds = findocs.map(f => f.findoc);
  const { data: netamnts } = await supabase
    .from('stg_soft1_findoc_netamnt')
    .select('findoc, netamnt')
    .in('findoc', findocIds)
    .eq('company', 1000);

  const netamntMap = new Map((netamnts ?? []).map(n => [n.findoc, Number(n.netamnt ?? 0)]));

  // Group by month
  const byMonth = {};
  findocs.forEach((row) => {
    const month = (row.trndate ?? '').slice(0, 7);
    if (!month) return;
    const amount = netamntMap.get(row.findoc) ?? 0;
    const isCreditNote = [7063, 7064, 9962].includes(row.series);
    byMonth[month] = (byMonth[month] ?? 0) + (isCreditNote ? -amount : amount);
  });

  const result = Object.entries(byMonth)
    .map(([month, netamnt]) => ({ month, netamnt }))
    .sort((a, b) => b.month.localeCompare(a.month));

  res.json(result);
});

// Sales
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

module.exports = router;