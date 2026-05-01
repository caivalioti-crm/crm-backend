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
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.get('/', (req, res) => {
  res.send('CRM backend running');
});

app.post('/visits/record', authMiddleware, async (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'Missing request body' });

  const { entityType, entityId, visitDate, categories } = req.body;
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
      if (error) return res.status(500).json({ error: error.message });
    } else {
      for (const subCode of subcategoryCodes) {
        const { error } = await supabase.rpc('upsert_category_discussion', {
          p_entity_type: entityType,
          p_entity_id: entityId,
          p_category_code: categoryCode,
          p_subcategory_code: subCode,
          p_visit_date: isoVisitDate
        });
        if (error) return res.status(500).json({ error: error.message });
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
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data: data[0] ?? null });
});

app.get('/customers/:customerCode/dashboard', authMiddleware, async (req, res) => {
  const { customerCode } = req.params;
  const { data, error } = await supabase
    .from('customer_crm_kpis')
    .select('*')
    .eq('customer_code', customerCode)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.get('/customers/:customerCode/top-categories', authMiddleware, async (req, res) => {
  const { customerCode } = req.params;
  const { data, error } = await supabase
    .from('customer_top_3_categories')
    .select('*')
    .eq('customer_code', customerCode);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.get('/customers/:customerCode/neglected-categories', authMiddleware, async (req, res) => {
  const { customerCode } = req.params;
  const { data, error } = await supabase
    .from('customer_neglected_categories')
    .select('*')
    .eq('customer_code', customerCode);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

// ─── VISITS ────────────────────────────────────────────────────────────────
app.post('/api/visits', authMiddleware, async (req, res) => {
  const { customer_code, visit_date, visit_time, visit_type, notes, tasks, categories } = req.body;

  if (!customer_code || !visit_date) {
    return res.status(400).json({ error: 'customer_code and visit_date are required' });
  }

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

  if (tasks && tasks.length > 0) {
    const taskRows = tasks.map(t => ({
      visit_id: visit.id,
      description: t.description,
      reminder_date: t.reminderDate || null,
      status: 'not-started',
    }));
    const { error: taskError } = await supabase.from('crm_visit_tasks').insert(taskRows);
    if (taskError) return res.status(500).json({ error: taskError.message });
  }

  if (categories && categories.length > 0) {
    const categoryRows = categories.map(c => ({
      visit_id: visit.id,
      category_code: c.categoryCode,
      subcategory_code: c.subcategoryCode || null,
    }));
    const { error: catError } = await supabase.from('crm_visit_categories').insert(categoryRows);
    if (catError) return res.status(500).json({ error: catError.message });

    for (const cat of categories) {
      await supabase.rpc('upsert_category_discussion', {
        p_entity_type: 'customer',
        p_entity_id: customer_code,
        p_category_code: cat.categoryCode,
        p_subcategory_code: cat.subcategoryCode || null,
        p_visit_date: visit_date,
      });
    }
  }

  res.json({ success: true, visit });
});

app.get('/api/visits', authMiddleware, async (req, res) => {
  console.log('GET /api/visits query:', req.query);
  const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];
  const { customer_code } = req.query;

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

  if (customer_code) {
    query = query.eq('customer_code', customer_code);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Visits fetch error:', error);
    return res.status(500).json({ error: error.message });
  }

  const { data: profiles } = await supabase
    .from('crm_user_profiles')
    .select('id, full_name');

  const profileMap = new Map((profiles ?? []).map(p => [p.id, p.full_name]));

  const visitsWithNames = data.map(v => ({
    ...v,
    owner_name: profileMap.get(v.user_id) ?? v.salesman_code ?? 'Unknown',
  }));

  res.json(visitsWithNames);
});

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

// ─── COMMENTS ──────────────────────────────────────────────────────────────

app.post('/api/visits/:id/comments', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  if (!comment?.trim()) return res.status(400).json({ error: 'Comment is required' });

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

// Edit own comment (manager/admin only)
app.patch('/api/visits/comments/:commentId', authMiddleware, async (req, res) => {
  const { commentId } = req.params;
  const { comment } = req.body;
  if (!comment?.trim()) return res.status(400).json({ error: 'Comment is required' });
  const { error } = await supabase
    .from('crm_visit_comments')
    .update({ comment: comment.trim() })
    .eq('id', commentId)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

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

// ─── VISIT EDIT / DELETE ───────────────────────────────────────────────────

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

  const { error } = await query;
  if (error) return res.status(500).json({ error: error.message });

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

  // Return full visit with nested data + owner name
  const { data: fullVisit, error: fetchError } = await supabase
    .from('crm_visits')
    .select(`*, crm_visit_tasks(*), crm_visit_categories(*), crm_visit_comments(*)`)
    .eq('id', id)
    .single();

  if (fetchError) return res.status(500).json({ error: fetchError.message });

  const { data: profiles } = await supabase
    .from('crm_user_profiles')
    .select('id, full_name');

  const profileMap = new Map((profiles ?? []).map(p => [p.id, p.full_name]));

  res.json({
    ...fullVisit,
    owner_name: profileMap.get(fullVisit.user_id) ?? fullVisit.salesman_code ?? 'Unknown',
  });
});

// ─── PROSPECTS ────────────────────────────────────────────────────────────────

// Get competitors list
app.get('/api/competitors', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('crm_competitors')
    .select('*')
    .eq('is_active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Add new competitor
app.post('/api/competitors', authMiddleware, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  const { data, error } = await supabase
    .from('crm_competitors')
    .insert({ name: name.trim() })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get prospects
app.get('/api/prospects', authMiddleware, async (req, res) => {
  const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];
  let query = supabase
    .from('crm_prospects')
    .select(`*, crm_prospect_visits(*)`)
    .order('created_at', { ascending: false });

  if (!FULL_ACCESS_ROLES.includes(req.user.role)) {
    query = query.eq('salesman_code', req.user.salesman_code);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Check conversion — match vat_number against stg_soft1_trdr.afm
  const vatNumbers = (data || []).map(p => p.vat_number).filter(Boolean);
  let convertedMap = new Map();
  if (vatNumbers.length > 0) {
    const { data: matches } = await supabase
      .from('stg_soft1_trdr')
      .select('trdr_code, afm')
      .in('afm', vatNumbers)
      .eq('company', 1000)
      .eq('is_active', true)
      .eq('sodtype', 13);
    (matches || []).forEach(m => convertedMap.set(m.afm, m.trdr_code));
  }

  const prospects = (data || []).map(p => ({
    ...p,
    converted_customer_code: p.vat_number ? convertedMap.get(p.vat_number) ?? null : null,
    status: p.vat_number && convertedMap.has(p.vat_number) ? 'converted' : p.status,
  }));

  res.json(prospects);
});

// Create prospect
app.post('/api/prospects', authMiddleware, async (req, res) => {
  console.log('POST /api/prospects body:', JSON.stringify(req.body, null, 2));
  const {
    business_name, owner_name, phone, mobile, email,
    address, city, area, vat_number, notes, status,
    competitor_info, shop_profile,
  } = req.body;

  if (!business_name?.trim()) return res.status(400).json({ error: 'Business name is required' });

  console.log('Inserting prospect...');
  const { data: prospect, error } = await supabase
    .from('crm_prospects')
    .insert({
      business_name: business_name.trim(),
      owner_name, phone, mobile, email,
      address, city, area, vat_number, notes,
      status: status || 'new_lead',
      assigned_rep_id: req.user.id,
      salesman_code: req.user.salesman_code ?? '',
    })
    .select()
    .single();

  if (error) {
    console.error('Prospect insert error:', error);
    return res.status(500).json({ error: error.message });
  }

  console.log('Prospect inserted:', prospect.id);

  // Save competitor info
  if (competitor_info) {
    console.log('Inserting competitor info...');
    const { error: compError } = await supabase.from('crm_entity_competitor_info').insert({
      entity_type: 'prospect',
      entity_id: prospect.id,
      ...competitor_info,
    });
    if (compError) console.error('Competitor info error:', compError);
  }

  // Save shop profile
  if (shop_profile) {
    console.log('Inserting shop profile...');
    const { error: shopError } = await supabase.from('crm_entity_shop_profile').insert({
      entity_type: 'prospect',
      entity_id: prospect.id,
      ...shop_profile,
    });
    if (shopError) console.error('Shop profile error:', shopError);
  }

  console.log('Done!');
  res.json(prospect);
});

// Update prospect
app.patch('/api/prospects/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const {
    business_name, owner_name, phone, mobile, email,
    address, city, area, vat_number, notes, status,
    competitor_info, shop_profile,
  } = req.body;
  const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];

  let query = supabase
    .from('crm_prospects')
    .update({
      business_name, owner_name, phone, mobile, email,
      address, city, area, vat_number, notes, status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (!FULL_ACCESS_ROLES.includes(req.user.role)) {
    query = query.eq('assigned_rep_id', req.user.id);
  }

  const { data, error } = await query.select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Upsert competitor info
  if (competitor_info !== undefined) {
    await supabase.from('crm_entity_competitor_info').upsert({
      entity_type: 'prospect',
      entity_id: id,
      ...competitor_info,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'entity_type,entity_id' });
  }

  // Upsert shop profile
  if (shop_profile !== undefined) {
    await supabase.from('crm_entity_shop_profile').upsert({
      entity_type: 'prospect',
      entity_id: id,
      ...shop_profile,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'entity_type,entity_id' });
  }

  res.json(data);
});

// Delete prospect
app.delete('/api/prospects/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];

  let query = supabase.from('crm_prospects').delete().eq('id', id);
  if (!FULL_ACCESS_ROLES.includes(req.user.role)) {
    query = query.eq('assigned_rep_id', req.user.id);
  }

  const { error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Get entity profile (competitor + shop) — works for both prospects and customers
app.get('/api/entity-profile/:type/:id', authMiddleware, async (req, res) => {
  const { type, id } = req.params;

  const [competitorRes, shopRes] = await Promise.all([
    supabase.from('crm_entity_competitor_info')
      .select('*').eq('entity_type', type).eq('entity_id', id).single(),
    supabase.from('crm_entity_shop_profile')
      .select('*').eq('entity_type', type).eq('entity_id', id).single(),
  ]);

  res.json({
    competitor_info: competitorRes.data ?? null,
    shop_profile: shopRes.data ?? null,
  });
});

// Upsert entity profile
app.post('/api/entity-profile/:type/:id', authMiddleware, async (req, res) => {
  const { type, id } = req.params;
  const { competitor_info, shop_profile } = req.body;

  if (competitor_info !== undefined) {
    await supabase.from('crm_entity_competitor_info').upsert({
      entity_type: type,
      entity_id: id,
      ...competitor_info,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'entity_type,entity_id' });
  }

  if (shop_profile !== undefined) {
    await supabase.from('crm_entity_shop_profile').upsert({
      entity_type: type,
      entity_id: id,
      ...shop_profile,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'entity_type,entity_id' });
  }

  res.json({ success: true });
});

// Prospect visits
app.get('/api/prospects/:id/visits', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('crm_prospect_visits')
    .select(`*, crm_prospect_visit_categories(*)`)
    .eq('prospect_id', id)
    .order('visit_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/prospects/:id/visits', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { visit_date, visit_type, notes, outcome, categories } = req.body;

  if (!visit_date) return res.status(400).json({ error: 'visit_date is required' });

  const { data: visit, error } = await supabase
    .from('crm_prospect_visits')
    .insert({
      prospect_id: id,
      user_id: req.user.id,
      visit_date,
      visit_type: visit_type || 'in-person',
      notes,
      outcome: outcome || 'interested',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Insert categories
  if (categories && categories.length > 0) {
    const categoryRows = categories.map(c => ({
      prospect_visit_id: visit.id,
      category_code: c.categoryCode,
      subcategory_code: c.subcategoryCode || null,
    }));
    await supabase.from('crm_prospect_visit_categories').insert(categoryRows);
  }

  // Update prospect status
  await supabase.from('crm_prospects')
    .update({ status: 'visited', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'new_lead');

  res.json(visit);
});

// VAT check
app.get('/api/vat-check/:vat', authMiddleware, async (req, res) => {
  const { vat } = req.params;

  // Check in stg_soft1_trdr (active and inactive)
  const { data: customers } = await supabase
    .from('stg_soft1_trdr')
    .select('trdr_code, trdr_name, city, area_name, is_active')
    .eq('afm', vat.trim())
    .eq('company', 1000)
    .eq('sodtype', 13)
    .limit(1);

  if (customers && customers.length > 0) {
    const c = customers[0];
    return res.json({
      type: c.is_active ? 'existing_customer' : 'inactive_customer',
      data: c,
    });
  }

  // Check existing prospects
  const { data: prospects } = await supabase
    .from('crm_prospects')
    .select('id, business_name, city, area')
    .eq('vat_number', vat.trim())
    .limit(1);

  if (prospects && prospects.length > 0) {
    return res.json({ type: 'existing_prospect', data: prospects[0] });
  }

  return res.json({ type: 'not_found' });
});

// Category intelligence per customer
app.get('/api/customers/:code/categories', authMiddleware, async (req, res) => {
  const { code } = req.params;

  const { data: visits } = await supabase
    .from('crm_visits')
    .select('id, visit_date')
    .eq('customer_code', code);

  if (!visits || visits.length === 0) return res.json([]);

  const visitIds = visits.map(v => v.id);
  const visitDateMap = new Map(visits.map(v => [v.id, v.visit_date]));

  const { data: categories, error } = await supabase
    .from('crm_visit_categories')
    .select('category_code, subcategory_code, visit_id')
    .in('visit_id', visitIds);

  if (error) return res.status(500).json({ error: error.message });
  if (!categories || categories.length === 0) return res.json([]);

  // Fetch category names
  const allCodes = [...new Set([
    ...categories.map(c => c.category_code),
    ...categories.map(c => c.subcategory_code).filter(Boolean),
  ])];

  const { data: masters } = await supabase
    .from('crm_category_master')
    .select('category_code, full_name, short_name, level, parent_code')
    .in('category_code', allCodes);

  const masterMap = new Map((masters ?? []).map(m => [m.category_code, m]));

  // Group by category+subcategory, track last_discussed and count
  const grouped = new Map();
  categories.forEach(c => {
    const key = `${c.category_code}__${c.subcategory_code ?? ''}`;
    const visitDate = visitDateMap.get(c.visit_id);
    if (!grouped.has(key)) {
      grouped.set(key, {
        category_code: c.category_code,
        subcategory_code: c.subcategory_code ?? null,
        last_discussed: visitDate,
        times_discussed: 1,
      });
    } else {
      const existing = grouped.get(key);
      existing.times_discussed++;
      if (visitDate > existing.last_discussed) {
        existing.last_discussed = visitDate;
      }
    }
  });

  const result = Array.from(grouped.values()).map(item => {
    const displayCode = item.subcategory_code ?? item.category_code;
    const master = masterMap.get(displayCode) ?? masterMap.get(item.category_code);
    return {
      ...item,
      full_name: master?.full_name ?? displayCode,
      short_name: master?.short_name ?? displayCode,
      level: master?.level ?? 1,
      parent_code: master?.parent_code ?? null,
    };
  }).sort((a, b) => (b.last_discussed ?? '').localeCompare(a.last_discussed ?? ''));

  res.json(result);
});

app.listen(3001, () => {
  console.log('Backend running on http://localhost:3001');
});