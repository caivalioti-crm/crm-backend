require('dotenv').config();

const { supabase } = require('./supabaseClient');
const express = require('express');
const cors = require('cors');
const erpRoutes = require('./routes/erp');
const { authMiddleware } = require('./middleware/auth');

function convertDateToISO(ddmmyy) {
  const [day, month, shortYear] = ddmmyy.split('/');
  const year = Number(shortYear) < 50
    ? `20${shortYear}`
    : `19${shortYear}`;

  return `${year}-${month}-${day}`;
}

const app = express();
app.use(cors({
  origin: 'http://localhost:5173',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());
app.use('/api/erp', authMiddleware, erpRoutes);

app.get('/api/me', authMiddleware, async (req, res) => {
  res.json(req.user);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/db-test', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('category_discussion_history')
    .select('*')
    .limit(1);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

app.get('/', (req, res) => {
  res.send('CRM backend running');
});

app.post('/visits/record', authMiddleware, async (req, res) => {
  if (!req.body) {
    return res.status(400).json({ error: 'Missing request body' });
  }

  const {
    entityType,
    entityId,
    visitDate,
    categories
  } = req.body;

  const isoVisitDate = convertDateToISO(visitDate);

  for (const category of categories) {
    const { categoryCode, subcategoryCodes } = category;

    if (!subcategoryCodes || subcategoryCodes.length === 0) {
      const { error } = await supabase.rpc('upsert_category_discussion', {
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_category_code: categoryCode,
        p_subcategory_code: null,
        p_visit_date: isoVisitDate
      });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

    } else {
      for (const subCode of subcategoryCodes) {
        const { error } = await supabase.rpc('upsert_category_discussion', {
          p_entity_type: entityType,
          p_entity_id: entityId,
          p_category_code: categoryCode,
          p_subcategory_code: subCode,
          p_visit_date: isoVisitDate
        });

        if (error) {
          return res.status(500).json({ error: error.message });
        }
      }
    }
  }

  res.json({ success: true });
});

app.get('/customers/:customerCode/readiness', authMiddleware, async (req, res) => {
  const { customerCode } = req.params;

  const { data, error } = await supabase
    .from('customer_readiness_score')
    .select('*')
    .eq('customer_code', customerCode);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data: data[0] ?? null });
});

app.get('/customers/:customerCode/dashboard', authMiddleware, async (req, res) => {
  const { customerCode } = req.params;

  const { data, error } = await supabase
    .from('customer_crm_kpis')
    .select('*')
    .eq('customer_code', customerCode)
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

app.get('/customers/:customerCode/top-categories', authMiddleware, async (req, res) => {
  const { customerCode } = req.params;

  const { data, error } = await supabase
    .from('customer_top_3_categories')
    .select('*')
    .eq('customer_code', customerCode);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

app.get('/customers/:customerCode/neglected-categories', authMiddleware, async (req, res) => {
  const { customerCode } = req.params;

  const { data, error } = await supabase
    .from('customer_neglected_categories')
    .select('*')
    .eq('customer_code', customerCode);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

app.listen(3001, () => {
  console.log('Backend running on http://localhost:3001');
});