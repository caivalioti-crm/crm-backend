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

// POST /api/planning/suggest
// Body: {
//   week_start: 'YYYY-MM-DD',
//   target_user_id: UUID (managers only),
//   day_slots: [
//     { date: 'YYYY-MM-DD', area: 'ΑΡΓΟΛΙΔΑ', city: 'ΝΑΥΠΛΙΟ' },
//     ...
//   ],
//   filters: {
//     performance: 'all' | 'up' | 'down',
//     not_visited_since: 30 | 60 | 180 | 365 | null,
//     tiers: [0,1,2,3,4] | null,
//     joined_after: 'YYYY-MM-DD' | null,
//     joined_before: 'YYYY-MM-DD' | null,
//   },
//   max_per_day: 12
// }
router.post('/suggest', async (req, res) => {
  try {
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const {
      week_start,
      target_user_id,
      day_slots = [],
      filters = {},
      max_per_day = 12,
    } = req.body;

    if (!week_start || !day_slots.length) {
      return res.status(400).json({ error: 'week_start and day_slots required' });
    }

    // Determine which user's customers to fetch
    const userId = isRep ? req.user.id : (target_user_id || req.user.id);

    // 1. Get the rep's salesman_code
    const { data: profile } = await supabase
      .from('crm_user_profiles')
      .select('salesman_code')
      .eq('id', userId)
      .single();

    if (!profile?.salesman_code) {
      return res.status(400).json({ error: 'No salesman_code for user' });
    }

    const salesmanCode = profile.salesman_code;

    // 2. Get all unique areas/cities needed across day slots
    const neededAreas = [...new Set(day_slots.map(s => s.area).filter(Boolean))];
    const neededCities = [...new Set(day_slots.map(s => s.city).filter(Boolean))];

    // 3. Fetch customers for these areas/cities assigned to this rep
    let custQuery = supabase
      .from('vw_crm_customers')
      .select('code, name, city, area, address, salesman_code')
      .eq('salesman_code', Number(salesmanCode))
      .in('area', neededAreas);

    const { data: customers, error: custError } = await custQuery;
    if (custError) throw custError;

    const customerCodes = (customers ?? []).map(c => String(c.code));
    if (!customerCodes.length) return res.json({ days: [] });

// Map trdr_code → trdr_id for tier lookup
const { data: trdrMap } = await supabase
  .from('stg_soft1_trdr')
  .select('trdr_code, trdr_id')
  .in('trdr_code', customerCodes)
  .eq('company', 1000);

const codeToTrdrId = new Map((trdrMap ?? []).map(t => [String(t.trdr_code), t.trdr_id]));
const trdrIds = customerCodes.map(c => codeToTrdrId.get(c)).filter(Boolean);

    // 4. Fetch tier data from materialized view
    const { data: tierData } = await supabase
      .from('mv_crm_customer_tier')
      .select('customer_code, tier, last_invoice_date, total_invoices_6m, months_with_invoices')
      .in('customer_code', trdrIds);

    // Build tierMap keyed by trdr_code for easy lookup
    const trdrIdToCode = new Map((trdrMap ?? []).map(t => [String(t.trdr_id), String(t.trdr_code)]));
    const tierMap = new Map((tierData ?? []).map(t => [
      trdrIdToCode.get(String(t.customer_code)) ?? String(t.customer_code),
      t
    ]));

// 4b. Fetch coordinates for all customers
    const { data: coordData } = await supabase
      .from('crm_customer_coordinates')
      .select('customer_code, lat, lng, accuracy_meters')
      .in('customer_code', customerCodes);

    const coordMap = new Map((coordData ?? []).map(c => [String(c.customer_code), c]));

    // 5. Fetch last visit date per customer for this rep
    const { data: visitData } = await supabase
      .from('crm_visits')
      .select('customer_code, visit_date')
      .eq('salesman_code', salesmanCode)
      .in('customer_code', customerCodes)
      .order('visit_date', { ascending: false });

    const lastVisitMap = new Map();
    for (const v of visitData ?? []) {
      if (!lastVisitMap.has(v.customer_code)) {
        lastVisitMap.set(v.customer_code, v.visit_date);
      }
    }

    // 6. Fetch customer visit constraints
    const { data: constraintData } = await supabase
      .from('crm_customer_visit_constraints')
      .select('customer_code, allowed_days, earliest_time, latest_time, notes')
      .in('customer_code', customerCodes);

    const constraintMap = new Map((constraintData ?? []).map(c => [c.customer_code, c]));

    // 7. Fetch fixed appointments for the week
    const weekDates = day_slots.map(s => s.date);
    const { data: fixedVisits } = await supabase
      .from('crm_planned_visits')
      .select('*')
      .eq('user_id', userId)
      .eq('is_fixed_appointment', true)
      .in('planned_date', weekDates);

    const fixedByDate = new Map();
    for (const v of fixedVisits ?? []) {
      if (!fixedByDate.has(v.planned_date)) fixedByDate.set(v.planned_date, []);
      fixedByDate.get(v.planned_date).push(v);
    }

    // 8. Fetch sales performance if needed for filter
    let performanceMap = new Map();
    if (filters.performance && filters.performance !== 'all') {
      const now = new Date();
      const currFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const currTo = now.toISOString().split('T')[0];
      const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
      const prevTo = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

      const [currSales, prevSales] = await Promise.all([
        supabase.from('stg_soft1_findoc')
          .select('trdr, netamnt')
          .eq('company', 1000)
          .in('series', [7061, 7062, 7080])
          .gte('trndate', currFrom).lte('trndate', currTo)
          .in('trdr', trdrIds),
        supabase.from('stg_soft1_findoc')
          .select('trdr, netamnt')
          .eq('company', 1000)
          .in('series', [7061, 7062, 7080])
          .gte('trndate', prevFrom).lte('trndate', prevTo)
          .in('trdr', trdrIds),
      ]);

      const currMap = new Map();
      for (const r of currSales.data ?? []) {
        currMap.set(String(r.trdr), (currMap.get(String(r.trdr)) ?? 0) + Number(r.netamnt ?? 0));
      }
      const prevMap = new Map();
      for (const r of prevSales.data ?? []) {
        prevMap.set(String(r.trdr), (prevMap.get(String(r.trdr)) ?? 0) + Number(r.netamnt ?? 0));
      }
      for (const code of customerCodes) {
        const trdrId = String(codeToTrdrId.get(code) ?? '');
        const curr = currMap.get(trdrId) ?? 0;
        const prev = prevMap.get(trdrId) ?? 0;
        performanceMap.set(code, prev > 0 ? (curr - prev) / prev : null);
      }
    }

// 8b. Fetch YTD performance for all customers
    const now = new Date();
    const ytdFrom = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
    const ytdTo = now.toISOString().split('T')[0];
    const prevYtdFrom = new Date(now.getFullYear() - 1, 0, 1).toISOString().split('T')[0];
    const prevYtdTo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).toISOString().split('T')[0];

    const [ytdResult, prevYtdResult] = await Promise.all([
      supabase.from('stg_soft1_findoc')
        .select('trdr, netamnt')
        .eq('company', 1000)
        .in('series', [7061, 7062, 7080])
        .gte('trndate', ytdFrom).lte('trndate', ytdTo)
        .in('trdr', trdrIds),
      supabase.from('stg_soft1_findoc')
        .select('trdr, netamnt')
        .eq('company', 1000)
        .in('series', [7061, 7062, 7080])
        .gte('trndate', prevYtdFrom).lte('trndate', prevYtdTo)
        .in('trdr', trdrIds),
    ]);

    const ytdMap = new Map();
    for (const r of ytdResult.data ?? []) {
      const code = trdrIdToCode.get(String(r.trdr)) ?? String(r.trdr);
      ytdMap.set(code, (ytdMap.get(code) ?? 0) + Number(r.netamnt ?? 0));
    }
    const prevYtdMap = new Map();
    for (const r of prevYtdResult.data ?? []) {
      const code = trdrIdToCode.get(String(r.trdr)) ?? String(r.trdr);
      prevYtdMap.set(code, (prevYtdMap.get(code) ?? 0) + Number(r.netamnt ?? 0));
    }

    // 9. Target visit interval in days per tier
    const TIER_TARGET_DAYS = { 0: null, 1: 75, 2: 30, 3: 14, 4: 7 };

    const today = new Date();

    // 10. Score and filter customers
    const scoredCustomers = (customers ?? []).map(c => {
      const code = String(c.code);
      const tier = tierMap.get(code);
      const lastVisit = lastVisitMap.get(code);
      const constraint = constraintMap.get(code);
      const tierLevel = tier?.tier ?? 0;
      const targetDays = TIER_TARGET_DAYS[tierLevel];

      // Days since last visit
      const daysSinceVisit = lastVisit
        ? Math.floor((today - new Date(lastVisit)) / (1000 * 60 * 60 * 24))
        : 999;

      // Days since last purchase
      const daysSincePurchase = tier?.last_invoice_date
        ? Math.floor((today - new Date(tier.last_invoice_date)) / (1000 * 60 * 60 * 24))
        : 999;

      // Overdue score: how many target cycles overdue
      const overdueScore = targetDays ? daysSinceVisit / targetDays : 1;

      // Combined urgency score (60% visit recency, 40% purchase recency)
      const urgencyScore = (overdueScore * 0.6) + ((daysSincePurchase / 30) * 0.4);

const ytdRevenue = ytdMap.get(code) ?? 0;
      const prevYtdRevenue = prevYtdMap.get(code) ?? 0;
      const ytdGrowthPct = prevYtdRevenue > 0
        ? ((ytdRevenue - prevYtdRevenue) / prevYtdRevenue) * 100
        : null;

      return {
        code,
        name: c.name,
        city: c.city,
        area: c.area,
        address: c.address,
        lat: coordMap.get(code)?.lat ?? null,
        lng: coordMap.get(code)?.lng ?? null,
        coord_accuracy: coordMap.get(code)?.accuracy_meters ?? null,
        tier: tierLevel,
        ytd_revenue: Math.round(ytdRevenue),
        prev_ytd_revenue: Math.round(prevYtdRevenue),
        ytd_growth_pct: ytdGrowthPct !== null ? Math.round(ytdGrowthPct * 10) / 10 : null,
        last_visit_date: lastVisit ?? null,
        last_invoice_date: tier?.last_invoice_date ?? null,
        days_since_visit: daysSinceVisit,
        days_since_purchase: daysSincePurchase,
        urgency_score: urgencyScore,
        constraint: constraint ?? null,
        total_invoices_6m: tier?.total_invoices_6m ?? 0,
      };
    }).filter(c => {
      // Apply filters
      if (filters.tiers?.length) {
        if (!filters.tiers.includes(c.tier)) return false;
      }
      if (filters.not_visited_since && c.days_since_visit < filters.not_visited_since) return false;
      if (filters.performance === 'up' && performanceMap.size > 0) {
        const perf = performanceMap.get(c.code);
        if (perf === null || perf <= 0) return false;
      }
      if (filters.performance === 'down' && performanceMap.size > 0) {
        const perf = performanceMap.get(c.code);
        if (perf === null || perf >= 0) return false;
      }
   
      return true;
    });

    // 11. Build day suggestions
    const globallyUsedCodes = new Set();

    // Pre-mark fixed appointment customer codes as used
    for (const [, fixed] of fixedByDate) {
      for (const f of fixed) {
        if (f.customer_code) globallyUsedCodes.add(f.customer_code);
      }
    }

    const WORK_START = '09:00';
    const WORK_END = '17:00';
    const MINUTES_PER_CUSTOMER = 30;

    const days = day_slots.map(slot => {
      const { date, area, city } = slot;
      const dayOfWeek = new Date(date).getDay(); // 0=Sun,1=Mon...6=Sat
      // Convert to 1=Mon...7=Sun
      const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;

      const fixed = fixedByDate.get(date) ?? [];

      // Calculate available slots after fixed appointments
      const fixedMinutes = fixed.length * MINUTES_PER_CUSTOMER;
      const workMinutes = 8 * 60; // 09:00-17:00
      const availableSlots = Math.min(
        max_per_day - fixed.length,
        Math.floor((workMinutes - fixedMinutes) / MINUTES_PER_CUSTOMER)
      );

      // Get candidates for this day's area/city
      const filtered = scoredCustomers
        .filter(c => {
          if (globallyUsedCodes.has(c.code)) return false;
          if (c.area !== area) return false;
          if (city && c.city !== city) return false;
          if (c.constraint?.allowed_days?.length) {
            if (!c.constraint.allowed_days.includes(isoDay)) return false;
          }
          return true;
        })
        .sort((a, b) => b.urgency_score - a.urgency_score)
        .slice(0, availableSlots);

      function distKm(a, b) {
        if (!a.lat || !b.lat) return 999;
        const R = 6371;
        const dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLon = (b.lng - a.lng) * Math.PI / 180;
        const x = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
          Math.sin(dLon/2) * Math.sin(dLon/2);
        return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
      }

      // Find geographic centroid of all filtered customers
      const withCoords = filtered.filter(c => c.lat && c.lng);
      const centroidLat = withCoords.length
        ? withCoords.reduce((s, c) => s + c.lat, 0) / withCoords.length : 0;
      const centroidLng = withCoords.length
        ? withCoords.reduce((s, c) => s + c.lng, 0) / withCoords.length : 0;

      // Score = urgency weight + geographic clustering weight
      // Find the best "anchor" customer: highest urgency among top-10 by distance to centroid
      const sortedByDist = [...filtered].sort((a, b) =>
        distKm({ lat: centroidLat, lng: centroidLng }, a) -
        distKm({ lat: centroidLat, lng: centroidLng }, b)
      );
      // Pick anchor = highest urgency among the 5 geographically closest
      const anchorPool = sortedByDist.slice(0, 5);
      const anchor = anchorPool.sort((a, b) => b.urgency_score - a.urgency_score)[0] ?? filtered[0];

      // Nearest-neighbor from anchor
      const candidates = [];
      const pool = [...filtered];
      if (pool.length > 0 && anchor) {
        const anchorIdx = pool.findIndex(c => c.code === anchor.code);
        if (anchorIdx >= 0) candidates.push(pool.splice(anchorIdx, 1)[0]);
        else candidates.push(pool.splice(0, 1)[0]);

        while (pool.length > 0) {
          const last = candidates[candidates.length - 1];
          let nearestIdx = 0;
          let nearestDist = Infinity;
          for (let j = 0; j < pool.length; j++) {
            const d = distKm(last, pool[j]);
            if (d < nearestDist) { nearestDist = d; nearestIdx = j; }
          }
          candidates.push(pool.splice(nearestIdx, 1)[0]);
        }
      }

      // Mark as used globally so same customer isn't scheduled twice in the week
      for (const c of candidates) globallyUsedCodes.add(c.code);

      // Assign times starting from 09:00, after fixed appointments
      let currentMinutes = 9 * 60;
      const TRAVEL_BUFFER_SAME_CITY = 10; // minutes
      const TRAVEL_BUFFER_DIFF_CITY = 20; // minutes
      // Skip past fixed appointment times
      const sortedFixed = [...fixed].sort((a, b) =>
        (a.planned_time ?? '09:00').localeCompare(b.planned_time ?? '09:00')
      );

      const suggested = candidates.map((c, idx) => {
  const hours = Math.floor(currentMinutes / 60);
  const mins = currentMinutes % 60;
  const timeStr = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  currentMinutes += MINUTES_PER_CUSTOMER;
  // Add travel buffer
  const nextC = candidates[idx + 1];
  if (nextC) {
    if (c.lat && nextC.lat) {
      const km = distKm(c, nextC);
      // ~40 km/h average in city/regional driving + 5 min buffer
      const travelMins = Math.round((km / 40) * 60) + 5;
      currentMinutes += Math.min(Math.max(travelMins, 5), 45); // cap 5-45 min
    } else {
      const sameCity = c.city === nextC.city;
      currentMinutes += sameCity ? TRAVEL_BUFFER_SAME_CITY : TRAVEL_BUFFER_DIFF_CITY;
    }
  }
  return {
    customer_code: c.code,
    customer_name: c.name,
    city: c.city,
    area: c.area,
    address: c.address,
    tier: c.tier,
    last_visit_date: c.last_visit_date,
    last_invoice_date: c.last_invoice_date,
    days_since_visit: c.days_since_visit,
    days_since_purchase: c.days_since_purchase,
    urgency_score: Math.round(c.urgency_score * 100) / 100,
    suggested_time: timeStr,
    constraint: c.constraint,
    total_invoices_6m: c.total_invoices_6m,
    ytd_revenue: c.ytd_revenue,
    prev_ytd_revenue: c.prev_ytd_revenue,
    ytd_growth_pct: c.ytd_growth_pct,
    lat: c.lat,
    lng: c.lng,
  };
});

      return {
        date,
        area,
        city: city || null,
        day_name: ['Κυρ', 'Δευ', 'Τρι', 'Τετ', 'Πεμ', 'Παρ', 'Σαβ'][dayOfWeek],
        work_start: WORK_START,
        work_end: WORK_END,
        fixed_appointments: sortedFixed,
        suggested,
        total_slots: availableSlots,
        used_slots: suggested.length,
      };
    });

    res.json({ week_start, days });
  } catch (err) {
    console.error('Suggest error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;