'use strict';
// What the language model may call. Reads go straight to the real data (read-only); every action goes through the gateway,
// so the model can ask for anything but only the rules decide what happens.
const D = require('./data');
const St = require('./store');
const AP = require('./approvals');
const G = require('./gateway');
const P = require('./policy');
const Ag = require('./agents');

const READ = {
  overview: (i) => D.overview(i), orders: (i) => D.orders(i), delayed_orders: () => D.delayedOrders(25), awaiting_dispatch: () => D.awaitingDispatch(25),
  delivery_performance: (i) => D.deliveryPerformance(i), retail_stock: () => D.retailStock(), wholesale_stock: () => D.wholesaleStock(), riders: () => D.riders(),
  suppliers: () => D.suppliers(), stuck_dropship: () => D.stuckDropship(25), negative_margin: () => D.negativeMargin(25), trade: () => D.trade(),
  money: (i) => D.money(i), returns_refunds: () => D.returnsRefunds(),
  procurement_requests: () => require('./procurement').listRequests(), vendors: () => require('./procurement').listVendors(), purchase_orders: () => require('./procurement').listPOs(),
  shipments: () => require('./logistics').listShipments({ open: true }), delivery_providers: () => require('./logistics').listProviders(), provider_scorecards: () => require('./logistics').scorecards(),
  order_board: () => require('./orders').board({}), courier_compare: (i) => require('./logistics').compareForOrder(i.order_id, { weight_kg: i.weight_kg }),
  exceptions: () => St.listExceptions({ status: 'open' }), approvals: () => AP.list({ status: 'pending' }),
};
const ACTION_TYPES = Object.keys(P.ACTIONS);

const TOOLS = [
  { name: 'read_data', description: 'Read real VELTO-MART operational data. Always call this before stating any figure. what: ' + Object.keys(READ).join(', ') + '. Optional filters (overview/orders/money): channel (retail|wholesale|partner|dropship|international), country (2 letters), status, from, to.', input_schema: { type: 'object', properties: { what: { type: 'string', enum: Object.keys(READ) }, channel: { type: 'string' }, country: { type: 'string' }, status: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, order_id: { type: 'integer', description: 'For courier_compare: the order to compare delivery providers for.' }, weight_kg: { type: 'number', description: 'For courier_compare: parcel weight if the order has none recorded.' } }, required: ['what'] } },
  { name: 'take_action', description: 'Ask the system to do something. The rules decide what happens: it may run, wait for a person\'s approval, be recorded as a recommendation only, or be refused. The result says which. Never describe an action as done unless the result status is "done".', input_schema: { type: 'object', properties: { type: { type: 'string', enum: ACTION_TYPES }, summary: { type: 'string' }, justification: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' }, counterparty: { type: 'string' }, related_type: { type: 'string' }, related_id: { type: 'string' }, emergency: { type: 'boolean' }, payload: { type: 'object', description: 'action specific: {order_id} rider.assign; {title,detail,priority} task.create; {title,body} notify.staff; {} procurement.recommend; {request_id} quote.compare; {request_id,quotation_id,qty?} po.draft (do not pass amount); {vendor:{name,country,...}} supplier.onboard; {vendor_id,status,reason} supplier.status_change. To get a purchase order approved use po.create only through the Purchase Orders screen. Never invent a price or a vendor.' } }, required: ['type', 'summary'] } },
];

async function run(name, input, ctx) {
  const cfg = await St.getConfig(), i = input || {};
  if (name === 'read_data') {
    const fn = READ[i.what]; if (!fn) return { error: 'Unknown data set.' };
    const owner = Ag.AGENTS.find((a) => a.reads.includes(i.what));
    if (owner && !Ag.enabled(cfg, owner.key) && !Ag.AGENTS.some((a) => a.reads.includes(i.what) && Ag.enabled(cfg, a.key))) return { error: `The ${owner.name} is switched off.` };
    return fn(i);
  }
  if (name === 'take_action') {
    const agent = Ag.agentForAction(i.type);
    if (!Ag.enabled(cfg, agent)) return { status: 'blocked', action: i.type, reason: `The ${Ag.BY_KEY[agent].name} is switched off by management.` };
    return G.perform({ agent, user: ctx.user, requestedByUser: !!ctx.requestedByUser }, i.type, { ...i, payload: i.payload || {} });
  }
  return { error: 'unknown tool' };
}

module.exports = { TOOLS, READ, run };
