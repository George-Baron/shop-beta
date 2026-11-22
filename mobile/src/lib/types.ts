export type Card = {
  id: number; slug: string; name: string; brand?: string; image?: string; emoji?: string;
  price: number; compare_price?: number; off?: number; new_arrival?: number; stock: number;
  rating: number; rating_n: number; vendor?: { slug: string; name: string } | null;
};
export type Variant = { id: number; size?: string; color?: string; stock: number; price?: number };
export type ProductDetail = Card & { description?: string; images?: string[]; variants?: Variant[]; category?: string; fulfilment?: string; rx_required?: number; is_pharmacy?: number };
export type Review = { id: number; name: string; rating: number; body?: string; comment?: string; created?: number };
export type Store = { slug: string; name: string; tagline?: string };
export type Category = { id: number; store: string; slug: string; name: string; icon?: string };
export type Zone = { state: string; fee: number; eta: string; pod: number };
export type AppConfig = {
  settings: Record<string, string>; stores: Store[]; categories: Category[]; zones: Zone[];
  payments: { paystack: boolean; pod: boolean; demo: boolean; stripe: boolean };
};
export type CartLine = { productId: number; variantId: number | null; qty: number };
export type PricedLine = { productId: number; variantId: number | null; slug: string; name: string; variantLabel: string; price: number; qty: number; available: number; image?: string; emoji?: string; pharm?: boolean; rx?: boolean; vendorName?: string };
export type DeliveryOption = { label: string; fee: number; eta?: string };
export type Priced = {
  lines: PricedLine[]; subtotal: number; discount: number; coupon: string; couponError: string; issues: { productId?: number; message: string }[];
  delivery: { options?: Record<string, DeliveryOption>; selected?: string; fee?: number; free?: boolean; threshold?: number };
  total: number; tax: number; taxLabel: string; blocked: string[]; payments: string[]; has_dropship: boolean;
};
export type OrderRow = { ref: string; status: string; payment_method: string; payment_status: string; total: number; currency: string; created: number; item_count: number; first_item?: string; first_image?: string };
export type OrderItem = { id?: number; name: string; qty: number; price: number; variant_label?: string; image?: string };
export type OrderEvent = { status: string; note?: string; created: number };
export type OrderDetail = {
  ref: string; status: string; payment_method: string; payment_status: string; total: number; subtotal?: number; delivery_fee?: number; discount?: number; tax?: number; tax_label?: string; currency: string; created: number; gateway?: string; delivery?: string;
  items: OrderItem[]; events: OrderEvent[]; name?: string; address?: string; city?: string; state?: string; handover_code?: string; can_rate_delivery?: boolean; delivery_rating?: { rating: number; comment: string };
  rider?: { lat: number; lng: number; at: number } | null; pharmacy?: { rx_required: boolean; rx_status?: string; needs_payment?: boolean } | null;
};
export type OrderActions = { can_cancel: boolean; can_pay: boolean; can_rate_delivery: boolean };
export type Notice = { id: number; type: string; title: string; body: string; link: string; created: number; read: boolean };
export type Address = { id: number; label?: string; name?: string; phone?: string; state: string; city?: string; address: string };
export type Device = { id: number; name: string; platform: string; app_version: string; created: number; last_used: number; current: boolean };
export type WholesaleAccount = { status: 'pending' | 'approved' | 'rejected'; business_name?: string; [k: string]: unknown } | null;
export type WholesaleProduct = { id: number; slug: string; name: string; brand?: string; price: number; retail_price: number; min_qty: number; stock: number; image?: string };
export type QuoteItem = { id: number; product_id: number; name: string; qty: number; list_price: number; unit_price: number; line_total: number };
export type Quote = {
  ref: string; status: string; created: number; items: QuoteItem[]; goods_total: number; logistics_fee: number; service_pct: number; service_fee: number; total: number;
  valid_until: number | null; pay_by: number | null; admin_note?: string; buyer_note?: string; order_no?: string | null; invoice_no?: string | null;
  ship: { name: string; phone: string; state: string; city: string; address: string };
  events: { status: string; note: string; created: number }[]; fulfilment?: { stage: string; label?: string } | null;
};
export type QuoteRow = { ref: string; status: string; goods_total: number; total: number; created: number; valid_until?: number | null };
