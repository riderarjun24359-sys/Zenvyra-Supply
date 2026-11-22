# Zenvyra Supply API

Node.js/Express API for the Zenvyra Supply storefront.

## Setup

1. Create a Neon PostgreSQL database and copy its pooled connection string.
2. Set environment variables from `.env.example`; never commit real secrets.
3. Run `psql "$DATABASE_URL" -f schema.sql`.
4. Run `npm install`.
5. Set a strong `ADMIN_PASSWORD` (14+ characters) and `JWT_SECRET` (32+ random characters), then run `npm run admin:create`.
6. Run `npm start`.

## Routes

- `GET /health`
- `GET /api/products`
- `POST /api/orders`
- `POST /api/admin/login`
- `GET /api/admin/orders` (admin JWT)
- `PATCH /api/admin/orders/:id/status` (admin JWT)

Prices are stored as integer paise. The API recalculates totals from database prices and locks inventory rows during checkout. Online payment is intentionally not marked paid; Razorpay order creation and verified webhook handling must be added before accepting online payments.

## Security notes

- Never expose DATABASE_URL, JWT_SECRET or database credentials in browser code.
- Use a separate production database role with only required privileges.
- Configure FRONTEND_ORIGIN to the exact storefront origin.
- Keep payment card data out of this application.
