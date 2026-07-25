import {useEffect, useState} from 'react';
import {api} from './api';

export function useProtectedImage(path?: string): {url: string; loading: boolean} {
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
    api.mediaBlob(path, controller.signal).then(blob => {
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => setUrl('')).finally(() => setLoading(false));
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return {url, loading};
}
