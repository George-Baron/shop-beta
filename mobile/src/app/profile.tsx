import React, { useState } from 'react';
import { Banner, Body, Button, Field, H2, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { profileSchema } from '@/lib/schemas';
import { messageOf, useZodForm } from '@/lib/useForm';

export default function Profile() {
  const { user, setUser } = useAuth();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { control, handleSubmit, reset, formState: { errors, isSubmitting } } = useZodForm<{ name: string; phone: string; password: string; newPassword: string }>(profileSchema, { name: user?.name ?? '', phone: user?.phone ?? '', password: '', newPassword: '' });
  const go = handleSubmit(async (v) => {
    setMsg(null);
    try {
      const r = await api.put<{ user: typeof user }>('/me', { name: v.name, phone: v.phone.replace(/\s/g, ''), ...(v.newPassword ? { password: v.password, newPassword: v.newPassword } : {}) });
      if (r.user) setUser(r.user);
      reset({ name: v.name, phone: v.phone, password: '', newPassword: '' });
      setMsg({ ok: true, text: v.newPassword ? 'Saved. Your password was changed and your other devices were signed out.' : 'Saved.' });
    } catch (e) { setMsg({ ok: false, text: messageOf(e) }); }
  });
  return (
    <Screen>
      {msg ? <Banner kind={msg.ok ? 'ok' : 'error'}>{msg.text}</Banner> : null}
      <Body muted style={{ marginBottom: 12 }}>Email: {user?.email} (to change it, contact us)</Body>
      <Field control={control} name="name" label="Full name" error={errors.name?.message} />
      <Field control={control} name="phone" label="Phone" error={errors.phone?.message} keyboardType="phone-pad" />
      <H2>Change password</H2>
      <Field control={control} name="password" label="Current password" error={errors.password?.message} secureTextEntry autoComplete="current-password" />
      <Field control={control} name="newPassword" label="New password (leave empty to keep yours)" error={errors.newPassword?.message} secureTextEntry autoComplete="new-password" />
      <Button title="Save" onPress={go} loading={isSubmitting} />
    </Screen>
  );
}
