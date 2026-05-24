const { supabase } = require('../supabaseClient');
const express = require('express');
const router = express.Router();

const FULL_ACCESS_ROLES = ['admin', 'manager', 'exec'];

// Helper: get user_id filter based on role
function getUserFilter(req, targetUserId) {
  const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
  if (isRep) return req.user.id;
  return targetUserId || null; // null = all users
}

// GET /api/planning/planned-visits
// Query params: week_start, user_id (managers only), area, from, to
router.get('/planned-visits', async (req, res) => {
  try {
    const { week_start, user_id, area, from, to } = req.query;
    const userId = getUserFilter(req, user_id);

    let query = supabase
      .from('crm_planned_visits')
      .select('*')
      .order('planned_date', { ascending: true })
      .order('planned_time', { ascending: true });

    if (userId) query = query.eq('user_id', userId);
    if (week_start) query = query.eq('week_start', week_start);
    if (area) query = query.eq('area', area);
    if (from) query = query.gte('planned_date', from);
    if (to) query = query.lte('planned_date', to);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data ?? []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/planning/planned-visits
router.post('/planned-visits', async (req, res) => {
  try {
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const userId = isRep ? req.user.id : (req.body.user_id || req.user.id);

    const {
      week_start, area, city, planned_date, time_segment, planned_time,
      customer_code, prospect_id, temp_prospect_id,
      is_fixed_appointment, notes,
    } = req.body;

    const { data, error } = await supabase
      .from('crm_planned_visits')
      .insert({
        user_id: userId,
        week_start: week_start || null,
        area: area || null,
        city: city || null,
        planned_date: planned_date || null,
        time_segment: time_segment || null,
        planned_time: planned_time || null,
        customer_code: customer_code || null,
        prospect_id: prospect_id || null,
        temp_prospect_id: temp_prospect_id || null,
        is_fixed_appointment: is_fixed_appointment ?? false,
        notes: notes || null,
        status: 'planned',
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/planning/planned-visits/:id
router.patch('/planned-visits/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);

    // Verify ownership for reps
    if (isRep) {
      const { data: existing } = await supabase
        .from('crm_planned_visits')
        .select('user_id')
        .eq('id', id)
        .single();
      if (!existing || existing.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const allowed = [
      'week_start', 'area', 'city', 'planned_date', 'time_segment', 'planned_time',
      'customer_code', 'prospect_id', 'temp_prospect_id',
      'is_fixed_appointment', 'notes', 'status', 'actual_visit_id',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('crm_planned_visits')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/planning/planned-visits/:id
router.delete('/planned-visits/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);

    if (isRep) {
      const { data: existing } = await supabase
        .from('crm_planned_visits')
        .select('user_id')
        .eq('id', id)
        .single();
      if (!existing || existing.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const { error } = await supabase
      .from('crm_planned_visits')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- TEMP PROSPECTS ---

// GET /api/planning/temp-prospects
router.get('/temp-prospects', async (req, res) => {
  try {
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    let query = supabase
      .from('crm_temp_prospects')
      .select('*')
      .order('created_at', { ascending: false });

    if (isRep) query = query.eq('created_by', req.user.id);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data ?? []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/planning/temp-prospects
router.post('/temp-prospects', async (req, res) => {
  try {
    const { company_name, address, city, area, phone, notes } = req.body;
    if (!company_name) return res.status(400).json({ error: 'company_name required' });

    const { data, error } = await supabase
      .from('crm_temp_prospects')
      .insert({
        created_by: req.user.id,
        company_name,
        address: address || null,
        city: city || null,
        area: area || null,
        phone: phone || null,
        notes: notes || null,
        status: 'temp',
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/planning/temp-prospects/:id
router.patch('/temp-prospects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['company_name', 'address', 'city', 'area', 'phone', 'notes', 'status', 'transformed_to_code', 'transformed_at'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('crm_temp_prospects')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/planning/week-summary
// Returns planned visits + actual visits for a given week, grouped by day
router.get('/week-summary', async (req, res) => {
  try {
    const { week_start, user_id } = req.query;
    if (!week_start) return res.status(400).json({ error: 'week_start required' });

    const weekEnd = new Date(week_start);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    const userId = getUserFilter(req, user_id);

    const [plannedResult, actualResult] = await Promise.allSettled([
      (() => {
        let q = supabase
          .from('crm_planned_visits')
          .select('*')
          .gte('planned_date', week_start)
          .lte('planned_date', weekEndStr)
          .order('planned_date').order('planned_time');
        if (userId) q = q.eq('user_id', userId);
        return q;
      })(),
      (() => {
        let q = supabase
          .from('crm_visits')
          .select('id, visit_date, visit_type, notes, customer_code, owner_id, owner_name')
          .gte('visit_date', week_start)
          .lte('visit_date', weekEndStr)
          .order('visit_date');
        if (userId) q = q.eq('owner_id', userId);
        return q;
      })(),
    ]);

    const planned = plannedResult.status === 'fulfilled' ? (plannedResult.value.data ?? []) : [];
    const actual = actualResult.status === 'fulfilled' ? (actualResult.value.data ?? []) : [];

    res.json({ planned, actual, week_start, week_end: weekEndStr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;