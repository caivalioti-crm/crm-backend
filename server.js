require('dotenv').config();

const { supabase } = require('./supabaseClient');
const express = require('express');
const cron = require('node-cron');
const webpush = require('web-push');
const cors = require('cors');
const erpRoutes = require('./routes/erp');
const { authMiddleware } = require('./middleware/auth');
const multer = require('multer');
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 10 * 1024 * 1024 } 
});
const planningRouter = require('./routes/planning');



function convertDateToISO(ddmmyy) {
  const [day, month, shortYear] = ddmmyy.split('/');
  const year = Number(shortYear) < 50
    ? `20${shortYear}`
    : `19${shortYear}`;
  return `${year}-${month}-${day}`;
}

const app = express();

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://crm.eaivaliotis.gr'
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());
app.use('/api/erp', authMiddleware, erpRoutes);
app.use('/api/planning', authMiddleware, planningRouter);
app.use('/api', authMiddleware, require('./routes/coordinates'));

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

app.post('/api/visits', authMiddleware, upload.single('voice_memo'), async (req, res) => {
  const customer_code = req.body.customer_code;
  const visit_date = req.body.visit_date;
  const visit_time = req.body.visit_time;
  const visit_type = req.body.visit_type;
  const notes = req.body.notes;
  const tasks = typeof req.body.tasks === 'string' ? JSON.parse(req.body.tasks) : (req.body.tasks || []);
  const categories = typeof req.body.categories === 'string' ? JSON.parse(req.body.categories) : (req.body.categories || []);
  const shop_profile = typeof req.body.shop_profile === 'string' ? JSON.parse(req.body.shop_profile) : (req.body.shop_profile || null);
  const competition_info = typeof req.body.competition_info === 'string' ? JSON.parse(req.body.competition_info) : (req.body.competition_info || null);

  if (!customer_code || !visit_date) {
    return res.status(400).json({ error: 'customer_code and visit_date are required' });
  }

  let voice_memo_path = null;
  if (req.file) {
    const filename = `${req.user.id}/${Date.now()}.webm`;
    const { error: storageError } = await supabase.storage
      .from('voice-memos')
      .upload(filename, req.file.buffer, { contentType: 'audio/webm', upsert: false });
    if (!storageError) voice_memo_path = filename;
    else console.error('Voice memo upload error:', storageError);
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
      voice_memo_path,
      shop_profile: (shop_profile && Object.values(shop_profile).some(v => v !== undefined && v !== '' && v !== null)) ? {
      shop_type: shop_profile.shop_type || null,
      number_of_employees: shop_profile.numberOfEmployees ?? null,
      shop_size_m2: shop_profile.shopSizeM2 ?? null,
      stock_behavior: shop_profile.stockBehavior || null,
      vehicle_types: shop_profile.vehicleTypes ?? [],
      vehicle_brands: shop_profile.vehicleBrands ?? [],
    } : null,
    competitor_info: (competition_info && Object.values(competition_info).some(v => v !== undefined && v !== '' && v !== null)) ? {
      competitors_v2: competition_info.competitors ?? [],
      estimated_monthly_spend: competition_info.estimatedMonthlySpend ?? null,
      switch_reason: competition_info.switchReason || null,
    } : null,
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

  // Upsert shop profile + competition info
  if (shop_profile && Object.values(shop_profile).some(v => v !== undefined && v !== '' && v !== null)) {
    await supabase.from('crm_entity_shop_profile').upsert({
    entity_type: 'customer',
    entity_id: customer_code,
    shop_type: shop_profile.shop_type || null,
    number_of_employees: shop_profile.numberOfEmployees ?? null,
    shop_size_m2: shop_profile.shopSizeM2 ?? null,
    stock_behavior: shop_profile.stockBehavior || null,
    vehicle_types: shop_profile.vehicleTypes ?? [],
    vehicle_brands: shop_profile.vehicleBrands ?? [],
    updated_at: new Date().toISOString(),
  }, { onConflict: 'entity_type,entity_id' });
  }

  if (competition_info && Object.values(competition_info).some(v => v !== undefined && v !== '' && v !== null)) {
    await supabase.from('crm_entity_competitor_info').upsert({
    entity_type: 'customer',
    entity_id: customer_code,
    competitors_v2: competition_info.competitors ?? [],
    estimated_monthly_spend: competition_info.estimatedMonthlySpend ?? null,
    switch_reason: competition_info.switchReason || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'entity_type,entity_id' });
  }

  res.json({ success: true, visit });
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

  if (customer_code) query = query.eq('customer_code', customer_code);

  const { from, to } = req.query;
    if (from) query = query.gte('visit_date', from);
    if (to) query = query.lte('visit_date', to);

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

app.get('/api/visits/:id/voice-memo', authMiddleware, async (req, res) => {
  const { data: visit, error } = await supabase
    .from('crm_visits')
    .select('voice_memo_path')
    .eq('id', req.params.id)
    .single();

  if (error || !visit?.voice_memo_path) {
    return res.status(404).json({ error: 'No voice memo found' });
  }

  const { data, error: urlError } = await supabase.storage
    .from('voice-memos')
    .createSignedUrl(visit.voice_memo_path, 3600);

  if (urlError) return res.status(500).json({ error: urlError.message });

  res.json({ url: data.signedUrl });
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
  
  const {
    business_name, owner_name, phone, mobile, email,
    address, city, area, vat_number, notes, status,
    competitor_info, shop_profile,
  } = req.body;

  if (!business_name?.trim()) return res.status(400).json({ error: 'Business name is required' });

  
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

  // Save competitor info
  if (competitor_info) {
    const { error: compError } = await supabase.from('crm_entity_competitor_info').insert({
      entity_type: 'prospect',
      entity_id: prospect.id,
      ...competitor_info,
    });
    if (compError) console.error('Competitor info error:', compError);
  }

  // Save shop profile
  if (shop_profile) {
    
    const { error: shopError } = await supabase.from('crm_entity_shop_profile').insert({
      entity_type: 'prospect',
      entity_id: prospect.id,
      ...shop_profile,
    });
    if (shopError) console.error('Shop profile error:', shopError);
  }

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
      competitors_v2: competitor_info.competitors_v2 ?? [],
      estimated_monthly_spend: competitor_info.estimated_monthly_spend ?? null,
      switch_reason: competitor_info.switch_reason ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'entity_type,entity_id' });
  }

  if (shop_profile !== undefined) {
    await supabase.from('crm_entity_shop_profile').upsert({
      entity_type: type,
      entity_id: id,
      shop_type: shop_profile.shop_type ?? null,
      number_of_employees: shop_profile.number_of_employees ?? null,
      shop_size_m2: shop_profile.shop_size_m2 ?? null,
      stock_behavior: shop_profile.stock_behavior ?? null,
      vehicle_types: shop_profile.vehicle_types ?? [],
      vehicle_brands: shop_profile.vehicle_brands ?? [],
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

app.post('/api/prospects/:id/visits', authMiddleware, upload.single('voice_memo'), async (req, res) => {
  const { id } = req.params;
  const visit_date = req.body.visit_date;
  const visit_time = req.body.visit_time;
  const visit_type = req.body.visit_type;
  const notes = req.body.notes;
  const categories = typeof req.body.categories === 'string' ? JSON.parse(req.body.categories) : (req.body.categories || []);
  const shop_profile = typeof req.body.shop_profile === 'string' ? JSON.parse(req.body.shop_profile) : (req.body.shop_profile || null);
  const competition_info = typeof req.body.competition_info === 'string' ? JSON.parse(req.body.competition_info) : (req.body.competition_info || null);

  if (!visit_date) return res.status(400).json({ error: 'visit_date is required' });

  let voice_memo_path = null;
  if (req.file) {
    const filename = `${req.user.id}/prospect-${Date.now()}.webm`;
    const { error: storageError } = await supabase.storage
      .from('voice-memos')
      .upload(filename, req.file.buffer, { contentType: 'audio/webm', upsert: false });
    if (!storageError) voice_memo_path = filename;
    else console.error('Voice memo upload error:', storageError);
  }

  const { data: visit, error } = await supabase
    .from('crm_prospect_visits')
    .insert({
      prospect_id: id,
      user_id: req.user.id,
      visit_date,
      visit_time: visit_time || null,
      visit_type: visit_type || 'in-person',
      notes: notes || '',
      outcome: 'interested',
      voice_memo_path,
    shop_profile: (shop_profile && Object.values(shop_profile).some(v => v !== undefined && v !== '' && v !== null)) ? {
    shop_type: shop_profile.shop_type || null,
    number_of_employees: shop_profile.numberOfEmployees ?? null,
    shop_size_m2: shop_profile.shopSizeM2 ?? null,
    stock_behavior: shop_profile.stockBehavior || null,
    vehicle_types: shop_profile.vehicleTypes ?? [],
    vehicle_brands: shop_profile.vehicleBrands ?? [],
  } : null,
  competitor_info: (competition_info && Object.values(competition_info).some(v => v !== undefined && v !== '' && v !== null)) ? {
    competitors_v2: competition_info.competitors ?? [],
    estimated_monthly_spend: competition_info.estimatedMonthlySpend ?? null,
    switch_reason: competition_info.switchReason || null,
  } : null,
  })
  .select()
  .single();

  if (error) return res.status(500).json({ error: error.message });

  if (categories && categories.length > 0) {
    const categoryRows = categories.map(c => ({
      prospect_visit_id: visit.id,
      category_code: c.categoryCode,
      subcategory_code: c.subcategoryCode || null,
    }));
    await supabase.from('crm_prospect_visit_categories').insert(categoryRows);

    for (const cat of categories) {
      await supabase.rpc('upsert_category_discussion', {
        p_entity_type: 'prospect',
        p_entity_id: id,
        p_category_code: cat.categoryCode,
        p_subcategory_code: cat.subcategoryCode || null,
        p_visit_date: visit_date,
      });
    }
  }

  if (shop_profile && Object.values(shop_profile).some(v => v !== undefined && v !== '' && v !== null)) {
    await supabase.from('crm_entity_shop_profile').upsert({
    entity_type: 'prospect',
    entity_id: id,
    shop_type: shop_profile.shop_type || null,
    number_of_employees: shop_profile.numberOfEmployees ?? null,
    shop_size_m2: shop_profile.shopSizeM2 ?? null,
    stock_behavior: shop_profile.stockBehavior || null,
    vehicle_types: shop_profile.vehicleTypes ?? [],
    vehicle_brands: shop_profile.vehicleBrands ?? [],
    updated_at: new Date().toISOString(),
  }, { onConflict: 'entity_type,entity_id' });
  }

  if (competition_info && Object.values(competition_info).some(v => v !== undefined && v !== '' && v !== null)) {
    await supabase.from('crm_entity_competitor_info').upsert({
    entity_type: 'prospect',
    entity_id: id,
    competitors_v2: competition_info.competitors ?? [],
    estimated_monthly_spend: competition_info.estimatedMonthlySpend ?? null,
    switch_reason: competition_info.switchReason || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'entity_type,entity_id' });
  }

  await supabase.from('crm_prospects')
    .update({ status: 'visited', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'new_lead');

  res.json(visit);
});

// Prospect visit voice memo
app.get('/api/prospect-visits/:id/voice-memo', authMiddleware, async (req, res) => {
  const { data: visit, error } = await supabase
    .from('crm_prospect_visits')
    .select('voice_memo_path')
    .eq('id', req.params.id)
    .single();

  if (error || !visit?.voice_memo_path) {
    return res.status(404).json({ error: 'No voice memo found' });
  }

  const { data, error: urlError } = await supabase.storage
    .from('voice-memos')
    .createSignedUrl(visit.voice_memo_path, 3600);

  if (urlError) return res.status(500).json({ error: urlError.message });

  res.json({ url: data.signedUrl });
});

// Edit prospect visit
app.patch('/api/prospect-visits/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { notes, visit_type, visit_date } = req.body;

  const { error } = await supabase
    .from('crm_prospect_visits')
    .update({ notes, visit_type, visit_date })
    .eq('id', id)
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });

  const { data: updated, error: fetchErr } = await supabase
    .from('crm_prospect_visits')
    .select(`*, crm_prospect_visit_categories(*)`)
    .eq('id', id)
    .single();

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  res.json(updated);
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

// ─── CATEGORY INTELLIGENCE ────────────────────────────────────────────────────

app.get('/api/customers/:code/category-scope', authMiddleware, async (req, res) => {
  const { code } = req.params;
  const { data, error } = await supabase
    .from('crm_customer_category_scope')
    .select('*')
    .eq('customer_code', code)
    .eq('out_of_scope', true);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

app.post('/api/customers/:code/category-scope', authMiddleware, async (req, res) => {
  const { code } = req.params;
  const { category_code, category_level } = req.body;
  if (!category_code) return res.status(400).json({ error: 'category_code required' });
  const { error } = await supabase
    .from('crm_customer_category_scope')
    .upsert({
      customer_code: code,
      category_code,
      category_level: category_level ?? 1,
      out_of_scope: true,
      out_of_scope_at: new Date().toISOString(),
      out_of_scope_by: req.user.id,
    }, { onConflict: 'customer_code,category_code' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/customers/:code/category-scope/:categoryCode', authMiddleware, async (req, res) => {
  const { code, categoryCode } = req.params;
  const { error } = await supabase
    .from('crm_customer_category_scope')
    .update({ out_of_scope: false, out_of_scope_at: null, out_of_scope_by: null })
    .eq('customer_code', code)
    .eq('category_code', categoryCode);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/customers/:code/category-opportunities', authMiddleware, async (req, res) => {
  const { code } = req.params;
  const { data, error } = await supabase
    .from('crm_category_opportunities')
    .select('*')
    .eq('customer_code', code)
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

app.post('/api/customers/:code/category-opportunities', authMiddleware, async (req, res) => {
  const { code } = req.params;
  const {
    opportunity_type, category_code, category_level,
    category_name, signal_value, signal_context, status, notes,
  } = req.body;
  const { data, error } = await supabase
    .from('crm_category_opportunities')
    .upsert({
      customer_code: code,
      opportunity_type,
      category_code,
      category_level: category_level ?? 1,
      category_name,
      signal_value,
      signal_context,
      status: status ?? 'open',
      notes,
      updated_at: new Date().toISOString(),
      created_by: req.user.id,
    }, { onConflict: 'customer_code,category_code,opportunity_type' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/customers/:code/category-intelligence', authMiddleware, async (req, res) => {
  const { code } = req.params;
  const { from, to, prevFrom, prevTo } = req.query;
  if (!from || !to || !prevFrom || !prevTo) {
    return res.status(400).json({ error: 'from, to, prevFrom, prevTo required' });
  }

  try {
    // 1. Out-of-scope categories
    const { data: scopeData } = await supabase
      .from('crm_customer_category_scope')
      .select('category_code')
      .eq('customer_code', code)
      .eq('out_of_scope', true);
    const outOfScope = new Set((scopeData ?? []).map(s => s.category_code));

    // 2. Existing opportunity statuses
    const { data: oppData } = await supabase
      .from('crm_category_opportunities')
      .select('category_code, opportunity_type, status, notes')
      .eq('customer_code', code);
    const oppMap = new Map((oppData ?? []).map(o => [
      `${o.opportunity_type}__${o.category_code}`, o
    ]));

    // 3. This customer's sales — current period
    const { data: currRaw, error: currErr } = await supabase
      .from('vw_crm_customer_category_sales')
      .select('l1_code, l2_code, netamnt, category_id, full_name, level')
      .eq('customer_code', code)
      .gte('trndate', from)
      .lte('trndate', to);
    if (currErr) throw currErr;

    // 4. This customer's sales — prev period
    const { data: prevRaw, error: prevErr } = await supabase
      .from('vw_crm_customer_category_sales')
      .select('l1_code, l2_code, netamnt, category_id, full_name, level')
      .eq('customer_code', code)
      .gte('trndate', prevFrom)
      .lte('trndate', prevTo);
    if (prevErr) throw prevErr;

    // Aggregate helpers
    const aggL1 = (rows) => {
      const m = new Map();
      (rows ?? []).forEach(r => {
        if (r.l1_code) m.set(r.l1_code, (m.get(r.l1_code) ?? 0) + Number(r.netamnt ?? 0));
      });
      return m;
    };
    const aggL2 = (rows) => {
      const m = new Map();
      (rows ?? []).forEach(r => {
        if (r.l2_code) m.set(r.l2_code, (m.get(r.l2_code) ?? 0) + Number(r.netamnt ?? 0));
      });
      return m;
    };

    const currL1 = aggL1(currRaw);
    const prevL1 = aggL1(prevRaw);
    const currL2 = aggL2(currRaw);
    const prevL2 = aggL2(prevRaw);

    // Total revenue for significance calculation
    const prevTotal = [...prevL1.values()].reduce((s, v) => s + v, 0);

    // Top-3 L1 by prev revenue
    const prevL1Sorted = [...prevL1.entries()].sort((a, b) => b[1] - a[1]);
    const top3L1 = new Set(prevL1Sorted.slice(0, 3).map(([k]) => k));

    // Category name lookup from view rows
    const nameMap = new Map();
    const levelMap = new Map();
    [...(currRaw ?? []), ...(prevRaw ?? [])].forEach(r => {
      if (r.l1_code) { nameMap.set(r.l1_code, r.l1_code); levelMap.set(r.l1_code, 1); }
      if (r.l2_code) { nameMap.set(r.l2_code, r.l2_code); levelMap.set(r.l2_code, 2); }
    });

    // Get full names from crm_category_master
    const allCodes = new Set([...currL1.keys(), ...prevL1.keys(), ...currL2.keys(), ...prevL2.keys()]);
    const { data: masters } = await supabase
      .from('crm_category_master')
      .select('category_code, full_name, level')
      .in('category_code', [...allCodes]);
    const masterMap = new Map((masters ?? []).map(m => [m.category_code, m]));
    const getName = (c) => masterMap.get(c)?.full_name ?? c;
    const getLevel = (c) => masterMap.get(c)?.level ?? levelMap.get(c) ?? 1;

    // 5. Similar customers
    const { data: simData } = await supabase
      .rpc('get_similar_customers', { p_customer_code: code });

    const similarCodes = [...new Set((simData ?? []).map(r => r.similar_code))];
    const similarCount = similarCodes.length;

    // 6. Peer category sales + buyer count
    const peerL1Rev = new Map();
    const peerL2Rev = new Map();
    const peerL1Buyers = new Map();
    const peerL2Buyers = new Map();

    if (similarCount > 0) {
      const CHUNK = 50;
      const chunks = [];
      for (let i = 0; i < similarCodes.length; i += CHUNK) {
        chunks.push(similarCodes.slice(i, i + CHUNK));
      }

      for (const chunk of chunks) {
        const { data: peerRaw } = await supabase
          .rpc('get_peer_category_sales_intel', {
            p_customer_codes: chunk,
            p_from: from,
            p_to: to,
          });

        (peerRaw ?? []).forEach(r => {
          if (r.l1_code) {
            peerL1Rev.set(r.l1_code, (peerL1Rev.get(r.l1_code) ?? 0) + Number(r.netamnt ?? 0));
            if (!peerL1Buyers.has(r.l1_code)) peerL1Buyers.set(r.l1_code, new Set());
            peerL1Buyers.get(r.l1_code).add(r.customer_code);
          }
          if (r.l2_code) {
            peerL2Rev.set(r.l2_code, (peerL2Rev.get(r.l2_code) ?? 0) + Number(r.netamnt ?? 0));
            if (!peerL2Buyers.has(r.l2_code)) peerL2Buyers.set(r.l2_code, new Set());
            peerL2Buyers.get(r.l2_code).add(r.customer_code);
          }
        });
      }
    }

    // Fetch names for peer categories not in customer's own data
    const peerCodes = new Set([...peerL1Rev.keys(), ...peerL2Rev.keys()]);
    const unknownCodes = [...peerCodes].filter(c => !masterMap.has(c));
    if (unknownCodes.length > 0) {
      const { data: extraMasters } = await supabase
        .from('crm_category_master')
        .select('category_code, full_name, level')
        .in('category_code', unknownCodes);
      (extraMasters ?? []).forEach(m => masterMap.set(m.category_code, m));
    }

    // ── SIGNAL 1: DECLINING ──────────────────────────────────────────────────
    const declining = [];

    // Check L1
    prevL1.forEach((prevRev, cat) => {
      if (outOfScope.has(cat)) return;
      if (prevRev < 500) return;
      const currRev = currL1.get(cat) ?? 0;
      const pctOfTotal = prevTotal > 0 ? prevRev / prevTotal : 0;
      const isSignificant = pctOfTotal >= 0.05 || top3L1.has(cat);
      const drop = (prevRev - currRev) / prevRev;
      if (!isSignificant || drop <= 0.5) return;

      const oppKey = `declining__${cat}`;
      const existing = oppMap.get(oppKey);
      if (existing?.status === 'dismissed') return;

      declining.push({
        category_code: cat,
        category_name: getName(cat),
        category_level: 1,
        prev_revenue: Math.round(prevRev),
        curr_revenue: Math.round(currRev),
        drop_pct: Math.round(drop * 100),
        pct_of_total: Math.round(pctOfTotal * 100),
        was_top3: top3L1.has(cat),
        status: existing?.status ?? 'open',
        notes: existing?.notes ?? null,
      });
    });

    // Check L2
    prevL2.forEach((prevRev, cat) => {
      if (outOfScope.has(cat)) return;
      if (prevRev < 300) return;
      const currRev = currL2.get(cat) ?? 0;
      const drop = (prevRev - currRev) / prevRev;
      if (drop <= 0.5) return;
      // Only include L2 if its parent L1 is NOT already in declining
      const l1Parent = cat.split('.')[0];
      if (declining.some(d => d.category_code === l1Parent)) return;

      const oppKey = `declining__${cat}`;
      const existing = oppMap.get(oppKey);
      if (existing?.status === 'dismissed') return;

      declining.push({
        category_code: cat,
        category_name: getName(cat),
        category_level: 2,
        prev_revenue: Math.round(prevRev),
        curr_revenue: Math.round(currRev),
        drop_pct: Math.round(drop * 100),
        pct_of_total: 0,
        was_top3: false,
        status: existing?.status ?? 'open',
        notes: existing?.notes ?? null,
      });
    });

    declining.sort((a, b) => b.prev_revenue - a.prev_revenue);

    // ── SIGNAL 2: MISSING ────────────────────────────────────────────────────
    const missing = [];

    if (similarCount > 0) {
      // L1 missing
      peerL1Buyers.forEach((buyers, cat) => {
        if (outOfScope.has(cat)) return;
        if ((currL1.get(cat) ?? 0) > 0) return;
        const penetration = buyers.size / similarCount;
        if (penetration < 0.5) return;

        const oppKey = `missing__${cat}`;
        const existing = oppMap.get(oppKey);
        if (existing?.status === 'dismissed') return;

        missing.push({
          category_code: cat,
          category_name: getName(cat),
          category_level: 1,
          peer_penetration_pct: Math.round(penetration * 100),
          peer_avg_revenue: Math.round((peerL1Rev.get(cat) ?? 0) / similarCount),
          peer_buyer_count: buyers.size,
          similar_customer_count: similarCount,
          status: existing?.status ?? 'open',
          notes: existing?.notes ?? null,
        });
      });

      // L2 missing
      peerL2Buyers.forEach((buyers, cat) => {
        if (outOfScope.has(cat)) return;
        if ((currL2.get(cat) ?? 0) > 0) return;
        const penetration = buyers.size / similarCount;
        if (penetration < 0.5) return;
        // Only show L2 if parent L1 is not already missing
        const l1Parent = cat.split('.')[0];
        if (missing.some(m => m.category_code === l1Parent)) return;

        const oppKey = `missing__${cat}`;
        const existing = oppMap.get(oppKey);
        if (existing?.status === 'dismissed') return;

        missing.push({
          category_code: cat,
          category_name: getName(cat),
          category_level: 2,
          peer_penetration_pct: Math.round(penetration * 100),
          peer_avg_revenue: Math.round((peerL2Rev.get(cat) ?? 0) / similarCount),
          peer_buyer_count: buyers.size,
          similar_customer_count: similarCount,
          status: existing?.status ?? 'open',
          notes: existing?.notes ?? null,
        });
      });

      missing.sort((a, b) => b.peer_penetration_pct - a.peer_penetration_pct);
    }

    // ── SIGNAL 3: WEAK ───────────────────────────────────────────────────────
    const weak = [];

    if (similarCount > 0) {
      // L1 weak
      currL1.forEach((currRev, cat) => {
        if (outOfScope.has(cat)) return;
        if (currRev <= 0) return;
        const peerAvg = (peerL1Rev.get(cat) ?? 0) / similarCount;
        if (peerAvg < 300) return;
        const ratio = currRev / peerAvg;
        if (ratio >= 0.3) return;

        const oppKey = `weak__${cat}`;
        const existing = oppMap.get(oppKey);
        if (existing?.status === 'dismissed') return;

        weak.push({
          category_code: cat,
          category_name: getName(cat),
          category_level: 1,
          curr_revenue: Math.round(currRev),
          peer_avg_revenue: Math.round(peerAvg),
          gap_revenue: Math.round(peerAvg - currRev),
          ratio_pct: Math.round(ratio * 100),
          status: existing?.status ?? 'open',
          notes: existing?.notes ?? null,
        });
      });

      // L2 weak
      currL2.forEach((currRev, cat) => {
        if (outOfScope.has(cat)) return;
        if (currRev <= 0) return;
        const peerAvg = (peerL2Rev.get(cat) ?? 0) / similarCount;
        if (peerAvg < 200) return;
        const ratio = currRev / peerAvg;
        if (ratio >= 0.3) return;
        const l1Parent = cat.split('.')[0];
        if (weak.some(w => w.category_code === l1Parent)) return;

        const oppKey = `weak__${cat}`;
        const existing = oppMap.get(oppKey);
        if (existing?.status === 'dismissed') return;

        weak.push({
          category_code: cat,
          category_name: getName(cat),
          category_level: 2,
          curr_revenue: Math.round(currRev),
          peer_avg_revenue: Math.round(peerAvg),
          gap_revenue: Math.round(peerAvg - currRev),
          ratio_pct: Math.round(ratio * 100),
          status: existing?.status ?? 'open',
          notes: existing?.notes ?? null,
        });
      });

      weak.sort((a, b) => b.gap_revenue - a.gap_revenue);
    }

    res.json({
      similar_customers: { count: similarCount },
      out_of_scope: [...outOfScope],
      declining,
      missing,
      weak,
    });

  } catch (err) {
    console.error('Category intelligence error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Similar customers drill-down
app.get('/api/customers/:code/similar-customers', authMiddleware, async (req, res) => {
  try {
    const { code } = req.params;
    const { from, to } = req.query;

    const { data: similar, error } = await supabase.rpc('get_similar_customers', {
      p_customer_code: code,
    });
    if (error) throw error;
    if (!similar?.length) return res.json([]);

    const codes = similar.map(s => s.similar_code);

    // Get customer names/cities
    const { data: customers } = await supabase
      .from('vw_crm_customers')
      .select('code, name, city, area')
      .in('code', codes);

    const custMap = new Map((customers ?? []).map(c => [String(c.code), c]));

    // Get sales for period
    const { data: sales } = await supabase
      .from('vw_crm_sales')
      .select('customer_code, netamnt')
      .in('customer_code', codes)
      .gte('trndate', from || '2026-01-01')
      .lte('trndate', to || new Date().toISOString().split('T')[0]);

    const salesMap = new Map();
    for (const s of sales ?? []) {
      salesMap.set(s.customer_code, (salesMap.get(s.customer_code) ?? 0) + Number(s.netamnt ?? 0));
    }

    // Get L1 categories for this customer
    const { data: myCats } = await supabase
      .from('vw_crm_customer_category_sales')
      .select('l1_code')
      .eq('customer_code', code)
      .gte('trndate', from || '2026-01-01')
      .lte('trndate', to || new Date().toISOString().split('T')[0]);

    const myL1s = new Set((myCats ?? []).map(r => r.l1_code).filter(Boolean));

    // Get L1 categories for each similar customer
    const { data: peerCats } = await supabase
      .from('vw_crm_customer_category_sales')
      .select('customer_code, l1_code')
      .in('customer_code', codes)
      .gte('trndate', from || '2026-01-01')
      .lte('trndate', to || new Date().toISOString().split('T')[0]);

    const peerCatMap = new Map();
    for (const r of peerCats ?? []) {
      if (!r.l1_code) continue;
      if (!peerCatMap.has(r.customer_code)) peerCatMap.set(r.customer_code, new Set());
      peerCatMap.get(r.customer_code).add(r.l1_code);
    }

    // Get category names
    const allL1s = new Set([...myL1s, ...[...peerCatMap.values()].flatMap(s => [...s])]);
    const { data: masters } = await supabase
      .from('crm_category_master')
      .select('category_code, short_name, full_name')
      .in('category_code', [...allL1s])
      .eq('level', 1);

    const masterMap = new Map((masters ?? []).map(m => [m.category_code, m.short_name ?? m.full_name ?? m.category_code]));

    const result = similar.map(s => {
      const cust = custMap.get(s.similar_code) ?? {};
      const peerL1s = peerCatMap.get(s.similar_code) ?? new Set();
      const shared = [...peerL1s].filter(c => myL1s.has(c)).map(c => masterMap.get(c) ?? c);
      const onlyPeer = [...peerL1s].filter(c => !myL1s.has(c)).map(c => masterMap.get(c) ?? c);
      return {
        code: s.similar_code,
        name: cust.name ?? s.similar_code,
        city: cust.city ?? '',
        area: cust.area ?? '',
        l1_overlap: Math.round(s.l1_overlap * 100),
        l2_overlap: Math.round(s.l2_overlap * 100),
        revenue: Math.round(salesMap.get(s.similar_code) ?? 0),
        shared_categories: shared,
        only_peer_categories: onlyPeer,
      };
    }).sort((a, b) => b.l2_overlap - a.l2_overlap);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DAILY TASK REMINDERS ────────────────────────────────────────────────────
async function sendDailyTaskReminders() {
  console.log('[Push] Running daily task reminders...');
  try {
    const today = new Date().toISOString().split('T')[0];
    const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];

    // Get all subscriptions
    const { data: subscriptions } = await supabase
      .from('crm_push_subscriptions')
      .select('user_id, subscription');

    if (!subscriptions || subscriptions.length === 0) {
      console.log('[Push] No subscriptions found.');
      return { sent: 0, skipped: 0 };
    }

    // Get active snoozes
    const { data: snoozes } = await supabase
      .from('crm_push_snooze')
      .select('user_id, snoozed_until')
      .gt('snoozed_until', new Date().toISOString());

    const snoozedUsers = new Set((snoozes ?? []).map(s => s.user_id));

    // Get all user profiles
    const { data: profiles } = await supabase
      .from('crm_user_profiles')
      .select('id, salesman_code, role, full_name');

    const profileMap = new Map((profiles ?? []).map(p => [p.id, p]));

    // ─── Pre-compute company-wide OVERDUE per rep (for manager team overview) ───
    const { data: allVisits } = await supabase
      .from('crm_visits')
      .select('id, salesman_code, user_id');

    const visitOwnerMap = new Map(
      (allVisits ?? []).map(v => [v.id, { salesman_code: v.salesman_code, user_id: v.user_id }])
    );

    const { data: allOverdueTasks } = await supabase
      .from('crm_visit_tasks')
      .select('id, visit_id, reminder_date')
      .not('status', 'eq', 'completed')
      .not('reminder_date', 'is', null)
      .lt('reminder_date', today);

    const overdueByRep = new Map(); // salesman_code → count
    for (const t of allOverdueTasks ?? []) {
      const owner = visitOwnerMap.get(t.visit_id);
      if (!owner || !owner.salesman_code) continue;
      overdueByRep.set(owner.salesman_code, (overdueByRep.get(owner.salesman_code) ?? 0) + 1);
    }

    const nameBySalesmanCode = new Map();
    for (const p of profiles ?? []) {
      if (p.salesman_code) nameBySalesmanCode.set(p.salesman_code, p.full_name);
    }

    let sent = 0;
    let skipped = 0;

    for (const sub of subscriptions) {
      if (snoozedUsers.has(sub.user_id)) { skipped++; continue; }

      const profile = profileMap.get(sub.user_id);
      if (!profile) { skipped++; continue; }

      const isManager = FULL_ACCESS_ROLES.includes(profile.role);

      // ─── Personal tasks: user_id OR salesman_code (Option C) ───
      const orFilters = [`user_id.eq.${profile.id}`];
      if (profile.salesman_code) {
        orFilters.push(`salesman_code.eq.${profile.salesman_code}`);
      }

      const { data: visits } = await supabase
        .from('crm_visits')
        .select('id')
        .or(orFilters.join(','));

      const visitIds = (visits ?? []).map(v => v.id);

      let personalTasks = [];
      if (visitIds.length > 0) {
        const { data: tasks } = await supabase
          .from('crm_visit_tasks')
          .select('id, description, reminder_date')
          .in('visit_id', visitIds)
          .not('status', 'eq', 'completed')
          .not('reminder_date', 'is', null)
          .lte('reminder_date', today);
        personalTasks = tasks ?? [];
      }

      const todayTasks = personalTasks.filter(t => t.reminder_date === today);
      const overdueTasks = personalTasks.filter(t => t.reminder_date < today);

      // ─── Team overview (managers only) ───
      let teamSection = '';
      if (isManager && overdueByRep.size > 0) {
        const otherReps = [...overdueByRep.entries()]
          .filter(([code]) => code !== profile.salesman_code);

        if (otherReps.length > 0) {
          const totalOverdue = otherReps.reduce((sum, [, count]) => sum + count, 0);
          const repList = otherReps
            .sort((a, b) => b[1] - a[1])
            .map(([code, count]) => `${nameBySalesmanCode.get(code) ?? code} (${count})`)
            .join(', ');
          teamSection = `\n\n⚠️ Team: ${totalOverdue} ληξιπρόθεσμες\n${repList}`;
        }
      }

      // Skip if nothing to say
      if (personalTasks.length === 0 && !teamSection) { skipped++; continue; }

      // ─── Build title ───
      let title;
      if (todayTasks.length > 0) {
        title = `📋 ${todayTasks.length} ${todayTasks.length > 1 ? 'εργασίες' : 'εργασία'} για σήμερα`;
      } else if (overdueTasks.length > 0) {
        title = `⚠️ ${overdueTasks.length} ${overdueTasks.length > 1 ? 'ληξιπρόθεσμες εργασίες' : 'ληξιπρόθεσμη εργασία'}`;
      } else {
        title = `⚠️ Team overdue tasks`;
      }

      // ─── Build body ───
      let body = '';
      if (personalTasks.length > 0) {
        body = personalTasks.slice(0, 3).map(t => `- ${t.description}`).join('\n');
        if (personalTasks.length > 3) {
          body += `\n+${personalTasks.length - 3} ακόμη`;
        }
      }
      body += teamSection;

      const payload = JSON.stringify({
        title,
        body: body.trim(),
        url: 'https://crm.eaivaliotis.gr',
        todayCount: todayTasks.length,
        overdueCount: overdueTasks.length,
      });

      try {
        console.log(`[Push] Sending to user ${sub.user_id}, endpoint: ${sub.subscription.endpoint?.substring(0, 60)}...`);
        await webpush.sendNotification(sub.subscription, payload, { TTL: 86400 });
        sent++;
      } catch (err) {
        console.error(`[Push] Failed for user ${sub.user_id}:`, err.message);
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('crm_push_subscriptions').delete().eq('user_id', sub.user_id);
        }
      }
    }

    console.log(`[Push] Done. Sent: ${sent}, Skipped: ${skipped}`);
    return { sent, skipped };
  } catch (err) {
    console.error('[Push] Error in sendDailyTaskReminders:', err);
    throw err;
  }
}


// Schedule: daily at 08:00 Greece time (05:00 UTC)
cron.schedule('0 5 * * *', sendDailyTaskReminders);

// Manual trigger endpoint (admins/execs only)
app.post('/api/push/trigger-reminders', authMiddleware, async (req, res) => {
  if (!['admin', 'exec'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await sendDailyTaskReminders();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/comments/unread — unread comment count for current user
app.get('/api/comments/unread', authMiddleware, async (req, res) => {
  try {
    const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];
    const isManager = FULL_ACCESS_ROLES.includes(req.user.role);

    let visitsQuery = supabase
      .from('crm_visits')
      .select('id');

    if (!isManager) {
      visitsQuery = visitsQuery.eq('salesman_code', req.user.salesman_code);
    }

    const { data: visits } = await visitsQuery;
    const visitIds = (visits ?? []).map(v => v.id);
    if (visitIds.length === 0) return res.json({ count: 0 });

    // Reps see unread manager comments on their visits
    // Managers see unread rep replies on their comments
    const { data: comments } = await supabase
      .from('crm_visit_comments')
      .select('id, visit_id, user_id, is_read, reply_text, reply_at')
      .in('visit_id', visitIds)
      .eq('is_read', false);

    let unreadCount = 0;
    if (isManager) {
      // Managers: count unread comments where they are NOT the commenter (rep replies count as read separately)
      // For now count all unread on their visible visits
      unreadCount = (comments ?? []).filter(c => c.user_id !== req.user.id).length;
    } else {
      // Reps: count unread comments from managers on their visits
      unreadCount = (comments ?? []).filter(c => c.user_id !== req.user.id).length;
    }

    res.json({ count: unreadCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


// Save push subscription
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Subscription required' });
  
  const { error } = await supabase.from('crm_push_subscriptions').upsert({
    user_id: req.user.id,
    subscription,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  
  if (error) {
    console.error('[Push] Subscribe failed for user', req.user.id, ':', error);
    return res.status(500).json({ error: error.message });
  }
  
  console.log('[Push] Subscribed user:', req.user.id);
  res.json({ success: true });
});

// Snooze push notifications
app.post('/api/push/snooze', authMiddleware, async (req, res) => {
  const { snooze_until } = req.body; // ISO string
  if (!snooze_until) return res.status(400).json({ error: 'snooze_until required' });
  await supabase.from('crm_push_snooze').upsert({
    user_id: req.user.id,
    snoozed_until: snooze_until,
  }, { onConflict: 'user_id' });
  res.json({ success: true });
});

// Get VAPID public key (frontend needs this to subscribe)
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

const path = require('path');

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  const title = data.title ?? 'CRM Alert';
  const options = {
    body: data.body ?? '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url ?? '/' },
    actions: [
      { action: 'snooze2h', title: '⏰ Snooze 2 ώρες' },
      { action: 'open', title: '📋 Άνοιγμα' },
    ],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'snooze2h') {
    const snoozeUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    event.waitUntil(
      fetch('/api/push/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snooze_until: snoozeUntil }),
      })
    );
    return;
  }
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(clients.openWindow(url));
});
  `);
});

// GET /api/tasks/due — due and overdue tasks for current user
app.get('/api/tasks/due', authMiddleware, async (req, res) => {
  try {
    const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];
    const today = new Date().toISOString().split('T')[0];

    let visitsQuery = supabase
      .from('crm_visits')
      .select('id, customer_code, visit_date, notes');

    if (!FULL_ACCESS_ROLES.includes(req.user.role)) {
      visitsQuery = visitsQuery.eq('salesman_code', req.user.salesman_code);
    }

    const { data: visits, error: visitsError } = await visitsQuery;
    if (visitsError) throw visitsError;

    const visitIds = (visits ?? []).map(v => v.id);
    if (visitIds.length === 0) return res.json({ today: [], overdue: [], total: 0 });

    const { data: tasks, error: tasksError } = await supabase
      .from('crm_visit_tasks')
      .select('id, visit_id, description, reminder_date, status')
      .in('visit_id', visitIds)
      .not('status', 'eq', 'completed')
      .not('reminder_date', 'is', null)
      .lte('reminder_date', today);

    if (tasksError) throw tasksError;

    const visitMap = new Map((visits ?? []).map(v => [v.id, v]));

    const enriched = (tasks ?? []).map(t => ({
      ...t,
      visit: visitMap.get(t.visit_id) ?? null,
      is_overdue: t.reminder_date < today,
    }));

    res.json({
      today: enriched.filter(t => t.reminder_date === today),
      overdue: enriched.filter(t => t.reminder_date < today),
      total: enriched.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status, reminder_date } = req.body;
  const update = {};
  if (status !== undefined) update.status = status;
  if (reminder_date !== undefined) update.reminder_date = reminder_date;
  const { error } = await supabase.from('crm_visit_tasks').update(update).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/customers/:code/coordinates', authMiddleware, async (req, res) => {
  const { code } = req.params;
  const { lat, lng, accuracy_meters } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  const { error } = await supabase
    .from('crm_customer_coordinates')
    .upsert({
          customer_code: code,
          lat,
          lng,
          accuracy_meters: accuracy_meters ?? null,
          captured_by: req.user.id,
          captured_at: new Date().toISOString(),
          coord_source: 'gps',
        }, { onConflict: 'customer_code' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});