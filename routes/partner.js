'use strict';
// The partner store's own portal (/partner). A store sees and changes only its own profile, products and orders.
const express = require('express');
const A = require('../lib/auth');
const V = require('../lib/vendors');
const CAT = require('../lib/catalog');
const S = require('../lib/shop');
const { int } = S;

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(A.requireVendor);

router.get('/me', ah(async (req, res) => res.json({ store: await V.profile(req.user), max_departments: V.MAX_DEPARTMENTS })));
router.put('/me', ah(async (req, res) => res.json({ store: await V.saveProfile(req.user, req.body || {}) })));
router.put('/departments', ah(async (req, res) => res.json({ departments: await V.saveDepartments(req.user, req.body && req.body.departments) })));

router.get('/products', ah(async (req, res) => res.json({ products: await V.myProducts(req.user, req.query) })));
router.get('/products/:id', ah(async (req, res) => res.json({ product: await V.myProduct(req.user, req.params.id) })));
router.post('/products', ah(async (req, res) => res.json({ ok: true, id: await V.createProduct(req.user, req.body) })));
router.put('/products/:id', ah(async (req, res) => res.json({ ok: true, ...(await V.updateProduct(req.user, req.params.id, req.body)) })));
router.put('/products/:id/stock', ah(async (req, res) => { await V.setStock(req.user, req.params.id, req.body && req.body.stock); res.json({ ok: true }); }));
router.delete('/products/:id', ah(async (req, res) => res.json({ ok: true, ...(await V.deleteProduct(req.user, req.params.id)) })));

// Photos for this store's products and page. The larger body is read only here, after the sign-in check above.
router.post('/upload', A.limiter('partner-upload', 120, 3600000), express.json({ limit: '4mb' }), ah(async (req, res) => {
  await V.mine(req.user);
  res.json({ url: await CAT.putImage(req.body && req.body.data) });
}));

router.get('/orders', ah(async (req, res) => res.json({ orders: await V.myOrders(req.user) })));
router.get('/earnings', ah(async (req, res) => res.json(await V.myEarnings(req.user))));

router.get('/catalogue', ah(async (req, res) => {
  const v = await V.mine(req.user);
  const depts = await V.departmentsOf(v.id), slugs = depts.map((d) => d.store);
  const { all } = require('../lib/db');
  res.json({ departments: depts, categories: slugs.length ? await all('SELECT id, store, name FROM categories WHERE store = ANY(?) ORDER BY sort, id', slugs) : [], all_departments: await all("SELECT slug, name, icon FROM stores WHERE active=1 AND slug <> 'pharmacy' ORDER BY sort, slug") });
}));

module.exports = router;
