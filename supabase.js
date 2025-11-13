const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL || "https://qhbecburfuibuetexhzm.supabase.co",
  process.env.SUPABASE_KEY || "sb_secret_W5CsypWvMGB4GpIukOESpg_oSke0esr"
);

module.exports = supabase;