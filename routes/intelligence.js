// Category Intelligence — New Items & Offers (P1)
// Relevance = brand ∩ category, computed server-side. See migrations/2026-06-20_category-intelligence.sql
const express = require('express');
const router = express.Router();
const { supabase } = require('../supabaseClient');

const COMPANY = 1000;
const BRAND_SHARE_MIN = 10;        // mirror the frontend brand-profile threshold
const OFFER_EXCLUDE_DAYS = 7;      // offers: hide items bought/ordered in the last week

// ── helpers ──────────────────────────────────────────────────────────────────
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
const l2Of = (code) => { const p = String(code).split('.'); return p.length >= 2 ? `${p[0]}.${p[1]}` : String(code); };

// Page through a PostgREST query (1000-row cap per request)
async function fetchAll(makeQuery, pageSize = 1000, maxPages = 30) {
  let all = [], page = 0;
  for (;;) {
    const { data, error } = await makeQuery().range(page * pageSize, page * pageSize + pageSize - 1);
    if (error) throw error;
    all = all.concat(data ?? []);
    if (!data || data.length < pageSize || ++page >= maxPages) break;
  }
  return all;
}

async function getTrdrId(code) {
  const { data } = await supabase.from('stg_soft1_trdr')
    .select('trdr_id').eq('trdr_code', code).eq('company', COMPANY).maybeSingle();
  return data?.trdr_id ?? null;
}

// soft1_id (= mtrl.mtrcategory) → category row
async function loadCategoryMaster() {
  const { data } = await supabase.from('crm_category_master')
    .select('category_code, parent_code, level, full_name, soft1_id');
  const bySoft1 = new Map();
  (data ?? []).forEach(m => bySoft1.set(String(m.soft1_id), m));
  return bySoft1;
}

// customer's bought L2 categories + spend (all history)
async function customerCategoryProfile(code) {
  const rows = await fetchAll(() => supabase.from('vw_crm_customer_category_sales')
    .select('l2_code, netamnt').eq('customer_code', code));
  const spendByL2 = new Map(), boughtL2 = new Set();
  rows.forEach(r => {
    if (!r.l2_code) return;
    boughtL2.add(r.l2_code);
    spendByL2.set(r.l2_code, (spendByL2.get(r.l2_code) || 0) + Number(r.netamnt || 0));
  });
  return { spendByL2, boughtL2 };
}

// categories covered by the customer's brands
async function brandCoverage(code) {
  const { data: bp } = await supabase.from('mv_customer_brand_profile')
    .select('brand, brand_share_pct').eq('customer_code', code).gte('brand_share_pct', BRAND_SHARE_MIN);
  const brands = (bp ?? []).map(b => b.brand);
  if (!brands.length) return { brands: [], covered: new Set() };
  const covered = new Set();
  for (const c of chunk(brands, 100)) {
    const { data } = await supabase.from('mv_category_brand_coverage').select('category_code').in('brand', c);
    (data ?? []).forEach(x => covered.add(x.category_code));
  }
  return { brands, covered };
}
// mirror frontend hasBrandCoverage: match the code or its L1/L2 prefix
function isBrandCovered(covered, brands, code) {
  if (!brands.length || covered.size === 0) return true;        // unknown brands → don't over-filter
  if (covered.has(code)) return true;
  const p = String(code).split('.');
  if (p.length > 1 && covered.has(p[0])) return true;
  if (p.length > 2 && covered.has(`${p[0]}.${p[1]}`)) return true;
  return false;
}

// Which of the candidate mtrls did this customer buy/order? Bounded by candidate sales volume.
async function customerBoughtAmong(trdrId, candidateMtrls, recentCutoff) {
  const ids = [...new Set(candidateMtrls.map(String))];   // stg_soft1_mtrlines.mtrl is text
  if (!ids.length || trdrId == null) return { ever: new Set(), recent: new Set() };

  let lines = [];
  for (const c of chunk(ids, 100)) {
    const { data } = await supabase.from('stg_soft1_mtrlines')
      .select('mtrl, findoc').eq('company', COMPANY).in('mtrl', c);
    lines.push(...(data ?? []));
  }
  if (!lines.length) return { ever: new Set(), recent: new Set() };

  const findocIds = [...new Set(lines.map(l => l.findoc))];
  const docMap = new Map();
  for (const c of chunk(findocIds, 200)) {
    const { data } = await supabase.from('stg_soft1_findoc')
      .select('findoc, trdr, trndate').eq('company', COMPANY).in('findoc', c);
    (data ?? []).forEach(d => docMap.set(d.findoc, d));
  }

  const ever = new Set(), recent = new Set(), trdrStr = String(trdrId);
  lines.forEach(l => {
    const d = docMap.get(l.findoc);
    if (!d || String(d.trdr) !== trdrStr) return;       // not this customer's document
    const m = String(l.mtrl);
    ever.add(m);
    if (recentCutoff && d.trndate && String(d.trndate) >= recentCutoff) recent.add(m);
  });
  return { ever, recent };
}

async function loadInterest(code, listType) {
  const { data } = await supabase.from('crm_customer_item_interest')
    .select('mtrl, discussed, interested, notes').eq('customer_code', code).eq('list_type', listType);
  return new Map((data ?? []).map(r => [String(r.mtrl), r]));
}
const interestFor = (map, mtrl) => {
  const r = map.get(String(mtrl));
  return { discussed: r?.discussed ?? false, interested: r?.interested ?? null, notes: r?.notes ?? null };
};
const vehicleTags = (it) => {
  const t = [];
  if (it.cccagrotiko) t.push('agrotiko');
  if (it.cccsuv) t.push('suv');
  if (it.cccklouba) t.push('van');
  if (it.cccepivatiko) t.push('epivatiko');
  if (it.cccfortigo) t.push('fortigo');
  return t;
};

const ITEM_COLS = 'mtrl, code, name, cccenglishname, mtrcategory, pricew, cccagrotiko, cccsuv, cccklouba, cccepivatiko, cccfortigo';

function shapeItem(it, cat, l2, spendByL2, interest, extra = {}) {
  return {
    mtrl: String(it.mtrl),
    code: it.code,
    name: it.name,
    english_name: it.cccenglishname,
    category_code: cat.category_code,
    category_name: cat.full_name,
    category_level: cat.level,
    price: it.pricew,
    vehicle: vehicleTags(it),
    category_spend: spendByL2.get(l2) ?? 0,
    ...interestFor(interest, it.mtrl),
    ...extra,
  };
}

// ── GET new items ─────────────────────────────────────────────────────────────
router.get('/customers/:code/new-items', async (req, res) => {
  try {
    const { code } = req.params;
    const { data: items, error } = await supabase.from('stg_soft1_mtrl')
      .select(ITEM_COLS).eq('company', COMPANY).eq('cccisnew', true).eq('cccactiveb2b', true);
    if (error) throw error;
    if (!items?.length) return res.json([]);

    const [trdrId, bySoft1, { spendByL2, boughtL2 }, { brands, covered }, interest] = await Promise.all([
      getTrdrId(code), loadCategoryMaster(), customerCategoryProfile(code), brandCoverage(code), loadInterest(code, 'new'),
    ]);
    const { ever } = await customerBoughtAmong(trdrId, items.map(i => String(i.mtrl)), null);

    const result = items
      .map(it => ({ it, cat: bySoft1.get(String(it.mtrcategory)) }))
      .filter(x => x.cat)                                            // drop unmapped (e.g. lamps)
      .map(x => ({ ...x, l2: l2Of(x.cat.category_code) }))
      .filter(x => !ever.has(String(x.it.mtrl)))                    // exclude ever bought/ordered
      .filter(x => boughtL2.has(x.l2))                             // category relevance
      .filter(x => isBrandCovered(covered, brands, x.cat.category_code)) // brand relevance
      .map(x => shapeItem(x.it, x.cat, x.l2, spendByL2, interest));

    result.sort((a, b) => b.category_spend - a.category_spend || (b.price || 0) - (a.price || 0));
    res.json(result);
  } catch (err) { console.error('new-items:', err); res.status(500).json({ error: err.message }); }
});

// ── GET offers ────────────────────────────────────────────────────────────────
router.get('/customers/:code/offers', async (req, res) => {
  try {
    const { code } = req.params;
    const trdrId = await getTrdrId(code);

    // customer's PRCRULE=104 group categories (mtrcategory list)
    let policyCats = new Set();
    if (trdrId != null) {
      const { data: pol } = await supabase.from('stg_soft1_ccctimologiakestrdr')
        .select('mtrcategory').eq('trdr', trdrId).eq('prcrule', 104);
      policyCats = new Set((pol ?? []).map(p => String(p.mtrcategory)));
    }

    // candidates: maxprcdisc IS NULL AND (cccisoffer OR mtrcategory ∈ policy104). cccactiveb2b only.
    const { data: flagged, error: e1 } = await supabase.from('stg_soft1_mtrl')
      .select(ITEM_COLS).eq('company', COMPANY).eq('cccactiveb2b', true)
      .is('maxprcdisc', null).eq('cccisoffer', true);
    if (e1) throw e1;

    let policyItems = [];
    if (policyCats.size) {
      const { data, error: e2 } = await supabase.from('stg_soft1_mtrl')
        .select(ITEM_COLS).eq('company', COMPANY).eq('cccactiveb2b', true)
        .is('maxprcdisc', null).in('mtrcategory', [...policyCats]);
      if (e2) throw e2;
      policyItems = data ?? [];
    }

    // merge + tag reason
    const byMtrl = new Map();
    (flagged ?? []).forEach(it => byMtrl.set(String(it.mtrl), { it, reason: new Set(['offer_flag']) }));
    policyItems.forEach(it => {
      const k = String(it.mtrl);
      if (byMtrl.has(k)) byMtrl.get(k).reason.add('policy_104');
      else byMtrl.set(k, { it, reason: new Set(['policy_104']) });
    });
    const candidates = [...byMtrl.values()];
    if (!candidates.length) return res.json([]);

    const [bySoft1, { spendByL2, boughtL2 }, { brands, covered }, interest] = await Promise.all([
      loadCategoryMaster(), customerCategoryProfile(code), brandCoverage(code), loadInterest(code, 'offer'),
    ]);
    const recentCutoff = new Date(Date.now() - OFFER_EXCLUDE_DAYS * 86400000).toISOString().slice(0, 10);
    const { recent } = await customerBoughtAmong(trdrId, candidates.map(c => String(c.it.mtrl)), recentCutoff);

    const result = candidates
      .map(c => ({ ...c, cat: bySoft1.get(String(c.it.mtrcategory)) }))
      .filter(x => x.cat)
      .map(x => ({ ...x, l2: l2Of(x.cat.category_code), is104: x.reason.has('policy_104') }))
      .filter(x => !recent.has(String(x.it.mtrl)))                  // exclude bought/ordered last 7 days
      // policy_104 items are relevant by virtue of the customer's own pricing policy;
      // pure cccisoffer items must pass brand ∩ category like new items.
      .filter(x => x.is104 || (boughtL2.has(x.l2) && isBrandCovered(covered, brands, x.cat.category_code)))
      .map(x => shapeItem(x.it, x.cat, x.l2, spendByL2, interest, { reason: [...x.reason], is_policy_104: x.is104 }));

    result.sort((a, b) =>
      (b.is_policy_104 - a.is_policy_104) || (b.category_spend - a.category_spend) || (b.price || 0) - (a.price || 0));
    res.json(result);
  } catch (err) { console.error('offers:', err); res.status(500).json({ error: err.message }); }
});

// ── POST item interest (συζητήθηκε / ενδιαφέρει) ──────────────────────────────
router.post('/customers/:code/item-interest', async (req, res) => {
  try {
    const { code } = req.params;
    const { mtrl, list_type, discussed, interested, notes } = req.body;
    if (!mtrl || !['new', 'offer'].includes(list_type)) {
      return res.status(400).json({ error: 'mtrl and valid list_type (new|offer) required' });
    }
    const { data, error } = await supabase.from('crm_customer_item_interest')
      .upsert({
        customer_code: code,
        mtrl: String(mtrl),
        list_type,
        discussed: discussed ?? false,
        interested: interested ?? null,
        notes: notes ?? null,
        captured_by: req.user?.id ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'customer_code,mtrl,list_type' })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { console.error('item-interest:', err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
