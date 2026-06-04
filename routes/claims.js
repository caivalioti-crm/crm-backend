const express = require('express');
const router = express.Router();
const { supabase } = require('../supabaseClient'); // ← shared client
const { randomUUID } = require('crypto');           // ← built-in, no install needed

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── GET /api/claims ───────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, customer_code, assigned_to, factory_handled_by, search } = req.query;

    let query = supabase
      .from('crm_claims')
      .select('*')
      .order('created_at', { ascending: false });

    if (status)              query = query.eq('status', status);
    if (customer_code)       query = query.eq('customer_code', customer_code);
    if (assigned_to)         query = query.eq('assigned_to', assigned_to);
    if (factory_handled_by)  query = query.eq('factory_handled_by', factory_handled_by);
    if (search)              query = query.or(
      `claim_number.ilike.%${search}%,customer_name.ilike.%${search}%,sku.ilike.%${search}%`
    );

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('GET /claims:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/claims ──────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      customer_code, customer_name,
      sku, sku_description, quantity,
      invoice_number, purchase_date, complaint_date,
      complaint_type, complaint_description,
      assigned_to, created_by
    } = req.body;

    const { data, error } = await supabase
      .from('crm_claims')
      .insert({
        customer_code, customer_name,
        sku, sku_description, quantity,
        invoice_number, purchase_date,
        complaint_date: complaint_date || new Date().toISOString().split('T')[0],
        complaint_type, complaint_description,
        assigned_to, created_by,
        status: 'new'
      })
      .select()
      .single();

    if (error) throw error;

    // Auto-log creation in history
    await supabase.from('crm_claim_status_history').insert({
      claim_id: data.id,
      from_status: null,
      to_status: 'new',
      changed_by: created_by || 'system',
      notes: 'Claim created'
    });

    res.status(201).json(data);
  } catch (err) {
    console.error('POST /claims:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/claims/:id ───────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: claim, error: claimErr } = await supabase
      .from('crm_claims')
      .select('*')
      .eq('id', id)
      .single();
    if (claimErr) throw claimErr;

    const { data: communications } = await supabase
      .from('crm_claim_communications')
      .select('*')
      .eq('claim_id', id)
      .order('created_at', { ascending: true });

    const { data: attachmentsRaw } = await supabase
      .from('crm_claim_attachments')
      .select('*')
      .eq('claim_id', id)
      .order('uploaded_at', { ascending: false });

    // Generate signed download URLs (1 hour)
    const attachments = await Promise.all((attachmentsRaw || []).map(async (att) => {
      const { data: urlData } = await supabase.storage
        .from('claim-attachments')
        .createSignedUrl(att.storage_path, 3600);
      return { ...att, signed_url: urlData?.signedUrl || null };
    }));

    const { data: history } = await supabase
      .from('crm_claim_status_history')
      .select('*')
      .eq('claim_id', id)
      .order('changed_at', { ascending: true });

    res.json({ ...claim, communications, attachments, history });
  } catch (err) {
    console.error('GET /claims/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/claims/:id ─────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const updates = { ...req.body };
    // These fields are immutable via PATCH
    ['status', 'id', 'claim_number', 'created_at'].forEach(k => delete updates[k]);

    const { data, error } = await supabase
      .from('crm_claims')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('PATCH /claims/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/claims/:id/status ──────────────────────────
const VALID_STATUSES = [
  'new', 'investigating', 'sent_to_factory',
  'awaiting_factory', 'factory_responded', 'resolved', 'closed'
];

router.post('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { to_status, changed_by, notes } = req.body;

    if (!VALID_STATUSES.includes(to_status)) {
      return res.status(400).json({ error: `Invalid status: ${to_status}` });
    }

    const { data: current, error: fetchErr } = await supabase
      .from('crm_claims')
      .select('status')
      .eq('id', id)
      .single();
    if (fetchErr) throw fetchErr;

    const updateObj = { status: to_status };
    if (to_status === 'resolved') updateObj.resolved_at = new Date().toISOString();
    if (to_status === 'closed')   updateObj.closed_at   = new Date().toISOString();

    const { data, error } = await supabase
      .from('crm_claims')
      .update(updateObj)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    await supabase.from('crm_claim_status_history').insert({
      claim_id: id,
      from_status: current.status,
      to_status,
      changed_by,
      notes: notes || null
    });

    res.json(data);
  } catch (err) {
    console.error('POST /claims/:id/status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/claims/:id/communications ──────────────────
router.post('/:id/communications', async (req, res) => {
  try {
    const { comm_type, direction, subject, body, contact_person, authored_by } = req.body;

    const { data, error } = await supabase
      .from('crm_claim_communications')
      .insert({
        claim_id: req.params.id,
        comm_type, direction, subject, body, contact_person, authored_by
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/claims/:id/attachments/upload-url ──────────
router.post('/:id/attachments/upload-url', async (req, res) => {
  try {
    const { file_name } = req.body;
    const ext = file_name.split('.').pop().toLowerCase();
    const storagePath = `claims/${req.params.id}/${randomUUID()}.${ext}`;

    const { data, error } = await supabase.storage
      .from('claim-attachments')
      .createSignedUploadUrl(storagePath);

    if (error) throw error;
    res.json({ upload_url: data.signedUrl, storage_path: storagePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/claims/:id/attachments/confirm ─────────────
router.post('/:id/attachments/confirm', async (req, res) => {
  try {
    const {
      storage_path, file_name, file_type,
      file_size_bytes, mime_type, description,
      is_factory_facing, uploaded_by
    } = req.body;

    const { data, error } = await supabase
      .from('crm_claim_attachments')
      .insert({
        claim_id: req.params.id,
        storage_path, file_name, file_type,
        file_size_bytes, mime_type, description,
        is_factory_facing: is_factory_facing || false,
        uploaded_by
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/claims/:id/attachments/:attachmentId ─────
router.delete('/:id/attachments/:attachmentId', async (req, res) => {
  try {
    const { data: att, error: fetchErr } = await supabase
      .from('crm_claim_attachments')
      .select('storage_path')
      .eq('id', req.params.attachmentId)
      .single();
    if (fetchErr) throw fetchErr;

    await supabase.storage.from('claim-attachments').remove([att.storage_path]);

    const { error } = await supabase
      .from('crm_claim_attachments')
      .delete()
      .eq('id', req.params.attachmentId);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;