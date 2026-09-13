import { QueryClient } from "@tanstack/solid-query";
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } });
