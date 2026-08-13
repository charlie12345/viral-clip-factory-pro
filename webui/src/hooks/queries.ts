import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';

const POLL_MS = 1500;

export function useActiveJob() {
  return useQuery({
    queryKey: ['job-status'],
    queryFn: () => api.jobStatus(),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });
}

export function useLogs(limit = 80) {
  return useQuery({
    queryKey: ['logs', limit],
    queryFn: () => api.getLogs(limit),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });
}

export function useClips() {
  const qc = useQueryClient();
  const job = useActiveJob();
  const query = useQuery({
    queryKey: ['clips'],
    queryFn: () => api.listClips(),
    // Poll faster while a job is running so new clips appear live
    refetchInterval: () => (job.data?.active ? 2000 : 10000),
  });
  // When job transitions to inactive, force refresh of clip list
  useEffect(() => {
    if (job.data && !job.data.active && job.data.finishedAt) {
      const t = setTimeout(() => qc.invalidateQueries({ queryKey: ['clips'] }), 800);
      return () => clearTimeout(t);
    }
  }, [job.data?.active, job.data?.finishedAt, qc]);
  return query;
}

export function useJobs() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.listJobs(),
    refetchInterval: 5000,
  });
}
