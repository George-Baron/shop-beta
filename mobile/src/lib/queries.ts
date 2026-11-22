import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
import type { AppConfig, Card, Notice, OrderActions, OrderDetail, OrderRow, ProductDetail, Review } from './types';

export const useConfig = () => useQuery({ queryKey: ['config'], queryFn: () => api.open<AppConfig>('/config'), staleTime: 5 * 60_000 });

export type ProductQuery = { q?: string; store?: string; category?: string; sort?: string };
export function useProducts(f: ProductQuery) {
  return useInfiniteQuery({
    queryKey: ['products', f],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v) p.set(k, v); p.set('page', String(pageParam));
      return api.open<{ products: Card[]; total: number; pages: number }>('/products?' + p.toString());
    },
    getNextPageParam: (last, all) => (all.length < last.pages ? all.length + 1 : undefined),
  });
}
export const useProduct = (slug: string) => useQuery({ queryKey: ['product', slug], queryFn: () => api.open<{ product: ProductDetail; related: Card[]; reviews: Review[] }>('/products/' + encodeURIComponent(slug)) });

export function useOrders() {
  const { status } = useAuth();
  return useInfiniteQuery({
    queryKey: ['orders'], enabled: status === 'in', initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<{ orders: OrderRow[]; next_before: number | null }>('/orders?limit=20' + (pageParam ? `&before=${pageParam}` : '')),
    getNextPageParam: (l) => l.next_before ?? undefined,
  });
}
export const useOrder = (ref: string, poll = false) => useQuery({
  queryKey: ['order', ref], queryFn: () => api.get<{ order: OrderDetail; actions: OrderActions }>('/orders/' + encodeURIComponent(ref)),
  refetchInterval: poll ? 4000 : false,
});
export function useNotices() {
  const { status } = useAuth();
  return useQuery({ queryKey: ['notices'], enabled: status === 'in', queryFn: () => api.get<{ notifications: Notice[]; unread: number; more: boolean }>('/notifications') });
}
