import { z } from 'zod';

export const email = z.string().trim().toLowerCase().email('Please enter a valid email address.');
export const password = z.string().min(8, 'Use at least 8 characters.').max(200);
// Nigerian numbers: 080…, 081…, 070…, 090…, or +234… ; the server does its own check too.
export const phone = z.string().trim().regex(/^(\+?234|0)[789][01]\d{8}$/, 'Enter a Nigerian phone number, for example 0803 123 4567.');
export const phoneOptional = z.string().trim().refine((v) => v === '' || /^(\+?234|0)[789][01]\d{8}$/.test(v.replace(/\s/g, '')), 'Enter a Nigerian phone number, for example 0803 123 4567.');

export const signInSchema = z.object({ email, password: z.string().min(1, 'Enter your password.') });
export const registerSchema = z.object({ name: z.string().trim().min(2, 'Please enter your name.').max(80), email, phone: phoneOptional, password });
export const forgotSchema = z.object({ email });
export const checkoutSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name.').max(80),
  email,
  phone: z.string().trim().transform((v) => v.replace(/\s/g, '')).pipe(phone),
  state: z.string().min(1, 'Choose your state.'),
  city: z.string().trim().min(2, 'Enter your city or area.').max(80),
  address: z.string().trim().min(5, 'Enter your street address.').max(200),
});
export const supportSchema = z.object({ message: z.string().trim().min(5, 'Please tell us a little more.').max(2000) });
export const profileSchema = z.object({ name: z.string().trim().min(2, 'Please enter your name.').max(80), phone: phoneOptional, password: z.string(), newPassword: z.string() })
  .refine((v) => !v.newPassword || v.newPassword.length >= 8, { path: ['newPassword'], message: 'Use at least 8 characters.' })
  .refine((v) => !v.newPassword || v.password.length > 0, { path: ['password'], message: 'Enter your current password to change it.' });
export const wholesaleApplySchema = z.object({
  business_name: z.string().trim().min(2, 'Enter the business name.'), contact_name: z.string().trim().min(2, 'Enter the contact person.'),
  phone, address: z.string().trim().min(5, 'Enter the business address.'), state: z.string().min(1, 'Choose the state.'), city: z.string().trim().min(2, 'Enter the city.'),
  reg_no: z.string().trim().min(3, 'Enter the business registration number (RC).'), business_type: z.string().trim().min(2, 'What kind of business is it?'), buys: z.string().trim().min(5, 'Tell us what you buy.'), est_monthly: z.string().trim().optional(),
});
export const deleteSchema = z.object({ password: z.string().min(1, 'Enter your password to confirm.') });
