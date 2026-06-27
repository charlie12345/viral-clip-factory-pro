import { useEffect, useState } from 'react';

export function useWakeLock(active: boolean, keepAwake: boolean) {
  const [sentinel, setSentinel] = useState<WakeLockSentinel | null>(null);
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<'ready' | 'on' | 'off' | 'unsupported' | 'error'>('off');

  useEffect(() => {
    setSupported('wakeLock' in navigator && typeof navigator.wakeLock.request === 'function');
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function acquire() {
      if (!active || !keepAwake || !supported) return;
      try {
        const s = await navigator.wakeLock.request('screen');
        if (cancelled) { s.release().catch(() => {}); return; }
        s.addEventListener('release', () => setSentinel(null));
        setSentinel(s);
        setStatus('on');
      } catch {
        setStatus('error');
      }
    }
    function release() {
      sentinel?.release().catch(() => {});
      setSentinel(null);
      setStatus(keepAwake && supported ? 'ready' : 'off');
    }
    if (active && keepAwake && supported) acquire(); else release();
    return () => { cancelled = true; release(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, keepAwake, supported]);

  return { status, supported };
}
