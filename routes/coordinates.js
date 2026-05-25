// GET /api/coordinates-by-rep?salesman_code=29&area=ΘΕΣΣΑΛΟΝΙΚΗ&city=ΠΟΛΥΓΥΡΟΣ
router.get('/coordinates', async (req, res) => {
  try {
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);
    const { salesman_code, area, city } = req.query;

    // Build customer filter
    let custQuery = supabase
      .from('vw_crm_customers')
      .select('code, name, city, area, address, salesman_code');

    if (isRep) {
      // Reps only see their own
      const { data: profile } = await supabase
        .from('crm_user_profiles')
        .select('salesman_code')
        .eq('id', req.user.id)
        .single();
      custQuery = custQuery.eq('salesman_code', Number(profile.salesman_code));
    } else {
      if (salesman_code) custQuery = custQuery.eq('salesman_code', Number(salesman_code));
      if (area) custQuery = custQuery.eq('area', area);
      if (city) custQuery = custQuery.eq('city', city);
    }

    const { data: customers, error: custErr } = await custQuery;
    if (custErr) throw custErr;

    const codes = (customers ?? []).map(c => String(c.code));
    if (!codes.length) return res.json([]);

    const { data: coords, error: coordErr } = await supabase
      .from('crm_customer_coordinates')
      .select('customer_code, lat, lng, accuracy_meters, captured_by, captured_at')
      .in('customer_code', codes);
    if (coordErr) throw coordErr;

    const coordMap = new Map((coords ?? []).map(c => [c.customer_code, c]));

    const result = customers.map(c => {
      const coord = coordMap.get(String(c.code));
      return {
        customer_code: String(c.code),
        customer_name: c.name,
        city: c.city,
        area: c.area,
        address: c.address,
        salesman_code: c.salesman_code,
        lat: coord?.lat ?? null,
        lng: coord?.lng ?? null,
        accuracy_meters: coord?.accuracy_meters ?? null,
        captured_by: coord?.captured_by ?? null,
        captured_at: coord?.captured_at ?? null,
        has_coords: !!coord,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/coordinates/:customer_code — update coordinates
router.patch('/coordinates/:customer_code', async (req, res) => {
  try {
    const { customer_code } = req.params;
    const { lat, lng, accuracy_meters } = req.body;
    const isRep = !FULL_ACCESS_ROLES.includes(req.user.role);

    if (isRep) {
      // Verify this customer belongs to this rep
      const { data: profile } = await supabase
        .from('crm_user_profiles')
        .select('salesman_code')
        .eq('id', req.user.id)
        .single();

      const { data: cust } = await supabase
        .from('vw_crm_customers')
        .select('salesman_code')
        .eq('code', customer_code)
        .single();

      if (String(cust?.salesman_code) !== String(profile?.salesman_code)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const { error } = await supabase
      .from('crm_customer_coordinates')
      .upsert({
        customer_code,
        lat,
        lng,
        accuracy_meters: accuracy_meters ?? 10,
        captured_by: req.user.id,
        captured_at: new Date().toISOString(),
        notes: null,
      }, { onConflict: 'customer_code' });

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});