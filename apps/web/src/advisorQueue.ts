import type {AdvisorRTCQueueTicket} from './types';

const CLIENT_KEY = 'anju_advisor_client_instance_id';
const TICKET_PREFIX = 'anju_advisor_rtc_ticket:';

export interface StoredAdvisorRTCTicket extends AdvisorRTCQueueTicket {
  room_id: string;
  advisor_session_id: string;
  client_instance_id: string;
  mode: 'audio' | 'audio_video';
}

function storage(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

export function advisorClientInstanceId(): string {
  const current = storage()?.getItem(CLIENT_KEY);
  if (current) return current;
  const fallback = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, value => {
    const random = Math.floor(Math.random() * 16);
    return (value === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
  const created = globalThis.crypto?.randomUUID?.() || fallback;
  storage()?.setItem(CLIENT_KEY, created);
  return created;
}

function ticketKey(roomId: string, mode: 'audio' | 'audio_video') {
  return `${TICKET_PREFIX}${roomId}:${mode}`;
}

export function saveAdvisorRTCTicket(
  roomId: string,
  advisorSessionId: string,
  clientInstanceId: string,
  mode: 'audio' | 'audio_video',
  ticket: AdvisorRTCQueueTicket,
): StoredAdvisorRTCTicket {
  const value: StoredAdvisorRTCTicket = {
    ...ticket,
    room_id: roomId,
    advisor_session_id: advisorSessionId,
    client_instance_id: clientInstanceId,
    mode,
  };
  storage()?.setItem(ticketKey(roomId, mode), JSON.stringify(value));
  return value;
}

export function readAdvisorRTCTicket(
  roomId: string,
  mode: 'audio' | 'audio_video',
): StoredAdvisorRTCTicket | null {
  try {
    const raw = storage()?.getItem(ticketKey(roomId, mode));
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredAdvisorRTCTicket;
    if (
      value.room_id !== roomId
      || value.mode !== mode
      || !value.ticket_id
      || !value.advisor_session_id
      || Date.parse(value.expires_at) <= Date.now()
    ) {
      clearAdvisorRTCTicket(roomId, mode);
      return null;
    }
    return value;
  } catch {
    clearAdvisorRTCTicket(roomId, mode);
    return null;
  }
}

export function clearAdvisorRTCTicket(roomId: string, mode: 'audio' | 'audio_video') {
  storage()?.removeItem(ticketKey(roomId, mode));
}
