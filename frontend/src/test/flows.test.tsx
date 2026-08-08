import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App from '../App';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

function restoreAt(route: string) {
  localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 't-1', last_route: route.replace(/^\//, '')}));
  window.location.hash = `#${route}`;
}

describe('recoverable product states', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('keeps P02 next disabled until all three profile answers exist', async () => {
    restoreAt('/profile');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: []});
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);
    expect(await screen.findByRole('button', {name: /保存并继续/})).toBeDisabled();
    expect(screen.queryByRole('button', {name: '腿脚不太方便'})).not.toBeInTheDocument();
  });

  it('does not ask for more views when an uploaded photo is already usable', async () => {
    restoreAt('/upload/room-1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: [{room_id: 'room-1', room_type: 'bathroom', status: 'media_collecting', media: [{media_id: 'media-1', mime_type: 'image/jpeg', width: 1200, height: 900, content_path: '/media/1', quality: {usable: true, clear: true, floor_visible: true, path_visible: true, lighting_sufficient: true, major_occlusion: false, scene_elements: ['floor'], missing_views: ['马桶区', '淋浴区']}}]}]});
      if (url.endsWith('/media/1')) return new Response(new Blob(['image'], {type: 'image/jpeg'}), {status: 200, headers: {'Content-Type': 'image/jpeg'}});
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);
    expect(await screen.findByText('可以用于分析')).toBeVisible();
    expect(screen.getByText(/画面清晰/)).toBeVisible();
    expect(screen.queryByText(/建议补拍|缺少：马桶区/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: '查看卫生间拍摄建议'}));
    expect(screen.getByRole('dialog', {name: '卫生间拍摄建议'})).toBeVisible();
  });

  it('requires a second confirmation for one room and uses the selected room name', async () => {
    restoreAt('/rooms');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1') && (!init?.method || init.method === 'GET')) return json({assessment_id: 'a-1', planned_rooms: [], rooms: []});
      if (url.endsWith('/planned-rooms') && init?.method === 'PUT') return json({planned_rooms: ['bedroom']});
      if (url.endsWith('/rooms') && init?.method === 'POST') return json({room_id: 'room-bed', room_type: 'bedroom', status: 'collecting_media', coverage_percent: 0, score: null, supported: true, media: []}, 201);
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);
    const bathroom = await screen.findByRole('button', {name: /卫生间 湿滑/});
    const bedroom = await screen.findByRole('button', {name: /卧室 起夜照明/});
    expect(bathroom).toHaveClass('recommended');
    fireEvent.click(bedroom);
    expect(bathroom).not.toHaveClass('recommended');
    expect(screen.getByRole('button', {name: '开始检查卧室'})).toBeEnabled();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/rooms') && init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', {name: '开始检查卧室'}));
    await waitFor(() => expect(window.location.hash).toBe('#/upload/room-bed'));
  });

  it('restores a saved multi-room plan as independent room tasks', async () => {
    restoreAt('/rooms');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', planned_rooms: ['bathroom', 'bedroom'], rooms: [
        {room_id: 'bath', room_type: 'bathroom', status: 'collecting_media', media: [], score: null},
        {room_id: 'bed', room_type: 'bedroom', status: 'result_ready', media: [], score: 88},
      ]});
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);
    expect(await screen.findByRole('heading', {name: '房间检查任务'})).toBeVisible();
    expect(screen.getByRole('button', {name: '上传照片'})).toBeVisible();
    expect(screen.getByRole('button', {name: '查看结果'})).toBeVisible();
  });

  it('keeps profile edits as a draft until the user explicitly saves', async () => {
    restoreAt('/profile');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1/profile') && init?.method === 'PUT') return json({mobility: 'normal', fall_history: 'none', living_status: 'with_family'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: []});
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', {name: '行走基本正常'}));
    fireEvent.click(screen.getByLabelText('没有'));
    fireEvent.click(screen.getByLabelText('与家人同住'));
    await new Promise(resolve => window.setTimeout(resolve, 350));
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/profile') && init?.method === 'PUT')).toBe(false);

    fireEvent.click(screen.getByRole('button', {name: /保存并继续/}));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/profile') && init?.method === 'PUT')).toBe(true));
  });

  it('renders a low-coverage report as an assessed-area score with an empty budget', async () => {
    restoreAt('/report');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/report')) return json({
        status: 'in_progress', checked_room_count: 1, planned_room_count: 6, coverage_percent: 42,
        score_title: '当前已检查区域安全参考分', assessed_area_score: 81, household_score: null,
        rooms: [], selected_items: [], budget: {currency: 'CNY', total_min: 0, total_max: 0, material_min: 0, material_max: 0, labor_min: 0, labor_max: 0, unknown_items: []},
        projected_score: null, price_disclaimer: '仅供参考',
      });
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);
    expect(await screen.findByText('当前已检查区域安全参考分')).toBeVisible();
    expect(screen.getByText('42%')).toBeVisible();
    expect(screen.queryByText('检查仍可继续')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', {name: '存在的隐患'})).toBeVisible();
    expect(screen.getByText('当前已检查区域暂未发现明确隐患')).toBeVisible();
    expect(screen.getByRole('heading', {name: '改造建议与预算'})).toBeVisible();
    expect(screen.getByRole('button', {name: '预览报告'})).toBeEnabled();
    expect(screen.getByRole('button', {name: '保存到手机相册'})).toBeEnabled();
    expect(screen.getByRole('button', {name: '生成分享报告'})).toBeEnabled();
    expect(screen.queryByText('参考总预算')).not.toBeInTheDocument();
  });

  it('restores a completed room-level renovation preview with accessible before and after controls', async () => {
    restoreAt('/renovation-preview/room-1');
    const selectedSolution = {
      risk_id: 'risk-1', risk_title: '淋浴区缺少稳定支撑', solution_package_id: 'SOL_BAR_B', tier: 'B', title: '推荐改造',
      summary: '在淋浴区入口和内部安装可靠固定扶手', actions: ['确认借力位置', '安装2—3个扶手'],
      visualizable_actions: [{action_code: 'shower_fixed_grab_bars', label: '安装固定扶手', risk_id: 'risk-1', risk_title: '淋浴区缺少稳定支撑', region: {type: 'bbox', x: .55, y: .2, width: .25, height: .45}, confidence: .92}],
    };
    const preview = {
      preview_id: 'preview-1', assessment_id: 'a-1', room_id: 'room-1', source_media_id: 'media-1', selection_hash: 'hash-1',
      selected_solutions: [selectedSolution], status: 'completed', stage: 'ready', error: null, provider: 'ark', model: 'seedream',
      prompt_version: 'v1', rule_set_version: 'rules-v1', visualized_actions: selectedSolution.visualizable_actions, skipped_actions: [],
      before_content_path: '/media/before', after_content_path: '/media/after', selected_for_report: false, stale: false,
      created_at: '2026-08-07T00:00:00Z', updated_at: '2026-08-07T00:00:01Z', disclaimer: 'AI 改造效果示意，仅用于方案沟通。',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_video: false, h5_camera: true, ios_home_camera: false, renovation_preview: true}});
      if (url.endsWith('/renovation-preview-context')) return json({
        room_id: 'room-1', room_type: 'bathroom', selection_hash: 'hash-1', selected_solutions: [selectedSolution],
        eligible_media: [{media_id: 'media-1', mime_type: 'image/jpeg', width: 1200, height: 900, content_path: '/media/before', recommended: true, selected_risk_evidence_count: 1}],
        previews: [preview], disclaimer: preview.disclaimer,
      });
      if (url === '/media/before' || url === '/media/after') return new Response(new Blob(['image'], {type: 'image/jpeg'}), {status: 200, headers: {'Content-Type': 'image/jpeg'}});
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);
    expect(await screen.findByRole('heading', {name: '看看改造后的样子'})).toBeVisible();
    expect(screen.getAllByText('安装固定扶手')).toHaveLength(2);
    expect(screen.getByLabelText('显示改造前照片的比例')).toBeVisible();
    const detailOverlay = screen.getByRole('img', {name: 'AI 改造细节位置，共 1 处'});
    expect(detailOverlay).toBeVisible();
    expect(screen.getByRole('list', {name: '已定位的改造细节'})).toBeVisible();
    expect(screen.getByRole('button', {name: '查看改造前'})).toBeEnabled();
    expect(screen.getByRole('button', {name: '查看改造后'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button', {name: '查看改造前'}));
    expect(detailOverlay).toHaveStyle({clipPath: 'inset(0 0 0 100%)'});
    fireEvent.click(screen.getByRole('button', {name: '查看改造后'}));
    expect(detailOverlay).toHaveStyle({clipPath: 'inset(0 0 0 0%)'});
    expect(screen.getByRole('button', {name: /保存到报告/})).toBeEnabled();
    expect(screen.getByText(/仅用于方案沟通/)).toBeVisible();
  });

  it('saves profile edits from My and returns to My instead of entering the check flow', async () => {
    restoreAt('/my');
    const assessment = {assessment_id: 'a-1', rooms: [], profile: {mobility: 'cane', fall_history: 'once', living_status: 'alone'}};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json(assessment);
      if (url.endsWith('/profile') && init?.method === 'PUT') return json({mobility: 'normal', fall_history: 'once', living_status: 'alone'});
      if (url.endsWith('/report')) return json({status: 'in_progress', checked_room_count: 0, planned_room_count: 0, coverage_percent: 0, score_title: '当前已检查区域安全参考分', assessed_area_score: null, household_score: null, rooms: [], selected_items: [], budget: {currency: 'CNY', total_min: 0, total_max: 0, material_min: 0, material_max: 0, labor_min: 0, labor_max: 0, unknown_items: []}, projected_score: null, price_disclaimer: '仅供参考'});
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '编辑'}));
    expect(window.location.hash).toBe('#/profile?from=my');
    fireEvent.click(await screen.findByRole('button', {name: '行走基本正常'}));
    fireEvent.click(screen.getByRole('button', {name: /^保存$/}));
    await waitFor(() => expect(window.location.hash).toBe('#/my'));
  });

  it('opens score details in a bottom sheet and keeps the persistent tabs', async () => {
    restoreAt('/result/room-1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: [{room_id: 'room-1', room_type: 'bathroom', status: 'result_ready', media: []}]});
      if (url.endsWith('/rooms/room-1/result')) return json({
        room_id: 'room-1', room_type: 'bathroom', status: 'result_ready', score: 78,
        score_label: '已检查区域参考分', coverage: {percent: 85, limited: false},
        counts: {high: 0, medium: 0, low: 0}, risks: [], score_breakdown: [],
        main_deductions: [{risk_id: 'risk-1', title: '缺少可靠扶手', deduction: 12, rule_ids: ['rule-1']}], rule_set_version: 'v1',
      });
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', {name: '查看评分依据'}));
    expect(screen.getByRole('dialog', {name: '参考分的计算依据'})).toBeVisible();
    expect(screen.getByText('扣 12 分')).toBeVisible();
    expect(screen.getByRole('navigation', {name: '主导航'})).toBeVisible();
    expect(screen.getByRole('button', {name: '我的'})).toBeVisible();
  });

  it('shows a result request failure instead of an endless loading state', async () => {
    restoreAt('/result/room-1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: [{room_id: 'room-1', room_type: 'bathroom', status: 'result_ready', media: []}]});
      if (url.endsWith('/rooms/room-1/result')) return json({code: 'provider_timeout', message: 'timed out'}, 504);
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', {name: '这次没有完成'})).toBeVisible();
    expect(screen.getByText('分析时间较长，请稍后重试')).toBeVisible();
    expect(screen.queryByText('正在准备检查结果…')).not.toBeInTheDocument();
  });

  it('drives the analysis step from the server stage', async () => {
    restoreAt('/analyzing/room-1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: [{
        room_id: 'room-1', room_type: 'bathroom', status: 'analyzing', score: null,
        media: [{media_id: 'media-1', content_path: '/media/1', quality: {usable: true, scene_elements: ['floor'], missing_views: []}}],
      }]});
      if (url.endsWith('/media/1')) return new Response(new Blob(['image'], {type: 'image/jpeg'}), {status: 200, headers: {'Content-Type': 'image/jpeg'}});
      if (url.endsWith('/rooms/room-1/status')) return json({job_id: 'job-1', status: 'running', stage: 'rules_applied', error: null});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);

    const stage = await screen.findByText('正在应用居家安全规则');
    expect(stage.closest('.active')).not.toBeNull();
    expect(screen.getByText('当前服务端任务阶段')).toBeVisible();
  });

  it('does not overlap status polling while the previous request is pending', async () => {
    restoreAt('/analyzing/room-1');
    let statusCalls = 0;
    const pendingStatus = new Promise<Response>(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: [{room_id: 'room-1', room_type: 'bathroom', status: 'analyzing', media: []}]});
      if (url.endsWith('/rooms/room-1/status')) {
        statusCalls += 1;
        return pendingStatus;
      }
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    await waitFor(() => expect(statusCalls).toBe(1));
    await new Promise(resolve => window.setTimeout(resolve, 1350));
    expect(statusCalls).toBe(1);
  });

  it('recovers a stale risk route after re-analysis instead of showing a generic failure', async () => {
    restoreAt('/solutions/room-1/stale-risk');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: [{room_id: 'room-1', room_type: 'bathroom', media: []}]});
      if (url.endsWith('/rooms/room-1/result')) return json({
        room_id: 'room-1', room_type: 'bathroom', status: 'result_ready', score: 82,
        score_label: '已检查区域参考分', coverage: {percent: 80, limited: false},
        counts: {high: 1, medium: 0, low: 0}, score_breakdown: [], main_deductions: [], rule_set_version: 'v1',
        risks: [{risk_id: 'current-risk', room_id: 'room-1', media_id: 'media-1', risk_code: 'BATH_NO_GRAB_BAR', state: 'unreviewed', feedback: null, title: '缺少可靠扶手', evidence: '淋浴区未见可靠扶手', confidence: 0.9, region: null, severity: 'high', score_deduction: 12}],
      });
      if (url.endsWith('/risks/stale-risk/solutions')) return json({code: 'risk_not_found', message: 'not found'}, 404);
      if (url.endsWith('/risks/current-risk/solutions')) return json({risk_id: 'current-risk', solutions: [], selected_solution_package_id: null, price_disclaimer: '仅供参考'});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    expect(await screen.findByRole('heading', {name: '缺少可靠扶手怎么改？'})).toBeVisible();
    expect(window.location.hash).toBe('#/solutions/room-1/current-risk');
    expect(screen.queryByText('这次没有完成')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/risks/stale-risk/solutions'))).toBe(false);
  });

  it('redirects a deep solution link without issuing protected calls when no session exists', async () => {
    window.location.hash = '#/solutions/room-1/stale-risk';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/health')) return json({analysis: 'ark'});
      return json({code: 'unexpected_request', message: 'unexpected'}, 500);
    });

    render(<App />);
    expect(await screen.findByRole('heading', {name: /给父母的家/})).toBeVisible();
    expect(window.location.hash).toBe('#/home');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/result') || String(input).includes('/solutions'))).toBe(false);
  });

  it('requires room selection before entering the temporary H5 camera', async () => {
    window.location.hash = '#/home';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_video: true, h5_camera: true, ios_home_camera: true}});
      if (url.endsWith('/api/v2/assessments') && init?.method === 'POST') return json({assessment_id: 'camera-assessment', access_token: 'camera-token'}, 201);
      if (url.endsWith('/api/v2/assessments/camera-assessment')) return json({assessment_id: 'camera-assessment', profile: {}, rooms: [{room_id: 'camera-room', room_type: 'living_room', status: 'collecting_media', media: []}]});
      if (url.endsWith('/api/v2/assessments/camera-assessment/rooms') && init?.method === 'POST') return json({room_id: 'camera-room', room_type: 'living_room', status: 'collecting_media', media: []}, 201);
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '中央相机'}));
    const dialog = screen.getByRole('dialog', {name: '开始家庭实时检查'});
    expect(dialog).toBeVisible();
    expect(dialog).toHaveTextContent('iPhone App 会调用原生扫描');
    expect(dialog).toHaveTextContent('扫描结束只保存代表画面');
    expect(dialog).toHaveTextContent('保存后可在照片页确认并开始 AI 检查');
    expect(window.location.hash).toBe('#/home');
    fireEvent.click(screen.getByRole('button', {name: /选择房间/}));
    fireEvent.click(screen.getByRole('button', {name: /客厅/}));
    await waitFor(() => expect(window.location.hash).toBe('#/camera?room_id=camera-room&auto_start=1'));
    expect(await screen.findByRole('heading', {name: '实时扫描'})).toBeVisible();
    expect(screen.getByRole('button', {name: '结束扫描并保存'})).toBeDisabled();
  });
});
