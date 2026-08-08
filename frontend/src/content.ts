import type {RoomType, Severity} from './types';

export const PRODUCT_NAME = '安心家 AI';

export const CAMERA_COPY = {
  invitationTitle: '开始家庭实时检查',
  invitationBody: '先选择房间。iPhone App 会调用原生扫描，外部浏览器会使用网页相机。',
  enter: '选择房间',
  privacy: '只有通过本地质量与场景变化检查的候选画面才会发送；离开页面后摄像头会立即关闭。',
  reportTip: '扫描结束只保存代表画面；档案完整时会直接开始正式分析，未完成则先引导补齐。',
  regionOverlayLabel: '最近分析画面的临时建议位置',
  regionOverlayDescription: '标注仅对应最近一张已分析画面，不会固定在现实物体上。',
  positionLeft: '左侧',
  positionCenter: '中央',
  positionRight: '右侧',
  positionTop: '上方',
  positionMiddle: '中部',
  positionBottom: '下方',
  regionItemLabel: (number: number, title: string, position: string, confidence: number, needsManualCheck: boolean) =>
    `临时建议 ${number}，${title}，位于画面${position}，模型把握度 ${Math.round(confidence * 100)}%${needsManualCheck ? '，需要人工确认' : ''}`,
};

export const ADVISOR_COPY = {
  title: 'AI适老顾问',
  draftLabel: '待确认提示',
  formalLabel: '正式检查结果',
  privacy: '仅保存本次检查的文字对话，不保存原始音频。',
  draftDisclaimer: '以下是扫描中的临时提示，不计分、不显示风险等级或预算；结束扫描后会基于代表画面重新正式分析。',
  formalDisclaimer: '风险等级、评分和预算由已校验的规则与价格数据生成；顾问只负责解释和引导操作。',
  inputPlaceholder: '输入问题，或点击麦克风说话…',
  states: {
    idle: '点击开始说话',
    connecting: '正在连接',
    listening: '正在听',
    thinking: '正在理解',
    speaking: '正在回答·点击打断',
    reconnecting: '重连中',
    error: '语音不可用，可继续文字咨询',
  },
};

export const HOME_HERO_COPY = {
  rugCallout: '留意地毯边缘',
  handrailCallout: '建议增设扶手',
  cameraEntry: '使用实时相机检查',
  eyebrow: '居家安全检查',
  progressTitle: '本次检查进度',
  progressIdle: '从一张清晰的房间照片开始',
  progressActive: (stage: string) => `进行到：${stage}`,
};

export const ONBOARDING_COPY = {
  replay: '重新体验新手引导',
  steps: {
    start: {
      title: '开始一次居家安全检查',
      body: '先开始本次检查，接下来会了解家人情况、选择房间并采集环境画面。',
    },
    profile: {
      title: '先了解家人情况',
      body: '行动能力、跌倒史和居住状态会影响居家风险的规则判断。完成后会继续选择房间。',
    },
    rooms: {
      title: '选择需要检查的房间',
      body: '建议先从老人最常活动、也最容易跌倒的区域开始。',
    },
    capture: {
      title: '任选一种采集方式',
      body: '上传 1—3 张清晰照片，或使用中央相机边扫描边获得临时提示。两种方式都会保存代表画面，用于之后的正式分析。',
    },
    analyze: {
      title: '画面已准备好',
      body: '点击开始 AI 检查。正式分析前会再次校验家人档案和照片质量。',
    },
    result: {
      title: '查看有证据的风险',
      body: '参考分与覆盖度分开显示。点击图片标注或问题列表，可以查看证据位置和风险等级。',
    },
    risk: {
      title: '从风险进入整改方案',
      body: '确认证据后，查看这个问题可以怎样处理。',
    },
    solutions: {
      title: '比较 A/B/C 整改方案',
      body: 'A 是临时止险，B 是推荐改造，C 是专业改造。金额来自结构化价格规则，不会由 AI 自由编造。',
    },
    report: {
      title: '在报告中查看预算与进度',
      body: '报告汇总已检查区域、整改清单和参考预算，也可以保存或分享给家人。',
    },
  },
} as const;

export const UPLOAD_COPY = {
  eyebrow: '房间影像',
};

export const RENOVATION_PREVIEW_COPY = {
  title: '看看改造后的样子',
  intro: '把这个房间已经加入清单的方案，合并成一张 AI 效果示意图。',
  generate: '生成改造效果',
  save: '保存到报告',
  disclaimer: 'AI 改造效果示意，仅用于方案沟通。安装位置、尺寸、墙体、防水与施工可行性须现场确认；实际安全改善需整改后重新拍摄复查。',
};

export const ROOM_COPY: Record<RoomType, {name: string; icon: string; hint: string; supported: boolean; priority?: boolean}> = {
  bathroom: {name: '卫生间', icon: 'bathtub', hint: '湿滑、起身和支撑问题较集中', supported: true, priority: true},
  bedroom: {name: '卧室', icon: 'bed', hint: '起夜照明、床边起身与通行风险', supported: true},
  living_room: {name: '客厅', icon: 'chair', hint: '动线障碍、地毯与线缆绊倒风险', supported: true},
  kitchen: {name: '厨房', icon: 'kitchen', hint: '高低处取物、地面油水防滑', supported: true},
  corridor: {name: '玄关走廊', icon: 'door_front', hint: '换鞋支撑、门槛与夜间照明', supported: true},
  balcony: {name: '阳台', icon: 'balcony', hint: '门槛高低差、通行与晾衣安全', supported: true},
};

export const SCENE_ELEMENT_COPY: Record<string, string> = {
  floor: '地面', entrance_threshold: '门槛', shower: '淋浴区', toilet: '马桶', support_wall: '支撑墙面', lighting: '照明',
  bed: '床铺', bedside: '床边', wardrobe: '衣柜', walking_path: '通行区', switch: '开关',
  sofa: '沙发', coffee_table: '茶几', rug: '地毯', cable: '线缆',
  counter: '操作台', stove: '灶台', sink: '水槽', storage: '储物区',
  doorway: '出入口', shoe_area: '换鞋区', handrail: '扶手',
  balcony_door: '阳台门', drying_area: '晾衣区', guardrail: '护栏',
};

export const ROOM_PHOTO_GUIDES: Record<RoomType, Array<{image: string; icon: string; text: string}>> = {
  bathroom: [
    {image: 'guide-doorway.jpg', icon: 'pan_tool_alt', text: '在门口拍一张全景'},
    {image: 'guide-floor.jpg', icon: 'door_front', text: '拍清楚地面和门槛'},
    {image: 'guide-shower.jpg', icon: 'shower', text: '补拍马桶或淋浴区域'},
  ],
  bedroom: [
    {image: 'guide-doorway.jpg', icon: 'pan_tool_alt', text: '在门口拍床和主通道'},
    {image: 'guide-floor.jpg', icon: 'bed', text: '拍清床边起身区'},
    {image: 'hero-living-room.jpg', icon: 'light', text: '补拍开关和夜间照明'},
  ],
  living_room: [
    {image: 'hero-living-room.jpg', icon: 'pan_tool_alt', text: '拍沙发到出入口全景'},
    {image: 'guide-floor.jpg', icon: 'rug', text: '拍清地毯和通行地面'},
    {image: 'guide-doorway.jpg', icon: 'cable', text: '补拍线缆与家具间隙'},
  ],
  kitchen: [
    {image: 'guide-doorway.jpg', icon: 'pan_tool_alt', text: '在门口拍厨房全景'},
    {image: 'guide-floor.jpg', icon: 'floor', text: '拍清水槽前和主通道'},
    {image: 'hero-living-room.jpg', icon: 'shelves', text: '补拍高位和低位储物区'},
  ],
  corridor: [
    {image: 'guide-doorway.jpg', icon: 'door_front', text: '拍清出入口和门槛'},
    {image: 'guide-floor.jpg', icon: 'directions_walk', text: '沿主通道拍完整地面'},
    {image: 'hero-living-room.jpg', icon: 'chair', text: '补拍换鞋区和支撑位置'},
  ],
  balcony: [
    {image: 'guide-doorway.jpg', icon: 'door_front', text: '拍清阳台门和高差'},
    {image: 'guide-floor.jpg', icon: 'directions_walk', text: '拍完整地面与通道'},
    {image: 'hero-living-room.jpg', icon: 'dry_cleaning', text: '补拍晾衣区和护栏'},
  ],
};

export const SEVERITY_COPY: Record<Severity, string> = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
};

export const DIFFICULTY_COPY: Record<string, string> = {
  none: '无需施工',
  low: '较低',
  medium: '中等',
  high: '较高',
};

export const STAGE_COPY: Record<string, string> = {
  collecting_media: '等待上传照片',
  quality_checked: '正在确认照片质量',
  scene_understood: '已识别房间与主要设施',
  risks_detecting: '正在检查地面与通行区域',
  regions_grounded: '正在确认风险位置',
  rules_applied: '正在应用居家安全规则',
  score_calculated: '正在计算参考分与覆盖度',
  solutions_ready: '已完成整改方案准备',
  failed: '分析没有完成',
};

export const ERROR_COPY: Record<string, string> = {
  assessment_access_denied: '上次检查已失效，请重新开始',
  provider_not_configured: '分析服务尚未配置',
  provider_timeout: '分析时间较长，请稍后重试',
  provider_invalid_response: '这次没有看清，请重新分析',
  provider_refusal: '这张照片暂时无法完成分析',
  room_rules_not_ready: '这个房间的完整规则仍在完善中',
  no_usable_media: '至少需要一张可以看清的照片',
  analysis_interrupted: '服务重启中断了分析，请重新开始',
  analysis_start_failed: '暂时无法开始分析，请稍后重试',
  analysis_failed: '分析没有完成，请重新尝试',
};
