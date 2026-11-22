import { useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Banner, Body, Button, Chip, Empty, Field, H2, Row, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { supportSchema } from '@/lib/schemas';
import { messageOf, useZodForm } from '@/lib/useForm';
import { Link } from 'expo-router';

const TOPICS: [string, string][] = [['order_issue', 'Problem with my order'], ['delivery', 'Delivery'], ['payment', 'Payment'], ['return_refund', 'Return or refund'], ['account', 'My account'], ['other', 'Something else']];

export default function Support() {
  const { status } = useAuth();
  const { orderRef } = useLocalSearchParams<{ orderRef?: string }>();
  const [topic, setTopic] = useState(orderRef ? 'order_issue' : '');
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const { control, handleSubmit, formState: { errors, isSubmitting } } = useZodForm<{ message: string }>(supportSchema, { message: '' });
  if (status !== 'in') return <Empty title="Sign in to contact us" action={<Link href="/sign-in" asChild><Button title="Sign in" onPress={() => undefined} /></Link>} />;
  const go = handleSubmit(async (v) => {
    setError('');
    if (!topic) { setError('Please choose what your message is about.'); return; }
    try { const r = await api.post<{ message: string }>('/support', { topic, message: v.message, ...(orderRef ? { orderRef: String(orderRef) } : {}) }); setDone(r.message); }
    catch (e) { setError(messageOf(e)); }
  });
  if (done) return <Screen><Banner kind="ok">{done}</Banner><Body muted>Refunds and returns are decided by our team, and they will reply by email.</Body></Screen>;
  return (
    <Screen>
      {orderRef ? <Banner>About order {orderRef}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      <H2>What is it about?</H2>
      <Row style={{ flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>{TOPICS.map(([id, label]) => <Chip key={id} label={label} active={topic === id} onPress={() => setTopic(id)} />)}</Row>
      <Field control={control} name="message" label="Your message" error={errors.message?.message} multiline />
      <Button title="Send message" onPress={go} loading={isSubmitting} />
      <Body muted style={{ marginTop: 16 }}>We reply by email, usually within one working day.</Body>
    </Screen>
  );
}
