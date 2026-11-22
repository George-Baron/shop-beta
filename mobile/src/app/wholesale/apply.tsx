import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Banner, Body, Button, Chip, Field, Row, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/queries';
import { wholesaleApplySchema } from '@/lib/schemas';
import { messageOf, useZodForm } from '@/lib/useForm';

type F = { business_name: string; contact_name: string; phone: string; address: string; state: string; city: string; reg_no: string; business_type: string; buys: string; est_monthly: string };

export default function Apply() {
  const router = useRouter();
  const qc = useQueryClient();
  const cfg = useConfig();
  const [error, setError] = useState('');
  const { control, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } = useZodForm<F>(wholesaleApplySchema, { business_name: '', contact_name: '', phone: '', address: '', state: '', city: '', reg_no: '', business_type: '', buys: '', est_monthly: '' });
  const state = watch('state');
  const go = handleSubmit(async (v) => {
    setError('');
    try { await api.post('/wholesale/apply', { ...v, phone: v.phone.replace(/\s/g, '') }); await qc.invalidateQueries({ queryKey: ['ws-me'] }); router.replace('/wholesale'); }
    catch (e) { setError(messageOf(e)); }
  });
  return (
    <Screen>
      <Body muted style={{ marginBottom: 12 }}>Tell us about your business. Our team checks the details before approving your account.</Body>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Field control={control} name="business_name" label="Business name" error={errors.business_name?.message} />
      <Field control={control} name="contact_name" label="Contact person" error={errors.contact_name?.message} />
      <Field control={control} name="phone" label="Business phone" error={errors.phone?.message} keyboardType="phone-pad" />
      <Field control={control} name="reg_no" label="Registration number (RC)" error={errors.reg_no?.message} autoCapitalize="characters" />
      <Field control={control} name="business_type" label="Type of business (e.g. retailer)" error={errors.business_type?.message} />
      <Field control={control} name="address" label="Business address" error={errors.address?.message} multiline />
      <Body style={{ fontWeight: '600', marginBottom: 6 }}>State</Body>
      <Row style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>{(cfg.data?.zones ?? []).map((z) => <Chip key={z.state} label={z.state} active={state === z.state} onPress={() => setValue('state', z.state, { shouldValidate: true })} />)}</Row>
      {errors.state ? <Body style={{ color: '#b42318' }}>{errors.state.message}</Body> : null}
      <Field control={control} name="city" label="City" error={errors.city?.message} />
      <Field control={control} name="buys" label="What do you plan to buy?" error={errors.buys?.message} multiline />
      <Field control={control} name="est_monthly" label="Estimated monthly spend (optional)" error={errors.est_monthly?.message} />
      <Button title="Send application" onPress={go} loading={isSubmitting} />
    </Screen>
  );
}
