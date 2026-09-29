const { createClient } = require('@supabase/supabase-js');
const { supabase, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('../supabaseClient');

const adminClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// The `coords` role (e.g. Periklis Christou) is a locked-down account that can
// ONLY use the coordinate-cleanup tool — it must never reach any sales/revenue
// endpoint. This is the real security boundary; the UI hiding is cosmetic.
const COORDS_ALLOWED = [
  { method: 'GET',   re: /^\/api\/me\/?$/ },
  { method: 'GET',   re: /^\/api\/coordinates\/?$/ },
  { method: 'PATCH', re: /^\/api\/coordinates\/[^/]+\/?$/ },
  { method: 'GET',   re: /^\/api\/coordinate-tiers\/?$/ },
];

function coordsRoleAllowed(req) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return COORDS_ALLOWED.some(r => r.method === req.method && r.re.test(path));
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { data: profile, error: profileError } = await adminClient
    .from('crm_user_profiles')
    .select('role, salesman_code, full_name, is_active')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(403).json({ error: 'No profile found' });
  }

  if (!profile.is_active) {
    return res.status(403).json({ error: 'Account disabled' });
  }

  if (profile.role === 'coords' && !coordsRoleAllowed(req)) {
    return res.status(403).json({ error: 'This account is limited to the coordinates tool' });
  }

  req.user = {
    id: user.id,
    email: user.email,
    role: profile.role,
    salesman_code: profile.salesman_code,
    full_name: profile.full_name
  };

  next();
}

module.exports = { authMiddleware };