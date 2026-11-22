import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Body, Button, Card, Chip, Empty, Field, H1, H2, Loading, Row, Screen } from '@/components/ui';
import { usePriced } from '@/app/(tabs)/cart';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { cartItems, forgetKeys, keyFor, openPayment, safePayUrl, visibleMethods } from '@/lib/checkout';
import { ENV } from '@/lib/config';
import { naira, payLabel } from '@/lib/format';
import { useConfig } from '@/lib/queries';
import { checkoutSchema } from '@/lib/schemas';
import type { Address } from '@/lib/types';
import { messageOf, useZodForm } from '@/lib/useForm';
import { colors, radius, space } from '@/theme';

type Form = { name: string; email: string; phone: string; state: string; city: string; address: string };

export default function Checkout() {
  const { status, user } = useAuth();
  const { lines, clear } = useCart();
  const router = useRouter();
  const qc = useQueryClient();
  const cfg = useConfig();
  const saved = useQuery({ queryKey: ['addresses'], enabled: status === 'in', queryFn: () => api.get<{ addresses: Address[] }>('/addresses') });
  const { control, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } = useZodForm<Form>(checkoutSchema, { name: user?.name ?? '', email: user?.email ?? '', phone: user?.phone ?? '', state: '', city: '', address: '' });
  const state = watch('state');
  const [delivery, setDelivery] = useState('standard');
  const [payment, setPayment] = useState('');
  const [error, setError] = useState('');
  const priced = usePriced(state || 'Lagos', delivery);
  const p = priced.data;
  const methods = visibleMethods(p?.payments ?? [], ENV);
  useEffect(() => { if (methods.length && !methods.includes(payment)) setPayment(methods[0]); }, [methods.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status !== 'in') return <Empty title="Sign in to check out" hint="Your cart is saved on this phone." action={<Link href="/sign-in" asChild><Button title="Sign in or create account" onPress={() => undefined} /></Link>} />;
  if (lines.length === 0) return <Empty title="Your cart is empty" />;

  const place = handleSubmit(async (v) => {
    setError('');
    if (!state) return;
    if (!payment) { setError('Choose how you want to pay.'); return; }
    // Re-price right before ordering: the server's numbers are the ones that count.
    const body = { items: cartItems(lines), contact: { name: v.name, email: v.email, phone: v.phone }, address: { state: v.state, city: v.city, address: v.address }, delivery, payment };
    try {
      const r = await api.post<{ ref: string; next: string; url?: string }>('/checkout', body, { 'Idempotency-Key': keyFor(body) });
      forgetKeys(); clear(); qc.invalidateQueries({ queryKey: ['orders'] });
      if (r.next === 'paystack' || r.next === 'stripe') {
        const url = safePayUrl(r.url);
        if (!url) { router.replace({ pathname: '/order/[ref]', params: { ref: r.ref } }); return; }   // the order page offers "Pay now" again
        await openPayment(url);
        router.replace({ pathname: '/order/[ref]', params: { ref: r.ref, paying: '1' } });
      } else router.replace({ pathname: '/order/[ref]', params: { ref: r.ref } });
    } catch (e) {
      // A dropped connection keeps the same key, so tapping again cannot create a second order.
      setError(e instanceof ApiError && e.offline ? 'We lost the connection. Tap Place order again: your order will not be duplicated.' : messageOf(e));
    }
  });

  return (
    <Screen>
      <H1>Delivery details</H1>
      {error ? <Banner kind="error">{error}</Banner> : null}
      {saved.data?.addresses.length ? (
        <View style={{ marginBottom: space.md }}>
          <Body muted style={{ marginBottom: 6 }}>Use a saved address</Body>
          <Row style={{ flexWrap: 'wrap', gap: 6 }}>
            {saved.data.addresses.map((a) => <Chip key={a.id} label={a.label || `${a.address.slice(0, 18)}…`} onPress={() => { setValue('state', a.state); setValue('city', a.city ?? ''); setValue('address', a.address); if (a.name) setValue('name', a.name); if (a.phone) setValue('phone', a.phone); }} />)}
          </Row>
        </View>
      ) : null}
      <Field control={control} name="name" label="Full name" error={errors.name?.message} autoComplete="name" />
      <Field control={control} name="email" label="Email (for your receipt)" error={errors.email?.message} autoCapitalize="none" keyboardType="email-address" />
      <Field control={control} name="phone" label="Phone (the rider will call this number)" error={errors.phone?.message} keyboardType="phone-pad" />
      <Body style={{ fontWeight: '600', marginBottom: 6 }}>State</Body>
      <Row style={{ flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
        {(cfg.data?.zones ?? []).map((z) => <Chip key={z.state} label={z.state} active={state === z.state} onPress={() => setValue('state', z.state, { shouldValidate: true })} />)}
      </Row>
      {errors.state ? <Text style={{ color: colors.danger, marginBottom: space.sm }}>{errors.state.message}</Text> : <View style={{ height: space.sm }} />}
      <Field control={control} name="city" label="City or area" error={errors.city?.message} />
      <Field control={control} name="address" label="Street address" error={errors.address?.message} multiline />

      {p?.delivery.options && state ? (
        <View><H2>Delivery</H2>
          {Object.entries(p.delivery.options).map(([k, o]) => (
            <Pressable key={k} accessibilityRole="radio" accessibilityState={{ selected: (p.delivery.selected ?? delivery) === k }} onPress={() => setDelivery(k)}
              style={{ padding: space.md, borderRadius: radius.md, borderWidth: 2, borderColor: (p.delivery.selected ?? delivery) === k ? colors.gold : colors.line, backgroundColor: colors.white, marginBottom: space.sm }}>
              <Text style={{ fontWeight: '700', color: colors.ink }}>{o.label} · {o.fee ? naira(o.fee) : 'Free'}</Text>{o.eta ? <Body muted>{o.eta}</Body> : null}
            </Pressable>
          ))}
        </View>
      ) : state ? <Body muted>Delivery to this state is not available yet.</Body> : null}

      <H2>Payment</H2>
      {methods.length === 0 && p ? <Banner kind="error">No payment method is available for this order right now.</Banner> : null}
      {methods.map((m) => (
        <Pressable key={m} accessibilityRole="radio" accessibilityState={{ selected: payment === m }} onPress={() => setPayment(m)}
          style={{ padding: space.md, borderRadius: radius.md, borderWidth: 2, borderColor: payment === m ? colors.gold : colors.line, backgroundColor: colors.white, marginBottom: space.sm }}>
          <Text style={{ fontWeight: '700', color: colors.ink }}>{payLabel(m)}</Text>
          {m === 'pod' ? <Body muted>Pay the rider when your order arrives. We may call to confirm it first.</Body> : <Body muted>You will pay on a secure page; we never see your card details.</Body>}
        </Pressable>
      ))}

      {p ? (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}><Body>Items</Body><Body>{naira(p.subtotal)}</Body></Row>
          {p.discount > 0 ? <Row style={{ justifyContent: 'space-between' }}><Body>Discount</Body><Body>−{naira(p.discount)}</Body></Row> : null}
          <Row style={{ justifyContent: 'space-between' }}><Body>Delivery</Body><Body>{state ? (p.delivery.fee ? naira(p.delivery.fee) : 'Free') : 'Choose a state'}</Body></Row>
          {p.tax > 0 ? <Row style={{ justifyContent: 'space-between' }}><Body>{p.taxLabel || 'Tax'}</Body><Body>{naira(p.tax)}</Body></Row> : null}
          <Row style={{ justifyContent: 'space-between', marginTop: 6 }}><Text style={{ fontWeight: '800', fontSize: 18, color: colors.navy }}>Total</Text><Text style={{ fontWeight: '800', fontSize: 18, color: colors.navy }}>{naira(p.total)}</Text></Row>
        </Card>
      ) : priced.isLoading ? <Loading /> : null}
      {p?.issues.map((i, n) => <Banner key={n}>{i.message}</Banner>)}
      {p?.blocked.map((b, n) => <Banner key={n} kind="error">{b}</Banner>)}
      <Button title={payment === 'pod' ? 'Place order' : 'Place order and pay'} onPress={place} loading={isSubmitting} disabled={!p || p.blocked.length > 0 || !state || !p.delivery.options} testID="place-order" />
    </Screen>
  );
}
