import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type FieldValues, type DefaultValues } from 'react-hook-form';
import type { ZodType } from 'zod';
import { ApiError } from './api';

/** react-hook-form wired to a Zod schema. */
export function useZodForm<T extends FieldValues>(schema: ZodType<any, any>, defaultValues: DefaultValues<T>) {
  return useForm<T>({ resolver: zodResolver(schema as any) as any, defaultValues, mode: 'onBlur' });
}
export const messageOf = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
