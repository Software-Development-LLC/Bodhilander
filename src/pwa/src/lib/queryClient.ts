/**
 * Shared React Query client.
 *
 * Defaults tuned for a "phone in your pocket" use case: no refetch when the
 * tab regains focus (we'd rather not chew battery), and a small stale time so
 * navigation between pages reuses recent data.
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});
