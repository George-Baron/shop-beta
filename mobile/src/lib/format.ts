export const naira = (n: number | undefined | null) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
export const dateTime = (secs: number | undefined) => (secs ? new Date(secs * 1000).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const day = (secs: number | undefined) => (secs ? new Date(secs * 1000).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const STATUS: Record<string, string> = { pending: 'Placed', paid: 'Paid', confirmed: 'Confirmed', processing: 'Being prepared', shipped: 'On its way', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded' };
export const statusLabel = (s: string) => STATUS[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
export const payLabel = (m: string) => ({ paystack: 'Card / bank (Paystack)', stripe: 'Card (Stripe)', pod: 'Pay on delivery' } as Record<string, string>)[m] ?? m;
