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