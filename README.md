# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Loyalty IDs

The loyalty program uses customer-held IDs in the form `123456789`. Phone
numbers are contact information only and never select a loyalty account.

- New customers can create an ID while checking out, connect an existing ID,
  or place an order without bonuses.
- The full ID is returned only when created or rotated. The database stores a
  keyed HMAC and a masked display value such as `12******9`.
- Set `LOYALTY_HMAC_SECRET` to a random secret of at least 32 characters in
  production. If omitted, the backend falls back to `JWT_SECRET` for backwards
  compatibility.
- Five failed ID attempts per browser and IP are allowed in a rolling 15-minute
  window, with an additional global abuse ceiling.
- A customer who loses both the browser copy and their downloaded copy cannot
  recover the balance. Staff can adjust accounts but cannot view or reset a
  customer's private ID.
