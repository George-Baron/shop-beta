'use strict';
// The ten specialist agents. An agent is a named area of responsibility: the data it may read and the departments it may act in.
// They share the same verified data and the same gateway, so none of them can override the policy. A person can switch any of them off.
const P = require('./policy');

const AGENTS = [
  { key: 'procurement', name: 'Procurement Intelligence Agent', depts: ['procurement', 'suppliers'], reads: ['retail_stock', 'wholesale_stock', 'suppliers', 'procurement_requests', 'vendors', 'purchase_orders'], about: 'Replenishment needs, supplier comparison, draft purchase orders.' },
  { key: 'inventory', name: 'Inventory Intelligence Agent', depts: ['warehouse'], reads: ['retail_stock', 'wholesale_stock'], about: 'Stock risk, reorder points, expected stock-out dates.' },
  { key: 'orders', name: 'Order Management Agent', depts: ['retail'], reads: ['orders', 'delayed_orders', 'awaiting_dispatch'], about: 'Watches every channel, classifies orders, raises order exceptions.' },
  { key: 'wholesale', name: 'Wholesale Operations Agent', depts: ['wholesale'], reads: ['wholesale_stock', 'orders'], about: 'Wholesale orders and stock, kept apart from retail.' },
  { key: 'partner_dropship', name: 'Partner and Dropshipping Agent', depts: ['partners', 'dropshipping'], reads: ['stuck_dropship', 'suppliers'], about: 'Partner and supplier fulfilment, deadlines and performance.' },
  { key: 'international_trade', name: 'International Trade Agent', depts: ['import_export'], reads: ['trade'], about: 'Import and export consignments, customs holds, landed cost.' },
  { key: 'logistics', name: 'Logistics and Dispatch Agent', depts: ['riders', 'couriers'], reads: ['riders', 'awaiting_dispatch', 'delivery_performance'], about: 'Rider assignment, courier comparison, shipment tracking.' },
  { key: 'customer_fulfilment', name: 'Customer Fulfilment Agent', depts: ['refunds', 'compensation'], reads: ['returns_refunds'], about: 'Returns, refund recommendations, delivery messages.' },
  { key: 'finance', name: 'Operations Finance Agent', depts: ['financial'], reads: ['money', 'negative_margin'], about: 'Cost and margin watching. Only ever prepares payments; a person releases money.' },
  { key: 'risk', name: 'Risk and Compliance Agent', depts: [], reads: ['exceptions', 'approvals'], about: 'Approval rules, audit trail, exceptions and escalation.' },
];
const BY_KEY = Object.fromEntries(AGENTS.map((a) => [a.key, a]));
const agentForDept = (dept) => (AGENTS.find((a) => a.depts.includes(dept)) || { key: 'orchestrator' }).key;
const agentForAction = (type) => { const i = P.actionInfo(type); return i ? agentForDept(i.dept) : 'orchestrator'; };
const enabled = (cfg, key) => !(cfg.agents_disabled || []).includes(key);
const list = (cfg) => AGENTS.map((a) => ({ key: a.key, name: a.name, about: a.about, departments: a.depts, enabled: enabled(cfg, a.key) }));

module.exports = { AGENTS, BY_KEY, agentForDept, agentForAction, enabled, list };
