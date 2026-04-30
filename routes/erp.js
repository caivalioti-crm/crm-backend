const { supabase } = require('../supabaseClient');
const express = require('express');
const router = express.Router();

const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];

// Customers
router.get('/customers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vw_crm_customers')
      .select('*')
      .limit(5000);

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Failed to load customers', details: error });
    }

    const allCustomers = Array.isArray(data) ? data : [];

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
    const { from, to } = req.query;

    const { data, error } = await supabase.rpc('get_sales_summary', {
      p_from: from || '2022-01-01',
      p_to: to || new Date().toISOString().split('T')[0]
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

    if (FULL_ACCESS_ROLES.includes(req.user.role)) {
      return res.json(mapped);
    }

    // Rep filtering — use direct view query with limit
    const { data: customers, error: custError } = await supabase
      .from('vw_crm_customers')
      .select('salesman_code, trdr_id')
      .limit(5000);

    if (custError) return res.status(500).json({ error: 'Failed to filter sales' });

    const repCustomerCodes = customers
      .filter(c => String(c.salesman_code) === String(req.user.salesman_code))
      .map(c => String(c.trdr_id));

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

// Sales by area
router.get('/sales/by-area', async (req, res) => {
  try {
    const { from, to } = req.query;

    const [current, compare] = await Promise.all([
      supabase.rpc('get_sales_by_area', {
        p_from: from || '2022-01-01',
        p_to: to || new Date().toISOString().split('T')[0]
      }),
      supabase.rpc('get_sales_by_area', {
        p_from: req.query.compareFrom || '2022-01-01',
        p_to: req.query.compareTo || new Date().toISOString().split('T')[0]
      })
    ]);

    if (current.error) return res.status(500).json({ error: current.error.message });
    if (compare.error) return res.status(500).json({ error: compare.error.message });

    // Merge current + compare
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

    const [current, compare] = await Promise.all([
      supabase.rpc('get_sales_by_city', {
        p_from: from || '2022-01-01',
        p_to: to || new Date().toISOString().split('T')[0],
        p_area: area || null
      }),
      supabase.rpc('get_sales_by_city', {
        p_from: compareFrom || '2022-01-01',
        p_to: compareTo || new Date().toISOString().split('T')[0],
        p_area: area || null
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