'use strict';
// "Members" are signed-in customers. Visitors who are not signed in can browse and buy from the shop, but dropshipped items, the Import & Export desk, the
// Rewards programme and wholesale are for registered customers only. This module remembers, for the request being handled, whether the visitor is a member,
// so the shared product query (PC.visibleSql) can leave dropshipped items out for everyone else without every route having to remember to ask.
// Outside a web request (background jobs, scripts) there is no visitor and nothing is hidden. Search-engine pages are built as a guest, so they never list members-only items.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const isMember = () => { const s = als.getStore(); return !s || s.member; };
const run = (member, fn) => als.run({ member: !!member }, fn);
const middleware = (req, res, next) => als.run({ member: !!req.user }, next);
const MEMBERS_ONLY = 'This is for registered customers. Please sign in or create a free account.';
module.exports = { isMember, run, middleware, MEMBERS_ONLY };
