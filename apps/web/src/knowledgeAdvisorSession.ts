export interface StoredKnowledgeAdvisorSession {
  session_id: string;
  access_token: string;
  expires_at: string;
}

const STORAGE_KEY = 'anju_knowledge_advisor_session_v1';

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function readKnowledgeAdvisorSession(): StoredKnowledgeAdvisorSession | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredKnowledgeAdvisorSession;
    if (!value.session_id || !value.access_token || Date.parse(value.expires_at) <= Date.now()) {
      clearKnowledgeAdvisorSession();
      return null;
    }
    return value;
  } catch {
    clearKnowledgeAdvisorSession();
    return null;
  }
}

export function writeKnowledgeAdvisorSession(value: StoredKnowledgeAdvisorSession): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function clearKnowledgeAdvisorSession(): void {
  storage()?.removeItem(STORAGE_KEY);
}
