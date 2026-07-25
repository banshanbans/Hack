import {useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode} from 'react';
import {HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams} from 'react-router-dom';
import {api, friendlyError} from './api';
import {DIFFICULTY_COPY, PRODUCT_NAME, ROOM_COPY, ROOM_PHOTO_GUIDES, SCENE_ELEMENT_COPY, SEVERITY_COPY, STAGE_COPY} from './content';
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

function FlowProgress({pathname}: {pathname: string}) {
  const steps: [RegExp, number, string][] = [
    [/^\/profile$/, 1, '家人情况'],
    [/^\/rooms$/, 2, '选择房间'],
    [/^\/upload\//, 3, '上传照片'],
    [/^\/analyzing\//, 4, 'AI 检查'],
    [/^\/result\//, 5, '查看结果'],
    [/^\/report$/, 6, '改造清单'],
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
  const {session, setSession, setAssessment, health, setHealth, toast, showToast} = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});
  const isHome = location.pathname === '/home';
  const isShare = location.pathname.startsWith('/share/');
  const isMy = location.pathname === '/my';
  const isProfileEditing = location.pathname === '/profile' && new URLSearchParams(location.search).get('from') === 'my';

  useEffect(() => {
    api.health().then(value => setHealth(value.analysis)).catch(() => setHealth('unavailable'));
  }, [setHealth]);

  useEffect(() => {
    mainRef.current?.focus({preventScroll: true});
    const path = location.pathname;
    const frame = window.requestAnimationFrame(() => window.scrollTo({top: scrollPositions.current[path] || 0, behavior: 'instant'}));
    const rememberScroll = () => { scrollPositions.current[path] = window.scrollY; };
    window.addEventListener('scroll', rememberScroll, {passive: true});
    if (session && !isHome && !isShare && !isMy && !isProfileEditing) {
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

  return <div className={`site-frame ${isShare ? '' : 'has-tab-bar'}`}>
    {!isShare && <header className="app-header">
      <button className="icon-button" onClick={goBack} aria-label="返回" disabled={isHome}><Icon name="arrow_back" /></button>
      <strong>{PRODUCT_NAME}</strong>
      <button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="检查与隐私"><Icon name="more_vert" /></button>
    </header>}
    {health === 'demo' && <div className="demo-banner" role="status"><Icon name="science" />演示模式：当前展示固定样例结果</div>}
    {!isShare && !isProfileEditing && <FlowProgress pathname={location.pathname} />}
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
        <Route path="/selected-solution/:roomId/:riskId/:solutionId" element={<SelectedSolutionPage />} />
        <Route path="/report" element={<ReportPage />} />
        <Route path="/my" element={<MyPage />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </main>
    {!isShare && <PersistentTabBar pathname={location.pathname} />}
    {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    {menuOpen && <Modal title="检查与隐私" close={() => setMenuOpen(false)}>
      <p>照片仅用于本次居家环境分析。你可以删除这次检查及服务端保存的分析副本。</p>
      <button className="button danger full" disabled={!session} onClick={() => { setMenuOpen(false); setDeleteConfirmOpen(true); }}><Icon name="delete_forever" />删除本次检查</button>
    </Modal>}
    {deleteConfirmOpen && <Modal title="确定删除本次检查？" close={() => setDeleteConfirmOpen(false)}>
      <p>所有照片、分析结果和已选改造方案都会从服务端删除，且无法撤销。</p>
      <div className="button-stack"><button className="button danger full" onClick={deleteAssessment}><Icon name="delete_forever" />确认永久删除</button><button className="button quiet full" onClick={() => setDeleteConfirmOpen(false)}>取消</button></div>
    </Modal>}
  </div>;
}

function PersistentTabBar({pathname}: {pathname: string}) {
  const navigate = useNavigate();
  const {session} = useApp();
  const myActive = pathname === '/my';
  const checkPath = session ? `/${session.last_route || 'rooms'}` : '/home';
  return <nav className="persistent-tab-bar" aria-label="主导航">
    <button className={!myActive ? 'active' : ''} aria-current={!myActive ? 'page' : undefined} onClick={() => myActive && navigate(checkPath)}><Icon name="fact_check" filled={!myActive} /><span>检查</span></button>
    <button className={myActive ? 'active' : ''} aria-current={myActive ? 'page' : undefined} onClick={() => !myActive && navigate('/my')}><Icon name="person" filled={myActive} /><span>我的</span></button>
  </nav>;
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
  </section>;
}

function ProfilePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const {session, showToast} = useApp();
  const {assessment, loading, error, reload} = useAssessment();
  const initial = assessment?.profile;
  const [profile, setProfile] = useState<Partial<ElderProfile>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (initial) setProfile(initial); }, [initial]);
  if (!session) return <Navigate to="/home" replace />;
  if (loading && !assessment) return <Loading />;
  if (error) return <ErrorState error={error} retry={reload} />;
  const complete = Boolean(profile.mobility && profile.fall_history && profile.living_status);
  const editingFromMy = new URLSearchParams(location.search).get('from') === 'my';
  const changed = Boolean(initial) && (profile.mobility !== initial?.mobility || profile.fall_history !== initial?.fall_history || profile.living_status !== initial?.living_status);
  const saveProfile = async () => {
    if (!complete) return;
    setSaving(true);
    try {
      await api.saveProfile(profile as ElderProfile);
      showToast('个人档案已保存');
      navigate(editingFromMy ? '/my' : '/rooms');
    } catch (value) {
      showToast(friendlyError(value));
    } finally { setSaving(false); }
  };
  const mobility = [
    ['normal', 'directions_walk', '行走基本正常'], ['cane', 'elderly', '使用拐杖'], ['walker', 'assist_walker', '使用助行器'], ['wheelchair', 'accessible', '使用轮椅'],
  ] as const;
  return <section className="page profile-page">
    <div className="page-intro"><h1>{editingFromMy ? '编辑个人档案' : '先了解一下家人的情况'}</h1><p>不同的行动能力，会影响居家风险的判断。</p></div>
    <fieldset className="form-section"><legend>行动能力</legend><div className="mobility-grid">
      {mobility.map(([value, icon, label]) => <button key={value} type="button" className={`choice-card ${profile.mobility === value ? 'selected' : ''}`} onClick={() => setProfile(current => ({...current, mobility: value}))}><Icon name={icon} /><span>{label}</span>{profile.mobility === value && <Icon name="check_circle" filled className="choice-check" />}</button>)}
    </div></fieldset>
    <RadioSection title="最近半年是否发生过跌倒？" name="fall" value={profile.fall_history} onChange={value => setProfile(current => ({...current, fall_history: value as ElderProfile['fall_history']}))} options={[['none', '没有'], ['once', '发生过一次'], ['multiple', '发生过多次']]} />
    <RadioSection title="父母目前是否独居？" name="living" value={profile.living_status} onChange={value => setProfile(current => ({...current, living_status: value as ElderProfile['living_status']}))} options={[['alone', '独居'], ['with_family', '与家人同住']]} />
    <div className="draft-actions"><p className="draft-note"><Icon name="edit_note" />选择只会保留在本页，点击“{editingFromMy ? '保存' : '保存并继续'}”后才会提交。</p>{changed && <button className="text-button" onClick={() => initial && setProfile(initial)}>撤销修改</button>}</div>
    <div className="sticky-footer"><button className="button primary full" disabled={!complete || saving} onClick={saveProfile}>{saving ? '正在保存…' : editingFromMy ? '保存' : '保存并继续'}<Icon name={editingFromMy ? 'save' : 'arrow_forward'} /></button></div>
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
  const openRoom = (room: RoomAssessment) => navigate(room.status === 'result_ready' ? `/result/${room.room_id}` : room.status === 'analyzing' ? `/analyzing/${room.room_id}` : `/upload/${room.room_id}`);
  const choose = async (roomType: keyof typeof ROOM_COPY) => {
    if (multiMode) {
      setSelectedRooms(current => {
        const next = new Set(current);
        if (next.has(roomType)) next.delete(roomType); else next.add(roomType);
        return next;
      });
      return;
    }
    setBusy(true);
    try {
      const existing = assessment?.rooms.find(item => item.room_type === roomType);
      const room = existing || await api.createRoom(roomType);
      openRoom(room);
    } catch (value) { showToast(friendlyError(value)); }
    finally { setBusy(false); }
  };
  const saveSelectedRooms = async () => {
    if (!selectedRooms.size) { showToast('请至少选择一个房间'); return; }
    setBusy(true);
    try {
      const plannedRooms: RoomAssessment[] = [];
      for (const roomType of selectedRooms) {
        const existing = assessment?.rooms.find(item => item.room_type === roomType);
        const room = existing || await api.createRoom(roomType);
        plannedRooms.push(room);
      }
      const nextRoom = plannedRooms.find(item => item.status !== 'result_ready') || plannedRooms[0];
      if (nextRoom) openRoom(nextRoom);
    } catch (value) { showToast(friendlyError(value)); }
    finally { setBusy(false); }
  };
  return <section className="page rooms-page">
    <div className="page-intro"><h1>这次想检查哪里？</h1><p>建议从老人最常活动、也最容易跌倒的区域开始。</p></div>
    <div className="room-mode-switch" role="group" aria-label="房间检查方式">
      <button className={!multiMode ? 'active' : ''} aria-pressed={!multiMode} onClick={() => setMultiMode(false)}>检查一个房间</button>
      <button className={multiMode ? 'active' : ''} aria-pressed={multiMode} onClick={() => setMultiMode(true)}>规划多个房间</button>
    </div>
    {multiMode && <div className="mode-note" role="status"><Icon name="checklist" /><span><b>先制定检查计划</b>所选房间都会保存；接下来会从第一个房间开始，完成后可返回这里继续下一个。</span></div>}
    <div className="room-grid">{Object.entries(ROOM_COPY).map(([key, room]) => {
      const existing = assessment?.rooms.find(item => item.room_type === key);
      const selected = multiMode && selectedRooms.has(key as keyof typeof ROOM_COPY);
      return <button key={key} className={`room-card ${room.priority ? 'recommended' : ''} ${selected ? 'plan-selected' : ''}`} aria-pressed={multiMode ? selected : undefined} disabled={busy} onClick={() => choose(key as keyof typeof ROOM_COPY)}>
        <span className="room-icon"><Icon name={room.icon} filled={room.priority} /></span>
        <b>{room.name}</b><p>{room.hint}</p>
        {selected && <span className="plan-check"><Icon name="check_circle" filled />已选择</span>}
        {existing?.status === 'result_ready' && <span className="completion"><Icon name="check_circle" filled />{existing.score} 分</span>}
      </button>;
    })}</div>
    <button className="button primary full" disabled={busy || (multiMode && !selectedRooms.size)} onClick={multiMode ? saveSelectedRooms : () => choose('bathroom')}>{multiMode ? `保存计划并开始（${selectedRooms.size} 个房间）` : '优先检查卫生间'}</button>
  </section>;
}

function UploadPage() {
  const {roomId = ''} = useParams();
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const {assessment, loading, error, reload} = useAssessment();
  const [busy, setBusy] = useState(false);
  const [pendingDeleteMediaId, setPendingDeleteMediaId] = useState<string | null>(null);
  if (!session) return <Navigate to="/home" replace />;
  if (loading && !assessment) return <Loading />;
  if (error) return <ErrorState error={error} retry={reload} />;
  const room = assessment?.rooms.find(item => item.room_id === roomId);
  if (!room) return <ErrorState error={new Error('没有找到这个房间')} />;
  const roomName = ROOM_COPY[room.room_type].name;
  const photoGuides = ROOM_PHOTO_GUIDES[room.room_type];
  const usable = room.media.some(item => item.quality.usable);
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
    for (const file of files) {
      try {
        const normalized = await normalizeImage(file);
        await api.uploadMedia(roomId, normalized.blob, normalized.width, normalized.height);
      } catch (value) { showToast(friendlyError(value)); }
    }
    setBusy(false);
    reload();
    event.target.value = '';
    if (droppedCount) showToast(`已添加 ${files.length} 张，另 ${droppedCount} 张因达到上限未添加`);
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
    <div className="page-intro"><h1>上传{roomName}照片</h1><p>拍摄越完整，分析结果越准确。</p></div>
    <label className="upload-drop"><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={upload} disabled={busy || room.media.length >= 6} /><span className="upload-icon"><Icon name="photo_camera" filled /></span><b>拍照或从相册选择</b><small>最多 6 张，推荐 1—3 张</small></label>
    <section><h2>拍摄建议</h2><div className="photo-tips">{photoGuides.map(guide => <PhotoTip key={guide.text} {...guide} />)}</div></section>
    <section className="quality-card"><h2>当前照片状态</h2>{room.media.length === 0 ? <p className="muted">还没有照片</p> : <div className="quality-list">{room.media.map(media => <MediaRow key={media.media_id} media={media} remove={() => setPendingDeleteMediaId(media.media_id)} />)}</div>}</section>
    <div className="thumb-strip">{room.media.map(media => <MediaThumb key={media.media_id} media={media} />)}{room.media.length < 6 && <label className="add-thumb"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={upload} disabled={busy} /><Icon name="add_photo_alternate" /></label>}</div>
    <div className="sticky-footer"><button className="button primary full" disabled={!usable || busy} onClick={analyze}><Icon name="document_scanner" />{busy ? '正在处理…' : '开始 AI 检查'}</button></div>
    {pendingDeleteMediaId && <Modal title="删除这张照片？" close={() => setPendingDeleteMediaId(null)}>
      <p>删除后需要重新上传，相关照片不会再用于本次分析。</p>
      <div className="button-stack"><button className="button danger full" onClick={async () => { const mediaId = pendingDeleteMediaId; setPendingDeleteMediaId(null); await remove(mediaId); }}>确认删除</button><button className="button quiet full" onClick={() => setPendingDeleteMediaId(null)}>取消</button></div>
    </Modal>}
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
  const passedNotes = [quality.clear && '画面清晰', quality.floor_visible && '已拍到地面', quality.path_visible && '通道可见', quality.lighting_sufficient && '光线充足'].filter(Boolean);
  const retryNotes = [!quality.clear && '画面不够清晰', quality.major_occlusion && '主要区域被遮挡', quality.missing_views.length ? `缺少：${quality.missing_views.join('、')}` : ''].filter(Boolean);
  const notes = quality.usable ? passedNotes : retryNotes;
  return <article className="media-row"><span className={`status-icon ${quality.usable ? 'ok' : 'warn'}`}><Icon name={quality.usable ? 'check_circle' : 'warning'} filled /></span><div><b>{quality.usable ? '可以用于分析' : '建议重新拍摄'}</b><p>{notes.join(' · ') || (quality.usable ? '照片已通过质量检查' : '请参考上方拍摄建议重拍')}</p></div><button className="icon-button" onClick={remove} aria-label="删除这张照片"><Icon name="delete" /></button></article>;
}

function AnalyzingPage() {
  const {roomId = ''} = useParams();
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const assessmentState = useAssessment();
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [visualStage, setVisualStage] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const room = assessmentState.assessment?.rooms.find(item => item.room_id === roomId);
  const media = room?.media.find(item => item.quality.usable);
  const {url} = useProtectedImage(media?.content_path);
  const poll = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await api.status(roomId, signal);
      setStatus(value);
      setError(null);
    } catch (value) { if ((value as Error).name !== 'AbortError') setError(value); }
  }, [navigate, roomId]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    poll(controller.signal);
    const timer = window.setInterval(() => poll(controller.signal), 1200);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [poll, session]);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsedSeconds(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const stages = ['scene_understood', 'risks_detecting', 'regions_grounded', 'rules_applied', 'score_calculated', 'solutions_ready'];
  useEffect(() => {
    if (status?.status === 'failed') return;
    if (visualStage < stages.length - 1) {
      const timer = window.setTimeout(() => setVisualStage(value => value + 1), 850);
      return () => window.clearTimeout(timer);
    }
    if (status?.status === 'completed') {
      const timer = window.setTimeout(() => navigate(`/result/${roomId}`, {replace: true}), 500);
      return () => window.clearTimeout(timer);
    }
  }, [navigate, roomId, status?.status, visualStage]);
  if (!session) return <Navigate to="/home" replace />;
  if (error || assessmentState.error) return <ErrorState error={error || assessmentState.error} retry={() => { poll(); assessmentState.reload(); }} />;
  const roomName = room ? ROOM_COPY[room.room_type].name : '房间';
  const recognizedElements = [...new Set(media?.quality.scene_elements || [])].filter(item => SCENE_ELEMENT_COPY[item]);
  const tagElements = recognizedElements.slice(0, 3);
  const retry = async () => { try { await api.analyze(roomId); await poll(); } catch (value) { showToast(friendlyError(value)); } };
  const progressPercent = status?.status === 'completed' ? 100 : Math.min(95, Math.round((visualStage + 1) / stages.length * 100));
  const timeExpectation = elapsedSeconds < 8
    ? `预计还需约 ${Math.max(1, 8 - elapsedSeconds)} 秒`
    : elapsedSeconds < 30 ? '正在生成结果，通常会在 1 分钟内完成' : '分析时间比平时久，可以退出等待，稍后从首页继续';
  return <section className="page analyzing-page">
    <div className="center-heading"><h1>正在检查{roomName}</h1><p>AI 正在深度分析您的居家环境</p></div>
    <div className="analysis-progress" role="status" aria-live="polite"><div><b>{progressPercent}%</b><span>{timeExpectation}</span></div><div className="progress"><i style={{width: `${progressPercent}%`}} /></div></div>
    <div className="scan-visual"><img src={url || `${ASSETS}/analysis-bathroom.jpg`} alt={`正在检查的${roomName}`} /><span className="scan-line" />{tagElements.map((element, index) => <span key={element} className={`scan-tag tag-${index + 1}`}>{SCENE_ELEMENT_COPY[element]}</span>)}</div>
    <div className="recognized-card"><b><Icon name={recognizedElements.length ? 'check_circle' : 'progress_activity'} filled={Boolean(recognizedElements.length)} />{recognizedElements.length ? '已识别环境要素' : '正在识别环境要素'}</b><div className="chip-row">{recognizedElements.length ? recognizedElements.map(element => <span key={element}>{SCENE_ELEMENT_COPY[element]}</span>) : <span>请稍候…</span>}</div></div>
    <div className="analysis-steps" role="status" aria-live="polite">{stages.map((stage, index) => <div key={stage} className={index < visualStage ? 'done' : index === visualStage ? 'active' : ''}><span><Icon name={index < visualStage ? 'check' : index === visualStage ? 'progress_activity' : 'circle'} filled={index < visualStage} /></span><p><b>{STAGE_COPY[stage]}</b>{index === visualStage && <small>分析画面中可见的环境特征</small>}</p></div>)}</div>
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

function ResultPage() {
  const {roomId = ''} = useParams();
  const navigate = useNavigate();
  const {session} = useApp();
  const assessmentState = useAssessment();
  const {result, loading, error, reload} = useRoomResult(roomId);
  const [scoreOpen, setScoreOpen] = useState(false);
  if (!session) return <Navigate to="/home" replace />;
  if (loading || assessmentState.loading || !result) return <Loading label="正在准备检查结果…" />;
  if (error || assessmentState.error) return <ErrorState error={error || assessmentState.error} retry={() => { reload(); assessmentState.reload(); }} />;
  const lead = result.risks[0];
  const leadMedia = assessmentState.assessment?.rooms.find(item => item.room_id === roomId)?.media.find(item => item.media_id === lead?.media_id);
  const roomName = ROOM_COPY[result.room_type].name;
  return <section className="page result-page">
    <div className="complete-mark"><Icon name="check_circle" filled /></div>
    <div className="center-heading"><h1>{roomName}检查完成</h1><p>大部分问题都可以通过低成本措施改善。</p></div>
    <div className="result-overview"><article className="summary-card"><div><small>{result.score_label}</small><b className="score-number">{result.score}<em>/100</em></b></div><div className="coverage-block"><span>检查覆盖度 {result.coverage.percent}%</span><div className="progress"><i style={{width: `${result.coverage.percent}%`}} /></div></div><button className="text-button" onClick={() => setScoreOpen(true)}>查看评分依据</button></article>
    <article className="risk-summary"><small>发现问题</small><b className="issue-number">{result.risks.length}<em>个</em></b></article></div>
    {lead && <section><h2>主要风险展示</h2><article className="lead-risk"><ProtectedImage media={leadMedia} fallback={`${ASSETS}/result-shower.jpg`} /><div><span className={`severity ${lead.severity}`}><Icon name="priority_high" />优先处理</span><h3>{lead.title}</h3><p>{lead.evidence}</p><button className="button primary full" onClick={() => navigate(`/risk/${roomId}/${lead.risk_id}`)}>查看怎么改</button></div></article></section>}
    <div className="button-stack"><button className="button secondary full" onClick={() => lead && navigate(`/risk/${roomId}/${lead.risk_id}`)}>查看全部 {result.risks.length} 个问题</button><button className="button quiet full" onClick={() => navigate('/report')}>查看改造清单</button></div>
    {scoreOpen && <Modal title="参考分的计算依据" close={() => setScoreOpen(false)}><div className="score-basis-sheet"><p>参考分由经过校验的风险、家人情况和本地规则确定性计算；覆盖度与参考分分开展示。</p>{result.main_deductions.length ? <div>{result.main_deductions.map(item => <div key={item.risk_id}><span>{item.title}</span><b>扣 {item.deduction} 分</b></div>)}</div> : <p className="muted">当前没有扣分项。</p>}<button className="button primary full" onClick={() => setScoreOpen(false)}>知道了</button></div></Modal>}
  </section>;
}

function RiskPage() {
  const {roomId = '', riskId = ''} = useParams();
  const navigate = useNavigate();
  const {session, assessment} = useApp();
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
    <RiskOverlay imageUrl={url} fallbackUrl={`${ASSETS}/risk-bathroom.jpg`} risks={result.risks} activeId={risk.risk_id} zoom={zoom} drawing={false} onSelect={id => navigate(`/risk/${roomId}/${id}`, {replace: true})} onRegionChange={() => undefined} />
    <div className="risk-switcher"><button disabled={index === 0} onClick={() => switchRisk(index - 1)}><Icon name="chevron_left" /></button><span>风险 {index + 1} / {result.risks.length}</span><button disabled={index === result.risks.length - 1} onClick={() => switchRisk(index + 1)}><Icon name="chevron_right" /></button></div>
    <article className="risk-detail"><span className={`severity ${risk.severity}`}><Icon name="warning" filled />{SEVERITY_COPY[risk.severity]}</span><h1>{risk.title}</h1><p>{risk.evidence}</p><small>参考扣分 {risk.score_deduction} 分 · {risk.region ? '已标出可参考位置' : '位置仍待确认'}</small><button className="button primary full" onClick={() => navigate(`/solutions/${roomId}/${risk.risk_id}`)}><Icon name="location_on" filled />查看解决方案</button></article>
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
    <div className="button-stack"><button className="button secondary full" onClick={() => navigate(nextRisk ? `/risk/${roomId}/${nextRisk.risk_id}` : `/result/${roomId}`)}>{nextRisk ? '继续查看下一个问题' : '返回检查结果'}<Icon name="arrow_forward" /></button><button className="button quiet full" onClick={() => navigate('/report')}>查看改造清单</button></div>
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

function ReportDetails({report}: {report: AssessmentReport}) {
  const risks = report.rooms.flatMap(room => room.risks.map(risk => ({...risk, roomName: ROOM_COPY[room.room_type].name})));
  const selectedByRisk = new Map(report.selected_items.map(item => [item.risk_id, item]));
  return <>
    <section className="report-dimension"><div className="report-section-title"><span>01</span><div><h2>存在的隐患</h2><p>共发现 {risks.length} 个有图像证据的问题</p></div></div>
      <div className="report-risk-list">{risks.length ? risks.map(risk => <article key={risk.risk_id} className={`report-risk-row ${risk.severity}`}><div><span className="severity-label">{SEVERITY_COPY[risk.severity]}</span><small>{risk.roomName}</small></div><h3>{risk.title}</h3><p>{risk.evidence}</p></article>) : <p className="empty-copy">当前已检查区域暂未发现明确隐患</p>}</div>
    </section>
    <section className="report-dimension"><div className="report-section-title"><span>02</span><div><h2>改造建议与预算</h2><p>预算来自结构化价格规则，仅供规划参考</p></div></div>
      <div className="report-recommendations">{risks.length ? risks.map(risk => {
        const selected = selectedByRisk.get(risk.risk_id);
        return <article key={risk.risk_id} className="report-recommendation"><div className="recommendation-heading"><div><small>{risk.roomName} · 对应隐患</small><h3>{risk.title}</h3></div>{selected && <b>{formatRange(selected.solution.price.total_min, selected.solution.price.total_max, selected.solution.price.currency)}</b>}</div>
          {selected ? <><p className="recommendation-name"><span>{selected.solution.tier} 档</span>{selected.solution.title}</p><p>{selected.solution.summary}</p><ol>{selected.solution.actions.map(action => <li key={action}>{action}</li>)}</ol><div className="recommendation-meta"><span>材料 {formatRange(selected.solution.price.material_min, selected.solution.price.material_max, selected.solution.price.currency)}</span><span>人工 {formatRange(selected.solution.price.labor_min, selected.solution.price.labor_max, selected.solution.price.currency)}</span><span>{selected.solution.duration}</span></div>{selected.solution.limitations.length ? <p className="recommendation-limit">实施前确认：{selected.solution.limitations.join('；')}</p> : null}</> : <p className="unselected-solution">尚未选择改造方案，可从隐患详情中查看 A/B/C 三档建议。</p>}
        </article>;
      }) : <p className="empty-copy">暂无需要列入报告的改造建议</p>}</div>
    </section>
    <article className="budget-card report-total-budget"><div><span><Icon name="payments" filled /></span><div><small>已选 {report.selected_items.length} 项 · 参考总预算</small><b>{formatRange(report.budget.total_min, report.budget.total_max, report.budget.currency)}</b></div></div><div className="budget-breakdown"><span>材料 {formatRange(report.budget.material_min, report.budget.material_max, report.budget.currency)}</span><span>人工 {formatRange(report.budget.labor_min, report.budget.labor_max, report.budget.currency)}</span></div>{report.budget.unknown_items.length ? <p className="unknown-price">另有 {report.budget.unknown_items.length} 项需现场询价</p> : null}<p>{report.price_disclaimer}</p></article>
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

async function downloadReportImage(report: AssessmentReport) {
  await document.fonts?.ready;
  const risks = report.rooms.flatMap(room => room.risks.map(risk => ({...risk, roomName: ROOM_COPY[room.room_type].name})));
  const selectedByRisk = new Map(report.selected_items.map(item => [item.risk_id, item]));
  const contentHeight = 800 + risks.length * 190 + risks.reduce((sum, risk) => sum + (selectedByRisk.get(risk.risk_id)?.solution.actions.length || 0) * 58 + (selectedByRisk.has(risk.risk_id) ? 300 : 160), 0);
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
  context.fillText('参考总预算', left + 730, metricY + 50);
  context.fillStyle = '#27240f';
  context.font = '800 52px "Noto Sans SC", sans-serif';
  context.fillText(String(report.assessed_area_score ?? '—'), left + 36, metricY + 125);
  context.fillText(`${risks.length} 个`, left + 400, metricY + 125);
  context.font = '800 38px "Noto Sans SC", sans-serif';
  context.fillText(formatRange(report.budget.total_min, report.budget.total_max, report.budget.currency), left + 730, metricY + 122);
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
  sectionTitle('02', '改造建议与预算', '已选方案的具体做法与结构化参考预算');
  risks.forEach(risk => {
    const selected = selectedByRisk.get(risk.risk_id);
    const boxHeight = selected ? 250 + selected.solution.actions.length * 52 : 132;
    context.fillStyle = '#fffef8'; context.fillRect(left, y, width, boxHeight);
    context.fillStyle = '#6f6848'; context.font = '400 20px "Noto Sans SC", sans-serif'; context.fillText(`${risk.roomName} · ${risk.title}`, left + 28, y + 38);
    if (!selected) {
      context.fillStyle = '#625e48'; context.font = '400 24px "Noto Sans SC", sans-serif'; context.fillText('尚未选择改造方案', left + 28, y + 88); y += boxHeight + 20; return;
    }
    context.fillStyle = '#27240f'; context.font = '800 29px "Noto Sans SC", sans-serif'; context.fillText(`${selected.solution.tier} 档 · ${selected.solution.title}`, left + 28, y + 82);
    context.fillStyle = '#443d1f'; context.font = '800 28px "Noto Sans SC", sans-serif'; context.fillText(formatRange(selected.solution.price.total_min, selected.solution.price.total_max, selected.solution.price.currency), left + width - 250, y + 82);
    let detailY = y + 124;
    context.fillStyle = '#625e48'; context.font = '400 22px "Noto Sans SC", sans-serif';
    detailY = drawWrappedText(context, selected.solution.summary, left + 28, detailY, width - 56, 30);
    selected.solution.actions.forEach((action, index) => { detailY = drawWrappedText(context, `${index + 1}. ${action}`, left + 40, detailY + 10, width - 80, 29); });
    context.fillStyle = '#6f6848'; context.font = '400 20px "Noto Sans SC", sans-serif'; context.fillText(`材料 ${formatRange(selected.solution.price.material_min, selected.solution.price.material_max)}  ·  人工 ${formatRange(selected.solution.price.labor_min, selected.solution.price.labor_max)}  ·  ${selected.solution.duration}`, left + 28, y + boxHeight - 30);
    y += boxHeight + 20;
  });
  y += 28;
  context.fillStyle = '#443d1f'; context.font = '800 34px "Noto Sans SC", sans-serif'; context.fillText(`参考总预算  ${formatRange(report.budget.total_min, report.budget.total_max, report.budget.currency)}`, left, y);
  context.fillStyle = '#6f6848'; context.font = '400 20px "Noto Sans SC", sans-serif'; drawWrappedText(context, report.price_disclaimer, left, y + 42, width, 28);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('报告图片生成失败');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${PRODUCT_NAME}-居家安全检查报告.png`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ReportPage() {
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const [report, setReport] = useState<AssessmentReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [downloading, setDownloading] = useState(false);
  const load = useCallback(() => api.report().then(value => { setReport(value); setError(null); }).catch(setError), []);
  useEffect(() => { if (session) load(); }, [load, session]);
  if (!session) return <Navigate to="/home" replace />;
  if (!report) return error ? <ErrorState error={error} retry={load} /> : <Loading />;
  const download = async () => { setDownloading(true); try { await downloadReportImage(report); showToast('报告图片已下载'); } catch (value) { showToast(friendlyError(value)); } finally { setDownloading(false); } };
  const save = async () => { try { const value = await api.complete(); setReport(value); showToast('报告已保存'); } catch (value) { showToast(friendlyError(value)); } };
  return <section className="page report-page">
    <div className="page-intro"><small className="eyebrow">{PRODUCT_NAME}</small><h1>居家安全检查报告</h1><p>把已发现的隐患、具体改造建议和预算整理在一起。</p></div>
    <div className="report-status"><span className="icon-disc teal-soft"><Icon name="check_circle" filled /></span><div><b>已完成 {report.checked_room_count} 个房间检查</b><p>家庭检查进度 {report.checked_room_count} / {report.planned_room_count}</p></div></div>
    <div className="report-metrics"><div><small>{report.score_title}</small><b>{report.assessed_area_score ?? '—'}</b></div><div><small>家庭覆盖度</small><b>{report.coverage_percent}%</b></div><div><small>预计整改后</small><b>{report.projected_score?.display ?? '—'}</b></div></div>
    <ReportDetails report={report} />
    <p className="fine-print">不用一次做完，先从最重要的一件事开始。</p>
    <button className="button primary full" onClick={save}><Icon name="save" filled />保存检查报告</button>
    <div className="split-actions"><button className="button secondary" disabled={downloading} onClick={download}><Icon name="download" />{downloading ? '正在生成…' : '下载报告图片'}</button><button className="button quiet" onClick={() => navigate('/rooms')}>继续检查其他房间</button></div>
  </section>;
}

function MyMediaThumbnail({media}: {media: MediaAsset}) {
  const {url} = useProtectedImage(media.content_path);
  return <img src={url || `${ASSETS}/demo-upload-floor.jpg`} alt="已上传照片" />;
}

function MyPage() {
  const navigate = useNavigate();
  const {session, showToast} = useApp();
  const assessmentState = useAssessment();
  const [report, setReport] = useState<AssessmentReport | null>(null);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    api.report(controller.signal).then(setReport).catch(() => undefined);
    return () => controller.abort();
  }, [session]);
  if (!session) return <section className="page my-page empty-my"><Icon name="person" className="state-icon" /><h1>我的</h1><p>开始一次检查后，这里会集中展示档案、图片、房屋问题和改造清单。</p><button className="button primary full" onClick={() => navigate('/home')}>开始检查</button></section>;
  if (assessmentState.loading && !assessmentState.assessment) return <Loading />;
  if (assessmentState.error) return <ErrorState error={assessmentState.error} retry={assessmentState.reload} />;
  const assessment = assessmentState.assessment;
  const profile = assessment?.profile || assessment?.profile_json;
  const mobilityCopy: Record<string, string> = {normal: '行走基本正常', limited: '腿脚不太方便', cane: '使用拐杖', walker: '使用助行器', wheelchair: '使用轮椅'};
  const fallCopy: Record<string, string> = {none: '没有', once: '发生过一次', multiple: '发生过多次'};
  const livingCopy: Record<string, string> = {alone: '独居', with_family: '与家人同住'};
  const roomTarget = (room: RoomAssessment) => room.status === 'result_ready' ? `/result/${room.room_id}` : room.status === 'analyzing' ? `/analyzing/${room.room_id}` : `/upload/${room.room_id}`;
  const risks = report?.rooms.flatMap(room => room.risks.map(risk => ({...risk, roomType: room.room_type}))) || [];
  const download = async () => {
    if (!report) { showToast('完成至少一个房间检查后即可下载报告'); return; }
    setDownloading(true);
    try { await downloadReportImage(report); showToast('报告图片已下载'); }
    catch (value) { showToast(friendlyError(value)); }
    finally { setDownloading(false); }
  };
  return <section className="page my-page">
    <div className="page-intro"><h1>我的</h1><p>档案、检查记录与改造方案都集中在这里。</p></div>
    <details className="my-section" open><summary><span><Icon name="person" filled />个人档案</span><Icon name="expand_more" /></summary><div className="my-section-body">
      <div className="section-heading"><b>家人情况</b><button className="text-button" onClick={() => navigate('/profile?from=my')}>编辑</button></div>
      {profile ? <div className="profile-summary"><span>行动能力<b>{mobilityCopy[profile.mobility]}</b></span><span>跌倒史<b>{fallCopy[profile.fall_history]}</b></span><span>居住状态<b>{livingCopy[profile.living_status]}</b></span></div> : <button className="button quiet full" onClick={() => navigate('/profile?from=my')}>完善个人档案</button>}
    </div></details>
    <details className="my-section" open><summary><span><Icon name="photo_library" filled />我的图片</span><Icon name="expand_more" /></summary><div className="my-section-body my-room-list">
      {assessment?.rooms.filter(room => room.media.length).length ? assessment.rooms.filter(room => room.media.length).map(room => <button key={room.room_id} className="my-room-card" onClick={() => navigate(roomTarget(room))}><span><b>{ROOM_COPY[room.room_type].name}</b><small>{room.media.length} 张 · {room.status === 'result_ready' ? '已完成检查' : room.status === 'analyzing' ? '正在分析' : '待继续检查'}</small></span><Icon name="chevron_right" /><span className="my-thumbnails">{room.media.slice(0, 4).map(media => <MyMediaThumbnail key={media.media_id} media={media} />)}</span></button>) : <p className="empty-copy">还没有上传图片</p>}
    </div></details>
    <details className="my-section" open><summary><span><Icon name="warning" filled />房屋问题</span><Icon name="expand_more" /></summary><div className="my-section-body issue-groups">
      {(['high', 'medium', 'low'] as const).map(level => {
        const items = risks.filter(risk => risk.severity === level);
        const title = level === 'high' ? '建议优先处理' : level === 'medium' ? '建议近期改善' : '可以继续观察';
        return <div key={level} className={`my-issue-group ${level}`}><div><b>{title}</b><span>{items.length} 个</span></div>{items.length ? items.map(risk => <button key={risk.risk_id} onClick={() => navigate(`/risk/${risk.room_id}/${risk.risk_id}`)}><span>{risk.title}</span><small>{ROOM_COPY[risk.roomType].name}</small><Icon name="chevron_right" /></button>) : <p>暂时没有这一级别的问题</p>}</div>;
      })}
    </div></details>
    <details className="my-section" open><summary><span><Icon name="handyman" filled />改造清单</span><Icon name="expand_more" /></summary><div className="my-section-body">
      <div className="my-solution-summary"><b>已选 {report?.selected_items.length || 0} 项</b>{report?.selected_items.map(item => {
        const roomId = report.rooms.find(room => room.risks.some(risk => risk.risk_id === item.risk_id))?.room_id || '';
        return <button key={item.selected_solution_id} onClick={() => navigate(`/selected-solution/${roomId}/${item.risk_id}/${item.solution.solution_package_id}`)}><span>{item.solution.summary}</span><b>{formatRange(item.solution.price.total_min, item.solution.price.total_max)}</b><Icon name="chevron_right" /></button>;
      })}<div className="my-budget"><span>参考总预算</span><b>{report ? formatRange(report.budget.total_min, report.budget.total_max, report.budget.currency) : '—'}</b></div><button className="button secondary full" onClick={() => navigate('/report')}>查看报告</button></div>
    </div></details>
    <details className="my-section" open><summary><span><Icon name="download" filled />下载报告给家人</span><Icon name="expand_more" /></summary><div className="my-section-body share-summary"><p>生成包含隐患、具体改造建议与参考预算的长图，可直接发送给家人。</p><button className="button primary full" disabled={!report || downloading} onClick={download}><Icon name="image" />{downloading ? '正在生成报告图片…' : '下载报告图片'}</button></div></details>
  </section>;
}

export default function App() {
  return <AppProvider><HashRouter><AppShell /></HashRouter></AppProvider>;
}
