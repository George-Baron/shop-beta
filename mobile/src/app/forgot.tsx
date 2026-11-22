import React, { useState } from 'react';
import { Banner, Body, Button, Field, H1, Screen } from '@/components/ui';
import { forgotPassword } from '@/lib/api';
import { forgotSchema } from '@/lib/schemas';
import { messageOf, useZodForm } from '@/lib/useForm';

export default function Forgot() {
  const [state, setState] = useState<'idle' | 'sent' | string>('idle');
  const { control, handleSubmit, formState: { errors, isSubmitting } } = useZodForm<{ email: string }>(forgotSchema, { email: '' });
  const go = handleSubmit(async (v) => { try { await forgotPassword(v.email.trim().toLowerCase()); setState('sent'); } catch (e) { setState('Error: ' + messageOf(e)); } });
  return (
    <Screen>
      <H1>Reset your password</H1>
      <Body muted style={{ marginBottom: 16 }}>Enter your email. If an account exists we will send a link that opens a page where you choose a new password.</Body>
      {state === 'sent' ? <Banner kind="ok">If that email has an account, a reset link is on its way. It works for one hour.</Banner> : null}
      {state.startsWith('Error: ') ? <Banner kind="error">{state.slice(7)}</Banner> : null}
      <Field control={control} name="email" label="Email" error={errors.email?.message} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Button title="Send reset link" onPress={go} loading={isSubmitting} />
    </Screen>
  );
}
