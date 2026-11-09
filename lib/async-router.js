'use strict';
// Express 4 does not catch errors from async handlers. This makes a router (or app) forward them to the error handler.
const express = require('express');
const wrap = (fn) => (fn.length === 4 ? fn : (req, res, next) => {
  try { const p = fn(req, res, next); if (p && typeof p.catch === 'function') p.catch(next); } catch (e) { next(e); }
});
function protect(target) {
  for (const m of ['get', 'post', 'put', 'delete', 'patch', 'use']) {
    const orig = target[m].bind(target);
    target[m] = (...args) => orig(...args.map((a) => (typeof a === 'function' ? wrap(a) : a)));
  }
  return target;
}
module.exports = { Router: () => protect(express.Router()), protect, wrap };
