const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// Customers
router.get('/customers', async (req, res) => {
  const { data, count, error } = await supabase
    .rpc(
      'select_vw_crm_customers',
      {},
      { count: 'exact' }   // ✅ ask PostgREST for total rows
    )
    .range(0, 999);        // ✅ first page (default size)

  if (error) {
    console.error('Supabase error:', error);
    return res.status(500).json({
      error: 'Failed to load customers',
      details: error
    });
  }

  res.json({
    items: data,           // <= 1000 customers
    total: count           // ✅ 1784 (real total)
  });
});

// Sales (analytics)
// Sales (analytics) — Phase 1: Supabase staging data
// Sales (analytics) — Phase 1: Supabase staging data (FINAL)
// Sales (analytics) — Phase 1 FINAL (revenue-only)
router.get('/sales', async (req, res) => {
  const { data, error } = await supabase
    .from('stg_soft1_findoc')
    .select(`
      trdr,
      trndate,
      netamnt,
      series
    `)
    .eq('company', 1000)
    .eq('sosource', 1351)
    .not('netamnt', 'is', null);   // ✅ FINAL FILTER

  if (error) {
    console.error('Supabase sales error:', error);
    return res.status(500).json({ error: error.message });
  }

  const mapped = data.map(row => ({
    customerCode: String(row.trdr),
    trnDate: row.trndate,
    netAmount: Number(row.netamnt),
    series: row.series,
    salesRepId: 'demo'   // Phase‑1 placeholder (locked)
  }));

  res.json(mapped);
});

// Categories purchased
router.get('/categories/purchased', async (req, res) => {
  const { data, error } = await supabase.rpc('select_vw_crm_categories_purchased');

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load categories' });
  }

  res.json(data);
});

module.exports = router;