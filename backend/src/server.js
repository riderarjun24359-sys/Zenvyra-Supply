require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT || 10000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin: (process.env.FRONTEND_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean),
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "100kb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 200, standardHeaders: "draft-7", legacyHeaders: false }));

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !process.env.JWT_SECRET) return res.status(401).json({ error: "Authentication required" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch {
    res.status(503).json({ status: "degraded", database: "unavailable" });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, slug, description, price_paise, compare_at_price_paise, image_url, category, stock_quantity FROM products WHERE is_active = TRUE AND stock_quantity > 0 ORDER BY created_at DESC LIMIT 100"
    );
    res.json({ products: result.rows });
  } catch (error) {
    console.error("products.list", error.message);
    res.status(500).json({ error: "Unable to load products" });
  }
});

app.post("/api/orders", rateLimit({ windowMs: 60 * 60 * 1000, limit: 10 }), async (req, res) => {
  const { customer, items, payment_method } = req.body || {};
  if (!customer || !Array.isArray(items) || items.length < 1 || items.length > 30) {
    return res.status(400).json({ error: "Invalid order details" });
  }
  const name = String(customer.name || "").trim().slice(0, 100);
  const phone = String(customer.phone || "").trim().slice(0, 20);
  const email = String(customer.email || "").trim().slice(0, 160);
  const address = String(customer.address || "").trim().slice(0, 500);
  if (!name || !/^\+?[0-9\s-]{10,16}$/.test(phone) || !address) {
    return res.status(400).json({ error: "Name, valid phone and delivery address are required" });
  }
  if (!["cod", "online"].includes(payment_method)) {
    return res.status(400).json({ error: "Unsupported payment method" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let total = 0;
    const normalized = [];
    for (const item of items) {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity);
      if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
        throw new Error("Invalid item");
      }
      const product = await client.query(
        "SELECT id, name, price_paise, stock_quantity FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE",
        [productId]
      );
      if (!product.rowCount || product.rows[0].stock_quantity < quantity) throw new Error("Product unavailable or insufficient stock");
      const p = product.rows[0];
      total += Number(p.price_paise) * quantity;
      normalized.push({ ...p, quantity });
    }
    const order = await client.query(
      "INSERT INTO orders (customer_name, customer_phone, customer_email, delivery_address, payment_method, payment_status, order_status, total_paise) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING id, order_number, total_paise, order_status, created_at",
      [name, phone, email || null, address, payment_method, "pending", total]
    );
    for (const item of normalized) {
      await client.query(
        "INSERT INTO order_items (order_id, product_id, product_name, unit_price_paise, quantity) VALUES ($1,$2,$3,$4,$5)",
        [order.rows[0].id, item.id, item.name, item.price_paise, item.quantity]
      );
      await client.query("UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2", [item.quantity, item.id]);
    }
    await client.query("COMMIT");
    res.status(201).json({ order: order.rows[0], message: "Order received. Payment is not yet processed." });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error.message === "Invalid item" ? error.message : "Unable to place order" });
  } finally {
    client.release();
  }
});

app.post("/api/admin/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 8 }), async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  try {
    const result = await pool.query("SELECT id, email, password_hash FROM admin_users WHERE email = $1 AND is_active = TRUE", [email]);
    if (!result.rowCount || !(await bcrypt.compare(password, result.rows[0].password_hash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
      return res.status(500).json({ error: "Authentication is not configured" });
    }
    const token = jwt.sign({ sub: result.rows[0].id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "8h", issuer: "zenvyra-supply" });
    res.json({ token, expires_in: 28800 });
  } catch (error) {
    console.error("admin.login", error.message);
    res.status(500).json({ error: "Unable to sign in" });
  }
});

app.get("/api/admin/orders", requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, order_number, customer_name, customer_phone, payment_method, payment_status, order_status, total_paise, created_at FROM orders ORDER BY created_at DESC LIMIT 200"
    );
    res.json({ orders: result.rows });
  } catch (error) {
    console.error("admin.orders", error.message);
    res.status(500).json({ error: "Unable to load orders" });
  }
});

app.patch("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  const allowed = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
  const status = String(req.body?.status || "");
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid order status" });
  try {
    const result = await pool.query("UPDATE orders SET order_status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, order_number, order_status", [status, req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Order not found" });
    res.json({ order: result.rows[0] });
  } catch (error) {
    console.error("admin.orders.update", error.message);
    res.status(500).json({ error: "Unable to update order" });
  }
});

app.use((err, _req, res, _next) => {
  console.error("api.error", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(port, () => console.log(`Zenvyra API listening on ${port}`));
