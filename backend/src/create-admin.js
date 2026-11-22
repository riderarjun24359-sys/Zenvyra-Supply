require("dotenv").config();
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

(async () => {
  const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 14) {
    throw new Error("Set DATABASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD (minimum 14 characters) first.");
  }
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await pool.query(
      "INSERT INTO admin_users (email, password_hash) VALUES ($1,$2) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE",
      [ADMIN_EMAIL.toLowerCase(), hash]
    );
    console.log("Admin account created/updated.");
  } finally {
    await pool.end();
  }
})().catch(error => { console.error(error.message); process.exit(1); });
