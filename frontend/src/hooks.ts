import {useEffect, useState} from 'react';
import {api} from './api';
import type {SessionState} from './types';

export function useProtectedImage(path?: string, credentials?: SessionState): {url: string; loading: boolean} {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(Boolean(path));
  useEffect(() => {
    if (!path) {
      setUrl('');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let objectUrl = '';
    setLoading(true);
    const loader = credentials ? api.mediaBlobFor(credentials, path, controller.signal) : api.mediaBlob(path, controller.signal);
    loader.then(blob => {
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => setUrl('')).finally(() => setLoading(false));
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [credentials?.access_token, credentials?.assessment_id, path]);
  return {url, loading};
}
