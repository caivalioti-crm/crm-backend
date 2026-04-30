const { supabase } = require('../supabaseClient');
const express = require('express');
const router = express.Router();

const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];

// Customers
router.get('/customers', async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('select_vw_crm_customers');

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Failed to load customers', details: error });
    }

    const allCustomers = Array.isArray(data) ? data : [];

    // Filter by salesman_code for reps
    const filtered = FULL_ACCESS_ROLES.includes(req.user.role)
      ? allCustomers
      : allCustomers.filter(c => String(c.salesman_code) === String(req.user.salesman_code));

    res.json({ items: filtered, total: filtered.length });

  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// Sales
router.get('/sales', async (req, res) => {
  try {
    let query = supabase
      .from('stg_soft1_findoc')
      .select('trdr, trndate, netamnt, series')
      .eq('company', 1000)
      .eq('sosource', 1351)
      .not('netamnt', 'is', null);

    const { data, error } = await query;

    if (error) {
      console.error('Supabase sales error:', error);
      return res.status(500).json({ error: error.message });
    }

    const mapped = data.map(row => ({
      customerCode: String(row.trdr),
      trnDate: row.trndate,
      netAmount: Number(row.netamnt),
      series: row.series,
      salesRepId: 'demo'
    }));

    // Filter by salesman_code for reps
    // We need customers to know which trdr belongs to this rep
    if (FULL_ACCESS_ROLES.includes(req.user.role)) {
      return res.json(mapped);
    }

    // Get this rep's customers first
    const { data: customers, error: custError } = await supabase.rpc('select_vw_crm_customers');
    if (custError) return res.status(500).json({ error: 'Failed to filter sales' });

    const repCustomerCodes = customers
      .filter(c => String(c.salesman_code) === String(req.user.salesman_code))
      .map(c => String(c.code));

    const filteredSales = mapped.filter(s => repCustomerCodes.includes(s.customerCode));
    res.json(filteredSales);

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

module.exports = router;