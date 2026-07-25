import {useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode} from 'react';
import {HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams} from 'react-router-dom';
import {api, friendlyError} from './api';
import {DIFFICULTY_COPY, PRODUCT_NAME, ROOM_COPY, SEVERITY_COPY, STAGE_COPY} from './content';
import {useProtectedImage} from './hooks';
import {normalizeImage} from './image';
import RiskOverlay from './RiskOverlay';
import {AppProvider, formatRange, useApp} from './store';
import type {AnalysisStatus, Assessment, AssessmentReport, ElderProfile, MediaAsset, RoomAssessment, RoomResult, SafetyRisk, SolutionPackage} from './types';

const ASSETS = '/assets/stitch';

function Icon({name, filled = false, className = ''}: {name: string; filled?: boolean; className?: string}) {
  return <span className={`material-symbols-rounded ${filled ? 'is-filled' : ''} ${className}`} aria-hidden="true">{name}</span>;
}

function Loading({label = '正在加载…'}: {label?: string}) {
  return <div className="center-state" role="status"><span className="spinner" /><p>{label}</p></div>;
}

function ErrorState({error, retry}: {error: unknown; retry?: () => void}) {
  return <section className="page center-state"><Icon name="cloud_off" className="state-icon" /><h1>这次没有完成</h1><p>{friendlyError(error)}</p>{retry && <button className="button primary" onClick={retry}>重试</button>}</section>;
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
    <img src={url || fallback} alt={media ? '已上传的卫生间照片' : '卫生间拍摄示意图'} />
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
  const {session, setSession, setAssessment, health, setHealth, toast, showToast} = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const isHome = location.pathname === '/home';
  const isShare = location.pathname.startsWith('/share/');

  useEffect(() => {
    api.health().then(value => setHealth(value.analysis)).catch(() => setHealth('unavailable'));
  }, [setHealth]);

  useEffect(() => {
    mainRef.current?.focus({preventScroll: true});
    window.scrollTo({top: 0, behavior: 'instant'});
    if (session && !isHome && !isShare) {
      setSession({...session, last_route: location.pathname.replace(/^\//, '')});
    }
  }, [location.pathname, session?.access_token, session?.assessment_id]); // route focus and persistence are intentionally coupled

  const deleteAssessment = async () => {
    try {
      await api.deleteAssessment();
      setSession(null);
      setAssessment(null);
      setMenuOpen(false);
      navigate('/home');
      showToast('本次检查和照片已删除');
    } catch (error) {
      showToast(friendlyError(error));
    }
  };

  return <div className="site-frame">
    {!isShare && <header className="app-header">
      <button className="icon-button" onClick={() => isHome ? undefined : history.length > 1 ? history.back() : navigate('/home')} aria-label="返回" disabled={isHome}><Icon name="arrow_back" /></button>
      <strong>{PRODUCT_NAME}</strong>
      <button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="检查与隐私"><Icon name="more_vert" /></button>
    </header>}
    {health === 'demo' && <div className="demo-banner" role="status"><Icon name="science" />演示模式：当前展示固定样例结果</div>}
    <main ref={mainRef} tabIndex={-1}>
      <Routes>
        <Route path="/home" element={<HomePage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/rooms" element={<RoomsPage />} />
        <Route path="/upload/:roomId" element={<UploadPage />} />
        <Route path="/analyzing/:roomId" element={<AnalyzingPage />} />
        <Route path="/result/:roomId" element={<ResultPage />} />
        <Route path="/risk/:roomId/:riskId" element={<RiskPage />} />
        <Route path="/solutions/:roomId/:riskId" element={<SolutionsPage />} />
        <Route path="/report" element={<ReportPage />} />
        <Route path="/share/:token" element={<SharePage />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </main>
    {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    {menuOpen && <Modal title="检查与隐私" close={() => setMenuOpen(false)}>
      <p>照片仅用于本次居家环境分析。你可以删除这次检查及服务端保存的分析副本。</p>
      <button className="button danger full" disabled={!session} onClick={deleteAssessment}><Icon name="delete_forever" />删除本次检查</button>
    </Modal>}
  </div>;
}

function HomePage() {
  const navigate = useNavigate();
  const {session, setSession, showToast} = useApp();
  const [busy, setBusy] = useState(false);
  const start = async (mode: 'photo' | 'video_frame') => {
    setBusy(true);
    try {
      const value = await api.createAssessment(mode);
      setSession({assessment_id: value.assessment_id, access_token: value.access_token});
      navigate('/profile');
    } catch (error) {
      showToast(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };
  return <section className="page home-page">
    <div className="hero-copy"><h1>给父母的家<br />做一次安全体检</h1><p>上传家中的照片，AI 帮你发现容易忽略的跌倒与行动风险。</p></div>
    <div className="hero-image">
      <img src={`${ASSETS}/hero-living-room.jpg`} alt="温暖明亮的居家客厅" />
      <span className="image-callout amber"><Icon name="warning" filled />地毯边缘翘起</span>
      <span className="image-callout teal"><Icon name="info" filled />建议增设扶手</span>
    </div>
    <div className="button-stack">
      <button className="button primary full" disabled={busy} onClick={() => start('photo')}><Icon name="add_a_photo" filled />{busy ? '正在开始…' : '上传家中照片'}</button>
      <button className="button secondary full" disabled={busy} onClick={() => start('video_frame')}><Icon name="video_camera_front" />从视频画面开始检查</button>
      {session && <button className="button quiet full" onClick={() => navigate(`/${session.last_route || 'profile'}`)}>继续上次检查</button>}
    </div>
    <p className="fine-print">无需专业设备 · 约 2 分钟完成 · 不涉及医疗诊断</p>
    <div className="capability-grid">
      <div><span className="icon-disc teal-soft"><Icon name="center_focus_strong" /></span><b>AI 标注风险</b></div>
      <div><span className="icon-disc amber-soft"><Icon name="format_list_numbered" /></span><b>按优先级给建议</b></div>
      <div><span className="icon-disc blue-soft"><Icon name="checklist" /></span><b>生成家庭改造清单</b></div>
    </div>
  </section>;
}

function ProfilePage() {
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const {assessment, loading, error, reload} = useAssessment();
  const initial = assessment?.profile;
  const [profile, setProfile] = useState<Partial<ElderProfile>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (initial) setProfile(initial); }, [initial]);
  useEffect(() => {
    if (!profile.mobility || !profile.fall_history || !profile.living_status) return;
    const timer = window.setTimeout(() => api.saveProfile(profile as ElderProfile).catch(() => undefined), 300);
    return () => window.clearTimeout(timer);
  }, [profile]);
  if (!session) return <Navigate to="/home" replace />;
  if (loading && !assessment) return <Loading />;
  if (error) return <ErrorState error={error} retry={reload} />;
  const complete = Boolean(profile.mobility && profile.fall_history && profile.living_status);
  const next = async () => {
    if (!complete) return;
    setSaving(true);
    try {
      await api.saveProfile(profile as ElderProfile);
      navigate('/rooms');
    } catch (value) {
      showToast(friendlyError(value));
    } finally { setSaving(false); }
  };
  const mobility = [
    ['normal', 'directions_walk', '行走基本正常'], ['limited', 'accessible_forward', '腿脚不太方便'], ['cane', 'elderly', '使用拐杖'], ['walker', 'assist_walker', '使用助行器'], ['wheelchair', 'accessible', '使用轮椅'],
  ] as const;
  return <section className="page profile-page">
    <div className="page-intro"><h1>先了解一下家人的情况</h1><p>不同的行动能力，会影响居家风险的判断。</p></div>
    <fieldset className="form-section"><legend>行动能力</legend><div className="mobility-grid">
      {mobility.map(([value, icon, label]) => <button key={value} type="button" className={`choice-card ${profile.mobility === value ? 'selected' : ''} ${value === 'wheelchair' ? 'wide' : ''}`} onClick={() => setProfile(current => ({...current, mobility: value}))}><Icon name={icon} /><span>{label}</span>{profile.mobility === value && <Icon name="check_circle" filled className="choice-check" />}</button>)}
    </div></fieldset>
    <RadioSection title="最近半年是否发生过跌倒？" name="fall" value={profile.fall_history} onChange={value => setProfile(current => ({...current, fall_history: value as ElderProfile['fall_history']}))} options={[['none', '没有'], ['once', '发生过一次'], ['multiple', '发生过多次']]} />
    <RadioSection title="父母目前是否独居？" name="living" value={profile.living_status} onChange={value => setProfile(current => ({...current, living_status: value as ElderProfile['living_status']}))} options={[['alone', '独居'], ['with_family', '与家人同住']]} />
    <div className="sticky-footer"><button className="button primary full" disabled={!complete || saving} onClick={next}>{saving ? '正在保存…' : '下一步'}<Icon name="arrow_forward" /></button></div>
  </section>;
}

function RadioSection({title, name, value, options, onChange}: {title: string; name: string; value?: string; options: [string, string][]; onChange: (value: string) => void}) {
  return <fieldset className="radio-panel"><legend>{title}</legend>{options.map(([option, label]) => <label key={option} className="radio-row"><input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} /><span>{label}</span></label>)}</fieldset>;
}

function RoomsPage() {
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const {assessment, loading, error, reload} = useAssessment();
  const [busy, setBusy] = useState(false);
  const [multiMode, setMultiMode] = useState(false);
  const [selectedRooms, setSelectedRooms] = useState<Set<keyof typeof ROOM_COPY>>(new Set(['bathroom']));
  if (!session) return <Navigate to="/home" replace />;
  if (loading && !assessment) return <Loading />;
  if (error) return <ErrorState error={error} retry={reload} />;
  const choose = async (roomType: keyof typeof ROOM_COPY) => {
    if (multiMode) {
      setSelectedRooms(current => {
        const next = new Set(current);
        if (next.has(roomType)) next.delete(roomType); else next.add(roomType);
        return next;
      });
      return;
    }
    const copy = ROOM_COPY[roomType];
    if (!copy.supported) { showToast('这个房间的完整规则仍在完善中'); return; }
    setBusy(true);
    try {
      const room = await api.createRoom(roomType);
      navigate(`/upload/${room.room_id}`);
    } catch (value) { showToast(friendlyError(value)); }
    finally { setBusy(false); }
  };
  const saveSelectedRooms = async () => {
    if (!selectedRooms.size) { showToast('请至少选择一个房间'); return; }
    setBusy(true);
    try {
      let bathroom = assessment?.rooms.find(item => item.room_type === 'bathroom');
      for (const roomType of selectedRooms) {
        const existing = assessment?.rooms.find(item => item.room_type === roomType);
        const room = existing || await api.createRoom(roomType);
        if (roomType === 'bathroom') bathroom = room;
      }
      if (bathroom) navigate(`/upload/${bathroom.room_id}`);
      else { setMultiMode(false); reload(); showToast('房间计划已保存；本期仅卫生间可生成正式结论'); }
    } catch (value) { showToast(friendlyError(value)); }
    finally { setBusy(false); }
  };
  return <section className="page rooms-page">
    <div className="page-intro"><h1>这次想检查哪里？</h1><p>建议从老人最常活动、也最容易跌倒的区域开始。</p></div>
    {multiMode && <div className="mode-note" role="status"><Icon name="checklist" /><span><b>多房间计划</b>选择计划检查的房间；规则完善中的房间会保存进度，但不会生成正式结论。</span></div>}
    <div className="room-grid">{Object.entries(ROOM_COPY).map(([key, room]) => {
      const existing = assessment?.rooms.find(item => item.room_type === key);
      const selected = multiMode && selectedRooms.has(key as keyof typeof ROOM_COPY);
      return <button key={key} className={`room-card ${room.supported ? 'supported' : ''} ${selected ? 'plan-selected' : ''}`} aria-pressed={multiMode ? selected : undefined} disabled={busy} onClick={() => choose(key as keyof typeof ROOM_COPY)}>
        {room.supported && <span className="priority-ribbon">建议优先</span>}
        <span className="room-icon"><Icon name={room.icon} filled={room.supported} /></span>
        <b>{room.name}</b><p>{room.hint}</p>
        {selected && <span className="plan-check"><Icon name="check_circle" filled />已选择</span>}
        {existing?.status === 'result_ready' && <span className="completion"><Icon name="check_circle" filled />{existing.score} 分</span>}
        {!room.supported && <small>规则完善中</small>}
      </button>;
    })}</div>
    <button className="button primary full" disabled={busy || (multiMode && !selectedRooms.size)} onClick={multiMode ? saveSelectedRooms : () => choose('bathroom')}>{multiMode ? `保存 ${selectedRooms.size} 个房间并继续` : '检查卫生间'}</button>
    <button className="button quiet full" onClick={() => setMultiMode(value => !value)}>{multiMode ? '返回单房间检查' : '一次检查多个房间'}</button>
  </section>;
}

function UploadPage() {
  const {roomId = ''} = useParams();
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const {assessment, loading, error, reload} = useAssessment();
  const [busy, setBusy] = useState(false);
  if (!session) return <Navigate to="/home" replace />;
  if (loading && !assessment) return <Loading />;
  if (error) return <ErrorState error={error} retry={reload} />;
  const room = assessment?.rooms.find(item => item.room_id === roomId);
  if (!room) return <ErrorState error={new Error('没有找到这个房间')} />;
  const usable = room.media.some(item => item.quality.usable);
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files || [])].slice(0, Math.max(0, 6 - room.media.length));
    if (!files.length) return;
    setBusy(true);
    showToast(`正在处理 ${files.length} 张照片…`);
    for (const file of files) {
      try {
        const normalized = await normalizeImage(file);
        await api.uploadMedia(roomId, normalized.blob, normalized.width, normalized.height);
      } catch (value) { showToast(friendlyError(value)); }
    }
    setBusy(false);
    reload();
    event.target.value = '';
  };
  const analyze = async () => {
    setBusy(true);
    try { await api.analyze(roomId); navigate(`/analyzing/${roomId}`); }
    catch (value) { showToast(friendlyError(value)); setBusy(false); }
  };
  const remove = async (mediaId: string) => {
    try { await api.deleteMedia(roomId, mediaId); reload(); }
    catch (value) { showToast(friendlyError(value)); }
  };
  return <section className="page upload-page">
    <div className="page-intro"><h1>上传卫生间照片</h1><p>拍摄越完整，分析结果越准确。</p></div>
    <label className="upload-drop"><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={upload} disabled={busy || room.media.length >= 6} /><span className="upload-icon"><Icon name="photo_camera" filled /></span><b>拍照或从相册选择</b><small>最多 6 张，推荐 1—3 张</small></label>
    <section><h2>拍摄建议</h2><div className="photo-tips">
      <PhotoTip image="guide-doorway.jpg" icon="pan_tool_alt" text="在门口拍一张全景" />
      <PhotoTip image="guide-floor.jpg" icon="door_front" text="拍清楚地面和门槛" />
      <PhotoTip image="guide-shower.jpg" icon="shower" text="补拍马桶或淋浴区域" />
    </div></section>
    <section className="quality-card"><h2>当前照片状态</h2>{room.media.length === 0 ? <p className="muted">还没有照片</p> : <div className="quality-list">{room.media.map(media => <MediaRow key={media.media_id} media={media} remove={() => remove(media.media_id)} />)}</div>}</section>
    <div className="thumb-strip">{room.media.map(media => <MediaThumb key={media.media_id} media={media} />)}{room.media.length < 6 && <label className="add-thumb"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={upload} disabled={busy} /><Icon name="add_photo_alternate" /></label>}</div>
    <div className="sticky-footer"><button className="button primary full" disabled={!usable || busy} onClick={analyze}><Icon name="document_scanner" />{busy ? '正在处理…' : '开始 AI 检查'}</button></div>
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
  const notes = [quality.floor_visible && '已拍到完整地面', quality.lighting_sufficient && '光线充足', quality.missing_views.length ? `建议补拍：${quality.missing_views.join('、')}` : ''].filter(Boolean);
  return <article className="media-row"><span className={`status-icon ${quality.usable ? 'ok' : 'warn'}`}><Icon name={quality.usable ? 'check_circle' : 'warning'} filled /></span><div><b>{quality.usable ? '可以用于分析' : '建议补拍'}</b><p>{notes.join(' · ') || '正在确认照片质量'}</p></div><button className="icon-button" onClick={remove} aria-label="删除这张照片"><Icon name="delete" /></button></article>;
}

function AnalyzingPage() {
  const {roomId = ''} = useParams();
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const assessmentState = useAssessment();
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const media = assessmentState.assessment?.rooms.find(item => item.room_id === roomId)?.media.find(item => item.quality.usable);
  const {url} = useProtectedImage(media?.content_path);
  const poll = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await api.status(roomId, signal);
      setStatus(value);
      setError(null);
      if (value.status === 'completed') navigate(`/result/${roomId}`, {replace: true});
    } catch (value) { if ((value as Error).name !== 'AbortError') setError(value); }
  }, [navigate, roomId]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    poll(controller.signal);
    const timer = window.setInterval(() => poll(controller.signal), 1200);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [poll, session]);
  if (!session) return <Navigate to="/home" replace />;
  if (error || assessmentState.error) return <ErrorState error={error || assessmentState.error} retry={() => { poll(); assessmentState.reload(); }} />;
  const stages = ['quality_checked', 'scene_understood', 'risks_detecting', 'regions_grounded', 'rules_applied', 'score_calculated', 'solutions_ready'];
  const active = Math.max(0, stages.indexOf(status?.stage || 'quality_checked'));
  const retry = async () => { try { await api.analyze(roomId); await poll(); } catch (value) { showToast(friendlyError(value)); } };
  return <section className="page analyzing-page">
    <div className="center-heading"><h1>正在检查卫生间</h1><p>AI 正在深度分析您的居家环境</p></div>
    <div className="scan-visual"><img src={url || `${ASSETS}/analysis-bathroom.jpg`} alt="正在检查的卫生间" /><span className="scan-line" /><span className="scan-tag one">洗手台</span><span className="scan-tag two">马桶</span><span className="scan-tag three">地面</span></div>
    <div className="recognized-card"><b><Icon name="check_circle" filled />已识别环境要素</b><div className="chip-row"><span>卫生间</span><span>淋浴区</span><span>马桶</span><span>洗手台</span><span>门槛</span><span>地面</span></div></div>
    <div className="analysis-steps" role="status" aria-live="polite">{stages.slice(1).map((stage, index) => <div key={stage} className={index < active ? 'done' : index === active ? 'active' : ''}><span><Icon name={index < active ? 'check' : index === active ? 'progress_activity' : 'circle'} filled={index < active} /></span><p><b>{STAGE_COPY[stage]}</b>{index === active && <small>分析画面中可见的环境特征</small>}</p></div>)}</div>
    {status?.status === 'failed' && <div className="error-panel"><b>分析没有完成</b><p>{friendlyError({message: status.error || '', code: status.error})}</p><button className="button primary full" onClick={retry}>重新分析</button></div>}
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

function ResultPage() {
  const {roomId = ''} = useParams();
  const navigate = useNavigate();
  const {session} = useApp();
  const assessmentState = useAssessment();
  const {result, loading, error, reload} = useRoomResult(roomId);
  if (!session) return <Navigate to="/home" replace />;
  if (loading || assessmentState.loading || !result) return <Loading label="正在准备检查结果…" />;
  if (error || assessmentState.error) return <ErrorState error={error || assessmentState.error} retry={() => { reload(); assessmentState.reload(); }} />;
  const lead = result.risks[0];
  const leadMedia = assessmentState.assessment?.rooms.find(item => item.room_id === roomId)?.media.find(item => item.media_id === lead?.media_id);
  return <section className="page result-page">
    <div className="complete-mark"><Icon name="check_circle" filled /></div>
    <div className="center-heading"><h1>卫生间检查完成</h1><p>大部分问题都可以通过低成本措施改善。</p></div>
    <article className="summary-card"><div><small>{result.score_label}</small><b className="score-number">{result.score}<em>/100</em></b></div><div className="coverage-block"><span>检查覆盖度 {result.coverage.percent}%</span><div className="progress"><i style={{width: `${result.coverage.percent}%`}} /></div></div><button className="text-button" onClick={() => document.getElementById('score-detail')?.scrollIntoView({behavior: 'smooth'})}>查看评分依据</button></article>
    <article className="risk-summary"><h2>发现 {result.risks.length} 个需要注意的问题</h2><p>根据您的卫生间照片分析得出</p>{(['high', 'medium', 'low'] as const).map(level => <div key={level} className={`risk-count ${level}`}><Icon name={level === 'high' ? 'error' : level === 'medium' ? 'warning' : 'info'} filled /><span>{result.counts[level]} 个{level === 'high' ? '建议优先处理' : level === 'medium' ? '建议近期改善' : '可以继续观察'}</span><b>{SEVERITY_COPY[level]}</b></div>)}</article>
    {lead && <section><h2>主要风险展示</h2><article className="lead-risk"><ProtectedImage media={leadMedia} fallback={`${ASSETS}/result-shower.jpg`} /><div><span className={`severity ${lead.severity}`}><Icon name="priority_high" />优先处理</span><h3>{lead.title}</h3><p>{lead.evidence}</p><button className="button primary full" onClick={() => navigate(`/risk/${roomId}/${lead.risk_id}`)}>查看怎么改</button></div></article></section>}
    <details id="score-detail" className="detail-card"><summary>参考分的计算依据</summary><p>分数由经过校验的风险、家人情况和本地规则确定性计算。覆盖度与参考分分开展示。</p>{result.main_deductions.map(item => <div key={item.risk_id}><b>{item.title}</b><span>扣 {item.deduction} 分</span></div>)}</details>
    <div className="button-stack"><button className="button secondary full" onClick={() => lead && navigate(`/risk/${roomId}/${lead.risk_id}`)}>查看全部 {result.risks.length} 个问题</button><button className="button quiet full" onClick={() => navigate('/report')}>查看改造清单</button></div>
    <BottomNav active="risks" navigate={navigate} />
  </section>;
}

function BottomNav({active, navigate}: {active: string; navigate: ReturnType<typeof useNavigate>}) {
  const items = [['home', 'home_health', '首页', '/home'], ['risks', 'visibility', '风险', ''], ['solutions', 'verified_user', '方案', '/report'], ['profile', 'person', '我的', '/profile']];
  return <nav className="bottom-nav" aria-label="主导航">{items.map(([key, icon, label, path]) => <button key={key} className={active === key ? 'active' : ''} onClick={() => path && navigate(path)}><Icon name={icon} filled={active === key} /><span>{label}</span></button>)}</nav>;
}

function RiskPage() {
  const {roomId = '', riskId = ''} = useParams();
  const navigate = useNavigate();
  const {session, assessment, showToast} = useApp();
  const assessmentState = useAssessment();
  const resultState = useRoomResult(roomId);
  const [zoom, setZoom] = useState(1);
  const [drawing, setDrawing] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  if (!session) return <Navigate to="/home" replace />;
  if ((assessmentState.loading && !assessment) || resultState.loading || !resultState.result) return <Loading />;
  if (assessmentState.error || resultState.error) return <ErrorState error={assessmentState.error || resultState.error} retry={() => { assessmentState.reload(); resultState.reload(); }} />;
  const result = resultState.result;
  const index = Math.max(0, result.risks.findIndex(item => item.risk_id === riskId));
  const risk = result.risks[index];
  if (!risk) return <ErrorState error={new Error('没有找到这项风险')} />;
  const media = assessment?.rooms.find(item => item.room_id === roomId)?.media.find(item => item.media_id === risk.media_id);
  const {url} = useProtectedImage(media?.content_path);
  const updateRegion = async (region: SafetyRisk['region']) => {
    if (!region) return;
    try { await api.region(risk.risk_id, region); setDrawing(false); resultState.reload(); showToast('新位置已保存'); }
    catch (value) { showToast(friendlyError(value)); }
  };
  const feedback = async (value: string) => {
    try { await api.feedback(risk.risk_id, value); setFeedbackOpen(false); resultState.reload(); showToast('反馈已保存，参考分已更新'); }
    catch (error) { showToast(friendlyError(error)); }
  };
  const switchRisk = (next: number) => navigate(`/risk/${roomId}/${result.risks[next].risk_id}`, {replace: true});
  return <section className="risk-page">
    <div className="risk-toolbar"><span className="glass-chip"><Icon name="cloud_done" filled />AI 已识别 {result.risks.length} 处风险</span><button className="glass-button" onClick={() => setZoom(value => value >= 1.8 ? 1 : value + 0.2)} aria-label="放大照片"><Icon name={zoom > 1 ? 'zoom_out_map' : 'zoom_in'} /></button></div>
    <RiskOverlay imageUrl={url} fallbackUrl={`${ASSETS}/risk-bathroom.jpg`} risks={result.risks} activeId={risk.risk_id} zoom={zoom} drawing={drawing} onSelect={id => navigate(`/risk/${roomId}/${id}`, {replace: true})} onRegionChange={updateRegion} />
    <div className="risk-switcher"><button disabled={index === 0} onClick={() => switchRisk(index - 1)}><Icon name="chevron_left" /></button><span>风险 {index + 1} / {result.risks.length}</span><button disabled={index === result.risks.length - 1} onClick={() => switchRisk(index + 1)}><Icon name="chevron_right" /></button></div>
    <article className="risk-detail"><span className={`severity ${risk.severity}`}><Icon name="warning" filled />{SEVERITY_COPY[risk.severity]}</span><h1>{risk.title}</h1><p>{risk.evidence}</p><small>参考扣分 {risk.score_deduction} 分 · {risk.region ? '已标出可参考位置' : '位置仍待确认'}</small><button className="button primary full" onClick={() => navigate(`/solutions/${roomId}/${risk.risk_id}`)}><Icon name="location_on" filled />查看解决方案</button><div className="split-actions"><button className="button secondary" onClick={() => setFeedbackOpen(true)}><Icon name="help" />为什么有风险？</button><button className="button quiet" onClick={() => setDrawing(value => !value)}><Icon name="draw" />{drawing ? '取消圈选' : '这里判断不准确'}</button></div></article>
    {feedbackOpen && <Modal title="这里判断不准确" close={() => setFeedbackOpen(false)}><p>反馈会保存并重新计算参考分。</p><div className="button-stack"><button className="button quiet full" onClick={() => feedback('not_a_risk')}>不是风险</button><button className="button quiet full" onClick={() => { setFeedbackOpen(false); setDrawing(true); }}>位置不准确，重新圈选</button><button className="button quiet full" onClick={() => feedback('photo_unclear')}>照片看不清</button><button className="button quiet full" onClick={() => feedback('already_resolved')}>已经整改，等待复查</button><button className="button primary full" onClick={() => feedback('confirmed')}>确认存在</button></div></Modal>}
  </section>;
}

function SolutionsPage() {
  const {roomId = '', riskId = ''} = useParams();
  const navigate = useNavigate();
  const {session, assessment, showToast} = useApp();
  const assessmentState = useAssessment();
  const resultState = useRoomResult(roomId);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.solutions>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    setData(null);
    return api.solutions(riskId).then(value => { setData(value); setError(null); }).catch(setError);
  }, [riskId]);
  useEffect(() => { if (session) load(); }, [load, session]);
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
  const media = (assessment || assessmentState.assessment)?.rooms.find(item => item.room_id === roomId)?.media.find(item => item.media_id === risk.media_id);
  const select = async (solution: SolutionPackage) => {
    setBusy(solution.solution_package_id);
    try {
      if (data.selected_solution_package_id === solution.solution_package_id) await api.removeSolution(riskId);
      else await api.selectSolution(riskId, solution.solution_package_id);
      await load();
      showToast(data.selected_solution_package_id === solution.solution_package_id ? '已从清单移除' : '已加入改造清单');
    } catch (value) { showToast(friendlyError(value)); }
    finally { setBusy(''); }
  };
  return <section className="page solutions-page">
    <div className="page-intro"><h1>{risk.title}怎么改？</h1></div>
    <ProtectedImage media={media} fallback={`${ASSETS}/solution-shower.jpg`} className="solution-hero" />
    <p className="solution-observation">发现现有环境中缺少可靠支撑，建议根据家庭条件选择适合的改造方式。</p>
    <div className="solution-list">{data.solutions.map(solution => {
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
    <div className="button-stack"><button className="button secondary full" onClick={() => navigate(`/risk/${roomId}/${riskId}`)}>继续查看下一个问题<Icon name="arrow_forward" /></button><button className="button quiet full" onClick={() => navigate('/report')}>查看改造清单</button></div>
  </section>;
}

function ReportPage() {
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const [report, setReport] = useState<AssessmentReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api.report().then(value => { setReport(value); setError(null); }).catch(setError), []);
  useEffect(() => { if (session) load(); }, [load, session]);
  if (!session) return <Navigate to="/home" replace />;
  if (!report) return error ? <ErrorState error={error} retry={load} /> : <Loading />;
  const share = async () => {
    try {
      const value = await api.share();
      const url = new URL(value.path, location.href).href;
      if (navigator.share) await navigator.share({title: '安心家 AI 检查报告', text: '父母家的环境安全检查报告', url});
      else { await navigator.clipboard.writeText(url); showToast('分享链接已复制，24 小时内有效'); }
    } catch (value) { showToast(friendlyError(value)); }
  };
  const save = async () => { try { const value = await api.complete(); setReport(value); showToast('报告已保存'); } catch (value) { showToast(friendlyError(value)); } };
  return <section className="page report-page">
    <div className="page-intro"><h1>父母家的安全改造清单</h1></div>
    <div className="report-status"><span className="icon-disc teal-soft"><Icon name="check_circle" filled /></span><div><b>卫生间已完成检查</b><p>家庭检查进度 {report.checked_room_count} / {report.planned_room_count}</p></div></div>
    <div className="report-task" role="status"><Icon name={report.status === 'completed' ? 'task_alt' : 'pending_actions'} /><span><b>{report.status === 'completed' ? '报告已保存' : '检查仍可继续'}</b><small>可以刷新恢复，并继续补拍或检查其他房间</small></span></div>
    <div className="report-metrics"><div><small>{report.score_title}</small><b>{report.assessed_area_score ?? '—'}</b></div><div><small>家庭覆盖度</small><b>{report.coverage_percent}%</b></div><div><small>预计整改后</small><b>{report.projected_score?.display ?? '—'}</b></div></div>
    {(['high', 'medium', 'low'] as const).map(level => {
      const items = report.selected_items.filter(item => item.severity === level);
      return <section key={level} className={`checklist-group ${level}`}><h2><i />{level === 'high' ? '建议优先处理' : level === 'medium' ? '建议近期改善' : '可以继续观察'}</h2>{items.length ? items.map(item => <button key={item.selected_solution_id} className="checklist-item" onClick={() => navigate(`/solutions/${report.rooms[0]?.room_id || ''}/${item.risk_id}`)}><span className="task-box" /><span><b>{item.solution.summary}</b><small>{SEVERITY_COPY[item.severity]} · {formatRange(item.solution.price.total_min, item.solution.price.total_max)}</small></span><Icon name="chevron_right" /></button>) : <p className="empty-copy">还没有选择这一级别的整改方案</p>}</section>;
    })}
    <article className="budget-card"><h2>参考预算</h2><b>{formatRange(report.budget.total_min, report.budget.total_max, report.budget.currency)}</b><div><span>材料 {formatRange(report.budget.material_min, report.budget.material_max)}</span><span>人工 {formatRange(report.budget.labor_min, report.budget.labor_max)}</span></div>{report.budget.unknown_items.length ? <p className="unknown-price">另有 {report.budget.unknown_items.length} 项需现场询价</p> : null}<p>{report.price_disclaimer}</p></article>
    <p className="fine-print">不用一次做完，先从最重要的一件事开始。</p>
    <button className="button primary full" onClick={save}><Icon name="save" filled />保存检查报告</button>
    <div className="split-actions"><button className="button secondary" onClick={share}><Icon name="ios_share" />分享给家人</button><button className="button quiet" onClick={() => navigate('/rooms')}>继续检查其他房间</button></div>
  </section>;
}

function SharePage() {
  const {token = ''} = useParams();
  const [report, setReport] = useState<AssessmentReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.sharedReport(token, controller.signal).then(setReport).catch(value => { if ((value as Error).name !== 'AbortError') setError(value); });
    return () => controller.abort();
  }, [token]);
  if (error) return <ErrorState error={error} />;
  if (!report) return <Loading />;
  return <section className="page share-page"><div className="share-brand"><span className="icon-disc teal-soft"><Icon name="home_health" filled /></span><strong>{PRODUCT_NAME}</strong><small>24 小时只读报告</small></div><h1>父母家的环境安全检查</h1><div className="report-metrics"><div><small>{report.score_title}</small><b>{report.assessed_area_score ?? '—'}</b></div><div><small>家庭覆盖度</small><b>{report.coverage_percent}%</b></div></div><article className="budget-card"><h2>已选择 {report.selected_items.length} 项改造</h2><b>{formatRange(report.budget.total_min, report.budget.total_max)}</b></article><p className="fine-print">这是临时只读分享页，不包含原始照片、完整家人档案或内部日志。</p></section>;
}

export default function App() {
  return <AppProvider><HashRouter><AppShell /></HashRouter></AppProvider>;
}
