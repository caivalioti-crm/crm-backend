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
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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

// Create a new visit
app.post('/api/visits', authMiddleware, async (req, res) => {
  const { customer_code, visit_date, visit_time, visit_type, notes, tasks } = req.body;

  if (!customer_code || !visit_date) {
    return res.status(400).json({ error: 'customer_code and visit_date are required' });
  }

  // Insert visit
  const { data: visit, error: visitError } = await supabase
    .from('crm_visits')
    .insert({
      customer_code,
      salesman_code: req.user.salesman_code ?? '',
      user_id: req.user.id,
      visit_date,
      visit_time: visit_time || null,
      visit_type: visit_type || 'in-person',
      notes: notes || '',
    })
    .select()
    .single();

  if (visitError) {
    console.error('Visit insert error:', visitError);
    return res.status(500).json({ error: visitError.message });
  }

  // Insert tasks if any
  if (tasks && tasks.length > 0) {
    const taskRows = tasks.map(t => ({
      visit_id: visit.id,
      description: t.description,
      reminder_date: t.reminderDate || null,
      status: 'not-started',
    }));

    const { error: taskError } = await supabase
      .from('crm_visit_tasks')
      .insert(taskRows);

    if (taskError) {
      console.error('Task insert error:', taskError);
      return res.status(500).json({ error: taskError.message });
    }
  }

  res.json({ success: true, visit });
});

// Get visits for current user
app.get('/api/visits', authMiddleware, async (req, res) => {
  const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];

  let query = supabase
    .from('crm_visits')
    .select(`
      *,
      crm_visit_tasks (*),
      crm_visit_categories (*),
      crm_visit_comments (*)
    `)
    .order('visit_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (!FULL_ACCESS_ROLES.includes(req.user.role)) {
    query = query.eq('salesman_code', req.user.salesman_code);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Visits fetch error:', error);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// Get category master
app.get('/api/categories', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('crm_category_master')
    .select('category_code, parent_code, level, full_name, short_name')
    .order('category_code');

  if (error) {
    console.error('Categories fetch error:', error);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// Add comment to a visit
app.post('/api/visits/:id/comments', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;

  if (!comment?.trim()) {
    return res.status(400).json({ error: 'Comment is required' });
  }

  const { data, error } = await supabase
    .from('crm_visit_comments')
    .insert({
      visit_id: id,
      user_id: req.user.id,
      commenter_name: req.user.full_name,
      comment: comment.trim(),
      is_read: false,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Mark comment as read
app.patch('/api/visits/comments/:commentId/read', authMiddleware, async (req, res) => {
  const { commentId } = req.params;

  const { error } = await supabase
    .from('crm_visit_comments')
    .update({
      is_read: true,
      read_at: new Date().toISOString(),
      read_by_name: req.user.full_name,
    })
    .eq('id', commentId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Delete a visit (own visits for reps, any for managers/admins)
app.delete('/api/visits/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];

  let query = supabase.from('crm_visits').delete().eq('id', id);

  if (!FULL_ACCESS_ROLES.includes(req.user.role)) {
    query = query.eq('user_id', req.user.id);
  }

  const { error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Edit a visit (own visits for reps, any for managers/admins)
app.patch('/api/visits/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { notes, visit_type, visit_date, visit_time, categories } = req.body;
  const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];

  let query = supabase
    .from('crm_visits')
    .update({ notes, visit_type, visit_date, visit_time })
    .eq('id', id);

  if (!FULL_ACCESS_ROLES.includes(req.user.role)) {
    query = query.eq('user_id', req.user.id);
  }

const { data, error } = await query.select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Update categories if provided
  if (categories !== undefined) {
    await supabase.from('crm_visit_categories').delete().eq('visit_id', id);
    if (categories.length > 0) {
      const categoryRows = categories.map(c => ({
        visit_id: id,
        category_code: c.categoryCode,
        subcategory_code: c.subcategoryCode || null,
      }));
      const { error: catError } = await supabase.from('crm_visit_categories').insert(categoryRows);
      if (catError) return res.status(500).json({ error: catError.message });
    }
  }

const { data: fullVisit, error: fetchError } = await supabase
    .from('crm_visits')
    .select(`*, crm_visit_tasks(*), crm_visit_categories(*), crm_visit_comments(*)`)
    .eq('id', id)
    .single();

  if (fetchError) return res.status(500).json({ error: fetchError.message });
  res.json(fullVisit);
});

// Delete own comment (manager/admin only)
app.delete('/api/visits/comments/:commentId', authMiddleware, async (req, res) => {
  const { commentId } = req.params;

  const { error } = await supabase
    .from('crm_visit_comments')
    .delete()
    .eq('id', commentId)
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Rep replies to a comment
app.patch('/api/visits/comments/:commentId/reply', authMiddleware, async (req, res) => {
  const { commentId } = req.params;
  const { reply_text } = req.body;

  if (!reply_text?.trim()) return res.status(400).json({ error: 'Reply is required' });

  const { error } = await supabase
    .from('crm_visit_comments')
    .update({
      reply_text: reply_text.trim(),
      reply_at: new Date().toISOString(),
    })
    .eq('id', commentId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.listen(3001, () => {
  console.log('Backend running on http://localhost:3001');
});