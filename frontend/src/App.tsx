import {useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode} from 'react';
import {HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams} from 'react-router-dom';
import {api, friendlyError, parseAdvisorEvent} from './api';
import {ADVISOR_COPY, CAMERA_COPY, DIFFICULTY_COPY, HOME_HERO_COPY, KNOWLEDGE_ADVISOR_COPY, ONBOARDING_COPY, PRODUCT_NAME, RENOVATION_PREVIEW_COPY, ROOM_COPY, ROOM_PHOTO_GUIDES, SCENE_ELEMENT_COPY, SEVERITY_COPY, STAGE_COPY, UPLOAD_COPY} from './content';
import {useProtectedImage} from './hooks';
import {normalizeImage} from './image';
import {invokeNative, isNativeCaptureResult, nativeCapability, nativeRequestId, NATIVE_CAPTURE_RESULT_EVENT} from './nativeBridge';
import {hammingDistance, inspectPixels} from './video';
import LiveCameraOverlay, {type NumberedCameraSuggestion} from './LiveCameraOverlay';
import RiskOverlay, {coverMetrics, mapImagePoint} from './RiskOverlay';
import {AppProvider, formatRange, readAssessmentHistory, readDefaultProfile, removeAssessmentHistory, useApp, writeDefaultProfile} from './store';
import {OnboardingOverlay, OnboardingProvider, useOnboarding} from './onboarding';
import type {AdvisorBootstrap, AdvisorCard, AdvisorConfirmationCard, AdvisorContextRef, AdvisorRTCQueueTicket, AdvisorTurn, AnalysisStatus, Assessment, AssessmentHistoryEntry, AssessmentReport, CameraSuggestion, ElderProfile, KnowledgeAdvisorBootstrap, KnowledgeAdvisorTurn, MediaAsset, RenovationPreview, RenovationPreviewContext, RoomAssessment, RoomResult, RoomType, SafetyRisk, SessionState, SolutionPackage} from './types';
import {AdvisorVoiceRTC, type VoiceState} from './voiceRtc';
import {subscribeAdvisorEvents} from './advisorEvents';
import {
  advisorClientInstanceId, clearAdvisorRTCTicket, readAdvisorRTCTicket, saveAdvisorRTCTicket,
} from './advisorQueue';
import {clearKnowledgeAdvisorSession, readKnowledgeAdvisorSession, writeKnowledgeAdvisorSession, type StoredKnowledgeAdvisorSession} from './knowledgeAdvisorSession';

const ASSETS = '/assets/stitch';
const ANALYSIS_STAGES = ['quality_checked', 'scene_understood', 'risks_detecting', 'regions_grounded', 'rules_applied', 'score_calculated', 'solutions_ready'] as const;
const HOME_FLOW_STEPS = [
  {patterns: [/^profile$/], label: '家人情况'},
  {patterns: [/^rooms$/], label: '选择房间'},
  {patterns: [/^upload\//], label: '上传照片'},
  {patterns: [/^analyzing\//], label: 'AI 检查'},
  {patterns: [/^(result|risk|solutions|selected-solution|renovation-preview)\//], label: '查看结果'},
  {patterns: [/^report$/], label: '改造清单'},
] as const;

function getHomeProgress(lastRoute?: string) {
  if (!lastRoute) return {step: 1, label: HOME_FLOW_STEPS[0].label};
  const index = HOME_FLOW_STEPS.findIndex(item => item.patterns.some(pattern => pattern.test(lastRoute)));
  const safeIndex = index < 0 ? 0 : index;
  return {step: safeIndex + 1, label: HOME_FLOW_STEPS[safeIndex].label};
}

const CHECK_ROUTE_PATTERN = /^(profile|rooms|report|(?:upload|analyzing|result|renovation-preview)\/[A-Za-z0-9_-]{1,80}|(?:risk|solutions)\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,80}|selected-solution\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,80})$/;

function isCheckRoute(pathname: string): boolean {
  return CHECK_ROUTE_PATTERN.test(pathname.replace(/^\//, ''));
}

function profileIsComplete(assessment: Assessment | null): boolean {
  const profile = assessment?.profile || assessment?.profile_json;
  return Boolean(profile?.mobility && profile?.fall_history && profile?.living_status);
}

export function resolveCheckDestination(session: SessionState | null, assessment: Assessment | null): string | null {
  if (!session) return null;
  const route = (session.last_route || '').replace(/^\//, '');
  if (CHECK_ROUTE_PATTERN.test(route)) {
    const roomId = route.match(/^(?:upload|analyzing|result|renovation-preview|risk|solutions|selected-solution)\/([^/]+)/)?.[1];
    if (!roomId || !assessment || assessment.rooms.some(room => room.room_id === roomId)) return `/${route}`;
  }
  return profileIsComplete(assessment) ? '/rooms' : '/profile';
}

function Icon({name, filled = false, className = ''}: {name: string; filled?: boolean; className?: string}) {
  return <span className={`material-symbols-rounded ${filled ? 'is-filled' : ''} ${className}`} aria-hidden="true">{name}</span>;
}

function Loading({label = '正在加载…'}: {label?: string}) {
  return <div className="center-state" role="status"><span className="spinner" /><p>{label}</p></div>;
}

function ErrorState({error, retry}: {error: unknown; retry?: () => void}) {
  return <section className="page center-state"><Icon name="cloud_off" className="state-icon" /><h1>这次没有完成</h1><p>{friendlyError(error)}</p>{retry && <button className="button primary" onClick={retry}>重试</button>}</section>;
}

function FlowProgress({pathname}: {pathname: string}) {
  const steps: [RegExp, number, string][] = [
    [/^\/profile$/, 1, '家人情况'],
    [/^\/rooms$/, 2, '选择房间'],
    [/^\/upload\//, 3, '上传照片'],
    [/^\/analyzing\//, 4, 'AI 检查'],
    [/^\/result\//, 5, '查看结果'],
    [/^\/(report|renovation-preview\/)/, 6, '改造清单'],
  ];
  const current = steps.find(([pattern]) => pattern.test(pathname));
  if (!current) return null;
  const [, step, label] = current;
  return <div className="flow-progress" role="status" aria-label={`检查进度：第 ${step} 步，共 6 步，${label}`}>
    <span>第 {step} / 6 步 · {label}</span>
    <div><i style={{width: `${step / 6 * 100}%`}} /></div>
  </div>;
}

function Modal({title, children, close}: {title: string; children: ReactNode; close: () => void}) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && close()}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-heading"><h2 id="modal-title">{title}</h2><button className="icon-button" onClick={close} aria-label="关闭"><Icon name="close" /></button></div>
      {children}
    </section>
  </div>;
}

function ProtectedImage({media, className = '', fallback}: {media?: MediaAsset; className?: string; fallback: string}) {
  const {url, loading} = useProtectedImage(media?.content_path);
  return <div className={`protected-image ${className}`}>
    <img src={url || fallback} alt={media ? '已上传的房间照片' : '居家环境拍摄示意图'} />
    {loading && <span className="image-loading"><span className="spinner" /></span>}
    {!url && !loading && <span className="image-demo-chip">示意图</span>}
  </div>;
}

function useAssessment(): {assessment: Assessment | null; loading: boolean; error: unknown; reload: () => void} {
  const {session, assessment, setAssessment} = useApp();
  const [loading, setLoading] = useState(Boolean(session));
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!session) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api.getAssessment(controller.signal).then(value => {
      setAssessment(value);
      setError(null);
    }).catch(value => {
      if ((value as Error).name !== 'AbortError') setError(value);
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [session, setAssessment, version]);
  return {assessment, loading, error, reload: () => setVersion(value => value + 1)};
}

function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const {session, setSession, setAssessment, health, setHealth, setCapabilities, toast, showToast} = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});
  const isHome = location.pathname === '/home';
  const isShare = location.pathname.startsWith('/share/');
  const isKnowledgeAdvisor = location.pathname === '/advisor';
  const isAdvisor = isKnowledgeAdvisor || location.pathname.startsWith('/advisor/') || location.pathname.startsWith('/advisor-queue/');
  const isCamera = location.pathname === '/camera';
  const isMy = location.pathname === '/my';
  const isRenovations = location.pathname === '/renovations';
  const isProfileEditing = location.pathname === '/profile' && new URLSearchParams(location.search).get('from') === 'my';

  useEffect(() => {
    api.health().then(value => { setHealth(value.analysis); setCapabilities(value.capabilities || null); }).catch(() => { setHealth('unavailable'); setCapabilities(null); });
  }, [setCapabilities, setHealth]);

  useEffect(() => {
    mainRef.current?.focus({preventScroll: true});
    const path = location.pathname;
    const frame = window.requestAnimationFrame(() => window.scrollTo({top: scrollPositions.current[path] || 0, behavior: 'instant'}));
    const rememberScroll = () => { scrollPositions.current[path] = window.scrollY; };
    window.addEventListener('scroll', rememberScroll, {passive: true});
    if (session && !isHome && !isShare && !isAdvisor && !isMy && !isRenovations && !isProfileEditing && location.pathname !== '/camera') {
      setSession({...session, last_route: location.pathname.replace(/^\//, '')});
    }
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', rememberScroll);
    };
  }, [location.pathname, session?.access_token, session?.assessment_id]); // route focus and persistence are intentionally coupled

  const deleteAssessment = async () => {
    try {
      await api.deleteAssessment();
      removeAssessmentHistory(session?.assessment_id || '');
      setSession(null);
      setAssessment(null);
      setDeleteConfirmOpen(false);
      navigate('/home');
      showToast('本次检查和照片已删除');
    } catch (error) {
      showToast(friendlyError(error));
    }
  };
  const goBack = () => {
    if (isHome) return;
    if (location.pathname.startsWith('/analyzing/')) {
      showToast('已退出等待，服务端会继续分析');
      navigate('/rooms');
      return;
    }
    if (window.history.length > 1) window.history.back(); else navigate('/home');
  };

  return <div className={`site-frame ${isShare || isAdvisor || isCamera ? '' : 'has-tab-bar'} ${isHome ? 'home-shell' : ''} ${isAdvisor ? 'advisor-shell' : ''} ${isCamera ? 'camera-shell' : ''}`}>
    {!isShare && !isHome && <header className="app-header">
      <button className="icon-button" onClick={goBack} aria-label="返回" disabled={isHome}><Icon name="arrow_back" /></button>
      <strong>{isKnowledgeAdvisor ? KNOWLEDGE_ADVISOR_COPY.title : isAdvisor ? ADVISOR_COPY.title : PRODUCT_NAME}</strong>
      <div className="app-header-actions">
        {(isAdvisor || isCamera) && <button className="icon-button" onClick={() => navigate('/home')} aria-label="返回首页"><Icon name="home" filled /></button>}
        <button className="icon-button" onClick={() => setMenuOpen(true)} aria-label={isKnowledgeAdvisor ? '更多' : '检查与隐私'}><Icon name="more_vert" /></button>
      </div>
    </header>}
    {health === 'demo' && <div className="demo-banner" role="status"><Icon name="science" />演示模式：当前展示固定样例结果</div>}
    {!isShare && !isAdvisor && !isCamera && !isProfileEditing && <FlowProgress pathname={location.pathname} />}
    <main ref={mainRef} tabIndex={-1}>
      <Routes>
        <Route path="/home" element={<HomePage />} />
        <Route path="/renovations" element={<RenovationsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/rooms" element={<RoomsPage />} />
        <Route path="/upload/:roomId" element={<UploadPage />} />
        <Route path="/analyzing/:roomId" element={<AnalyzingPage />} />
        <Route path="/result/:roomId" element={<ResultPage />} />
        <Route path="/advisor" element={<KnowledgeAdvisorPage />} />
        <Route path="/advisor/:roomId" element={<AdvisorPage />} />
        <Route path="/advisor-queue/:roomId" element={<AdvisorQueuePage />} />
        <Route path="/risk/:roomId/:riskId" element={<RiskPage />} />
        <Route path="/solutions/:roomId/:riskId" element={<SolutionsPage />} />
        <Route path="/selected-solution/:roomId/:riskId/:solutionId" element={<SelectedSolutionPage />} />
        <Route path="/renovation-preview/:roomId" element={<RenovationPreviewPage />} />
        <Route path="/report" element={<ReportPage />} />
        <Route path="/camera" element={<CameraPage />} />
        <Route path="/my" element={<MyPage />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </main>
    {!isShare && !isAdvisor && !isCamera && <PersistentTabBar pathname={location.pathname} />}
    {!isShare && !isAdvisor && !isCamera && <OnboardingOverlay />}
    {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    {menuOpen && <Modal title={isKnowledgeAdvisor ? '对话与隐私' : '检查与隐私'} close={() => setMenuOpen(false)}>
      {isKnowledgeAdvisor ? <>
        <p>{KNOWLEDGE_ADVISOR_COPY.privacy}</p>
        <button className="button danger full" onClick={() => { setMenuOpen(false); window.dispatchEvent(new Event('anju:new-knowledge-advisor')); }}><Icon name="delete_sweep" />新对话</button>
      </> : <>
        <p>照片仅用于本次居家环境分析。你可以删除这次检查及服务端保存的分析副本。</p>
        <button className="button danger full" disabled={!session} onClick={() => { setMenuOpen(false); setDeleteConfirmOpen(true); }}><Icon name="delete_forever" />删除本次检查</button>
      </>}
    </Modal>}
    {deleteConfirmOpen && <Modal title="确定删除本次检查？" close={() => setDeleteConfirmOpen(false)}>
      <p>所有照片、分析结果和已选改造方案都会从服务端删除，且无法撤销。</p>
      <div className="button-stack"><button className="button danger full" onClick={deleteAssessment}><Icon name="delete_forever" />确认永久删除</button><button className="button quiet full" onClick={() => setDeleteConfirmOpen(false)}>取消</button></div>
    </Modal>}
  </div>;
}

function KnowledgeAdvisorPage() {
  const navigate = useNavigate();
  const {session, setSession, setAssessment, health, capabilities, showToast} = useApp();
  const [bootstrap, setBootstrap] = useState<KnowledgeAdvisorBootstrap | null>(null);
  const [credentials, setCredentials] = useState<StoredKnowledgeAdvisorSession | null>(null);
  const credentialsRef = useRef<StoredKnowledgeAdvisorSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState('');
  const [failedQuestion, setFailedQuestion] = useState('');
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [queueTicket, setQueueTicket] = useState<AdvisorRTCQueueTicket | null>(null);
  const [partialTranscript, setPartialTranscript] = useState('');
  const voiceRef = useRef<AdvisorVoiceRTC | null>(null);
  const queueTicketRef = useRef<AdvisorRTCQueueTicket | null>(null);
  const voiceAbortRef = useRef<AbortController | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const clientInstanceId = useMemo(advisorClientInstanceId, []);

  const appendTurn = useCallback((turn: KnowledgeAdvisorTurn) => {
    setBootstrap(current => current ? {
      ...current,
      turns: current.turns.some(item => item.turn_id === turn.turn_id) ? current.turns : [...current.turns, turn],
    } : current);
  }, []);

  const releaseVoice = useCallback(async () => {
    if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    heartbeatRef.current = null;
    idleTimerRef.current = null;
    voiceAbortRef.current?.abort();
    voiceAbortRef.current = null;
    const voice = voiceRef.current;
    voiceRef.current = null;
    await voice?.disconnect().catch(() => undefined);
    const currentCredentials = credentialsRef.current;
    const ticket = queueTicketRef.current;
    queueTicketRef.current = null;
    setQueueTicket(null);
    setPartialTranscript('');
    setVoiceState('idle');
    if (currentCredentials && ticket) {
      await api.cancelKnowledgeAdvisorRTCQueue(
        currentCredentials.session_id, currentCredentials.access_token, ticket.ticket_id, clientInstanceId,
      ).catch(() => undefined);
    }
  }, [clientInstanceId]);

  const resetVoiceIdleTimer = useCallback(() => {
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      void releaseVoice();
      showToast('语音对话已因 90 秒未操作自动停止');
    }, 90_000);
  }, [releaseVoice, showToast]);

  const persistTranscript = useCallback((value: {role: 'user' | 'assistant'; text: string; final: boolean; eventId: string}) => {
    resetVoiceIdleTimer();
    if (!value.final) {
      setPartialTranscript(value.text);
      return;
    }
    setPartialTranscript('');
    const current = credentialsRef.current;
    if (!current) return;
    void api.knowledgeAdvisorTranscript(current.session_id, current.access_token, {
      role: value.role, text: value.text, provider_event_id: value.eventId,
    }).then(appendTurn).catch(error => showToast(friendlyError(error)));
  }, [appendTurn, resetVoiceIdleTimer, showToast]);

  useEffect(() => {
    if (health === 'loading') return;
    if (capabilities?.knowledge_advisor === false) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    const run = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        let stored = readKnowledgeAdvisorSession();
        let value: KnowledgeAdvisorBootstrap;
        if (stored) {
          try {
            value = await api.getKnowledgeAdvisorSession(stored.session_id, stored.access_token, controller.signal);
            stored = {...stored, expires_at: value.expires_at};
          } catch (error) {
            const code = (error as Error & {code?: string}).code;
            if (!['knowledge_advisor_access_denied', 'knowledge_advisor_session_expired', 'knowledge_advisor_session_not_found'].includes(code || '')) throw error;
            clearKnowledgeAdvisorSession();
            stored = null;
            const created = await api.createKnowledgeAdvisorSession();
            stored = {session_id: created.session_id, access_token: created.access_token, expires_at: created.expires_at};
            value = created;
          }
        } else {
          const created = await api.createKnowledgeAdvisorSession();
          stored = {session_id: created.session_id, access_token: created.access_token, expires_at: created.expires_at};
          value = created;
        }
        if (!active || !stored) return;
        writeKnowledgeAdvisorSession(stored);
        credentialsRef.current = stored;
        setCredentials(stored);
        setBootstrap(value);
      } catch (error) {
        if ((error as Error).name !== 'AbortError' && active) setLoadError(error);
      } finally {
        if (active) setLoading(false);
      }
    };
    void run();
    return () => { active = false; controller.abort(); };
  }, [capabilities?.knowledge_advisor, health, loadVersion]);

  const newConversation = useCallback(async () => {
    await releaseVoice();
    const current = credentialsRef.current;
    if (current) {
      try {
        await api.deleteKnowledgeAdvisorSession(current.session_id, current.access_token);
      } catch (error) {
        const code = (error as Error & {code?: string}).code;
        if (!['knowledge_advisor_access_denied', 'knowledge_advisor_session_expired', 'knowledge_advisor_session_not_found'].includes(code || '')) {
          showToast('旧对话还没有删除，请在网络恢复后重试');
          return;
        }
      }
    }
    clearKnowledgeAdvisorSession();
    credentialsRef.current = null;
    setCredentials(null);
    setBootstrap(null);
    setFailedQuestion('');
    setPendingQuestion('');
    setLoadVersion(value => value + 1);
  }, [releaseVoice, showToast]);

  useEffect(() => {
    const handler = () => { void newConversation(); };
    window.addEventListener('anju:new-knowledge-advisor', handler);
    return () => window.removeEventListener('anju:new-knowledge-advisor', handler);
  }, [newConversation]);

  useEffect(() => {
    const online = () => { if (!bootstrap) setLoadVersion(value => value + 1); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [bootstrap]);

  useEffect(() => {
    const visibility = () => { if (document.visibilityState === 'hidden') void releaseVoice(); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      void releaseVoice();
    };
  }, [releaseVoice]);

  const sendMessage = useCallback(async (question: string) => {
    const clean = question.trim();
    const current = credentialsRef.current;
    if (!clean || !current || busy) return;
    setBusy(true);
    setPendingQuestion(clean);
    setFailedQuestion('');
    setInput('');
    try {
      const value = await api.knowledgeAdvisorMessage(current.session_id, current.access_token, clean);
      appendTurn(value.user_turn);
      appendTurn(value.assistant_turn);
      const updated = {...current, expires_at: value.expires_at};
      credentialsRef.current = updated;
      setCredentials(updated);
      writeKnowledgeAdvisorSession(updated);
    } catch (error) {
      setFailedQuestion(clean);
      showToast(friendlyError(error));
    } finally {
      setPendingQuestion('');
      setBusy(false);
    }
  }, [appendTurn, busy, showToast]);

  const toggleVoice = useCallback(async () => {
    if (voiceState === 'speaking' && voiceRef.current) {
      await voiceRef.current.interrupt().catch(() => undefined);
      resetVoiceIdleTimer();
      return;
    }
    if (voiceRef.current || queueTicketRef.current) {
      await releaseVoice();
      return;
    }
    const current = credentialsRef.current;
    if (!current || !bootstrap?.rtc.available) {
      showToast('实时语音暂不可用，你仍可以输入文字咨询');
      return;
    }
    setVoiceState('connecting');
    const controller = new AbortController();
    voiceAbortRef.current = controller;
    try {
      let ticket = await api.joinKnowledgeAdvisorRTCQueue(current.session_id, current.access_token, clientInstanceId);
      queueTicketRef.current = ticket;
      setQueueTicket(ticket);
      while (ticket.status === 'queued') {
        await new Promise(resolve => window.setTimeout(resolve, ticket.poll_after_ms || 2000));
        if (controller.signal.aborted) return;
        ticket = await api.knowledgeAdvisorRTCQueueStatus(
          current.session_id, current.access_token, ticket.ticket_id, clientInstanceId, controller.signal,
        );
        queueTicketRef.current = ticket;
        setQueueTicket(ticket);
      }
      if (!['granted', 'active'].includes(ticket.status)) throw new Error('advisor_queue_expired');
      const rtc = await api.startKnowledgeAdvisorVoice(
        current.session_id, current.access_token, clientInstanceId, ticket.ticket_id,
      );
      if (!rtc.available) throw new Error('voice_not_configured');
      const voice = new AdvisorVoiceRTC(rtc, {
        onState: state => { setVoiceState(state); if (state !== 'idle' && state !== 'error') resetVoiceIdleTimer(); },
        onTranscript: persistTranscript,
      });
      voiceRef.current = voice;
      await voice.connect({microphone: true});
      resetVoiceIdleTimer();
      heartbeatRef.current = window.setInterval(() => {
        const activeCredentials = credentialsRef.current;
        const activeTicket = queueTicketRef.current;
        if (!activeCredentials || !activeTicket) return;
        void api.heartbeatKnowledgeAdvisorRTCQueue(
          activeCredentials.session_id, activeCredentials.access_token, activeTicket.ticket_id, clientInstanceId,
        ).then(value => { queueTicketRef.current = value; setQueueTicket(value); }).catch(() => void releaseVoice());
      }, 30_000);
    } catch (error) {
      await releaseVoice();
      showToast((error as Error).message.includes('microphone') ? '麦克风权限未开启，已切换为文字咨询' : friendlyError(error));
      setVoiceState('error');
    }
  }, [bootstrap?.rtc.available, clientInstanceId, persistTranscript, releaseVoice, resetVoiceIdleTimer, showToast, voiceState]);

  const startOrContinueCheck = async () => {
    if (session) {
      navigate(`/${isCheckRoute(`/${session.last_route || ''}`) ? session.last_route : 'profile'}`);
      return;
    }
    try {
      const value = await api.createAssessment('photo');
      setSession({assessment_id: value.assessment_id, access_token: value.access_token});
      setAssessment(null);
      navigate('/profile');
    } catch (error) {
      showToast(friendlyError(error));
    }
  };

  if (capabilities?.knowledge_advisor === false) return <section className="page center-state knowledge-advisor-unavailable"><Icon name="smart_toy" className="state-icon" /><h1>AI 助手暂未开放</h1><p>你可以先使用照片或实时相机完成家庭检查。</p><button className="button primary" onClick={() => navigate('/home')}>返回首页</button></section>;
  if (loading && !bootstrap) return <Loading label="正在准备 AI 适老顾问…" />;
  if (loadError && !bootstrap) return <ErrorState error={loadError} retry={() => setLoadVersion(value => value + 1)} />;
  if (!bootstrap || !credentials) return <Loading />;
  const conversationTurns = bootstrap.turns.filter(turn => turn.kind !== 'welcome');
  const latestQuestions = [...conversationTurns].reverse().find(turn => turn.role === 'assistant')?.suggested_questions || bootstrap.quick_prompts;
  const voiceActive = voiceState !== 'idle' && voiceState !== 'error';
  const voiceLabel = queueTicket?.status === 'queued' ? `排队中，前面 ${Math.max(0, queueTicket.position - 1)} 人` : voiceState === 'speaking' ? '正在回答，点击打断' : voiceActive ? '实时语音中，点击停止' : '开始实时语音';

  return <section className="knowledge-advisor-page">
    <div className="knowledge-advisor-scroll">
      <section className="knowledge-welcome" aria-labelledby="knowledge-welcome-title">
        <span className="knowledge-avatar"><Icon name="support_agent" filled /></span>
        <div><small>长者友好家</small><h1 id="knowledge-welcome-title">{KNOWLEDGE_ADVISOR_COPY.welcomeTitle}</h1><p>{KNOWLEDGE_ADVISOR_COPY.introduction}</p><p>{KNOWLEDGE_ADVISOR_COPY.capabilities}</p></div>
      </section>
      <button className="knowledge-check-entry" onClick={() => void startOrContinueCheck()}><Icon name="home_health" filled /><span><b>{session ? '继续上次检查' : '开始家庭检查'}</b><small>通过照片或实时相机了解具体家庭环境</small></span><Icon name="chevron_right" /></button>
      <div className="knowledge-advisor-thread" aria-live="polite" aria-busy={busy}>
        {conversationTurns.map(turn => <article key={turn.turn_id} className={`knowledge-bubble ${turn.role}`}><p>{turn.text}</p><time>{new Date(turn.created_at).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})}</time></article>)}
        {pendingQuestion && <><article className="knowledge-bubble user pending"><p>{pendingQuestion}</p></article><article className="knowledge-bubble assistant thinking" role="status"><span className="typing-dots" aria-label="正在回答"><i /><i /><i /></span><p>正在回答…</p></article></>}
        {partialTranscript && <article className="knowledge-bubble partial"><p>{partialTranscript}</p><span className="typing-dots" aria-label="实时字幕"><i /><i /><i /></span></article>}
        {failedQuestion && <article className="knowledge-message-failed" role="alert"><p>上一个问题没有发送完成。</p><button onClick={() => void sendMessage(failedQuestion)}>重试</button></article>}
      </div>
      {conversationTurns.length === 0 ? <div className="knowledge-prompt-groups" aria-label="快捷问题">{KNOWLEDGE_ADVISOR_COPY.quickPromptGroups.map(group => <section key={group.title}><h2>{group.title}</h2><div className="knowledge-quick-prompts">{group.questions.map(question => <button key={question} disabled={busy} onClick={() => void sendMessage(question)}>{question}</button>)}</div></section>)}</div>
        : <div className="knowledge-quick-prompts" aria-label="继续追问">{latestQuestions.map(question => <button key={question} disabled={busy} onClick={() => void sendMessage(question)}>{question}</button>)}</div>}
    </div>
    <div className="knowledge-advisor-dock">
      {queueTicket?.status === 'queued' && <p className="knowledge-queue-status" role="status">AI 顾问体验人数较多，正在排队…</p>}
      <form className="knowledge-composer" onSubmit={event => { event.preventDefault(); void sendMessage(input); }}>
        <input value={input} maxLength={500} disabled={busy} onChange={event => setInput(event.target.value)} placeholder={KNOWLEDGE_ADVISOR_COPY.inputPlaceholder} aria-label="适老化咨询问题" />
        <button type="submit" className="knowledge-send" disabled={!input.trim() || busy} aria-label="发送"><Icon name="arrow_upward" filled /></button>
        <button type="button" className={`knowledge-mic state-${voiceState}`} onClick={() => void toggleVoice()} aria-label={voiceLabel} title={voiceLabel}><Icon name={voiceState === 'speaking' ? 'front_hand' : voiceActive ? 'stop' : 'mic'} filled /></button>
      </form>
      <p className="knowledge-disclaimer">{KNOWLEDGE_ADVISOR_COPY.disclaimer}</p>
    </div>
  </section>;
}

function AdvisorQueuePage() {
  const {roomId = ''} = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const {session} = useApp();
  const query = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const advisorSessionId = query.get('session_id') || '';
  const mode = query.get('mode') === 'audio_video' ? 'audio_video' : 'audio';
  const returnTo = useMemo(() => {
    const fallback = mode === 'audio_video'
      ? `/camera?room_id=${encodeURIComponent(roomId)}`
      : `/advisor/${roomId}`;
    const requested = query.get('return_to') || '';
    const sameRoomCamera = requested.startsWith(`/camera?room_id=${encodeURIComponent(roomId)}`);
    const sameRoomAdvisor = requested === `/advisor/${roomId}` || requested.startsWith(`/advisor/${roomId}?`);
    return sameRoomCamera || sameRoomAdvisor ? requested : fallback;
  }, [mode, query, roomId]);
  const clientInstanceId = useMemo(advisorClientInstanceId, []);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [ticketId, setTicketId] = useState('');

  useEffect(() => {
    if (!session || !roomId || !advisorSessionId) return;
    const controller = new AbortController();
    let timer: number | null = null;
    const enter = (value: Awaited<ReturnType<typeof api.joinAdvisorRTCQueue>>) => {
      if (value.status === 'unavailable') {
        navigate(returnTo, {replace: true});
        return true;
      }
      saveAdvisorRTCTicket(roomId, advisorSessionId, clientInstanceId, mode, value);
      setTicketId(value.ticket_id);
      setPosition(value.position);
      if (value.status === 'granted' || value.status === 'active') {
        navigate(returnTo, {replace: true});
        return true;
      }
      return false;
    };
    const run = async () => {
      try {
        let current = readAdvisorRTCTicket(roomId, mode);
        if (!current || current.advisor_session_id !== advisorSessionId) {
          const joined = await api.joinAdvisorRTCQueue(roomId, advisorSessionId, clientInstanceId, mode);
          if (enter(joined)) return;
          current = readAdvisorRTCTicket(roomId, mode);
        }
        if (!current) return;
        const poll = async () => {
          try {
            const value = await api.advisorRTCQueueStatus(
              roomId, advisorSessionId, current!.ticket_id, clientInstanceId, controller.signal,
            );
            if (enter(value)) return;
            timer = window.setTimeout(poll, value.poll_after_ms || 2_000);
          } catch (value) {
            if ((value as Error).name === 'AbortError') return;
            clearAdvisorRTCTicket(roomId, mode);
            setError(value);
          }
        };
        timer = window.setTimeout(poll, current.poll_after_ms || 2_000);
      } catch (value) { setError(value); }
    };
    void run();
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [advisorSessionId, clientInstanceId, mode, navigate, returnTo, roomId, session?.assessment_id]);

  const cancel = async () => {
    const stored = readAdvisorRTCTicket(roomId, mode);
    try {
      if (stored) await api.cancelAdvisorRTCQueue(
        roomId, advisorSessionId, stored.ticket_id, clientInstanceId,
      );
    } catch { /* The local ticket is still discarded. */ }
    clearAdvisorRTCTicket(roomId, mode);
    navigate(returnTo, {replace: true});
  };

  if (!session) return <Navigate to="/home" replace />;
  if (!advisorSessionId) return <Navigate to={returnTo} replace />;
  return <section className="page advisor-queue-page">
    <div className="advisor-queue-orbit" aria-hidden="true"><Icon name="support_agent" filled /></div>
    <small className="eyebrow">AI 适老顾问</small>
    <h1>AI 顾问体验人数较多，正在排队，请稍候。</h1>
    {error
      ? <p role="alert">{friendlyError(error)}</p>
      : <p role="status" aria-live="polite">{position > 0 ? `当前前方 ${position - 1} 位` : '正在分配实时席位…'}</p>}
    <p className="fine-print">获得席位后会自动继续；排队最长保留 3 分钟。</p>
    <div className="button-stack">
      {Boolean(error) && <button className="button primary full" onClick={() => window.location.reload()}>重新排队</button>}
      <button className="button quiet full" onClick={() => void cancel()}>{ticketId ? '取消排队' : '返回'}</button>
    </div>
  </section>;
}

function CameraIntroModal({close, enter}: {close: () => void; enter: () => void}) {
  return <Modal title={CAMERA_COPY.invitationTitle} close={close}>
    <p>{CAMERA_COPY.invitationBody}</p>
    <p className="fine-print"><Icon name="privacy_tip" />{CAMERA_COPY.privacy}</p>
    <p className="fine-print">{CAMERA_COPY.reportTip}</p>
    <div className="button-stack"><button className="button primary full" onClick={enter}><Icon name="photo_camera" />{CAMERA_COPY.enter}</button><button className="button quiet full" onClick={close}>暂不进入</button></div>
  </Modal>;
}

function CameraLaunchModal({close}: {close: () => void}) {
  const navigate = useNavigate();
  const {session, setSession, showToast} = useApp();
  const onboarding = useOnboarding();
  const [choosingRoom, setChoosingRoom] = useState(false);
  const [busyRoom, setBusyRoom] = useState<RoomType | null>(null);
  const enterRoom = async (roomType: RoomType) => {
    setBusyRoom(roomType);
    try {
      let currentSession = session;
      if (!currentSession) {
        const created = await api.createAssessment('photo');
        currentSession = {assessment_id: created.assessment_id, access_token: created.access_token};
        setSession(currentSession);
      }
      const assessment = await api.getAssessment();
      const room = assessment.rooms.find(item => item.room_type === roomType && item.status !== 'completed') || await api.createRoom(roomType);
      if (onboarding.active) {
        if (!onboarding.state.phase_status.home) onboarding.completePhase('home', 'capture');
        else onboarding.enterPhase('capture');
      }
      close();
      navigate(`/camera?room_id=${encodeURIComponent(room.room_id)}&auto_start=1`);
    } catch (error) {
      showToast(friendlyError(error));
      setBusyRoom(null);
    }
  };
  if (!choosingRoom) return <CameraIntroModal close={close} enter={() => setChoosingRoom(true)} />;
  return <Modal title="选择本次实时检查的房间" close={close}>
    <p>房型只用于调整拍摄提示；临时建议不会直接进入评分。</p>
    <div className="room-grid camera-room-grid">{(Object.keys(ROOM_COPY) as RoomType[]).map(roomType => {
      const copy = ROOM_COPY[roomType];
      return <button key={roomType} className="room-card" disabled={busyRoom !== null} onClick={() => enterRoom(roomType)}><Icon name={copy.icon} filled /><span><b>{copy.name}</b><small>{busyRoom === roomType ? '正在准备…' : '进入实时相机'}</small></span></button>;
    })}</div>
  </Modal>;
}

function PersistentTabBar({pathname}: {pathname: string}) {
  const navigate = useNavigate();
  const homeActive = /^\/(home|profile|rooms|upload(?:\/|$)|analyzing(?:\/|$))/.test(pathname);
  const renovationActive = /^\/(renovations|result(?:\/|$)|risk(?:\/|$)|solutions(?:\/|$)|selected-solution(?:\/|$)|renovation-preview(?:\/|$)|report(?:\/|$))/.test(pathname);
  const myActive = pathname === '/my';
  return <nav className="persistent-tab-bar three-tabs" aria-label="主导航">
    <button className={homeActive ? 'active' : ''} aria-current={homeActive ? 'page' : undefined} onClick={() => !homeActive && navigate('/home')}><Icon name="home" filled={homeActive} /><span>首页</span></button>
    <button className={renovationActive ? 'active' : ''} aria-current={renovationActive ? 'page' : undefined} onClick={() => !renovationActive && navigate('/renovations')}><Icon name="handyman" filled={renovationActive} /><span>改造方案</span></button>
    <button className={myActive ? 'active' : ''} aria-current={myActive ? 'page' : undefined} onClick={() => !myActive && navigate('/my')}><Icon name="person" filled={myActive} /><span>我的</span></button>
  </nav>;
}

function CameraPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const {session, setSession, showToast} = useApp();
  const onboarding = useOnboarding();
  const assessmentState = useAssessment();
  const cameraQuery = new URLSearchParams(location.search);
  const roomId = cameraQuery.get('room_id') || '';
  const shouldAutoStartNative = cameraQuery.get('auto_start') === '1';
  const room = assessmentState.assessment?.rooms.find(item => item.room_id === roomId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const acceptedRef = useRef<{blob: Blob; width: number; height: number; sourceId: string; hash: string} | null>(null);
  const stableFramesRef = useRef(new Map<string, {
    frameId: string; blob: Blob; width: number; height: number; hash: string;
    capturedAtMs: number; brightness: number; sharpness: number; motion: number;
    pinned: boolean; confidence: number; groupId?: number; inspectionId?: string;
  }>());
  const inspectionGroupsRef = useRef(new Map<string, number>());
  const rtcFallbackRef = useRef(false);
  const suggestionsRef = useRef<CameraSuggestion[]>([]);
  const overlayTimerRef = useRef<number | null>(null);
  const overlayPreviewUrlRef = useRef<string | null>(null);
  const requestSequenceRef = useRef(0);
  const nativeRequestRef = useRef<string | null>(null);
  const pendingCompletionRef = useRef<{cameraSessionId: string; mediaIds: string[]} | null>(null);
  const nativeAutoStartHandledRef = useRef(false);
  const cameraSessionRef = useRef<string | null>(null);
  const advisorRef = useRef<AdvisorBootstrap | null>(null);
  const setupPromiseRef = useRef<Promise<{cameraSessionId: string; advisor: AdvisorBootstrap}> | null>(null);
  const voiceRef = useRef<AdvisorVoiceRTC | null>(null);
  const voiceIdleTimerRef = useRef<number | null>(null);
  const rtcTicketRef = useRef(readAdvisorRTCTicket(roomId, 'audio_video'));
  const rtcHeartbeatRef = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('相机尚未开启');
  const [suggestions, setSuggestions] = useState<CameraSuggestion[]>([]);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState('');
  const [overlaySuggestion, setOverlaySuggestion] = useState<CameraSuggestion | null>(null);
  const [overlayFrame, setOverlayFrame] = useState<{frameId: string; imageUrl: string; width: number; height: number; suggestions: NumberedCameraSuggestion[]} | null>(null);
  const [mirrored, setMirrored] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nativePending, setNativePending] = useState(false);
  const [hasRepresentative, setHasRepresentative] = useState(false);
  const [completionError, setCompletionError] = useState('');
  const [advisor, setAdvisor] = useState<AdvisorBootstrap | null>(null);
  const [advisorTurns, setAdvisorTurns] = useState<AdvisorTurn[]>([]);
  const [advisorOpen, setAdvisorOpen] = useState(false);
  const [advisorInput, setAdvisorInput] = useState('');
  const [advisorBusy, setAdvisorBusy] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [rtcFallback, setRtcFallback] = useState(false);

  const appendAdvisorTurns = useCallback((...incoming: AdvisorTurn[]) => {
    setAdvisorTurns(current => {
      const known = new Set(current.map(turn => turn.turn_id));
      return [...current, ...incoming.filter(turn => !known.has(turn.turn_id))];
    });
  }, []);

  const prepareScanSession = useCallback(async () => {
    if (!roomId) throw new Error('没有找到这个房间');
    if (cameraSessionRef.current && advisorRef.current) return {cameraSessionId: cameraSessionRef.current, advisor: advisorRef.current};
    if (!setupPromiseRef.current) {
      setupPromiseRef.current = (async () => {
        const camera = await api.createCameraSession(roomId);
        cameraSessionRef.current = camera.camera_session_id;
        const value = await api.createAdvisorSession(roomId, {
          camera_session_id: camera.camera_session_id,
          context_refs: {room_id: roomId, camera_session_id: camera.camera_session_id},
        });
        advisorRef.current = value;
        setAdvisor(value);
        setAdvisorTurns(value.turns);
        return {cameraSessionId: camera.camera_session_id, advisor: value};
      })().catch(error => {
        setupPromiseRef.current = null;
        throw error;
      });
    }
    return setupPromiseRef.current;
  }, [roomId]);

  const clearOverlay = useCallback(() => {
    if (overlayTimerRef.current !== null) window.clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = null;
    if (overlayPreviewUrlRef.current) URL.revokeObjectURL(overlayPreviewUrlRef.current);
    overlayPreviewUrlRef.current = null;
    setOverlaySuggestion(null);
    setOverlayFrame(null);
  }, []);

  const showOverlay = useCallback((items: CameraSuggestion[], frameId: string, blob: Blob, width: number, height: number, firstNumber: number) => {
    const suggestion = [...items].sort((left, right) => Number(left.possible_repeat) - Number(right.possible_repeat) || right.confidence - left.confidence)[0];
    if (!suggestion) return;
    if (overlayTimerRef.current !== null) window.clearTimeout(overlayTimerRef.current);
    if (overlayPreviewUrlRef.current) URL.revokeObjectURL(overlayPreviewUrlRef.current);
    overlayPreviewUrlRef.current = null;
    setOverlaySuggestion(suggestion);
    const located = items.flatMap((item, index) => item.region ? [{suggestion: item, number: firstNumber + index}] : []);
    if (located.length) {
      const imageUrl = URL.createObjectURL(blob);
      overlayPreviewUrlRef.current = imageUrl;
      setOverlayFrame({frameId, imageUrl, width, height, suggestions: located});
    } else setOverlayFrame(null);
    overlayTimerRef.current = window.setTimeout(clearOverlay, 3_000);
  }, [clearOverlay]);

  const stopCamera = useCallback(() => {
    requestSequenceRef.current += 1;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    clearOverlay();
    setMirrored(false);
    setActive(false);
    setStatus('相机已关闭');
  }, [clearOverlay]);

  const stopVoice = useCallback(async () => {
    if (voiceIdleTimerRef.current !== null) window.clearTimeout(voiceIdleTimerRef.current);
    voiceIdleTimerRef.current = null;
    if (rtcHeartbeatRef.current !== null) window.clearInterval(rtcHeartbeatRef.current);
    rtcHeartbeatRef.current = null;
    await voiceRef.current?.disconnect();
    voiceRef.current = null;
    const ticket = rtcTicketRef.current;
    rtcTicketRef.current = null;
    if (ticket) {
      await api.cancelAdvisorRTCQueue(
        roomId, ticket.advisor_session_id, ticket.ticket_id, ticket.client_instance_id,
      ).catch(() => undefined);
      clearAdvisorRTCTicket(roomId, ticket.mode);
    }
    setVoiceState('idle');
    setPartialTranscript('');
  }, [roomId]);

  const startQueueHeartbeat = useCallback((ticket: NonNullable<typeof rtcTicketRef.current>) => {
    if (rtcHeartbeatRef.current !== null) window.clearInterval(rtcHeartbeatRef.current);
    rtcHeartbeatRef.current = window.setInterval(() => {
      void api.heartbeatAdvisorRTCQueue(
        roomId, ticket.advisor_session_id, ticket.ticket_id, ticket.client_instance_id,
      ).then(value => {
        rtcTicketRef.current = saveAdvisorRTCTicket(
          roomId, ticket.advisor_session_id, ticket.client_instance_id, ticket.mode, value,
        );
      }).catch(() => {
        if (rtcHeartbeatRef.current !== null) window.clearInterval(rtcHeartbeatRef.current);
        rtcHeartbeatRef.current = null;
      });
    }, 20_000);
  }, [roomId]);

  const resetVoiceIdleTimer = useCallback(() => {
    if (voiceIdleTimerRef.current !== null) window.clearTimeout(voiceIdleTimerRef.current);
    voiceIdleTimerRef.current = window.setTimeout(() => {
      void voiceRef.current?.disableMicrophone();
      setVoiceState('idle');
      showToast('90 秒未操作，已自动停止语音监听');
    }, 90_000);
  }, [showToast]);

  const scanContextRefs = useCallback((): AdvisorContextRef => {
    const selected = suggestionsRef.current.find(item => item.suggestion_id === selectedSuggestionId);
    return {
      room_id: roomId,
      ...(cameraSessionRef.current ? {camera_session_id: cameraSessionRef.current} : {}),
      ...(selected ? {camera_suggestion_id: selected.suggestion_id, ...(selected.frame_id ? {frame_id: selected.frame_id} : {})} : {}),
    };
  }, [roomId, selectedSuggestionId]);

  const sendScanMessage = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || advisorBusy) return;
    setAdvisorBusy(true);
    setAdvisorOpen(true);
    try {
      const prepared = advisorRef.current ? {advisor: advisorRef.current} : await prepareScanSession();
      const value = await api.advisorMessage(roomId, prepared.advisor.session_id, clean, scanContextRefs());
      appendAdvisorTurns(value.user_turn, value.assistant_turn);
      setAdvisorInput('');
      if (voiceRef.current) resetVoiceIdleTimer();
    } catch (error) { showToast(friendlyError(error)); }
    finally { setAdvisorBusy(false); }
  }, [advisorBusy, appendAdvisorTurns, prepareScanSession, resetVoiceIdleTimer, roomId, scanContextRefs, showToast]);

  const toggleScanVoice = useCallback(async () => {
    const prepared = advisorRef.current ? {advisor: advisorRef.current} : await prepareScanSession();
    if (voiceState === 'speaking') { await voiceRef.current?.interrupt(); return; }
    if (voiceRef.current?.isConnected) {
      if (voiceRef.current.isMicrophoneEnabled) {
        await voiceRef.current.disableMicrophone();
        if (voiceIdleTimerRef.current !== null) window.clearTimeout(voiceIdleTimerRef.current);
        voiceIdleTimerRef.current = null;
      } else {
        try { await voiceRef.current.enableMicrophone(); resetVoiceIdleTimer(); }
        catch (error) {
          setVoiceState('error');
          showToast((error as Error).message === 'microphone_denied' ? '麦克风权限未开启，已切换到文字输入' : '实时语音无法连接，可继续文字咨询');
        }
      }
      setAdvisorOpen(true);
      return;
    }
    let rtc = prepared.advisor.rtc;
    if (!rtc.available) { setVoiceState('error'); showToast('实时语音尚未配置，可以继续使用文字咨询'); setAdvisorOpen(true); return; }
    let ticket = rtcTicketRef.current || readAdvisorRTCTicket(roomId, 'audio');
    if (!ticket || ticket.advisor_session_id !== prepared.advisor.session_id) {
      try {
        const joined = await api.joinAdvisorRTCQueue(
          roomId, prepared.advisor.session_id, advisorClientInstanceId(), 'audio',
        );
        if (joined.status === 'unavailable') {
          setVoiceState('error'); showToast('实时语音尚未配置，可以继续使用文字咨询'); return;
        }
        ticket = saveAdvisorRTCTicket(
          roomId, prepared.advisor.session_id, advisorClientInstanceId(), 'audio', joined,
        );
      } catch (error) { showToast(friendlyError(error)); return; }
    }
    if (ticket.status === 'queued') {
      navigate(
        `/advisor-queue/${roomId}?session_id=${encodeURIComponent(prepared.advisor.session_id)}`
        + `&mode=audio&return_to=${encodeURIComponent(`/camera?room_id=${encodeURIComponent(roomId)}`)}`,
      );
      return;
    }
    rtcTicketRef.current = ticket;
    if (rtc.requires_start || !rtc.token) {
      try {
        rtc = await api.startAdvisorVoice(
          roomId, prepared.advisor.session_id, ticket.client_instance_id, ticket.ticket_id,
        );
        const updated = {...prepared.advisor, rtc};
        advisorRef.current = updated;
        setAdvisor(updated);
      } catch (error) {
        await stopVoice();
        setVoiceState('error');
        showToast(friendlyError(error));
        return;
      }
    }
    const voice = new AdvisorVoiceRTC(rtc, {
      onState: setVoiceState,
      onPlaybackBlocked: () => showToast('浏览器已暂停顾问声音，点击页面任意位置即可恢复'),
      onTranscript: value => {
        resetVoiceIdleTimer();
        setPartialTranscript(value.final ? '' : value.text);
        if (value.final && value.role === 'user') void sendScanMessage(value.text);
      },
    });
    voiceRef.current = voice;
    setAdvisorOpen(true);
    try { await voice.connect({microphone: true}); startQueueHeartbeat(ticket); resetVoiceIdleTimer(); }
    catch (error) {
      await stopVoice();
      setVoiceState('error');
      showToast((error as Error).message === 'microphone_denied' ? '麦克风权限未开启，已切换到文字输入' : '实时语音无法连接，可继续文字咨询');
    }
  }, [navigate, prepareScanSession, resetVoiceIdleTimer, roomId, sendScanMessage, showToast, startQueueHeartbeat, stopVoice, voiceState]);

  const endAdvisorSession = useCallback(async () => {
    await stopVoice();
    const value = advisorRef.current;
    if (!value) return;
    try { await api.endAdvisorSession(roomId, value.session_id); } catch { /* Analysis must not be blocked by RTC cleanup. */ }
    advisorRef.current = null;
  }, [roomId, stopVoice]);

  const completeScan = useCallback(async (cameraSessionId: string, mediaIds: string[]) => {
    pendingCompletionRef.current = {cameraSessionId, mediaIds};
    setSaving(true);
    setCompletionError('');
    try {
      await api.completeCameraSession(roomId, cameraSessionId, mediaIds);
    } catch (error) {
      setCompletionError('代表画面已上传，但扫描记录尚未完成，请重试保存。');
      showToast(friendlyError(error));
      setSaving(false);
      return;
    }
    pendingCompletionRef.current = null;
    showToast(`已保存 ${mediaIds.length} 张代表画面，可确认后开始 AI 检查`);
    if (onboarding.active) onboarding.completePhase('capture', 'analyze');
    assessmentState.reload();
    await endAdvisorSession().catch(() => undefined);
    setSaving(false);
    navigate(`/upload/${roomId}`);
  }, [assessmentState, endAdvisorSession, navigate, onboarding, roomId, showToast]);

  useEffect(() => {
    if (!session || !room) return;
    void prepareScanSession().catch(error => showToast(friendlyError(error)));
  }, [prepareScanSession, room?.room_id, session?.assessment_id, showToast]);

  useEffect(() => {
    const events = advisor?.events;
    if (!advisor || !events?.websocket_path || !events.token || nativeCapability('live_scan')) return;
    return subscribeAdvisorEvents({roomId, sessionId: advisor.session_id, initial: events, onMessage: event => {
      const value = parseAdvisorEvent(event.data);
      if (value?.type === 'turn' && value.turn?.turn_id) appendAdvisorTurns(value.turn);
      if (value?.type === 'camera_suggestion_added' && value.suggestion?.suggestion_id) {
        const suggestion = value.suggestion;
        if (!suggestionsRef.current.some(item => item.suggestion_id === suggestion.suggestion_id)) {
          const firstNumber = suggestionsRef.current.length + 1;
          suggestionsRef.current = [...suggestionsRef.current, suggestion];
          setSuggestions(suggestionsRef.current);
          const frame = suggestion.frame_id ? stableFramesRef.current.get(suggestion.frame_id) : undefined;
          if (frame && value.inspection_id && frame.inspectionId === value.inspection_id) {
            frame.pinned = true;
            frame.confidence = Math.max(frame.confidence, suggestion.confidence);
            showOverlay([suggestion], frame.frameId, frame.blob, frame.width, frame.height, firstNumber);
          }
          setStatus(`发现 ${suggestionsRef.current.length} 条待确认提示`);
        }
      }
      if (value?.type === 'inspection_state' && value.inspection_id && ['suggested', 'inspected', 'expired'].includes(value.status || '')) {
        const groupId = inspectionGroupsRef.current.get(value.inspection_id);
        if (groupId !== undefined) {
          inspectionGroupsRef.current.delete(value.inspection_id);
          void voiceRef.current?.deleteInspectionImage(groupId).catch(() => undefined);
        }
      }
    }});
  }, [advisor?.events, advisor?.session_id, appendAdvisorTurns, roomId, showOverlay]);

  useEffect(() => {
    const visibility = () => { if (document.visibilityState !== 'visible') { stopCamera(); void stopVoice(); } };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      stopCamera();
      void stopVoice();
    };
  }, [stopCamera, stopVoice]);

  useEffect(() => {
    const receive = (event: Event) => {
      const result = (event as CustomEvent<unknown>).detail;
      if (!isNativeCaptureResult(result) || result.request_id !== nativeRequestRef.current || result.room_id !== roomId) return;
      void (async () => {
        nativeRequestRef.current = null;
        setNativePending(false);
        if (result.status === 'cancelled') {
          setStatus('已取消本次扫描');
          await endAdvisorSession();
          return;
        }
        if (result.uploaded_media_ids.length) {
          const cameraSessionId = result.camera_session_id || cameraSessionRef.current;
          if (!cameraSessionId) throw new Error('本次扫描已失效，请重试');
          const failed = result.failed_count ? `，${result.failed_count} 张未上传` : '';
          showToast(`已保存 ${result.uploaded_media_ids.length} 张代表画面${failed}`);
          await completeScan(cameraSessionId, result.uploaded_media_ids);
        } else {
          await endAdvisorSession();
          setStatus(result.error_code ? '本次扫描没有完成，请重试' : '本次没有保存可用画面');
        }
      })().catch(error => showToast(friendlyError(error)));
    };
    window.addEventListener(NATIVE_CAPTURE_RESULT_EVENT, receive);
    return () => window.removeEventListener(NATIVE_CAPTURE_RESULT_EVENT, receive);
  }, [completeScan, endAdvisorSession, roomId, showToast]);

  const startCamera = async () => {
    if (!session || !room) { showToast('请先选择本次检查的房间'); return; }
    let prepared: {cameraSessionId: string; advisor: AdvisorBootstrap};
    try { prepared = await prepareScanSession(); }
    catch (error) { showToast(friendlyError(error)); return; }
    const clientInstanceId = advisorClientInstanceId();
    let rtcTicket = readAdvisorRTCTicket(roomId, 'audio_video');
    if (rtcTicket && rtcTicket.advisor_session_id !== prepared.advisor.session_id) {
      clearAdvisorRTCTicket(roomId, 'audio_video');
      rtcTicket = null;
    }
    if (prepared.advisor.rtc.available && !rtcTicket) {
      try {
        const joined = await api.joinAdvisorRTCQueue(
          roomId, prepared.advisor.session_id, clientInstanceId, 'audio_video',
        );
        if (joined.status !== 'unavailable') {
          rtcTicket = saveAdvisorRTCTicket(
            roomId, prepared.advisor.session_id, clientInstanceId, 'audio_video', joined,
          );
        }
      } catch (error) { showToast(friendlyError(error)); return; }
    }
    if (rtcTicket?.status === 'queued') {
      const returnPath = `/camera?room_id=${encodeURIComponent(roomId)}${nativeCapability('live_scan') ? '&auto_start=1' : ''}`;
      navigate(
        `/advisor-queue/${roomId}?session_id=${encodeURIComponent(prepared.advisor.session_id)}`
        + `&mode=audio_video&return_to=${encodeURIComponent(returnPath)}`,
      );
      return;
    }
    if (rtcTicket) rtcTicketRef.current = rtcTicket;
    if (nativeCapability('live_scan')) {
      const remainingSlots = Math.max(0, 6 - room.media.length);
      if (!remainingSlots) { await stopVoice(); showToast('该房间已有 6 张照片，请删除后再扫描'); return; }
      const requestId = nativeRequestId();
      const started = invokeNative('start_live_scan', {
        request_id: requestId, assessment_id: session.assessment_id, access_token: session.access_token,
        room_id: room.room_id, room_type: room.room_type, remaining_slots: remainingSlots,
        camera_session_id: prepared.cameraSessionId, advisor_session_id: prepared.advisor.session_id,
        advisor_events: prepared.advisor.events,
        advisor_client_instance_id: rtcTicket?.client_instance_id,
        advisor_queue_ticket_id: rtcTicket?.ticket_id,
      });
      if (started) {
        if (rtcTicket && nativeCapability('advisor_rtc_lease')) {
          if (rtcHeartbeatRef.current !== null) window.clearInterval(rtcHeartbeatRef.current);
          rtcHeartbeatRef.current = null;
          rtcTicketRef.current = null;
          clearAdvisorRTCTicket(roomId, rtcTicket.mode);
          void api.analytics('advisor_rtc_lease_transferred', roomId, {holder: 'ios_native'}).catch(() => undefined);
        } else if (rtcTicket) startQueueHeartbeat(rtcTicket);
        nativeRequestRef.current = requestId;
        setNativePending(true);
        setStatus('原生实时相机已打开；结束后会保存代表画面');
      } else {
        await stopVoice();
        showToast('无法打开原生相机，请重试');
      }
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) { await stopVoice(); showToast('当前浏览器不支持网页相机，请改用照片'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: 'environment'}, width: {ideal: 1280}, height: {ideal: 720}}, audio: false});
      streamRef.current = stream;
      const videoTrack = stream.getVideoTracks?.()[0];
      setMirrored(videoTrack?.getSettings?.().facingMode === 'user');
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      setActive(true);
      setStatus('正在连接实时视觉顾问…');
      rtcFallbackRef.current = false;
      setRtcFallback(false);
      let rtc = prepared.advisor.rtc;
      if (rtc.available && (rtc.requires_start || !rtc.token || rtc.media_mode !== 'audio_video')) {
        try {
          if (!rtcTicket) throw new Error('advisor_queue_required');
          rtc = await api.startAdvisorRealtime(
            roomId, prepared.advisor.session_id,
            rtcTicket.client_instance_id, rtcTicket.ticket_id,
          );
          startQueueHeartbeat(rtcTicket);
          const updated = {...prepared.advisor, rtc};
          advisorRef.current = updated;
          setAdvisor(updated);
        } catch {
          rtc = {...rtc, available: false, video_available: false, reason: 'provider_unavailable'};
        }
      }
      if (!rtc.available || !rtc.video_available || !videoTrack) {
        await stopVoice();
        rtcFallbackRef.current = true;
        setRtcFallback(true);
        setStatus('实时视频暂不可用，已切换到兼容检查模式');
        return;
      }
      const voice = new AdvisorVoiceRTC(rtc, {
        onState: state => {
          if (state !== 'idle' || voiceRef.current?.isMicrophoneEnabled) setVoiceState(state);
        },
        onPlaybackBlocked: () => showToast('浏览器已暂停顾问声音，点击页面任意位置即可恢复'),
        onTranscript: value => {
          resetVoiceIdleTimer();
          setPartialTranscript(value.final ? '' : value.text);
          if (value.final && value.role === 'user') void sendScanMessage(value.text);
        },
      });
      voiceRef.current = voice;
      try {
        await voice.connect({videoTrack, microphone: false});
        setStatus('实时顾问已看到画面，请缓慢移动并拍清通道和地面');
      } catch {
        await voice.disconnect().catch(() => undefined);
        if (voiceRef.current === voice) voiceRef.current = null;
        await stopVoice();
        rtcFallbackRef.current = true;
        setRtcFallback(true);
        setStatus('实时视频连接失败，已切换到兼容检查模式');
      }
    } catch (error) {
      stopCamera();
      await stopVoice();
      const copy = (error as Error).name === 'NotAllowedError' ? '没有获得相机权限，请在浏览器设置中允许或改用照片' : '相机无法开启，请改用照片';
      setStatus(copy);
      showToast(copy);
    }
  };

  useEffect(() => {
    if (!shouldAutoStartNative || nativeAutoStartHandledRef.current || !session || !room || !nativeCapability('live_scan')) return;
    nativeAutoStartHandledRef.current = true;
    void startCamera();
  }, [room?.room_id, session?.assessment_id, shouldAutoStartNative]);

  useEffect(() => {
    if (!active || !session) return;
    let cancelled = false;
    let inflight = false;
    let previousHash = '';
    let submittedHash = '';
    let calls = 0;
    let failures = 0;
    let nextAllowedAt = 0;
    const controller = new AbortController();

    const retainFrame = (frame: {
      frameId: string; blob: Blob; width: number; height: number; hash: string;
      capturedAtMs: number; brightness: number; sharpness: number; motion: number;
      pinned: boolean; confidence: number;
    }) => {
      stableFramesRef.current.set(frame.frameId, frame);
      const removable = () => [...stableFramesRef.current.values()]
        .filter(item => !item.pinned)
        .sort((left, right) => left.capturedAtMs - right.capturedAtMs)[0];
      let totalBytes = [...stableFramesRef.current.values()].reduce((sum, item) => sum + item.blob.size, 0);
      while (stableFramesRef.current.size > 8 || totalBytes > 24 * 1024 * 1024) {
        const oldest = removable();
        if (!oldest) break;
        stableFramesRef.current.delete(oldest.frameId);
        totalBytes -= oldest.blob.size;
      }
      acceptedRef.current = {blob: frame.blob, width: frame.width, height: frame.height, sourceId: frame.frameId, hash: frame.hash};
      setHasRepresentative(stableFramesRef.current.size > 0);
    };

    const addFallbackSuggestions = (items: CameraSuggestion[], frameId: string, blob: Blob, width: number, height: number) => {
      const fresh = items.filter(item => !suggestionsRef.current.some(current => current.suggestion_id === item.suggestion_id));
      if (!fresh.length) { clearOverlay(); return; }
      const firstNumber = suggestionsRef.current.length + 1;
      suggestionsRef.current = [...suggestionsRef.current, ...fresh];
      setSuggestions(suggestionsRef.current);
      const frame = stableFramesRef.current.get(frameId);
      if (frame) {
        frame.pinned = true;
        frame.confidence = Math.max(frame.confidence, ...fresh.map(item => item.confidence));
      }
      showOverlay(fresh, frameId, blob, width, height, firstNumber);
    };

    const inspect = async () => {
      const video = videoRef.current;
      if (cancelled || inflight || document.visibilityState !== 'visible' || !video || video.readyState < 2 || calls >= 30 || Date.now() < nextAllowedAt) return;
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
      if (!context) return;
      context.drawImage(video, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      const local = inspectPixels(pixels.data, width, height);
      const motionBits = previousHash ? hammingDistance(local.hash, previousHash) : 0;
      previousHash = local.hash;
      const motion = Math.min(1, motionBits / 64);
      if (local.brightness < 28 || local.brightness > 232) { clearOverlay(); setStatus('画面过暗或过亮，请调整角度后重试'); return; }
      if (local.sharpness < 5 || motion > .48) { clearOverlay(); setStatus('请放慢移动，并让通道和地面保持清晰'); return; }
      if (submittedHash && hammingDistance(local.hash, submittedHash) < 6) { setStatus('画面变化较小，继续缓慢移动相机'); return; }
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
      if (!blob || cancelled) return;
      const frameId = globalThis.crypto?.randomUUID?.() || `camera-${Date.now()}`;
      const capturedAtMs = Date.now();
      retainFrame({
        frameId, blob, width, height, hash: local.hash, capturedAtMs,
        brightness: local.brightness, sharpness: local.sharpness, motion,
        pinned: false, confidence: 0,
      });
      const requestSequence = ++requestSequenceRef.current;
      inflight = true; calls += 1; setStatus('正在理解当前画面…');
      try {
        if (!rtcFallbackRef.current && voiceRef.current?.isConnected && cameraSessionRef.current) {
          const prepared = await api.prepareCameraInspection(roomId, cameraSessionRef.current, {
            frame_id: frameId, captured_at_ms: capturedAtMs, width, height, orientation: 'up',
            perceptual_hash: local.hash,
            quality: {brightness: local.brightness, sharpness: local.sharpness, motion},
          });
          if (cancelled || requestSequence !== requestSequenceRef.current) return;
          const frame = stableFramesRef.current.get(frameId);
          if (frame) {
            frame.groupId = prepared.group_id;
            frame.inspectionId = prepared.inspection_id;
          }
          inspectionGroupsRef.current.set(prepared.inspection_id, prepared.group_id);
          await voiceRef.current.sendInspectionImage(prepared, blob);
          submittedHash = local.hash;
          setStatus('已送达稳定画面，顾问正在判断…');
        } else {
          const previousSummary = [...new Set(suggestionsRef.current.map(item => item.risk_code))].slice(-5);
          const result = await api.inspectCamera(roomId, blob, width, height, {
            frame_id: frameId, previous_summary: previousSummary, source_kind: 'h5_camera_frame',
            orientation: 'up', camera_session_id: cameraSessionRef.current || undefined,
          }, controller.signal);
          if (cancelled || requestSequence !== requestSequenceRef.current) return;
          submittedHash = local.hash;
          if (!result.quality_usable) {
            setStatus('这张画面暂时不适合检查，请放慢移动并拍清地面和通道');
            return;
          }
          const located = result.suggestions.map(item => ({...item, frame_id: result.frame_id}));
          addFallbackSuggestions(located, result.frame_id, blob, width, height);
          setStatus(located.length ? `发现 ${located.length} 条待确认提示` : '当前画面没有可靠提示，请继续检查其他角度');
        }
        failures = 0;
        nextAllowedAt = Date.now() + 6_000;
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          clearOverlay();
          const value = error as Error & {code?: string};
          if (value.code === 'assessment_access_denied') {
            if (!cancelled) { setSession(null); stopCamera(); navigate('/home', {replace: true}); showToast('上次检查已失效，请重新选择房间'); }
            return;
          } else if (value.code === 'camera_request_in_progress') { setStatus('上一张画面仍在检查，请稍候'); return; }
          else if (value.code === 'provider_capacity_busy' || value.code === 'provider_http_429') setStatus('当前实时检查较多，会自动尝试下一张画面');
          else if (value.code === 'provider_timeout') setStatus('云端检查时间较长，将稍后重试');
          else if (value.code === 'provider_invalid_response' || value.code === 'provider_refusal') setStatus('这张画面暂时无法判断，请换一个角度');
          else if (!navigator.onLine) setStatus('网络已断开，恢复连接后会继续检查');
          else setStatus('本次画面检查没有完成，将稍后重试');
          failures += 1;
          if (!rtcFallbackRef.current && failures >= 3) {
            rtcFallbackRef.current = true;
            setRtcFallback(true);
            setStatus('实时视觉连续失败，已切换到兼容检查模式');
          }
          nextAllowedAt = Date.now() + Math.min(16_000, 2_000 * 2 ** failures);
        }
      } finally { inflight = false; }
    };
    const timer = window.setInterval(inspect, 1_000);
    void inspect();
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [active, clearOverlay, navigate, roomId, session?.assessment_id, setSession, showOverlay, showToast, stopCamera]);

  const finishWebScan = async () => {
    if (!stableFramesRef.current.size || !session || !room) return;
    setSaving(true);
    try {
      stopCamera();
      await stopVoice();
      const roomSlots = Math.max(0, 6 - room.media.length);
      const ranked = [...stableFramesRef.current.values()].sort((left, right) => (
        Number(right.pinned) - Number(left.pinned)
        || right.confidence - left.confidence
        || (right.sharpness - Math.abs(right.brightness - 128) / 12)
          - (left.sharpness - Math.abs(left.brightness - 128) / 12)
      ));
      const representatives: typeof ranked = [];
      for (const frame of ranked) {
        if (representatives.some(item => hammingDistance(item.hash, frame.hash) < 4)) continue;
        representatives.push(frame);
        if (representatives.length >= Math.min(6, roomSlots)) break;
      }
      if (!representatives.length) throw new Error('该房间已有 6 张照片，请删除后重试');
      const uploadedIds: string[] = [];
      for (const frame of representatives) {
        const uploaded = await api.uploadMedia(room.room_id, frame.blob, frame.width, frame.height, {
          sourceKind: 'h5_camera_frame', sourceId: frame.frameId, capturedAtMs: frame.capturedAtMs,
          orientation: 'up', perceptualHash: frame.hash,
        });
        uploadedIds.push(uploaded.media_id);
      }
      const prepared = await prepareScanSession();
      await completeScan(prepared.cameraSessionId, uploadedIds);
    } catch (error) {
      setCompletionError('代表画面尚未完成上传，请重试。');
      showToast(friendlyError(error));
      setSaving(false);
    }
  };

  const selectedSuggestion = suggestions.find(item => item.suggestion_id === selectedSuggestionId);
  const guidanceTitle = completionError || overlaySuggestion?.title || status;
  const guidanceBody = completionError
    ? '照片不会丢失，网络恢复后可重试保存扫描记录。'
    : overlaySuggestion?.short_advice || (rtcFallback
      ? '当前使用兼容检查；顶部指引和正式分析不受影响。'
      : active ? '这些都是待确认提示，保存后可在照片页确认并开始正式分析。' : '开启相机后，我会在这里实时提醒你。');
  const voiceLabel = ADVISOR_COPY.states[voiceState];

  if (!session) return <Navigate to="/home" replace />;
  if (assessmentState.loading && !assessmentState.assessment) return <Loading />;
  if (assessmentState.error) return <ErrorState error={assessmentState.error} retry={assessmentState.reload} />;
  if (!room) return <ErrorState error={new Error('没有找到本次实时检查的房间')} />;

  return <section className="page camera-page camera-advisor-page">
    <div className="page-intro compact"><small className="eyebrow">{ROOM_COPY[room.room_type].name}</small><h1>实时扫描</h1><p>顾问会边看边提醒，结束后只保存代表画面。</p></div>
    <div className={`camera-viewport ${active ? 'active' : ''}`}>
      <video ref={videoRef} className={mirrored ? 'mirrored' : ''} muted playsInline aria-label="后置摄像头实时画面" />
      {!active && <button type="button" className="camera-placeholder" aria-label="开启后置相机" onClick={startCamera} disabled={nativePending || saving}><img src="/assets/camera-tab.svg" alt="" /><b>{nativePending ? '正在使用原生相机…' : '点击开启相机'}</b><p>将在你点击后申请相机权限</p></button>}
      {overlayFrame && <LiveCameraOverlay frameId={overlayFrame.frameId} imageUrl={overlayFrame.imageUrl} frameWidth={overlayFrame.width} frameHeight={overlayFrame.height} suggestions={overlayFrame.suggestions} mirrored={mirrored} />}
      <button className="camera-advisor-guidance" onClick={() => setAdvisorOpen(true)} aria-label="打开 AI 适老顾问对话"><Icon name="assistant" filled /><span><small>AI 适老顾问</small><b>{guidanceTitle}</b><em>{guidanceBody}</em></span><Icon name="expand_more" /></button>
    </div>
    <div className="camera-live-actions">
      <button className={`camera-voice-button state-${voiceState}`} onClick={() => void toggleScanVoice()} aria-label={voiceLabel}><Icon name={voiceState === 'speaking' ? 'stop' : voiceState !== 'idle' && voiceState !== 'error' ? 'mic_off' : 'mic'} filled /><span>{voiceLabel}</span></button>
      <button className="camera-findings-button" onClick={() => setAdvisorOpen(true)}><span><b>{suggestions.length ? `已发现 ${suggestions.length} 条待确认提示` : '暂无待确认提示'}</b><small>{selectedSuggestion ? `已选中：${selectedSuggestion.title}` : '点击查看并选择“这个地方”'}</small></span><Icon name="keyboard_arrow_up" /></button>
    </div>
    {completionError && <div className="camera-analysis-retry" role="alert"><Icon name="cloud_off" /><span><b>{completionError}</b><small>你可以直接重试，无需重新拍摄。</small></span><button className="button secondary" disabled={saving || !pendingCompletionRef.current} onClick={() => { const pending = pendingCompletionRef.current; if (pending) void completeScan(pending.cameraSessionId, pending.mediaIds); }}>重试保存</button></div>}
    <button className="button primary full camera-finish-button" disabled={!hasRepresentative || saving || nativePending} onClick={() => void finishWebScan()}><Icon name="document_scanner" filled />{saving ? '正在保存代表画面…' : '结束扫描并保存'}</button>
    {!hasRepresentative && !nativePending && <p className="camera-finish-hint">需要先保存一张清晰的代表画面</p>}
    {active && <button className="button quiet full" onClick={() => { stopCamera(); void stopVoice(); }}><Icon name="pause_circle" />暂停扫描</button>}
    <button className="button quiet full" onClick={() => { stopCamera(); void endAdvisorSession(); navigate(`/upload/${roomId}`); }}>改用照片</button>

    {advisorOpen && <div className="camera-advisor-sheet-backdrop" onClick={() => setAdvisorOpen(false)}><section className="camera-advisor-sheet" role="dialog" aria-modal="true" aria-label="扫描中的 AI 适老顾问" onClick={event => event.stopPropagation()}>
      <header><div><small>扫描中</small><h2>AI 适老顾问</h2></div><button className="icon-button" onClick={() => setAdvisorOpen(false)} aria-label="收起顾问"><Icon name="close" /></button></header>
      <p className="advisor-scan-disclaimer">待确认提示，不计分，不显示风险等级或预算。</p>
      <div className="camera-suggestion-picker">{suggestions.length ? suggestions.map((item, index) => <button key={item.suggestion_id} className={selectedSuggestionId === item.suggestion_id ? 'selected' : ''} onClick={() => setSelectedSuggestionId(current => current === item.suggestion_id ? '' : item.suggestion_id)}><span>{index + 1}</span><div><b>{item.title}</b><small>{item.short_advice}</small></div><Icon name={selectedSuggestionId === item.suggestion_id ? 'check_circle' : 'radio_button_unchecked'} filled={selectedSuggestionId === item.suggestion_id} /></button>) : <p className="muted">缓慢移动相机，顾问会把有依据的提示放在这里。</p>}</div>
      <div className="camera-advisor-turns" aria-live="polite">{advisorTurns.slice(-6).map(turn => <article key={turn.turn_id} className={`advisor-bubble ${turn.role}`}><p>{turn.text}</p></article>)}{partialTranscript && <article className="advisor-bubble user partial"><p>{partialTranscript}</p></article>}</div>
      <div className="advisor-quick-prompts">{(advisor?.quick_prompts || []).map(prompt => <button key={prompt} disabled={advisorBusy} onClick={() => void sendScanMessage(prompt)}>{prompt}</button>)}</div>
      <form className="camera-advisor-composer" onSubmit={event => { event.preventDefault(); void sendScanMessage(advisorInput); }}><input value={advisorInput} maxLength={500} onChange={event => setAdvisorInput(event.target.value)} placeholder={selectedSuggestion ? `追问“${selectedSuggestion.title}”` : '输入问题，或先选中一处提示'} aria-label="扫描中向顾问提问" /><button type="submit" disabled={!advisorInput.trim() || advisorBusy} aria-label="发送"><Icon name="arrow_upward" filled /></button><button type="button" className={`advisor-mic state-${voiceState}`} onClick={() => void toggleScanVoice()} aria-label={voiceLabel}><Icon name="mic" filled /></button></form>
    </section></div>}
  </section>;
}

function HomePage() {
  const navigate = useNavigate();
  const {session, assessment, setSession, setAssessment, showToast, capabilities} = useApp();
  const onboarding = useOnboarding();
  const [busy, setBusy] = useState(false);
  const [cameraIntroOpen, setCameraIntroOpen] = useState(false);
  const [pendingEntry, setPendingEntry] = useState<'photo' | 'camera' | null>(null);
  const createPhotoAssessment = async () => {
    setBusy(true);
    try {
      const value = await api.createAssessment('photo');
      setSession({assessment_id: value.assessment_id, access_token: value.access_token});
      setAssessment(null);
      if (onboarding.active) onboarding.completePhase('home', 'profile');
      navigate('/profile');
    } catch (error) {
      showToast(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };
  const startEntry = (entry: 'photo' | 'camera') => {
    if (session) { setPendingEntry(entry); return; }
    if (entry === 'camera') setCameraIntroOpen(true);
    else void createPhotoAssessment();
  };
  const startNew = () => {
    const entry = pendingEntry;
    setPendingEntry(null);
    setSession(null);
    setAssessment(null);
    if (entry === 'camera') setCameraIntroOpen(true);
    else void createPhotoAssessment();
  };
  const continueCurrent = async () => {
    const entry = pendingEntry;
    setPendingEntry(null);
    if (!session) return;
    setBusy(true);
    try {
      const current = assessment?.assessment_id === session.assessment_id ? assessment : await api.getAssessment();
      setAssessment(current);
      if (current.status === 'completed') { navigate('/renovations'); return; }
      if (entry === 'camera') { setCameraIntroOpen(true); return; }
      const destination = resolveCheckDestination(session, current) || '/profile';
      if (onboarding.active) onboarding.completePhase('home', destination === '/profile' ? 'profile' : 'rooms');
      navigate(destination);
    } catch (error) { showToast(friendlyError(error)); }
    finally { setBusy(false); }
  };
  const hasCameraEntry = nativeCapability('live_scan') ? capabilities?.ios_home_camera !== false : capabilities?.h5_camera !== false;
  const knowledgeAdvisorAvailable = capabilities?.knowledge_advisor !== false;
  const progress = session ? getHomeProgress(session.last_route) : {step: 1, label: HOME_FLOW_STEPS[0].label};
  const progressPercent = Math.round(progress.step / HOME_FLOW_STEPS.length * 100);
  return <section className="page home-page">
    <header className="home-brand-bar">
      <Icon name="shield_with_heart" filled />
      <strong>{HOME_HERO_COPY.brand}</strong>
      <span aria-hidden="true" />
    </header>
    <div className="home-editorial-content">
      <section className="home-hero" aria-labelledby="home-hero-title">
        <img src={`${ASSETS}/home-hero-care.jpg`} alt="温暖客厅与居家安全检查手机界面" loading="eager" fetchPriority="high" />
        <div className="hero-copy"><h1 id="home-hero-title">给父母的家<br />做一次安全体检</h1><p>AR实时识别/上传家中的照片，<br />AI帮你发现容易忽略的行动风险。</p></div>
      </section>
      <section className="home-progress-card" aria-labelledby="home-progress-title">
        <div className="home-progress-meta">
          <span className="home-family-chip"><Icon name="favorite" filled />{HOME_HERO_COPY.brand}</span>
          <strong aria-label={`第 ${progress.step} 步，共 ${HOME_FLOW_STEPS.length} 步`}>{progress.step}/{HOME_FLOW_STEPS.length}</strong>
        </div>
        <h2 id="home-progress-title">{HOME_HERO_COPY.progressTitle}</h2>
        {session ? <button className="home-progress-resume" onClick={() => navigate(`/${session.last_route || 'profile'}`)} aria-label="继续上次检查">{HOME_HERO_COPY.progressActive(progress.label)}</button> : <p className="home-progress-status">{HOME_HERO_COPY.progressActive(progress.label)}</p>}
        <div className="home-progress-segments" role="progressbar" aria-label="检查完成进度" aria-valuemin={0} aria-valuemax={HOME_FLOW_STEPS.length} aria-valuenow={progress.step} aria-valuetext={`${progressPercent}%`}>
          {HOME_FLOW_STEPS.map((item, index) => <span key={item.label} className={index < progress.step ? 'complete' : ''} />)}
        </div>
        <div className="home-action-stack">
          <button data-onboarding-target="home-ar-entry" className="button primary full home-primary-button" aria-label={hasCameraEntry ? 'AR 实时识别' : 'AR 实时识别暂未开放'} disabled={!hasCameraEntry || busy} onClick={() => startEntry('camera')}><Icon name="photo_camera" filled />{hasCameraEntry ? 'AR 实时识别' : '实时识别暂未开放'}</button>
          <div className="home-secondary-actions two-actions">
            <button data-onboarding-target="home-photo-entry" className="button secondary full home-secondary-button" disabled={busy} onClick={() => startEntry('photo')}><Icon name="image" />{busy ? '正在开始…' : '上传家中照片'}</button>
            <button className="button secondary full home-secondary-button" aria-label={knowledgeAdvisorAvailable ? '问问 AI 助手' : 'AI 助手暂未开放'} disabled={!knowledgeAdvisorAvailable || busy} onClick={() => navigate('/advisor')}><Icon name="smart_toy" />{knowledgeAdvisorAvailable ? '问问 AI 助手' : 'AI 助手暂未开放'}</button>
          </div>
        </div>
      </section>
    </div>
    {cameraIntroOpen && <CameraLaunchModal close={() => setCameraIntroOpen(false)} />}
    {pendingEntry && <Modal title={assessment?.status === 'completed' ? '已有一份完成的检查' : '继续上次检查？'} close={() => setPendingEntry(null)}>
      <p>{assessment?.status === 'completed' ? '你可以查看上次改造记录，或为新的家庭环境创建一次检查。' : '继续会保留当前照片和进度；新建检查会单独保存到历史记录。'}</p>
      <div className="button-stack"><button className="button primary full" onClick={() => void continueCurrent()}>{assessment?.status === 'completed' ? '查看上次记录' : '继续本次检查'}</button><button className="button secondary full" onClick={startNew}>新建检查</button></div>
    </Modal>}
  </section>;
}

function ProfilePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const {session, showToast} = useApp();
  const onboarding = useOnboarding();
  const {assessment, loading, error, reload} = useAssessment();
  const query = new URLSearchParams(location.search);
  const editingFromMy = query.get('from') === 'my';
  const defaultProfile = useMemo(() => readDefaultProfile(), []);
  const initial = editingFromMy ? defaultProfile || undefined : assessment?.profile || assessment?.profile_json || defaultProfile || undefined;
  const [profile, setProfile] = useState<Partial<ElderProfile>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (initial) setProfile(initial); }, [initial]);
  if (!session && !editingFromMy) return <Navigate to="/home" replace />;
  if (!editingFromMy && loading && !assessment) return <Loading />;
  if (!editingFromMy && error) return <ErrorState error={error} retry={reload} />;
  const complete = Boolean(profile.mobility && profile.fall_history && profile.living_status);
  const requestedReturn = query.get('return_to') || '';
  const safeReturn = /^\/(upload|advisor)\/[A-Za-z0-9-]{1,80}$/.test(requestedReturn) ? requestedReturn : '';
  const changed = Boolean(initial) && (profile.mobility !== initial?.mobility || profile.fall_history !== initial?.fall_history || profile.living_status !== initial?.living_status);
  const saveProfile = async () => {
    if (!complete) return;
    setSaving(true);
    try {
      if (editingFromMy) {
        writeDefaultProfile(profile as ElderProfile);
        showToast('默认个人档案已保存，将用于新检查预填');
      } else {
        await api.saveProfile(profile as ElderProfile);
        if (!readDefaultProfile()) writeDefaultProfile(profile as ElderProfile);
        showToast('个人档案已保存');
      }
      if (onboarding.active) onboarding.completePhase('profile', safeReturn ? 'capture' : 'rooms');
      navigate(editingFromMy ? '/my' : safeReturn || '/rooms');
    } catch (value) {
      showToast(friendlyError(value));
    } finally { setSaving(false); }
  };
  const mobility = [
    ['normal', 'directions_walk', '行走基本正常'], ['cane', 'elderly', '使用拐杖'], ['walker', 'assist_walker', '使用助行器'], ['wheelchair', 'accessible', '使用轮椅'],
  ] as const;
  return <section className="page profile-page">
    <div className="page-intro"><h1>{editingFromMy ? '编辑个人档案' : '先了解一下家人的情况'}</h1><p>不同的行动能力，会影响居家风险的判断。</p></div>
    <div data-onboarding-target="profile-form" className="onboarding-target-group">
    <fieldset className="form-section"><legend>行动能力</legend><div className="mobility-grid">
      {mobility.map(([value, icon, label]) => <button key={value} type="button" className={`choice-card ${profile.mobility === value ? 'selected' : ''}`} onClick={() => setProfile(current => ({...current, mobility: value}))}><Icon name={icon} /><span>{label}</span>{profile.mobility === value && <Icon name="check_circle" filled className="choice-check" />}</button>)}
    </div></fieldset>
    <RadioSection title="最近半年是否发生过跌倒？" name="fall" value={profile.fall_history} onChange={value => setProfile(current => ({...current, fall_history: value as ElderProfile['fall_history']}))} options={[['none', '没有'], ['once', '发生过一次'], ['multiple', '发生过多次']]} />
    <RadioSection title="父母目前是否独居？" name="living" value={profile.living_status} onChange={value => setProfile(current => ({...current, living_status: value as ElderProfile['living_status']}))} options={[['alone', '独居'], ['with_family', '与家人同住']]} />
    <div className="draft-actions"><p className="draft-note"><Icon name="edit_note" />选择只会保留在本页，点击“{editingFromMy ? '保存' : '保存并继续'}”后才会提交。</p>{changed && <button className="text-button" onClick={() => initial && setProfile(initial)}>撤销修改</button>}</div>
    </div>
    <div data-onboarding-target="profile-save" className="sticky-footer"><button className="button primary full" disabled={!complete || saving} onClick={saveProfile}>{saving ? '正在保存…' : editingFromMy ? '保存' : '保存并继续'}<Icon name={editingFromMy ? 'save' : 'arrow_forward'} /></button></div>
  </section>;
}

function RadioSection({title, name, value, options, onChange}: {title: string; name: string; value?: string; options: [string, string][]; onChange: (value: string) => void}) {
  return <fieldset className="radio-panel"><legend>{title}</legend><div className="radio-options-card">{options.map(([option, label]) => <label key={option} className="radio-row"><input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} /><span>{label}</span></label>)}</div></fieldset>;
}

function RoomsPage() {
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const onboarding = useOnboarding();
  const {assessment, loading, error, reload} = useAssessment();
  const [busy, setBusy] = useState(false);
  const [multiMode, setMultiMode] = useState(false);
  const [singleRoom, setSingleRoom] = useState<keyof typeof ROOM_COPY | null>(null);
  const [selectedRooms, setSelectedRooms] = useState<Set<keyof typeof ROOM_COPY>>(new Set());
  const [editingPlan, setEditingPlan] = useState(false);
  const [localTasks, setLocalTasks] = useState<RoomAssessment[] | null>(null);
  if (!session) return <Navigate to="/home" replace />;
  if (loading && !assessment) return <Loading />;
  if (error) return <ErrorState error={error} retry={reload} />;
  const openRoom = (room: RoomAssessment) => {
    if (onboarding.active) {
      if (room.status === 'result_ready' || room.status === 'completed' || room.status === 'analyzing') onboarding.completePhase('rooms', 'result');
      else onboarding.completePhase('rooms', 'capture');
    }
    navigate(room.status === 'result_ready' ? `/result/${room.room_id}` : room.status === 'analyzing' ? `/analyzing/${room.room_id}` : `/upload/${room.room_id}`);
  };
  const choose = async (roomType: keyof typeof ROOM_COPY) => {
    if (multiMode) {
      setSelectedRooms(current => {
        const next = new Set(current);
        if (next.has(roomType)) next.delete(roomType); else next.add(roomType);
        return next;
      });
      return;
    }
    setSingleRoom(roomType);
  };
  const saveSelectedRooms = async (roomTypes: Array<keyof typeof ROOM_COPY>) => {
    if (!roomTypes.length) { showToast('请至少选择一个房间'); return; }
    setBusy(true);
    try {
      await api.savePlannedRooms(roomTypes);
      const plannedRooms: RoomAssessment[] = [];
      for (const roomType of roomTypes) {
        const existing = assessment?.rooms.find(item => item.room_type === roomType);
        const room = existing || await api.createRoom(roomType);
        plannedRooms.push(room);
      }
      if (onboarding.active) onboarding.completePhase('rooms', 'capture');
      if (multiMode) {
        setLocalTasks(plannedRooms);
        setEditingPlan(false);
        reload();
      } else if (plannedRooms[0]) openRoom(plannedRooms[0]);
    } catch (value) { showToast(friendlyError(value)); }
    finally { setBusy(false); }
  };
  const savedPlan = assessment?.planned_rooms || assessment?.planned_rooms_json || [];
  const taskRooms = localTasks || savedPlan.map(roomType => assessment?.rooms.find(room => room.room_type === roomType)).filter(Boolean) as RoomAssessment[];
  const showTasks = !editingPlan && taskRooms.length > 0 && (savedPlan.length > 0 || Boolean(localTasks));
  const hasRoomSelection = multiMode ? selectedRooms.size > 0 : singleRoom !== null;
  const taskStatus = (room: RoomAssessment) => {
    if (room.status === 'result_ready' || room.status === 'completed') return {label: `${room.score ?? '—'} 分 · 已完成`, action: '查看结果'};
    if (room.status === 'analyzing') return {label: 'AI 正在分析', action: '查看进度'};
    if (room.status === 'analysis_failed') return {label: '分析未完成', action: '重新检查'};
    if (room.media.length) return {label: `已上传 ${room.media.length} 张`, action: '继续上传'};
    return {label: '等待上传照片', action: '上传照片'};
  };
  if (showTasks) return <section className="page rooms-page">
    <div className="page-intro"><h1>房间检查任务</h1><p>每个房间独立上传和分析，完成后可以随时回来继续。</p></div>
    <div className="room-task-list" data-onboarding-target="room-selection">{taskRooms.map(room => {
      const copy = ROOM_COPY[room.room_type];
      const status = taskStatus(room);
      return <article key={room.room_id} className={`room-task-card status-${room.status}`}><span className="room-icon"><Icon name={copy.icon} filled /></span><div><b>{copy.name}</b><small>{status.label}</small></div><button className="button secondary" onClick={() => openRoom(room)}>{status.action}</button></article>;
    })}</div>
    <button data-onboarding-target="room-selection" className="button quiet full" onClick={() => { setEditingPlan(true); setMultiMode(true); setSelectedRooms(new Set(savedPlan)); }}>修改检查房间</button>
    <button className="button primary full" disabled={!taskRooms.some(room => room.status === 'result_ready' || room.status === 'completed')} onClick={() => navigate('/report')}>查看改造清单</button>
  </section>;
  return <section className="page rooms-page">
    <div className="page-intro"><h1>这次想检查哪里？</h1><p>建议从老人最常活动、也最容易跌倒的区域开始。</p></div>
    <div className="room-mode-switch" role="group" aria-label="房间检查方式">
      <button className={!multiMode ? 'active' : ''} aria-pressed={!multiMode} onClick={() => setMultiMode(false)}>检查一个房间</button>
      <button className={multiMode ? 'active' : ''} aria-pressed={multiMode} onClick={() => setMultiMode(true)}>规划多个房间</button>
    </div>
    {multiMode && <div className="mode-note" role="status"><Icon name="checklist" /><span><b>先制定检查计划</b>所选房间都会保存；接下来会从第一个房间开始，完成后可返回这里继续下一个。</span></div>}
    <div className="room-grid" data-onboarding-target="room-selection">{Object.entries(ROOM_COPY).map(([key, room]) => {
      const existing = assessment?.rooms.find(item => item.room_type === key);
      const selected = multiMode ? selectedRooms.has(key as keyof typeof ROOM_COPY) : singleRoom === key;
      const recommended = Boolean(room.priority && !hasRoomSelection);
      return <button key={key} className={`room-card ${recommended ? 'recommended' : ''} ${selected ? 'plan-selected' : ''}`} aria-pressed={selected} disabled={busy} onClick={() => choose(key as keyof typeof ROOM_COPY)}>
        <span className="room-icon"><Icon name={room.icon} filled={recommended} /></span>
        <b>{room.name}</b><p>{room.hint}</p>
        {selected && <span className="plan-check"><Icon name="check_circle" filled />已选择</span>}
        {existing?.status === 'result_ready' && <span className="completion"><Icon name="check_circle" filled />{existing.score} 分</span>}
      </button>;
    })}</div>
    <button data-onboarding-target="room-selection" className="button primary full" disabled={busy || (multiMode ? !selectedRooms.size : !singleRoom)} onClick={() => saveSelectedRooms(multiMode ? [...selectedRooms] : singleRoom ? [singleRoom] : [])}>{multiMode ? `保存计划（${selectedRooms.size} 个房间）` : singleRoom ? `开始检查${ROOM_COPY[singleRoom].name}` : '请先选择一个房间'}</button>
  </section>;
}

function UploadPage() {
  const {roomId = ''} = useParams();
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const onboarding = useOnboarding();
  const {assessment, loading, error, reload} = useAssessment();
  const [busy, setBusy] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [pendingDeleteMediaId, setPendingDeleteMediaId] = useState<string | null>(null);
  const nativePhotoRequestRef = useRef<string | null>(null);
  useEffect(() => {
    const receive = (event: Event) => {
      const result = (event as CustomEvent<unknown>).detail;
      if (!isNativeCaptureResult(result) || result.request_id !== nativePhotoRequestRef.current || result.room_id !== roomId) return;
      nativePhotoRequestRef.current = null;
      setBusy(false);
      if (result.status === 'cancelled') return;
      if (result.uploaded_media_ids.length) {
        reload();
        showToast('照片已上传并完成质量检查');
      } else showToast(result.error_code ? '拍照上传没有完成，请重试' : '本次没有保存照片');
    };
    window.addEventListener(NATIVE_CAPTURE_RESULT_EVENT, receive);
    return () => window.removeEventListener(NATIVE_CAPTURE_RESULT_EVENT, receive);
  }, [reload, roomId, showToast]);
  const room = assessment?.rooms.find(item => item.room_id === roomId);
  const usable = Boolean(room?.media.some(item => item.quality.usable));
  useEffect(() => {
    if (usable && onboarding.active && onboarding.state.phase !== 'analyze') onboarding.completePhase('capture', 'analyze');
  }, [onboarding.active, onboarding.completePhase, onboarding.state.phase, usable]);
  if (!session) return <Navigate to="/home" replace />;
  if (loading && !assessment) return <Loading />;
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!room) return <ErrorState error={new Error('没有找到这个房间')} />;
  const roomName = ROOM_COPY[room.room_type].name;
  const photoGuides = ROOM_PHOTO_GUIDES[room.room_type];
  const profile = assessment?.profile || assessment?.profile_json;
  const profileComplete = Boolean(profile?.mobility && profile?.fall_history && profile?.living_status);
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = [...(event.target.files || [])];
    const remaining = Math.max(0, 6 - room.media.length);
    const files = selectedFiles.slice(0, remaining);
    const droppedCount = selectedFiles.length - files.length;
    if (!files.length) {
      if (selectedFiles.length) showToast('最多上传 6 张，本次选择的照片未添加');
      event.target.value = '';
      return;
    }
    setBusy(true);
    showToast(`正在处理 ${files.length} 张照片…`);
    let uploadedUsable = false;
    for (const file of files) {
      try {
        const normalized = await normalizeImage(file);
        const uploaded = await api.uploadMedia(roomId, normalized.blob, normalized.width, normalized.height);
        uploadedUsable = uploadedUsable || uploaded.quality.usable;
      } catch (value) { showToast(friendlyError(value)); }
    }
    setBusy(false);
    reload();
    if (uploadedUsable && onboarding.active) onboarding.completePhase('capture', 'analyze');
    event.target.value = '';
    if (droppedCount) showToast(`已添加 ${files.length} 张，另 ${droppedCount} 张因达到上限未添加`);
  };
  const analyze = async () => {
    if (!profileComplete) {
      if (onboarding.active) onboarding.enterPhase('profile');
      navigate(`/profile?return_to=${encodeURIComponent(`/upload/${roomId}`)}`);
      return;
    }
    setBusy(true);
    try {
      await api.analyze(roomId);
      if (onboarding.active) onboarding.completePhase('analyze', 'result');
      navigate(`/analyzing/${roomId}`);
    }
    catch (value) { showToast(friendlyError(value)); setBusy(false); }
  };
  const remove = async (mediaId: string) => {
    try { await api.deleteMedia(roomId, mediaId); reload(); }
    catch (value) { showToast(friendlyError(value)); }
  };
  const captureNativePhoto = () => {
    if (!session || room.media.length >= 6) return;
    const requestId = nativeRequestId();
    if (!invokeNative('capture_photo', {
      request_id: requestId, assessment_id: session.assessment_id, access_token: session.access_token,
      room_id: room.room_id, room_type: room.room_type, remaining_slots: 1,
    })) return;
    nativePhotoRequestRef.current = requestId;
    setBusy(true);
  };
  return <section className="page upload-page">
    <div className="page-intro"><small className="eyebrow">{UPLOAD_COPY.eyebrow}</small><h1>上传{roomName}照片</h1><p>拍摄越完整，分析结果越准确。</p></div>
    <div data-onboarding-target="capture-source" className={`upload-drop ${room.media.length ? 'has-media' : ''}`}><span className="upload-icon"><Icon name={room.media.length ? 'check_circle' : 'photo_camera'} filled /></span><b>{busy ? '正在上传并检查照片…' : room.media.length ? `已上传 ${room.media.length} 张` : '拍照或从相册选择'}</b><small>{room.media.length >= 6 ? '已达到 6 张上限，可使用已有照片或删除后重试' : '最多 6 张，推荐 1—3 张'}</small><div className="upload-source-actions">{nativeCapability('photo_capture') ? <button className="button secondary" disabled={busy || room.media.length >= 6} onClick={captureNativePhoto}><Icon name="photo_camera" />拍照</button> : <label className="button secondary"><input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={upload} disabled={busy || room.media.length >= 6} /><Icon name="photo_camera" />拍照</label>}<label className="button quiet"><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={upload} disabled={busy || room.media.length >= 6} /><Icon name="photo_library" />从相册选择</label></div></div>
    <button className="photo-guide-trigger" onClick={() => setGuideOpen(true)}><span><Icon name="tips_and_updates" filled /><b>查看{roomName}拍摄建议</b></span><Icon name="chevron_right" /></button>
    <section className="quality-card"><h2>当前照片状态</h2>{room.media.length === 0 ? <p className="muted">还没有照片</p> : <div className="quality-list">{room.media.map(media => <MediaRow key={media.media_id} media={media} remove={() => setPendingDeleteMediaId(media.media_id)} />)}</div>}</section>
    <div className="thumb-strip">{room.media.map(media => <MediaThumb key={media.media_id} media={media} />)}{room.media.length < 6 && <label className="add-thumb"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={upload} disabled={busy} /><Icon name="add_photo_alternate" /></label>}</div>
    <div data-onboarding-target="capture-analyze" className="sticky-footer"><button className="button primary full" disabled={!usable || busy} onClick={analyze}><Icon name={profileComplete ? 'document_scanner' : 'person'} />{busy ? '正在处理…' : profileComplete ? '开始 AI 检查' : '先完善家人情况'}</button></div>
    {pendingDeleteMediaId && <Modal title="删除这张照片？" close={() => setPendingDeleteMediaId(null)}>
      <p>删除后需要重新上传，相关照片不会再用于本次分析。</p>
      <div className="button-stack"><button className="button danger full" onClick={async () => { const mediaId = pendingDeleteMediaId; setPendingDeleteMediaId(null); await remove(mediaId); }}>确认删除</button><button className="button quiet full" onClick={() => setPendingDeleteMediaId(null)}>取消</button></div>
    </Modal>}
    {guideOpen && <Modal title={`${roomName}拍摄建议`} close={() => setGuideOpen(false)}><div className="photo-tips">{photoGuides.map(guide => <PhotoTip key={guide.text} {...guide} />)}</div><button className="button primary full" onClick={() => setGuideOpen(false)}>知道了</button></Modal>}
  </section>;
}

function PhotoTip({image, icon, text}: {image: string; icon: string; text: string}) {
  return <div><div className="tip-image"><img src={`${ASSETS}/${image}`} alt="" /><Icon name={icon} /></div><p>{text}</p></div>;
}

function MediaThumb({media}: {media: MediaAsset}) {
  const {url} = useProtectedImage(media.content_path);
  return <div className={`media-thumb ${media.quality.usable ? 'usable' : ''}`}><img src={url || `${ASSETS}/demo-upload-floor.jpg`} alt="已上传照片缩略图" />{media.quality.usable && <Icon name="check_circle" filled />}</div>;
}

function MediaRow({media, remove}: {media: MediaAsset; remove: () => void}) {
  const quality = media.quality;
  const failed = Boolean(quality.error);
  const passedNotes = [quality.clear && '画面清晰', quality.floor_visible && '已拍到地面', quality.path_visible && '通道可见', quality.lighting_sufficient && '光线充足'].filter(Boolean);
  const retryNotes = [!quality.clear && '画面不够清晰', quality.major_occlusion && '主要区域被遮挡', quality.missing_views.length ? `缺少：${quality.missing_views.join('、')}` : ''].filter(Boolean);
  const notes = quality.usable ? passedNotes : retryNotes;
  return <article className="media-row"><span className={`status-icon ${quality.usable ? 'ok' : 'warn'}`}><Icon name={quality.usable ? 'check_circle' : failed ? 'error' : 'warning'} filled /></span><div><b>{quality.usable ? '可以用于分析' : failed ? '照片检查失败' : '建议重新拍摄'}</b><p>{failed ? '这张照片暂时无法识别，请删除后重新上传' : notes.join(' · ') || (quality.usable ? '照片已通过质量检查' : '请打开拍摄建议后重新拍摄')}</p></div><button className="icon-button" onClick={remove} aria-label="删除这张照片"><Icon name="delete" /></button></article>;
}

function AnalyzingPage() {
  const {roomId = ''} = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const {session, showToast} = useApp();
  const assessmentState = useAssessment();
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pollVersion, setPollVersion] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const room = assessmentState.assessment?.rooms.find(item => item.room_id === roomId);
  const media = room?.media.find(item => item.quality.usable);
  const {url} = useProtectedImage(media?.content_path);
  const poll = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await api.status(roomId, signal);
      setStatus(value);
      setError(null);
      return value;
    } catch (value) {
      if ((value as Error).name !== 'AbortError') setError(value);
      return null;
    }
  }, [roomId]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let stopped = false;
    let timer: number | undefined;
    const run = async () => {
      const value = await poll(controller.signal);
      if (!stopped && value && ['not_started', 'queued', 'running'].includes(value.status)) {
        timer = window.setTimeout(run, 1200);
      }
    };
    void run();
    return () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [poll, pollVersion, session?.access_token, session?.assessment_id]);
  useEffect(() => {
    if (status?.status === 'completed' || status?.status === 'failed') return;
    const timer = window.setInterval(() => setElapsedSeconds(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [status?.status]);
  useEffect(() => {
    if (status?.status === 'completed') {
      const destination = new URLSearchParams(location.search).get('return_to') === 'advisor' ? `/advisor/${roomId}` : `/result/${roomId}`;
      const timer = window.setTimeout(() => navigate(destination, {replace: true}), 500);
      return () => window.clearTimeout(timer);
    }
  }, [location.search, navigate, roomId, status?.status]);
  if (!session) return <Navigate to="/home" replace />;
  if (error || assessmentState.error) return <ErrorState error={error || assessmentState.error} retry={() => { setPollVersion(value => value + 1); assessmentState.reload(); }} />;
  const roomName = room ? ROOM_COPY[room.room_type].name : '房间';
  const recognizedElements = [...new Set(media?.quality.scene_elements || [])].filter(item => SCENE_ELEMENT_COPY[item]);
  const retry = async () => {
    try {
      await api.analyze(roomId);
      setElapsedSeconds(0);
      setPollVersion(value => value + 1);
    } catch (value) { showToast(friendlyError(value)); }
  };
  const reportedStage = ANALYSIS_STAGES.indexOf(status?.stage as typeof ANALYSIS_STAGES[number]);
  const visualStage = reportedStage >= 0 ? reportedStage : 0;
  const progressPercent = status?.status === 'completed' ? 100 : Math.min(95, Math.round((visualStage + 1) / ANALYSIS_STAGES.length * 100));
  const timeExpectation = elapsedSeconds < 30
    ? '正在按服务端返回的分析阶段处理'
    : '分析时间比平时久，可以退出等待，稍后从首页继续';
  return <section className="page analyzing-page">
    <div className="center-heading"><h1>正在检查{roomName}</h1><p>AI 正在深度分析您的居家环境</p></div>
    <div className="analysis-progress" role="status" aria-live="polite"><div><b>{progressPercent}%</b><span>{timeExpectation}</span></div><div className="progress"><i style={{width: `${progressPercent}%`}} /></div></div>
    <div className="scan-visual"><img src={url || `${ASSETS}/analysis-bathroom.jpg`} alt={`正在检查的${roomName}`} /><span className="scan-line" /></div>
    <div className="recognized-card"><b><Icon name={recognizedElements.length ? 'check_circle' : 'progress_activity'} filled={Boolean(recognizedElements.length)} />{recognizedElements.length ? '照片预检识别到的要素' : '正在预检照片要素'}</b><div className="chip-row">{recognizedElements.length ? recognizedElements.map(element => <span key={element}>{SCENE_ELEMENT_COPY[element]}</span>) : <span>请稍候…</span>}</div><small>这些标签表示照片中已看清的区域，不代表精确位置。</small></div>
    <div className="analysis-steps" role="status" aria-live="polite">{ANALYSIS_STAGES.map((stage, index) => <div key={stage} className={index < visualStage ? 'done' : index === visualStage ? 'active' : ''}><span><Icon name={index < visualStage ? 'check' : index === visualStage ? 'progress_activity' : 'circle'} filled={index < visualStage} /></span><p><b>{STAGE_COPY[stage]}</b>{index === visualStage && <small>{status?.status === 'failed' ? '分析在此处停止' : '当前服务端任务阶段'}</small>}</p></div>)}</div>
    {status?.status === 'failed' && <div className="error-panel"><b>分析没有完成</b><p>{friendlyError({message: status.error || '', code: status.error})}</p><button className="button primary full" onClick={retry}>重新分析</button></div>}
    {status?.status !== 'failed' && <button className="button quiet full" onClick={() => { showToast('已退出等待，服务端会继续分析'); navigate('/rooms'); }}>退出等待，返回房间列表</button>}
    <p className="analysis-exit-note">退出只会停止本页轮询，服务端仍会继续分析；之后点击该房间即可返回进度页。</p>
    <p className="fine-print"><Icon name="info" />我们只分析居家环境，不进行健康或医疗诊断。</p>
  </section>;
}

function useRoomResult(roomId: string) {
  const {session, roomResult, setRoomResult} = useApp();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!session) {
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api.result(roomId, controller.signal).then(value => { setRoomResult(value); setError(null); }).catch(value => { if ((value as Error).name !== 'AbortError') setError(value); }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [roomId, session, setRoomResult, version]);
  return {result: roomResult?.room_id === roomId ? roomResult : null, loading, error, reload: () => setVersion(value => value + 1)};
}

function RiskPhotoButton({media, active, count, onClick}: {media: MediaAsset; active: boolean; count: number; onClick: () => void}) {
  const {url} = useProtectedImage(media.content_path);
  return <button className={`risk-photo-button ${active ? 'active' : ''}`} onClick={onClick} aria-pressed={active}><img src={url || `${ASSETS}/demo-upload-floor.jpg`} alt="风险证据照片" /><span>{count} 处</span></button>;
}

function ResultPage() {
  const {roomId = ''} = useParams();
  const navigate = useNavigate();
  const {session} = useApp();
  const onboarding = useOnboarding();
  const assessmentState = useAssessment();
  const {result, loading, error, reload} = useRoomResult(roomId);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [selectedMediaId, setSelectedMediaId] = useState('');
  const room = assessmentState.assessment?.rooms.find(item => item.room_id === roomId);
  const evidenceMedia = useMemo(() => {
    if (!result || !room) return [];
    return room.media.map(media => {
      const risks = result.risks.filter(risk => risk.media_id === media.media_id);
      return {media, risks, highCount: risks.filter(risk => risk.severity === 'high').length};
    }).filter(item => item.risks.length).sort((a, b) => b.risks.length - a.risks.length || b.highCount - a.highCount);
  }, [result, room]);
  useEffect(() => {
    if (!selectedMediaId && evidenceMedia[0]) setSelectedMediaId(evidenceMedia[0].media.media_id);
    if (selectedMediaId && !evidenceMedia.some(item => item.media.media_id === selectedMediaId)) setSelectedMediaId(evidenceMedia[0]?.media.media_id || '');
  }, [evidenceMedia, selectedMediaId]);
  if (!session) return <Navigate to="/home" replace />;
  if (error || assessmentState.error) return <ErrorState error={error || assessmentState.error} retry={() => { reload(); assessmentState.reload(); }} />;
  if (loading || assessmentState.loading || !result) return <Loading label="正在准备检查结果…" />;
  const roomName = ROOM_COPY[result.room_type].name;
  const activeEvidence = evidenceMedia.find(item => item.media.media_id === selectedMediaId) || evidenceMedia[0];
  const numberById = Object.fromEntries(result.risks.map((risk, index) => [risk.risk_id, index + 1]));
  const firstRisk = activeEvidence?.risks[0] || result.risks[0];
  return <section className="page result-page">
    <div className="complete-mark"><Icon name="check_circle" filled /></div>
    <div className="center-heading"><h1>{roomName}检查完成</h1><p>大部分问题都可以通过低成本措施改善。</p></div>
    <div className="result-overview" data-onboarding-target="result-overview"><article className="summary-card"><div><small>{result.score_label}</small><b className="score-number">{result.score}<em>/100</em></b></div><div className="coverage-block"><span>检查覆盖度 {result.coverage.percent}%</span><div className="progress"><i style={{width: `${result.coverage.percent}%`}} /></div></div><button className="text-button" onClick={() => setScoreOpen(true)}>查看评分依据</button></article>
    <article className="risk-summary"><small>发现问题</small><b className="issue-number">{result.risks.length}<em>个</em></b></article></div>
    {activeEvidence && <section className="risk-overview-section" data-onboarding-target="result-risks"><h2>主要风险</h2><ResultRiskOverlay media={activeEvidence.media} risks={activeEvidence.risks} numberById={numberById} onSelect={riskId => { if (onboarding.active) onboarding.completePhase('result', 'risk'); navigate(`/risk/${roomId}/${riskId}`); }} />
      {evidenceMedia.length > 1 && <div className="risk-photo-strip" aria-label="切换风险照片">{evidenceMedia.map(item => <RiskPhotoButton key={item.media.media_id} media={item.media} active={item.media.media_id === activeEvidence.media.media_id} count={item.risks.length} onClick={() => setSelectedMediaId(item.media.media_id)} />)}</div>}
      <div className="risk-overview-list">{activeEvidence.risks.map(risk => <button key={risk.risk_id} onClick={() => { if (onboarding.active) onboarding.completePhase('result', 'risk'); navigate(`/risk/${roomId}/${risk.risk_id}`); }}><span>{numberById[risk.risk_id]}</span><div><b>{risk.title}</b><small>{SEVERITY_COPY[risk.severity]}</small></div><Icon name="chevron_right" /></button>)}</div>
    </section>}
    {!result.risks.length && <p className="empty-copy">当前已检查区域暂未发现明确风险。</p>}
    <button className="advisor-entry-button" onClick={() => navigate(`/advisor/${roomId}${selectedMediaId ? `?media_id=${encodeURIComponent(selectedMediaId)}` : ''}`)}><Icon name="forum" filled /><span><b>问问 AI 适老顾问</b><small>继续追问风险、方案和预算</small></span><Icon name="chevron_right" /></button>
    <div className="result-fixed-actions"><button className="button secondary" disabled={!firstRisk} onClick={() => { if (!firstRisk) return; if (onboarding.active) onboarding.completePhase('result', 'risk'); navigate(`/risk/${roomId}/${firstRisk.risk_id}`); }}>查看问题</button><button data-onboarding-target="result-report" className="button primary" onClick={() => { if (onboarding.active) onboarding.completePhase('result', 'report'); navigate('/report'); }}>查看改造清单</button></div>
    {scoreOpen && <Modal title="参考分的计算依据" close={() => setScoreOpen(false)}><div className="score-basis-sheet"><p>参考分由经过校验的风险、家人情况和本地规则确定性计算；覆盖度与参考分分开展示。</p>{result.main_deductions.length ? <div>{result.main_deductions.map(item => <div key={item.risk_id}><span>{item.title}</span><b>扣 {item.deduction} 分</b></div>)}</div> : <p className="muted">当前没有扣分项。</p>}<button className="button primary full" onClick={() => setScoreOpen(false)}>知道了</button></div></Modal>}
  </section>;
}

function ResultRiskOverlay({media, risks, numberById, onSelect}: {media: MediaAsset; risks: SafetyRisk[]; numberById: Record<string, number>; onSelect: (riskId: string) => void}) {
  const {url} = useProtectedImage(media.content_path);
  return <RiskOverlay imageUrl={url} fallbackUrl={`${ASSETS}/result-shower.jpg`} risks={risks} mediaId={media.media_id} activeId="" numberById={numberById} zoom={1} drawing={false} onSelect={onSelect} onRegionChange={() => undefined} />;
}

function AdvisorMediaButton({media, active, onClick}: {media: MediaAsset; active: boolean; onClick: () => void}) {
  const {url} = useProtectedImage(media.content_path);
  return <button className={`advisor-media-button ${active ? 'active' : ''}`} aria-pressed={active} onClick={onClick}><img src={url || `${ASSETS}/demo-upload-floor.jpg`} alt="参考画面缩略图" /><span>{active ? '当前画面' : '切换画面'}</span></button>;
}

function AdvisorPage() {
  const {roomId = ''} = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const query = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const [bootstrap, setBootstrap] = useState<AdvisorBootstrap | null>(null);
  const [turns, setTurns] = useState<AdvisorTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selectedMediaId, setSelectedMediaId] = useState(query.get('media_id') || '');
  const [selectedRiskId, setSelectedRiskId] = useState(query.get('risk_id') || '');
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [decided, setDecided] = useState<Set<string>>(new Set());
  const voiceRef = useRef<AdvisorVoiceRTC | null>(null);
  const voiceIdleTimerRef = useRef<number | null>(null);
  const voiceQueueTicketRef = useRef(readAdvisorRTCTicket(roomId, 'audio'));
  const voiceQueueHeartbeatRef = useRef<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const releaseVoice = useCallback(async () => {
    if (voiceIdleTimerRef.current !== null) window.clearTimeout(voiceIdleTimerRef.current);
    voiceIdleTimerRef.current = null;
    if (voiceQueueHeartbeatRef.current !== null) window.clearInterval(voiceQueueHeartbeatRef.current);
    voiceQueueHeartbeatRef.current = null;
    await voiceRef.current?.disconnect();
    voiceRef.current = null;
    const ticket = voiceQueueTicketRef.current;
    voiceQueueTicketRef.current = null;
    if (ticket) {
      await api.cancelAdvisorRTCQueue(
        roomId, ticket.advisor_session_id, ticket.ticket_id, ticket.client_instance_id,
      ).catch(() => undefined);
      clearAdvisorRTCTicket(roomId, 'audio');
    }
    setVoiceState('idle');
  }, [roomId]);

  const startVoiceQueueHeartbeat = useCallback((ticket: NonNullable<typeof voiceQueueTicketRef.current>) => {
    if (voiceQueueHeartbeatRef.current !== null) window.clearInterval(voiceQueueHeartbeatRef.current);
    voiceQueueHeartbeatRef.current = window.setInterval(() => {
      void api.heartbeatAdvisorRTCQueue(
        roomId, ticket.advisor_session_id, ticket.ticket_id, ticket.client_instance_id,
      ).then(value => {
        voiceQueueTicketRef.current = saveAdvisorRTCTicket(
          roomId, ticket.advisor_session_id, ticket.client_instance_id, 'audio', value,
        );
      }).catch(() => {
        if (voiceQueueHeartbeatRef.current !== null) window.clearInterval(voiceQueueHeartbeatRef.current);
        voiceQueueHeartbeatRef.current = null;
      });
    }, 20_000);
  }, [roomId]);

  const appendTurns = useCallback((...incoming: AdvisorTurn[]) => {
    setTurns(current => {
      const known = new Set(current.map(turn => turn.turn_id));
      const next = [...current];
      for (const turn of incoming) {
        if (!known.has(turn.turn_id)) {
          known.add(turn.turn_id);
          next.push(turn);
        }
      }
      return next;
    });
  }, []);

  const contextRefs = useCallback((): AdvisorContextRef => ({
    room_id: roomId,
    ...(selectedMediaId ? {media_id: selectedMediaId} : {}),
    ...(selectedRiskId ? {risk_id: selectedRiskId} : {}),
  }), [roomId, selectedMediaId, selectedRiskId]);

  const loadedAdvisorKeyRef = useRef('');

  const load = useCallback(async (force = false) => {
    if (!session) return;
    const loadKey = `${session.assessment_id}:${roomId}:${query.toString()}`;
    if (!force && loadedAdvisorKeyRef.current === loadKey) return;
    loadedAdvisorKeyRef.current = loadKey;
    try {
      const value = await api.createAdvisorSession(roomId, {
        camera_session_id: query.get('camera_session_id') || undefined,
        context_refs: {
          room_id: roomId,
          ...(query.get('media_id') ? {media_id: query.get('media_id')!} : {}),
          ...(query.get('risk_id') ? {risk_id: query.get('risk_id')!} : {}),
          ...(query.get('solution_id') ? {solution_package_id: query.get('solution_id')!} : {}),
        },
      });
      setBootstrap(value);
      setTurns(value.turns);
      setSelectedMediaId(current => current || value.current_media?.media_id || '');
      setSelectedRiskId(current => current || query.get('risk_id') || value.risks.find(item => item.media_id === query.get('media_id'))?.risk_id || '');
      setError(null);
    } catch (value) {
      if (loadedAdvisorKeyRef.current === loadKey) loadedAdvisorKeyRef.current = '';
      setError(value);
    }
  }, [query, roomId, session]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView?.({behavior: 'smooth', block: 'end'}); }, [partialTranscript, turns.length]);
  useEffect(() => {
    const events = bootstrap?.events;
    if (!bootstrap || !events?.websocket_path || !events.token) return;
    return subscribeAdvisorEvents({roomId, sessionId: bootstrap.session_id, initial: events, onMessage: event => {
      const value = parseAdvisorEvent(event.data);
      if (value?.type === 'turn' && value.turn?.turn_id) appendTurns(value.turn);
    }});
  }, [appendTurns, bootstrap?.events, bootstrap?.session_id, roomId]);
  useEffect(() => () => { void releaseVoice(); }, [releaseVoice]);

  const resetVoiceIdleTimer = () => {
    if (voiceIdleTimerRef.current !== null) window.clearTimeout(voiceIdleTimerRef.current);
    voiceIdleTimerRef.current = window.setTimeout(() => {
      void releaseVoice();
      showToast('90 秒未操作，已自动停止语音监听');
    }, 90_000);
  };

  const appendMessage = async (text: string, requestedAction?: {tool_name: string; arguments?: Record<string, string>}) => {
    const clean = text.trim();
    if (!bootstrap || !clean || busy) return;
    setBusy(true);
    if (voiceRef.current) resetVoiceIdleTimer();
    try {
      const value = await api.advisorMessage(roomId, bootstrap.session_id, clean, contextRefs(), requestedAction);
      appendTurns(value.user_turn, value.assistant_turn);
      setInput('');
    } catch (value) { showToast(friendlyError(value)); }
    finally { setBusy(false); }
  };

  const decide = async (card: AdvisorConfirmationCard, approved: boolean) => {
    if (!bootstrap || decided.has(card.confirmation_id)) return;
    setBusy(true);
    try {
      const value = await api.decideAdvisorConfirmation(roomId, bootstrap.session_id, card.confirmation_id, approved);
      setDecided(current => new Set(current).add(card.confirmation_id));
      appendTurns(value.turn);
      if (approved && card.tool_name === 'start_formal_analysis') navigate(`/analyzing/${roomId}?return_to=advisor`);
      else if (approved) await load(true);
    } catch (value) {
      const typed = value as Error & {code?: string};
      if (typed.code === 'profile_incomplete') navigate(`/profile?return_to=${encodeURIComponent(`/advisor/${roomId}`)}`);
      else if (typed.code === 'advisor_confirmation_in_progress' || typed.code === 'advisor_confirmation_already_decided') {
        void api.analytics('advisor_confirmation_conflict', roomId, {code: typed.code}).catch(() => undefined);
        setDecided(current => new Set(current).add(card.confirmation_id));
        await load(true);
      }
      else showToast(friendlyError(value));
    } finally { setBusy(false); }
  };

  const toggleVoice = async () => {
    if (!bootstrap) return;
    if (voiceState === 'speaking') { await voiceRef.current?.interrupt(); return; }
    if (voiceState !== 'idle' && voiceState !== 'error') {
      await releaseVoice();
      return;
    }
    if (!bootstrap.rtc.available) {
      setVoiceState('error');
      showToast('实时语音尚未配置，可以继续使用文字咨询');
      return;
    }
    let rtc = bootstrap.rtc;
    let ticket = voiceQueueTicketRef.current || readAdvisorRTCTicket(roomId, 'audio');
    if (!ticket || ticket.advisor_session_id !== bootstrap.session_id) {
      try {
        const joined = await api.joinAdvisorRTCQueue(
          roomId, bootstrap.session_id, advisorClientInstanceId(), 'audio',
        );
        if (joined.status === 'unavailable') {
          setVoiceState('error'); showToast('实时语音尚未配置，可以继续使用文字咨询'); return;
        }
        ticket = saveAdvisorRTCTicket(
          roomId, bootstrap.session_id, advisorClientInstanceId(), 'audio', joined,
        );
      } catch (value) { setVoiceState('error'); showToast(friendlyError(value)); return; }
    }
    if (ticket.status === 'queued') {
      const returnTo = `${location.pathname}${location.search}`;
      navigate(
        `/advisor-queue/${roomId}?session_id=${encodeURIComponent(bootstrap.session_id)}`
        + `&mode=audio&return_to=${encodeURIComponent(returnTo)}`,
      );
      return;
    }
    voiceQueueTicketRef.current = ticket;
    if (rtc.requires_start || !rtc.token) {
      try {
        rtc = await api.startAdvisorVoice(
          roomId, bootstrap.session_id, ticket.client_instance_id, ticket.ticket_id,
        );
        setBootstrap(current => current ? {...current, rtc} : current);
      } catch (value) {
        await releaseVoice();
        setVoiceState('error');
        showToast(friendlyError(value));
        return;
      }
    }
    const voice = new AdvisorVoiceRTC(rtc, {
      onState: setVoiceState,
      onPlaybackBlocked: () => showToast('浏览器已暂停顾问声音，点击页面任意位置即可恢复'),
      onTranscript: value => {
        resetVoiceIdleTimer();
        setPartialTranscript(value.final ? '' : value.text);
        if (!value.final || value.role !== 'user') return;
        void appendMessage(value.text);
      },
    });
    voiceRef.current = voice;
    try { await voice.connect({microphone: true}); startVoiceQueueHeartbeat(ticket); resetVoiceIdleTimer(); }
    catch (value) {
      await releaseVoice();
      setVoiceState('error');
      showToast((value as Error).message === 'microphone_denied' ? '麦克风权限未开启，已切换到文字输入' : '实时语音无法连接，可继续文字咨询');
    }
  };

  if (!session) return <Navigate to="/home" replace />;
  if (error) return <ErrorState error={error} retry={load} />;
  if (!bootstrap) return <Loading label="正在准备顾问会话…" />;
  if (bootstrap.phase === 'analyzing') return <Navigate to={`/analyzing/${roomId}`} replace />;
  if (bootstrap.phase !== 'formal') return <Navigate to={`/camera?room_id=${encodeURIComponent(roomId)}`} replace />;
  const phaseLabel = ADVISOR_COPY.formalLabel;
  const activeRisk = bootstrap.risks.find(item => item.risk_id === selectedRiskId);
  const voiceLabel = ADVISOR_COPY.states[voiceState];
  return <section className="advisor-page">
    <header className="advisor-context-header">
      <div><span className={`advisor-phase phase-${bootstrap.phase}`}>{phaseLabel}</span><h1>{bootstrap.room.room_name}·{ADVISOR_COPY.title}</h1></div>
      <span className={`advisor-connection state-${voiceState}`}><i />{voiceLabel}</span>
    </header>

    <section className="advisor-reference-card" aria-labelledby="advisor-reference-title">
      <div className="section-heading"><div><small>当前参考</small><h2 id="advisor-reference-title">{activeRisk?.title || '代表画面'}</h2></div><span>{bootstrap.media.length} 张</span></div>
      {bootstrap.media.length ? <div className="advisor-media-strip">{bootstrap.media.map(media => <AdvisorMediaButton key={media.media_id} media={media} active={media.media_id === selectedMediaId} onClick={() => {
        setSelectedMediaId(media.media_id);
        const matching = bootstrap.risks.find(item => item.media_id === media.media_id);
        setSelectedRiskId(matching?.risk_id || '');
      }} />)}</div> : <p className="muted">尚未保存代表画面，顾问会先引导你补拍。</p>}
    </section>

    <div className="advisor-thread" aria-live="polite">
      {bootstrap.risks.length > 0 && <article className="advisor-bubble assistant advisor-overview-bubble"><p>正式检查共发现 {bootstrap.risks.length} 项有证据支持的风险：</p><AdvisorCardView card={{type: 'risk_summary', risks: bootstrap.risks}} roomId={roomId} decided={decided} onDecide={decide} onSelectRisk={risk => { setSelectedRiskId(risk.risk_id); setSelectedMediaId(risk.media_id); }} onRequestAction={(text, action) => void appendMessage(text, action)} /></article>}
      {turns.map(turn => <article key={turn.turn_id} className={`advisor-bubble ${turn.role}`}><p>{turn.text}</p>{turn.cards.map((card, index) => <AdvisorCardView key={`${turn.turn_id}-${index}`} card={card} roomId={roomId} decided={decided} onDecide={decide} onSelectRisk={risk => { setSelectedRiskId(risk.risk_id); setSelectedMediaId(risk.media_id); }} onRequestAction={(text, action) => void appendMessage(text, action)} />)}<time>{new Date(turn.created_at).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})}</time></article>)}
      {partialTranscript && <article className="advisor-bubble user partial"><p>{partialTranscript}</p><span className="typing-dots" aria-label="正在听"><i /><i /><i /></span></article>}
      <div ref={endRef} />
    </div>

    <p className="advisor-rule-note"><Icon name="verified_user" />{ADVISOR_COPY.formalDisclaimer}</p>
    <div className="advisor-quick-prompts" aria-label="快捷问题">{bootstrap.quick_prompts.map(prompt => <button key={prompt} disabled={busy} onClick={() => void appendMessage(prompt)}>{prompt}</button>)}</div>

    <form className="advisor-composer" onSubmit={event => { event.preventDefault(); void appendMessage(input); }}>
      <div className="advisor-input-row"><input value={input} maxLength={500} onChange={event => setInput(event.target.value)} placeholder={ADVISOR_COPY.inputPlaceholder} aria-label="给 AI 适老顾问的问题" /><button type="submit" className="advisor-send" disabled={!input.trim() || busy} aria-label="发送"><Icon name="arrow_upward" filled /></button><button type="button" className={`advisor-mic state-${voiceState}`} onClick={() => void toggleVoice()} aria-label={voiceLabel}><Icon name={voiceState === 'speaking' ? 'stop' : voiceState !== 'idle' && voiceState !== 'error' ? 'mic_off' : 'mic'} filled /></button></div>
      <small><span>{voiceLabel}</span><span>{ADVISOR_COPY.privacy}</span></small>
    </form>
  </section>;
}

function AdvisorCardView({card, roomId, decided, onDecide, onSelectRisk, onRequestAction}: {card: AdvisorCard; roomId: string; decided: Set<string>; onDecide: (card: AdvisorConfirmationCard, approved: boolean) => void; onSelectRisk: (risk: SafetyRisk) => void; onRequestAction: (text: string, action: {tool_name: string; arguments?: Record<string, string>}) => void}) {
  const navigate = useNavigate();
  if (card.type === 'system_state') return <div className="advisor-system-card"><Icon name="info" /><span><b>{card.label}</b><small>已保存 {card.media_count || 0} 张代表画面</small></span></div>;
  if (card.type === 'temporary_suggestions') return <div className="advisor-card-list temporary">{card.suggestions.map(item => <section key={item.suggestion_id}><i /><div><b>{item.title}</b><p>{item.evidence}</p><small>可能存在·建议确认</small></div></section>)}<p className="advisor-card-disclaimer">{card.disclaimer}</p></div>;
  if (card.type === 'risk_summary') return <div className="advisor-card-list risks">{card.risks.map(risk => <button key={risk.risk_id} onClick={() => { onSelectRisk(risk); navigate(`/risk/${roomId}/${risk.risk_id}`); }}><span className={`severity-dot ${risk.severity}`} /><div><b>{risk.title}</b><small>{risk.severity_label || SEVERITY_COPY[risk.severity]}·{risk.evidence}</small></div><Icon name="chevron_right" /></button>)}</div>;
  if (card.type === 'risk_evidence') return <button className="advisor-evidence-card" onClick={() => navigate(`/risk/${roomId}/${card.risk.risk_id}`)}><span className={`severity-dot ${card.risk.severity}`} /><div><b>{card.risk.title}</b><p>{card.risk.evidence}</p><small>{SEVERITY_COPY[card.risk.severity]}·查看证据位置</small></div><Icon name="open_in_new" /></button>;
  if (card.type === 'solution_options') return <div className="advisor-solutions-card">{card.solutions.map(solution => <section key={solution.solution_package_id} className={solution.tier === 'B' ? 'recommended' : ''}><header><span>{solution.tier}</span><div><b>{solution.title}</b><small>{solution.construction_required ? '需要施工' : '无需施工'}·{solution.duration}</small></div></header><p>{solution.summary}</p><strong>{formatRange(solution.price.total_min, solution.price.total_max, solution.price.currency)}</strong>{solution.limitations.length ? <small>限制：{solution.limitations.join('；')}</small> : null}<button className="button secondary full" onClick={() => onRequestAction(`把 ${solution.tier} 方案加入清单`, {tool_name: 'select_solution', arguments: {risk_id: card.risk_id, solution_package_id: solution.solution_package_id}})}>{card.selected_solution_package_id === solution.solution_package_id ? '已在清单' : '请求加入清单'}</button></section>)}<p className="advisor-card-disclaimer">{card.price_disclaimer}</p></div>;
  if (card.type === 'budget') return <div className="advisor-budget-card"><small>已选项目去重后预算</small><b>{formatRange(card.total_min, card.total_max, card.currency)}</b><div><span>材料 {formatRange(card.material_min, card.material_max, card.currency)}</span><span>人工 {formatRange(card.labor_min, card.labor_max, card.currency)}</span></div><p>{card.disclaimer}</p></div>;
  if (card.type === 'confirmation') {
    const isDone = card.status !== 'pending' || decided.has(card.confirmation_id);
    const stateLabel = card.status === 'processing' ? '处理中' : card.status === 'failed' ? '未完成' : isDone ? '已处理' : '确认';
    return <div className="advisor-confirmation-card"><Icon name="task_alt" filled /><div><b>需要你确认</b><p>{card.label}</p></div><div><button className="button primary" disabled={isDone} onClick={() => onDecide(card, true)}>{stateLabel}</button><button className="button quiet" disabled={isDone} onClick={() => onDecide(card, false)}>拒绝</button></div></div>;
  }
  return null;
}

function RiskPage() {
  const {roomId = '', riskId = ''} = useParams();
  const navigate = useNavigate();
  const {session, assessment} = useApp();
  const onboarding = useOnboarding();
  const assessmentState = useAssessment();
  const resultState = useRoomResult(roomId);
  const [zoom, setZoom] = useState(1);
  const pendingResult = resultState.result;
  const pendingIndex = pendingResult ? Math.max(0, pendingResult.risks.findIndex(item => item.risk_id === riskId)) : 0;
  const pendingRisk = pendingResult?.risks[pendingIndex];
  const pendingMedia = assessment?.rooms.find(item => item.room_id === roomId)?.media.find(item => item.media_id === pendingRisk?.media_id);
  const {url} = useProtectedImage(pendingMedia?.content_path);
  if (!session) return <Navigate to="/home" replace />;
  if ((assessmentState.loading && !assessment) || resultState.loading || !resultState.result) return <Loading />;
  if (assessmentState.error || resultState.error) return <ErrorState error={assessmentState.error || resultState.error} retry={() => { assessmentState.reload(); resultState.reload(); }} />;
  const result = resultState.result;
  const index = Math.max(0, result.risks.findIndex(item => item.risk_id === riskId));
  const risk = result.risks[index];
  if (!risk) return <ErrorState error={new Error('没有找到这项风险')} />;
  const switchRisk = (next: number) => navigate(`/risk/${roomId}/${result.risks[next].risk_id}`, {replace: true});
  return <section className="risk-page">
    <div className="risk-toolbar"><span className="glass-chip"><Icon name="cloud_done" filled />AI 已识别 {result.risks.length} 处风险</span><button className="glass-button" onClick={() => setZoom(value => value >= 1.8 ? 1 : value + 0.2)} aria-label="放大照片"><Icon name={zoom > 1 ? 'zoom_out_map' : 'zoom_in'} /></button></div>
    <RiskOverlay imageUrl={url} fallbackUrl={`${ASSETS}/risk-bathroom.jpg`} risks={[risk]} mediaId={risk.media_id} activeId={risk.risk_id} numberById={Object.fromEntries(result.risks.map((item, itemIndex) => [item.risk_id, itemIndex + 1]))} zoom={zoom} drawing={false} onSelect={() => undefined} onRegionChange={() => undefined} />
    <div className="risk-switcher"><button disabled={index === 0} onClick={() => switchRisk(index - 1)}><Icon name="chevron_left" /></button><span>风险 {index + 1} / {result.risks.length}</span><button disabled={index === result.risks.length - 1} onClick={() => switchRisk(index + 1)}><Icon name="chevron_right" /></button></div>
    <article className="risk-detail"><span className={`severity ${risk.severity}`}><Icon name="warning" filled />{SEVERITY_COPY[risk.severity]}</span><h1>{risk.title}</h1><p>{risk.evidence}</p><small>参考扣分 {risk.score_deduction} 分 · {risk.region ? '已标出可参考位置' : '位置仍待确认'}</small><div className="button-stack"><button data-onboarding-target="risk-solution" className="button primary full" onClick={() => { if (onboarding.active) onboarding.completePhase('risk', 'solutions'); navigate(`/solutions/${roomId}/${risk.risk_id}`); }}><Icon name="location_on" filled />查看解决方案</button><button className="button secondary full" onClick={() => navigate(`/advisor/${roomId}?risk_id=${encodeURIComponent(risk.risk_id)}&media_id=${encodeURIComponent(risk.media_id)}`)}><Icon name="forum" />问问 AI 顾问</button></div></article>
  </section>;
}

function SolutionsPage() {
  const {roomId = '', riskId = ''} = useParams();
  const navigate = useNavigate();
  const {session, assessment, showToast} = useApp();
  const onboarding = useOnboarding();
  const assessmentState = useAssessment();
  const resultState = useRoomResult(roomId);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.solutions>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    setData(null);
    return api.solutions(riskId).then(value => { setData(value); setError(null); }).catch(setError);
  }, [riskId]);
  const riskAvailable = Boolean(resultState.result?.risks.some(item => item.risk_id === riskId));
  useEffect(() => {
    if (session && !resultState.loading && riskAvailable) load();
  }, [load, resultState.loading, riskAvailable, session]);
  useEffect(() => {
    if (resultState.loading || !resultState.result || resultState.result.risks.some(item => item.risk_id === riskId)) return;
    const latest = resultState.result.risks[0];
    showToast('分析结果已更新，已打开最新风险');
    navigate(latest ? `/solutions/${roomId}/${latest.risk_id}` : `/result/${roomId}`, {replace: true});
  }, [navigate, resultState.loading, resultState.result, riskId, roomId, showToast]);
  if (!session) return <Navigate to="/home" replace />;
  if (assessmentState.loading || resultState.loading || !data) return error ? <ErrorState error={error} retry={load} /> : <Loading />;
  const risk = resultState.result?.risks.find(item => item.risk_id === riskId);
  if (!risk) return <ErrorState error={new Error('没有找到这项风险')} />;
  const riskIndex = resultState.result?.risks.findIndex(item => item.risk_id === riskId) ?? -1;
  const nextRisk = resultState.result?.risks[riskIndex + 1];
  const media = (assessment || assessmentState.assessment)?.rooms.find(item => item.room_id === roomId)?.media.find(item => item.media_id === risk.media_id);
  const select = async (solution: SolutionPackage) => {
    setBusy(solution.solution_package_id);
    try {
      if (data.selected_solution_package_id === solution.solution_package_id) await api.removeSolution(riskId);
      else await api.selectSolution(riskId, solution.solution_package_id);
      await load();
      if (onboarding.active) onboarding.completePhase('solutions', 'report');
      showToast(data.selected_solution_package_id === solution.solution_package_id ? '已从清单移除' : '已加入改造清单');
    } catch (value) { showToast(friendlyError(value)); }
    finally { setBusy(''); }
  };
  return <section className="page solutions-page">
    <div className="page-intro"><h1>{risk.title}怎么改？</h1></div>
    <ProtectedImage media={media} fallback={`${ASSETS}/solution-shower.jpg`} className="solution-hero" />
    <p className="solution-observation">发现现有环境中缺少可靠支撑，建议根据家庭条件选择适合的改造方式。</p>
    <div className="solution-list" data-onboarding-target="solution-options">{data.solutions.map(solution => {
      const selected = data.selected_solution_package_id === solution.solution_package_id;
      return <article key={solution.solution_package_id} className={`solution-card tier-${solution.tier} ${solution.tier === 'B' ? 'recommended' : ''} ${selected ? 'selected' : ''}`}>
        <div className="solution-title"><span className="tier-icon"><Icon name={solution.tier === 'A' ? 'timer' : solution.tier === 'B' ? 'thumb_up' : 'construction'} filled /></span><div><small>{solution.tier === 'A' ? '临时止险' : solution.tier === 'B' ? '推荐方案' : '专业改造'}</small><h2>{solution.title}</h2></div>{solution.tier === 'B' && <span className="best-value">BEST VALUE</span>}</div>
        <p>{solution.summary}</p>
        <div className="solution-price">{formatRange(solution.price.total_min, solution.price.total_max, solution.price.currency)}</div>
        <div className="chip-row"><span>{solution.duration}</span><span>{solution.construction_required ? '需要施工' : '无需施工'}</span><span>改善程度 {solution.improvement}</span></div>
        <details className="solution-more"><summary>查看费用、实施与限制</summary>
          <div className="price-breakdown"><span>材料</span><b>{formatRange(solution.price.material_min, solution.price.material_max, solution.price.currency)}</b><span>人工</span><b>{formatRange(solution.price.labor_min, solution.price.labor_max, solution.price.currency)}</b><span>其他</span><b>{formatRange(solution.price.other_min, solution.price.other_max, solution.price.currency)}</b></div>
          <p><b>具体动作：</b>{solution.actions.join('；')}</p>
          <p><b>安装建议：</b>{solution.professional_installation} · 难度 {DIFFICULTY_COPY[solution.difficulty] || '需现场确认'}</p>
          <p><b>预计提升：</b>{solution.expected_score_gain_min}—{solution.expected_score_gain_max} 分（由服务端重新计算）</p>
          {solution.price.included?.length ? <p><b>费用包含：</b>{solution.price.included.join('、')}</p> : null}
          {solution.price.excluded?.length ? <p><b>不包含：</b>{solution.price.excluded.join('、')}</p> : null}
          {solution.limitations.length ? <p><b>限制：</b>{solution.limitations.join('；')}</p> : null}
        </details>
        <button className={`button full ${selected ? 'secondary' : 'primary'}`} disabled={Boolean(busy)} onClick={() => select(solution)}>{busy === solution.solution_package_id ? '正在保存…' : selected ? '已加入，点击移除' : '加入改造清单'}</button>
      </article>;
    })}</div>
    <details className="detail-card" open><summary>改造详情</summary><div className="detail-grid"><span><Icon name="handyman" />改造难度</span><b>{DIFFICULTY_COPY[data.solutions.find(item => item.solution_package_id === data.selected_solution_package_id)?.difficulty || ''] || '选择后查看'}</b><span><Icon name="schedule" />预计处理时间</span><b>{data.solutions.find(item => item.solution_package_id === data.selected_solution_package_id)?.duration || '视方案而定'}</b><span><Icon name="engineering" />是否建议专业安装</span><b>{data.solutions.find(item => item.solution_package_id === data.selected_solution_package_id)?.professional_installation || '视方案而定'}</b></div></details>
    <p className="fine-print">{data.price_disclaimer}</p>
    <div className="button-stack"><button className="button secondary full" onClick={() => navigate(`/advisor/${roomId}?risk_id=${encodeURIComponent(riskId)}`)}><Icon name="forum" />问问 AI 顾问</button><button className="button secondary full" onClick={() => navigate(nextRisk ? `/risk/${roomId}/${nextRisk.risk_id}` : `/result/${roomId}`)}>{nextRisk ? '继续查看下一个问题' : '返回检查结果'}<Icon name="arrow_forward" /></button><button data-onboarding-target="solutions-report" className="button quiet full" onClick={() => { if (onboarding.active) onboarding.completePhase('solutions', 'report'); navigate('/report'); }}>查看改造清单</button></div>
  </section>;
}

function SelectedSolutionPage() {
  const {roomId = '', riskId = '', solutionId = ''} = useParams();
  const navigate = useNavigate();
  const {session, assessment} = useApp();
  const assessmentState = useAssessment();
  const resultState = useRoomResult(roomId);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.solutions>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!session || resultState.loading || !resultState.result?.risks.some(item => item.risk_id === riskId)) return;
    const controller = new AbortController();
    api.solutions(riskId, controller.signal).then(value => { setData(value); setError(null); }).catch(value => { if ((value as Error).name !== 'AbortError') setError(value); });
    return () => controller.abort();
  }, [resultState.loading, resultState.result, riskId, session]);
  if (!session) return <Navigate to="/home" replace />;
  if (assessmentState.loading || resultState.loading || !data) return error ? <ErrorState error={error} /> : <Loading />;
  const risk = resultState.result?.risks.find(item => item.risk_id === riskId);
  const solution = data.solutions.find(item => item.solution_package_id === solutionId);
  if (!risk || !solution) return <ErrorState error={new Error('没有找到这项已选方案')} />;
  const media = (assessment || assessmentState.assessment)?.rooms.find(item => item.room_id === roomId)?.media.find(item => item.media_id === risk.media_id);
  return <section className="page selected-solution-page">
    <div className="page-intro"><small className="eyebrow">已选改造方案</small><h1>{solution.title}</h1><p>对应问题：{risk.title}</p></div>
    <ProtectedImage media={media} fallback={`${ASSETS}/solution-shower.jpg`} className="solution-hero" />
    <article className="selected-solution-detail">
      <div className="solution-title"><span className="tier-icon"><Icon name={solution.tier === 'A' ? 'timer' : solution.tier === 'B' ? 'thumb_up' : 'construction'} filled /></span><div><small>{solution.tier === 'A' ? '临时止险' : solution.tier === 'B' ? '推荐方案' : '专业改造'}</small><h2>{solution.summary}</h2></div></div>
      <div className="solution-price">{formatRange(solution.price.total_min, solution.price.total_max, solution.price.currency)}</div>
      <div className="chip-row"><span>{solution.duration}</span><span>{solution.construction_required ? '需要施工' : '无需施工'}</span><span>改善程度 {solution.improvement}</span></div>
      <section><h3>具体怎么做</h3><ol>{solution.actions.map(action => <li key={action}>{action}</li>)}</ol></section>
      <section><h3>费用明细</h3><div className="price-breakdown"><span>材料</span><b>{formatRange(solution.price.material_min, solution.price.material_max, solution.price.currency)}</b><span>人工</span><b>{formatRange(solution.price.labor_min, solution.price.labor_max, solution.price.currency)}</b><span>其他</span><b>{formatRange(solution.price.other_min, solution.price.other_max, solution.price.currency)}</b></div></section>
      <section><h3>实施说明</h3><p>{solution.professional_installation} · 难度 {DIFFICULTY_COPY[solution.difficulty] || '需现场确认'}</p>{solution.limitations.length ? <p><b>限制：</b>{solution.limitations.join('；')}</p> : null}</section>
    </article>
    <p className="fine-print">{data.price_disclaimer}</p>
    <div className="button-stack"><button className="button secondary full" onClick={() => navigate(`/solutions/${roomId}/${riskId}`)}>更换方案</button><button className="button quiet full" onClick={() => navigate('/report')}>返回改造清单</button></div>
  </section>;
}

function RenovationSourceOption({item, selected, onSelect}: {item: RenovationPreviewContext['eligible_media'][number]; selected: boolean; onSelect: () => void}) {
  const {url, loading} = useProtectedImage(item.content_path);
  return <button className={`renovation-source-option ${selected ? 'selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
    <span>{loading ? <span className="spinner" /> : <img src={url || `${ASSETS}/demo-upload-floor.jpg`} alt="候选房间原图" />}</span>
    <small>{item.recommended ? '推荐原图' : '其他视角'}{item.selected_risk_evidence_count ? ` · 覆盖 ${item.selected_risk_evidence_count} 项` : ''}</small>
    {selected && <Icon name="check_circle" filled />}
  </button>;
}

function RenovationComparison({preview}: {preview: RenovationPreview}) {
  const {url: beforeUrl} = useProtectedImage(preview.before_content_path);
  const {url: afterUrl} = useProtectedImage(preview.after_content_path || undefined);
  const [beforePercent, setBeforePercent] = useState(50);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({width: 1, height: 1});
  const [naturalSize, setNaturalSize] = useState({width: 1, height: 1});
  const locatedActions = useMemo(() => preview.visualized_actions.filter(action => action.region && typeof action.region.width === 'number'), [preview.visualized_actions]);
  const metrics = useMemo(
    () => coverMetrics(stageSize.width, stageSize.height, naturalSize.width, naturalSize.height),
    [naturalSize, stageSize],
  );
  useEffect(() => {
    if (!stageRef.current) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) setStageSize({width: rect.width, height: rect.height});
    });
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, []);
  return <section className="renovation-comparison" aria-label="改造前后效果对比">
    <div className="renovation-compare-stage" ref={stageRef}>
      <img src={afterUrl || beforeUrl || `${ASSETS}/solution-shower.jpg`} alt="AI 生成的改造后效果示意" onLoad={event => setNaturalSize({width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight})} />
      <div className="renovation-before-layer" style={{clipPath: `inset(0 ${100 - beforePercent}% 0 0)`}}><img src={beforeUrl || `${ASSETS}/solution-shower.jpg`} alt="改造前原始房间照片" /></div>
      {locatedActions.length ? <svg
        className="renovation-detail-overlay"
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
        role="img"
        aria-label={`AI 改造细节位置，共 ${locatedActions.length} 处`}
        style={{clipPath: `inset(0 0 0 ${beforePercent}%)`}}
      >
        {locatedActions.map((action, index) => {
          const region = action.region!;
          const topLeft = mapImagePoint([region.x, region.y], metrics);
          const bottomRight = mapImagePoint([region.x + region.width, region.y + region.height], metrics);
          const x = topLeft[0] * 1000, y = topLeft[1] * 1000;
          const width = (bottomRight[0] - topLeft[0]) * 1000, height = (bottomRight[1] - topLeft[1]) * 1000;
          const pinX = Math.max(28, Math.min(972, x + 24));
          const pinY = Math.max(28, Math.min(972, y + 24));
          return <g key={`${action.action_code}-${index}`} aria-label={`改造细节 ${index + 1}：${action.label}`}>
            <title>{`改造细节 ${index + 1}：${action.label}`}</title>
            <rect className="renovation-detail-box" x={x} y={y} width={width} height={height} rx="18" />
            <circle className="renovation-detail-pin" cx={pinX} cy={pinY} r="24" />
            <text className="renovation-detail-number" x={pinX} y={pinY}>{index + 1}</text>
          </g>;
        })}
      </svg> : null}
      <span className="compare-label before">改造前</span><span className="compare-label after">AI 效果示意</span>
      <i className="compare-handle" style={{left: `${beforePercent}%`}} aria-hidden="true" />
    </div>
    {locatedActions.length ? <ol className="renovation-detail-list" aria-label="已定位的改造细节">
      {locatedActions.map((action, index) => <li key={`${action.action_code}-${index}`}><span>{index + 1}</span><div><b>{action.label}</b>{action.risk_title ? <small>对应：{action.risk_title}</small> : null}</div></li>)}
    </ol> : <p className="renovation-grounding-note"><Icon name="location_off" />未能可靠定位生成细节，因此没有显示框选。</p>}
    <label className="renovation-range"><span>拖动查看前后差异</span><input type="range" min="0" max="100" value={beforePercent} onChange={event => setBeforePercent(Number(event.target.value))} aria-label="显示改造前照片的比例" /></label>
    <div className="renovation-view-buttons"><button className="button secondary" onClick={() => setBeforePercent(100)}>查看改造前</button><button className="button secondary" onClick={() => setBeforePercent(0)}>查看改造后</button></div>
  </section>;
}

function RenovationPreviewPage() {
  const {roomId = ''} = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const {session, showToast} = useApp();
  const [data, setData] = useState<RenovationPreviewContext | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState('');
  const [preview, setPreview] = useState<RenovationPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const returnTo = new URLSearchParams(location.search).get('return_to') === '/renovations' ? '/renovations' : '/report';
  const load = useCallback(async () => {
    try {
      const value = await api.renovationPreviewContext(roomId);
      setData(value); setError(null);
      setSelectedMediaId(current => current && value.eligible_media.some(item => item.media_id === current)
        ? current : value.eligible_media.find(item => item.recommended)?.media_id || value.eligible_media[0]?.media_id || '');
      setPreview(current => {
        if (current && value.previews.some(item => item.preview_id === current.preview_id)) return value.previews.find(item => item.preview_id === current.preview_id) || current;
        return value.previews.find(item => item.status === 'queued' || item.status === 'running')
          || value.previews.find(item => item.selected_for_report && !item.stale)
          || value.previews.find(item => item.status === 'completed' && !item.stale)
          || value.previews.find(item => item.status === 'completed')
          || null;
      });
    } catch (value) { setError(value); }
  }, [roomId]);
  useEffect(() => { if (session) load(); }, [load, session]);
  useEffect(() => {
    if (!preview || !['queued', 'running'].includes(preview.status)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.renovationPreview(roomId, preview.preview_id, controller.signal).then(value => {
        setPreview(value);
        if (['completed', 'failed'].includes(value.status)) load();
      }).catch(value => { if ((value as Error).name !== 'AbortError') setError(value); });
    }, 1200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [load, preview, roomId]);
  if (!session) return <Navigate to="/home" replace />;
  if (error && !data) return <ErrorState error={error} retry={load} />;
  if (!data) return <Loading label="正在准备改造方案…" />;
  const roomName = ROOM_COPY[data.room_type].name;
  const visualActions = data.selected_solutions.flatMap(item => item.visualizable_actions);
  const nonVisualActions = data.selected_solutions.filter(item => !item.visualizable_actions.length).flatMap(item => item.actions);
  const generate = async () => {
    if (!selectedMediaId) return;
    setBusy(true);
    try { setPreview(await api.createRenovationPreview(roomId, selectedMediaId)); setError(null); }
    catch (value) { showToast(friendlyError(value)); setError(value); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      setPreview(await api.selectRenovationPreview(roomId, preview.preview_id));
      showToast('改造效果已保存到报告');
      navigate(returnTo);
    } catch (value) { showToast(friendlyError(value)); }
    finally { setBusy(false); }
  };
  if (!data.selected_solutions.length) return <section className="page center-state"><Icon name="playlist_add" className="state-icon" /><h1>还没有已选方案</h1><p>先为这个房间选择至少一项 A/B/C 改造方案，再生成整体效果。</p><button className="button primary" onClick={() => navigate(`/result/${roomId}`)}>返回检查结果</button></section>;
  return <section className="page renovation-preview-page">
    <div className="page-intro"><small className="eyebrow">{roomName} · AI 效果示意</small><h1>{RENOVATION_PREVIEW_COPY.title}</h1><p>{RENOVATION_PREVIEW_COPY.intro}</p></div>
    <section className="renovation-plan-summary"><div className="section-heading"><h2>本次要展示的改造</h2><span>{data.selected_solutions.length} 项方案</span></div>{data.selected_solutions.map(item => <article key={item.risk_id}><span>{item.tier} 档</span><div><b>{item.risk_title}</b><p>{item.summary}</p></div></article>)}
      {visualActions.length ? <ul className="visual-action-list">{visualActions.map(action => <li key={`${action.risk_id}-${action.action_code}`}><Icon name="visibility" />{action.label}</li>)}</ul> : <p className="empty-copy">当前方案没有适合在图片中可靠表达的动作。</p>}
      {nonVisualActions.length ? <p className="nonvisual-note"><Icon name="info" />{nonVisualActions.join('、')}已纳入清单，但不适合在效果图中表达。</p> : null}
    </section>
    <section><div className="section-heading"><h2>选择一张原图</h2><span>生成前请确认</span></div>{data.eligible_media.length ? <div className="renovation-source-list">{data.eligible_media.map(item => <RenovationSourceOption key={item.media_id} item={item} selected={selectedMediaId === item.media_id} onSelect={() => setSelectedMediaId(item.media_id)} />)}</div> : <p className="empty-copy">没有质量合格的原始房间照片，请返回补拍。</p>}</section>
    {preview && ['queued', 'running'].includes(preview.status) && <section className="renovation-generating" role="status" aria-live="polite"><span className="spinner" /><h2>正在生成{roomName}改造效果</h2><p>可以离开本页，稍后回来继续查看；已选方案和评分不会受影响。</p></section>}
    {preview?.status === 'failed' && <section className="error-panel" role="alert"><b>效果图没有生成完成</b><p>{friendlyError({code: preview.error, message: preview.error || ''})}</p><button className="button primary full" disabled={busy} onClick={generate}>重新生成</button></section>}
    {preview?.status === 'completed' && <><RenovationComparison preview={preview} />{preview.stale && <div className="stale-preview" role="status"><Icon name="update" /><div><b>改造方案已经更新</b><p>这张旧效果图不会继续显示在报告中，请按当前方案重新生成。</p></div></div>}{preview.skipped_actions.length ? <p className="nonvisual-note"><Icon name="info" />未在图片中表达：{preview.skipped_actions.join('、')}</p> : null}<div className="button-stack"><button className="button primary full" disabled={busy || preview.stale} onClick={save}><Icon name="bookmark_add" filled />{preview.selected_for_report ? '已保存到报告' : RENOVATION_PREVIEW_COPY.save}</button><button className="button secondary full" disabled={busy} onClick={generate}>重新生成一个版本</button></div></>}
    {!preview && <button className="button primary full" disabled={busy || !selectedMediaId || !visualActions.length} onClick={generate}><Icon name="auto_awesome" filled />{busy ? '正在开始…' : RENOVATION_PREVIEW_COPY.generate}</button>}
    <p className="fine-print renovation-disclaimer"><Icon name="info" />{data.disclaimer || RENOVATION_PREVIEW_COPY.disclaimer}</p>
    <button className="button quiet full" onClick={() => navigate(returnTo)}>{returnTo === '/renovations' ? '返回改造方案' : '返回改造清单'}</button>
  </section>;
}

function ReportRenovationImage({preview}: {preview: RenovationPreview}) {
  const {url} = useProtectedImage(preview.after_content_path || undefined);
  return <img src={url || `${ASSETS}/solution-shower.jpg`} alt="已保存的 AI 改造效果示意" />;
}

function ReportRenovationSection({report}: {report: AssessmentReport}) {
  const navigate = useNavigate();
  const {capabilities} = useApp();
  if (!capabilities?.renovation_preview || !report.selected_items.length) return null;
  const roomByRisk = new Map(report.rooms.flatMap(room => room.risks.map(risk => [risk.risk_id, room] as const)));
  const roomCounts = new Map<string, number>();
  report.selected_items.forEach(item => {
    const room = roomByRisk.get(item.risk_id);
    if (room) roomCounts.set(room.room_id, (roomCounts.get(room.room_id) || 0) + 1);
  });
  const previewByRoom = new Map((report.renovation_previews || []).map(item => [item.room_id, item]));
  return <section className="report-renovation-section"><div className="report-section-title"><span>效果</span><div><h2>改造后的样子</h2><p>按房间汇总已选方案，生成 AI 效果示意</p></div></div><div className="report-renovation-grid">{[...roomCounts].map(([roomId, count]) => {
    const room = report.rooms.find(item => item.room_id === roomId);
    const preview = previewByRoom.get(roomId);
    return <article key={roomId} className="report-renovation-card">{preview ? <ReportRenovationImage preview={preview} /> : <span className="renovation-card-placeholder"><Icon name="auto_awesome" /></span>}<div><small>{room ? ROOM_COPY[room.room_type].name : '房间'} · {count} 项已选方案</small><h3>{preview ? '已保存改造效果' : '还没有生成效果图'}</h3><p>{preview ? '效果图与当前已选方案一致。' : '确认一张原图后，可预览整体改造后的样子。'}</p><button className={`button full ${preview ? 'secondary' : 'primary'}`} onClick={() => navigate(`/renovation-preview/${roomId}`)}>{preview ? '查看或重新生成' : '看看改造后的样子'}</button></div></article>;
  })}</div><p className="fine-print"><Icon name="info" />{RENOVATION_PREVIEW_COPY.disclaimer}</p></section>;
}

function ReportDetails({report}: {report: AssessmentReport}) {
  const risks = report.rooms.flatMap(room => room.risks.map(risk => ({...risk, roomName: ROOM_COPY[room.room_type].name})));
  const recommendationByRisk = new Map((report.recommendations || []).map(item => [item.risk_id, item]));
  return <>
    <section className="report-dimension"><div className="report-section-title"><span>01</span><div><h2>存在的隐患</h2><p>共发现 {risks.length} 个有图像证据的问题</p></div></div>
      <div className="report-risk-list">{risks.length ? risks.map(risk => <article key={risk.risk_id} className={`report-risk-row ${risk.severity}`}><div><span className="severity-label">{SEVERITY_COPY[risk.severity]}</span><small>{risk.roomName}</small></div><h3>{risk.title}</h3><p>{risk.evidence}</p></article>) : <p className="empty-copy">当前已检查区域暂未发现明确隐患</p>}</div>
    </section>
    <section className="report-dimension"><div className="report-section-title"><span>02</span><div><h2>改造建议与预算</h2><p>预算来自结构化价格规则，仅供规划参考</p></div></div>
      <div className="report-recommendations">{risks.length ? risks.map(risk => {
        const recommendation = recommendationByRisk.get(risk.risk_id);
        const visibleSolutions = recommendation?.selected_solution_package_id
          ? recommendation.solutions.filter(solution => solution.solution_package_id === recommendation.selected_solution_package_id)
          : recommendation?.solutions || [];
        return <article key={risk.risk_id} className="report-recommendation"><div className="recommendation-heading"><div><small>{risk.roomName} · 对应隐患</small><h3>{risk.title}</h3></div></div>
          {visibleSolutions.length ? <div className="report-solution-options">{visibleSolutions.map(solution => <section key={solution.solution_package_id}><div className="recommendation-heading"><p className="recommendation-name"><span>{solution.tier} 档</span>{solution.title}</p><b>{formatRange(solution.price.total_min, solution.price.total_max, solution.price.currency)}</b></div><p>{solution.summary}</p><ol>{solution.actions.map(action => <li key={action}>{action}</li>)}</ol><div className="recommendation-meta"><span>材料 {formatRange(solution.price.material_min, solution.price.material_max, solution.price.currency)}</span><span>人工 {formatRange(solution.price.labor_min, solution.price.labor_max, solution.price.currency)}</span><span>{solution.duration}</span></div>{solution.limitations.length ? <p className="recommendation-limit">实施前确认：{solution.limitations.join('；')}</p> : null}</section>)}</div> : <p className="unselected-solution">暂时没有可展示的改造方案。</p>}
        </article>;
      }) : <p className="empty-copy">暂无需要列入报告的改造建议</p>}</div>
    </section>
    <p className="fine-print">{report.price_disclaimer}</p>
  </>;
}

function drawWrappedText(context: CanvasRenderingContext2D, value: string, x: number, y: number, maxWidth: number, lineHeight: number) {
  let line = '';
  for (const character of Array.from(value)) {
    const next = line + character;
    if (line && context.measureText(next).width > maxWidth) {
      context.fillText(line, x, y);
      line = character;
      y += lineHeight;
    } else line = next;
  }
  if (line) context.fillText(line, x, y);
  return y + lineHeight;
}

async function loadReportImage(path: string): Promise<{image: HTMLImageElement; url: string}> {
  const blob = await api.mediaBlob(path);
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('效果图加载失败'));
      image.src = url;
    });
    return {image, url};
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function drawCoverImage(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.naturalWidth - sourceWidth) / 2;
  const sourceY = (image.naturalHeight - sourceHeight) / 2;
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

async function createReportImage(report: AssessmentReport): Promise<Blob> {
  await document.fonts?.ready;
  const risks = report.rooms.flatMap(room => room.risks.map(risk => ({...risk, roomName: ROOM_COPY[room.room_type].name})));
  const recommendationByRisk = new Map((report.recommendations || []).map(item => [item.risk_id, item]));
  const visibleSolutions = (riskId: string) => {
    const item = recommendationByRisk.get(riskId);
    if (!item) return [];
    return item.selected_solution_package_id ? item.solutions.filter(solution => solution.solution_package_id === item.selected_solution_package_id) : item.solutions;
  };
  const previewImages: Array<{preview: RenovationPreview; before: HTMLImageElement; after: HTMLImageElement; urls: string[]}> = [];
  for (const preview of report.renovation_previews || []) {
    if (!preview.after_content_path) continue;
    const loaded: Array<{image: HTMLImageElement; url: string}> = [];
    try {
      const before = await loadReportImage(preview.before_content_path); loaded.push(before);
      const after = await loadReportImage(preview.after_content_path); loaded.push(after);
      previewImages.push({preview, before: before.image, after: after.image, urls: [before.url, after.url]});
    } catch {
      loaded.forEach(item => URL.revokeObjectURL(item.url));
      /* The textual report remains shareable if one protected preview cannot be loaded. */
    }
  }
  const contentHeight = 760 + risks.length * 190 + risks.reduce((sum, risk) => sum + visibleSolutions(risk.risk_id).reduce((solutionSum, solution) => solutionSum + 250 + solution.actions.length * 45, 100), 0) + previewImages.length * 570;
  const canvas = document.createElement('canvas');
  canvas.width = 1242;
  canvas.height = Math.max(1754, contentHeight);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法生成报告图片');
  const left = 90;
  const width = canvas.width - left * 2;
  context.fillStyle = '#fffbe2';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#443d1f';
  context.font = '700 34px "Noto Sans SC", sans-serif';
  context.fillText(PRODUCT_NAME, left, 95);
  context.font = '800 58px "Noto Sans SC", sans-serif';
  context.fillText('居家安全检查报告', left, 180);
  context.font = '400 25px "Noto Sans SC", sans-serif';
  context.fillStyle = '#6f6848';
  context.fillText(`已检查 ${report.checked_room_count} 个房间 · 覆盖度 ${report.coverage_percent}%`, left, 232);
  const metricY = 278;
  context.fillStyle = '#fffef8';
  context.fillRect(left, metricY, width, 180);
  context.fillStyle = '#6f6848';
  context.font = '400 23px "Noto Sans SC", sans-serif';
  context.fillText(report.score_title, left + 36, metricY + 50);
  context.fillText('发现隐患', left + 400, metricY + 50);
  context.fillText('已选改造方案', left + 730, metricY + 50);
  context.fillStyle = '#27240f';
  context.font = '800 52px "Noto Sans SC", sans-serif';
  context.fillText(String(report.assessed_area_score ?? '—'), left + 36, metricY + 125);
  context.fillText(`${risks.length} 个`, left + 400, metricY + 125);
  context.fillText(`${report.selected_items.length} 项`, left + 730, metricY + 125);
  let y = 535;
  const sectionTitle = (number: string, title: string, subtitle: string) => {
    context.fillStyle = '#443d1f';
    context.font = '800 28px "Noto Sans SC", sans-serif';
    context.fillText(number, left, y);
    context.font = '800 40px "Noto Sans SC", sans-serif';
    context.fillText(title, left + 70, y);
    context.fillStyle = '#6f6848';
    context.font = '400 22px "Noto Sans SC", sans-serif';
    context.fillText(subtitle, left + 70, y + 38);
    y += 88;
  };
  sectionTitle('01', '存在的隐患', `共发现 ${risks.length} 个有图像证据的问题`);
  if (!risks.length) {
    context.fillStyle = '#6f6848'; context.font = '400 25px "Noto Sans SC", sans-serif'; context.fillText('当前已检查区域暂未发现明确隐患', left + 28, y + 45); y += 110;
  }
  risks.forEach(risk => {
    context.fillStyle = risk.severity === 'high' ? '#fff0ed' : risk.severity === 'medium' ? '#fff3cd' : '#eef4fb';
    context.fillRect(left, y, width, 150);
    context.fillStyle = risk.severity === 'high' ? '#a51018' : risk.severity === 'medium' ? '#6b5100' : '#31445c';
    context.font = '700 22px "Noto Sans SC", sans-serif'; context.fillText(`${SEVERITY_COPY[risk.severity]} · ${risk.roomName}`, left + 28, y + 40);
    context.fillStyle = '#27240f'; context.font = '800 29px "Noto Sans SC", sans-serif'; context.fillText(risk.title, left + 28, y + 80);
    context.fillStyle = '#625e48'; context.font = '400 21px "Noto Sans SC", sans-serif'; drawWrappedText(context, risk.evidence, left + 28, y + 116, width - 56, 28);
    y += 170;
  });
  y += 32;
  sectionTitle('02', '改造建议', '未选择时展示 A/B/C 三档，选择后仅展示所选方案');
  risks.forEach(risk => {
    context.fillStyle = '#6f6848'; context.font = '700 22px "Noto Sans SC", sans-serif'; context.fillText(`${risk.roomName} · ${risk.title}`, left, y + 30); y += 52;
    const solutions = visibleSolutions(risk.risk_id);
    if (!solutions.length) { context.fillStyle = '#625e48'; context.font = '400 24px "Noto Sans SC", sans-serif'; context.fillText('暂时没有可展示的改造方案', left + 28, y + 44); y += 100; return; }
    solutions.forEach(solution => {
      const boxHeight = 210 + solution.actions.length * 45;
      context.fillStyle = '#fffef8'; context.fillRect(left, y, width, boxHeight);
      context.fillStyle = '#27240f'; context.font = '800 29px "Noto Sans SC", sans-serif'; context.fillText(`${solution.tier} 档 · ${solution.title}`, left + 28, y + 46);
      context.fillStyle = '#443d1f'; context.font = '800 25px "Noto Sans SC", sans-serif'; context.fillText(formatRange(solution.price.total_min, solution.price.total_max, solution.price.currency), left + width - 250, y + 46);
      let detailY = y + 88;
      context.fillStyle = '#625e48'; context.font = '400 22px "Noto Sans SC", sans-serif';
      detailY = drawWrappedText(context, solution.summary, left + 28, detailY, width - 56, 30);
      solution.actions.forEach((action, index) => { detailY = drawWrappedText(context, `${index + 1}. ${action}`, left + 40, detailY + 8, width - 80, 29); });
      context.fillStyle = '#6f6848'; context.font = '400 20px "Noto Sans SC", sans-serif'; context.fillText(`材料 ${formatRange(solution.price.material_min, solution.price.material_max)} · 人工 ${formatRange(solution.price.labor_min, solution.price.labor_max)} · ${solution.duration}`, left + 28, y + boxHeight - 24);
      y += boxHeight + 16;
    });
    y += 14;
  });
  if (previewImages.length) {
    y += 28;
    sectionTitle('03', 'AI 改造效果示意', '按房间展示已选方案的改造前后对比，不代表施工定位或复查结论');
    previewImages.forEach(item => {
      const room = report.rooms.find(value => value.room_id === item.preview.room_id);
      context.fillStyle = '#443d1f'; context.font = '800 28px "Noto Sans SC", sans-serif';
      context.fillText(`${room ? ROOM_COPY[room.room_type].name : '房间'} · 改造前后`, left, y + 34);
      y += 58;
      const gap = 18;
      const imageWidth = (width - gap) / 2;
      const imageHeight = 330;
      drawCoverImage(context, item.before, left, y, imageWidth, imageHeight);
      drawCoverImage(context, item.after, left + imageWidth + gap, y, imageWidth, imageHeight);
      context.fillStyle = 'rgba(24,38,34,.82)';
      context.fillRect(left + 12, y + 12, 112, 38); context.fillRect(left + imageWidth + gap + 12, y + 12, 176, 38);
      context.fillStyle = '#fff'; context.font = '700 20px "Noto Sans SC", sans-serif';
      context.fillText('改造前', left + 28, y + 38); context.fillText('AI 效果示意', left + imageWidth + gap + 28, y + 38);
      y += imageHeight + 24;
      context.fillStyle = '#6f6848'; context.font = '400 19px "Noto Sans SC", sans-serif';
      y = drawWrappedText(context, item.preview.disclaimer || RENOVATION_PREVIEW_COPY.disclaimer, left, y, width, 27) + 24;
    });
  }
  y += 28;
  context.fillStyle = '#6f6848'; context.font = '400 20px "Noto Sans SC", sans-serif'; drawWrappedText(context, report.price_disclaimer, left, y, width, 28);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  previewImages.flatMap(item => item.urls).forEach(url => URL.revokeObjectURL(url));
  if (!blob) throw new Error('报告图片生成失败');
  return blob;
}

function downloadReportBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${PRODUCT_NAME}-居家安全检查报告.png`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function shareReportBlob(blob: Blob): Promise<boolean> {
  const file = new File([blob], `${PRODUCT_NAME}-居家安全检查报告.png`, {type: 'image/png'});
  if (!navigator.share || (navigator.canShare && !navigator.canShare({files: [file]}))) return false;
  await navigator.share({title: `${PRODUCT_NAME}居家安全检查报告`, text: '居家环境风险与改造建议', files: [file]});
  return true;
}

function ReportPage() {
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const [report, setReport] = useState<AssessmentReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyAction, setBusyAction] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const load = useCallback(() => api.report().then(value => { setReport(value); setError(null); }).catch(setError), []);
  useEffect(() => { if (session) load(); }, [load, session]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  if (!session) return <Navigate to="/home" replace />;
  if (!report) return error ? <ErrorState error={error} retry={load} /> : <Loading />;
  const preview = async () => {
    setBusyAction('preview');
    try {
      const blob = await createReportImage(report);
      setPreviewUrl(current => { if (current) URL.revokeObjectURL(current); return URL.createObjectURL(blob); });
    } catch (value) { showToast(friendlyError(value)); }
    finally { setBusyAction(''); }
  };
  const systemAction = async (intent: 'save' | 'share') => {
    setBusyAction(intent);
    try {
      const blob = await createReportImage(report);
      showToast(intent === 'save' ? '请在系统面板选择“存储图像”' : '请选择隔空投送或其他分享方式');
      if (!await shareReportBlob(blob)) {
        setPreviewUrl(current => { if (current) URL.revokeObjectURL(current); return URL.createObjectURL(blob); });
        downloadReportBlob(blob);
        showToast('当前浏览器不支持系统分享，已打开预览并下载图片');
      }
    } catch (value) {
      if ((value as Error).name !== 'AbortError') showToast(friendlyError(value));
    } finally { setBusyAction(''); }
  };
  return <section className="page report-page">
    <div className="page-intro"><small className="eyebrow">{PRODUCT_NAME}</small><h1>居家安全检查报告</h1><p>把已发现的隐患、具体改造建议和预算整理在一起。</p></div>
    <div className="report-status" data-onboarding-target="report-summary"><span className="icon-disc teal-soft"><Icon name="check_circle" filled /></span><div><b>已完成 {report.checked_room_count} 个房间检查</b><p>家庭检查进度 {report.checked_room_count} / {report.planned_room_count}</p></div></div>
    <div className="report-metrics" data-onboarding-target="report-summary"><div><small>{report.score_title}</small><b>{report.assessed_area_score ?? '—'}</b></div><div><small>家庭覆盖度</small><b>{report.coverage_percent}%</b></div><div><small>预计整改后</small><b>{report.projected_score?.display ?? '—'}</b></div></div>
    <ReportRenovationSection report={report} />
    <ReportDetails report={report} />
    <p className="fine-print">不用一次做完，先从最重要的一件事开始。</p>
    <div className="report-actions" data-onboarding-target="report-actions"><button className="button secondary full" disabled={Boolean(busyAction)} onClick={preview}><Icon name="preview" />{busyAction === 'preview' ? '正在生成预览…' : '预览报告'}</button><button className="button secondary full" disabled={Boolean(busyAction)} onClick={() => systemAction('save')}><Icon name="add_photo_alternate" />{busyAction === 'save' ? '正在准备…' : '保存到手机相册'}</button><button className="button primary full" disabled={Boolean(busyAction)} onClick={() => systemAction('share')}><Icon name="ios_share" filled />{busyAction === 'share' ? '正在生成…' : '生成分享报告'}</button></div>
    <button className="button quiet full" onClick={() => navigate('/rooms')}>继续检查其他房间</button>
    {previewUrl && <Modal title="报告预览" close={() => setPreviewUrl(current => { if (current) URL.revokeObjectURL(current); return ''; })}><img className="report-preview-image" src={previewUrl} alt="居家安全检查报告预览" /><button className="button primary full" onClick={() => systemAction('share')}>分享这份报告</button></Modal>}
  </section>;
}

interface HistoryRecord {
  entry: AssessmentHistoryEntry;
  assessment?: Assessment;
  report?: AssessmentReport;
  error?: unknown;
}

function sessionFromHistory(entry: AssessmentHistoryEntry, lastRoute?: string): SessionState {
  return {assessment_id: entry.assessment_id, access_token: entry.access_token, ...(lastRoute ? {last_route: lastRoute} : entry.last_route ? {last_route: entry.last_route} : {})};
}

function HistoryRiskImage({entry, media, risks}: {entry: AssessmentHistoryEntry; media?: MediaAsset; risks: SafetyRisk[]}) {
  const {url, loading} = useProtectedImage(media?.content_path, sessionFromHistory(entry));
  return <div className="history-risk-image" style={media ? {aspectRatio: `${media.width} / ${media.height}`} : undefined}>
    <img src={url || `${ASSETS}/demo-upload-floor.jpg`} alt="带风险标注的房间证据照片" />
    <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label={`风险位置标注，共 ${risks.filter(item => item.region).length} 处`}>
      {risks.map((risk, index) => risk.region && 'width' in risk.region ? <g key={risk.risk_id} className={`severity-${risk.severity}`}><rect x={risk.region.x * 1000} y={risk.region.y * 1000} width={risk.region.width * 1000} height={risk.region.height * 1000} rx="18" /><text x={(risk.region.x + risk.region.width / 2) * 1000} y={(risk.region.y + risk.region.height / 2) * 1000}>{index + 1}</text></g> : risk.region ? <polygon key={risk.risk_id} className={`severity-${risk.severity}`} points={risk.region.points.map(point => `${point[0] * 1000},${point[1] * 1000}`).join(' ')} /> : null)}
    </svg>
    {loading && <span className="image-loading"><span className="spinner" /></span>}
  </div>;
}

function HistoryPreviewImage({entry, preview}: {entry: AssessmentHistoryEntry; preview: RenovationPreview}) {
  const {url, loading} = useProtectedImage(preview.after_content_path || undefined, sessionFromHistory(entry));
  return <div className="history-preview-image"><img src={url || `${ASSETS}/solution-shower.jpg`} alt="AI 改造效果示意" />{loading && <span className="image-loading"><span className="spinner" /></span>}<span>AI 效果示意</span></div>;
}

function RenovationHistoryRoom({entry, assessmentRoom, result, report, activate}: {entry: AssessmentHistoryEntry; assessmentRoom: RoomAssessment; result?: RoomResult; report: AssessmentReport; activate: (path: string) => void}) {
  const {capabilities} = useApp();
  const [context, setContext] = useState<RenovationPreviewContext | null>(null);
  const [contextError, setContextError] = useState(false);
  useEffect(() => {
    if (!capabilities?.renovation_preview || !result) return;
    const controller = new AbortController();
    api.renovationPreviewContextFor(sessionFromHistory(entry), assessmentRoom.room_id, controller.signal).then(value => { setContext(value); setContextError(false); }).catch(error => { if ((error as Error).name !== 'AbortError') setContextError(true); });
    return () => controller.abort();
  }, [assessmentRoom.room_id, capabilities?.renovation_preview, entry.access_token, entry.assessment_id, result]);
  const roomRisks = result?.risks || [];
  const selectedItems = report.selected_items.filter(item => roomRisks.some(risk => risk.risk_id === item.risk_id));
  const media = assessmentRoom.media.find(item => roomRisks.some(risk => risk.media_id === item.media_id)) || assessmentRoom.media[0];
  const mediaRisks = media ? roomRisks.filter(risk => risk.media_id === media.media_id) : roomRisks;
  const previews = context?.previews || [];
  const activePreview = previews.find(item => item.selected_for_report && !item.stale && item.status === 'completed') || previews.find(item => !item.stale && item.status === 'completed');
  const running = previews.find(item => item.status === 'queued' || item.status === 'running');
  const stale = previews.find(item => item.stale && item.status === 'completed');
  return <article className="renovation-history-room">
    <header><div><small>{ROOM_COPY[assessmentRoom.room_type].name}</small><h3>{result ? `${roomRisks.length} 项风险 · ${result.score} 分` : '检查尚未完成'}</h3></div><button className="text-button" onClick={() => activate(result ? `/result/${assessmentRoom.room_id}` : assessmentRoom.status === 'analyzing' ? `/analyzing/${assessmentRoom.room_id}` : `/upload/${assessmentRoom.room_id}`)}>{result ? '查看结果' : '继续检查'}</button></header>
    {result && <>
      <HistoryRiskImage entry={entry} media={media} risks={mediaRisks} />
      <ol className="history-risk-list">{roomRisks.map((risk, index) => <li key={risk.risk_id}><span className={`severity-dot ${risk.severity}`}>{index + 1}</span><button onClick={() => activate(`/risk/${assessmentRoom.room_id}/${risk.risk_id}`)}><b>{risk.title}</b><small>{risk.evidence}</small></button></li>)}</ol>
      <section className="history-selected-solutions"><h4>已选改造方案</h4>{selectedItems.length ? selectedItems.map(item => <button key={item.selected_solution_id} onClick={() => activate(`/selected-solution/${assessmentRoom.room_id}/${item.risk_id}/${item.solution.solution_package_id}`)}><span><b>{item.solution.tier} 档 · {item.solution.title}</b><small>{item.solution.summary}</small></span><strong>{formatRange(item.solution.price.total_min, item.solution.price.total_max, item.solution.price.currency)}</strong></button>) : <p>还没有选择方案，可先从风险详情比较 A/B/C 方案。</p>}</section>
      {activePreview && <HistoryPreviewImage entry={entry} preview={activePreview} />}
      {running && <p className="history-preview-status" role="status"><span className="spinner" />效果图正在生成，可以稍后回来查看</p>}
      {stale && !activePreview && <p className="history-preview-status stale"><Icon name="update" />效果图已失效，请按当前方案重新生成</p>}
      {context?.previews.some(item => item.status === 'failed') && !activePreview && !running && <p className="history-preview-status error"><Icon name="cloud_off" />上次效果图未生成完成，可以重新尝试</p>}
      {contextError && selectedItems.length > 0 && <p className="history-preview-status error">暂时无法读取效果图状态</p>}
      {selectedItems.length > 0 && capabilities?.renovation_preview && <button className="button secondary full" onClick={() => activate(`/renovation-preview/${assessmentRoom.room_id}?return_to=${encodeURIComponent('/renovations')}`)}><Icon name="auto_awesome" filled />{activePreview ? '查看或重新生成' : stale || context?.previews.some(item => item.status === 'failed') ? '重新生成改造效果' : running ? '查看生成进度' : '生成改造效果'}</button>}
      {selectedItems.length === 0 && <button className="button secondary full" onClick={() => activate(`/result/${assessmentRoom.room_id}`)}>选择改造方案</button>}
    </>}
  </article>;
}

function RenovationsPage() {
  const navigate = useNavigate();
  const {session, setSession, setAssessment, showToast} = useApp();
  const [entries, setEntries] = useState<AssessmentHistoryEntry[]>(() => readAssessmentHistory());
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState('');
  const [deleteEntry, setDeleteEntry] = useState<AssessmentHistoryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    const sync = () => setEntries(readAssessmentHistory());
    window.addEventListener('anju-assessment-history-changed', sync);
    return () => window.removeEventListener('anju-assessment-history-changed', sync);
  }, []);
  useEffect(() => {
    if (session && !entries.some(item => item.assessment_id === session.assessment_id)) {
      setSession(entries[0] ? sessionFromHistory(entries[0]) : null);
      setAssessment(null);
    }
  }, [entries, session, setAssessment, setSession]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all(entries.map(async entry => {
      try {
        const [assessment, report] = await Promise.all([api.getAssessmentFor(entry, controller.signal), api.reportFor(entry, controller.signal)]);
        return {entry: {...entry, created_at: assessment.created_at || entry.created_at}, assessment, report} as HistoryRecord;
      } catch (error) { return {entry, error} as HistoryRecord; }
    })).then(value => setRecords(value.sort((left, right) => (right.assessment?.created_at || right.entry.created_at).localeCompare(left.assessment?.created_at || left.entry.created_at)))).finally(() => setLoading(false));
    return () => controller.abort();
  }, [entries]);
  const activate = (entry: AssessmentHistoryEntry, path: string) => {
    setSession(sessionFromHistory(entry, path.replace(/^\//, '').split('?')[0]));
    setAssessment(null);
    navigate(path);
  };
  const remove = async () => {
    if (!deleteEntry) return;
    setDeleting(true);
    try {
      await api.deleteAssessmentFor(deleteEntry);
      const remaining = removeAssessmentHistory(deleteEntry.assessment_id);
      if (session?.assessment_id === deleteEntry.assessment_id) {
        const next = remaining[0];
        setSession(next ? sessionFromHistory(next) : null);
        setAssessment(null);
      }
      setDeleteEntry(null);
      showToast('这次检查和相关照片已删除');
    } catch (error) { showToast(friendlyError(error)); }
    finally { setDeleting(false); }
  };
  if (loading && !records.length) return <Loading label="正在整理改造记录…" />;
  return <section className="page renovations-page">
    <div className="page-intro"><small className="eyebrow">检查历史与改造进度</small><h1>改造方案</h1><p>按每次检查整理风险证据、已选方案、预算和 AI 改造效果。</p></div>
    {!records.length ? <section className="empty-renovations"><Icon name="handyman" className="state-icon" /><h2>还没有检查记录</h2><p>从首页上传照片或使用 AR 实时识别后，记录会保存在这里。</p><button className="button primary full" onClick={() => navigate('/home')}>开始第一次检查</button></section> : <div className="renovation-history-list">{records.map(record => {
      const date = new Date(record.assessment?.created_at || record.entry.created_at);
      const open = expandedId === record.entry.assessment_id;
      const report = record.report;
      const assessment = record.assessment;
      return <article key={record.entry.assessment_id} className={`renovation-history-card ${session?.assessment_id === record.entry.assessment_id ? 'current' : ''}`}>
        <header><button className="renovation-history-toggle" aria-expanded={open} onClick={() => setExpandedId(value => value === record.entry.assessment_id ? '' : record.entry.assessment_id)}><span><small>{Number.isNaN(date.valueOf()) ? '历史检查' : date.toLocaleDateString('zh-CN', {year: 'numeric', month: 'long', day: 'numeric'})}{session?.assessment_id === record.entry.assessment_id ? ' · 当前' : ''}</small><b>{assessment?.status === 'completed' ? '已完成检查' : assessment ? '检查进行中' : '记录暂不可用'}</b></span><Icon name={open ? 'expand_less' : 'expand_more'} /></button></header>
        {record.error ? <div className="history-record-error"><p>{friendlyError(record.error)}</p><button className="text-button" onClick={() => setEntries(readAssessmentHistory())}>重试</button></div> : report && assessment ? <>
          <div className="history-metrics"><span><small>房间</small><b>{assessment.rooms.length}</b></span><span><small>{report.score_title}</small><b>{report.assessed_area_score ?? '—'}</b></span><span><small>覆盖度</small><b>{report.coverage_percent}%</b></span><span><small>参考预算</small><b>{formatRange(report.budget.total_min, report.budget.total_max, report.budget.currency)}</b></span></div>
          {open && <div className="history-record-details">{assessment.rooms.length ? assessment.rooms.map(room => <RenovationHistoryRoom key={room.room_id} entry={record.entry} assessmentRoom={room} result={report.rooms.find(item => item.room_id === room.room_id)} report={report} activate={path => activate(record.entry, path)} />) : <p className="empty-copy">这次检查还没有添加房间</p>}<div className="history-record-actions"><button className="button primary" onClick={() => activate(record.entry, report.rooms.length ? '/report' : resolveCheckDestination(record.entry, assessment) || '/profile')}>{report.rooms.length ? '查看完整报告' : '继续检查'}</button><button className="button danger" onClick={() => setDeleteEntry(record.entry)}>删除记录</button></div></div>}
        </> : null}
      </article>;
    })}</div>}
    {deleteEntry && <Modal title="删除这次检查？" close={() => !deleting && setDeleteEntry(null)}><p>照片、风险结果、已选方案和效果图会从服务端永久删除，无法恢复。</p><div className="button-stack"><button className="button danger full" disabled={deleting} onClick={() => void remove()}>{deleting ? '正在删除…' : '确认永久删除'}</button><button className="button quiet full" disabled={deleting} onClick={() => setDeleteEntry(null)}>取消</button></div></Modal>}
  </section>;
}

function MyPage() {
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const [profile, setProfile] = useState<ElderProfile | null>(() => readDefaultProfile());
  const [report, setReport] = useState<AssessmentReport | null>(null);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    const refresh = () => setProfile(readDefaultProfile());
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => {
    if (!session) { setReport(null); return; }
    const controller = new AbortController();
    api.report(controller.signal).then(setReport).catch(() => setReport(null));
    return () => controller.abort();
  }, [session]);
  const mobilityCopy: Record<string, string> = {normal: '行走基本正常', limited: '腿脚不太方便', cane: '使用拐杖', walker: '使用助行器', wheelchair: '使用轮椅'};
  const fallCopy: Record<string, string> = {none: '没有', once: '发生过一次', multiple: '发生过多次'};
  const livingCopy: Record<string, string> = {alone: '独居', with_family: '与家人同住'};
  const share = async () => {
    if (!report?.checked_room_count) { showToast('请先在改造方案中选择一份已完成的检查'); return; }
    setSharing(true);
    try {
      const blob = await createReportImage(report);
      showToast('请选择隔空投送或其他分享方式');
      if (!await shareReportBlob(blob)) { downloadReportBlob(blob); showToast('当前浏览器不支持系统分享，已下载报告图片'); }
    } catch (value) { if ((value as Error).name !== 'AbortError') showToast(friendlyError(value)); }
    finally { setSharing(false); }
  };
  return <section className="page my-page">
    <div className="page-intro"><h1>我的</h1><p>管理默认家人档案，并把当前检查报告分享给家人。</p></div>
    <section className="my-section simple"><div className="my-section-heading"><span><Icon name="person" filled /><b>默认个人档案</b></span><button className="text-button" onClick={() => navigate('/profile?from=my')}>{profile ? '编辑' : '完善'}</button></div>
      {profile ? <div className="profile-summary"><span>行动能力<b>{mobilityCopy[profile.mobility]}</b></span><span>跌倒史<b>{fallCopy[profile.fall_history]}</b></span><span>居住状态<b>{livingCopy[profile.living_status]}</b></span></div> : <div className="empty-copy"><p>保存后会在新建检查时自动预填，历史检查不会被修改。</p><button className="button secondary full" onClick={() => navigate('/profile?from=my')}>完善默认档案</button></div>}
    </section>
    <section className="my-section simple"><div className="my-section-heading"><span><Icon name="ios_share" filled /><b>报告分享</b></span>{report?.checked_room_count ? <button className="text-button" onClick={() => navigate('/report')}>查看报告</button> : null}</div>
      {report?.checked_room_count ? <div className="share-summary"><p>当前选择的检查包含 {report.checked_room_count} 个已检查房间、{report.selected_items.length} 项已选方案{report.renovation_previews?.length ? `和 ${report.renovation_previews.length} 张改造效果图` : ''}。</p><button className="button primary full" disabled={sharing} onClick={() => void share()}><Icon name="ios_share" />{sharing ? '正在生成分享报告…' : '生成分享报告'}</button></div> : <div className="empty-copy"><p>先在“改造方案”中选择一份完成的检查，再生成分享报告。</p><button className="button secondary full" onClick={() => navigate('/renovations')}>选择检查记录</button></div>}
    </section>
  </section>;
}

export default function App() {
  return <AppProvider><HashRouter><OnboardingProvider><AppShell /></OnboardingProvider></HashRouter></AppProvider>;
}
