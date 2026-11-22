import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export type PayStatus = { ref: string; status: string; payment_status: string; payment_method: string; gateway?: string; checking?: boolean };

/**
 * After the payment page closes the app NEVER decides the order is paid. It asks the server, which asks the gateway and checks reference,
 * currency and amount. We ask every 4 seconds for up to 2 minutes, then stop and let the customer ask again.
 */
export const POLL_MS = 4000;
export const POLL_LIMIT = 30;
export function usePaymentCheck(ref: string, enabled: boolean) {
  const qc = useQueryClient();
  const [attempts, setAttempts] = useState(0);
  const count = useRef(0);
  const q = useQuery({
    queryKey: ['paystatus', ref], enabled,
    queryFn: async () => { count.current += 1; setAttempts(count.current); return api.get<PayStatus>(`/orders/${encodeURIComponent(ref)}/payment-status`); },
    refetchInterval: (query) => {
      const d = query.state.data;
      if (d && d.payment_status === 'paid') return false;
      return count.current >= POLL_LIMIT ? false : POLL_MS;
    },
    gcTime: 0, staleTime: 0, retry: false,
  });
  const paid = q.data?.payment_status === 'paid';
  useEffect(() => { if (paid) { qc.invalidateQueries({ queryKey: ['order', ref] }); qc.invalidateQueries({ queryKey: ['orders'] }); } }, [paid, ref, qc]);
  const gaveUp = enabled && !paid && (attempts >= POLL_LIMIT || q.isError);
  // "Check again" starts a fresh two minutes.
  return { ...q, paid, gaveUp, recheck: () => { count.current = 0; setAttempts(0); return q.refetch(); } };
}
