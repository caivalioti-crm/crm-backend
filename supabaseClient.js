const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://wfqsmberclqdqmntrgtf.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndmcXNtYmVyY2xxZHFtbnRyZ3RmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njg3NDQ5MCwiZXhwIjoyMDkyNDUwNDkwfQ.krGDKSjFbaTeqluLu3sPOGqRNMqYl3VXN9JlkYcyhRA';

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
