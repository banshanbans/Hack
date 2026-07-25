import type {RoomType, Severity} from './types';

export const PRODUCT_NAME = '安心家 AI';

export const ROOM_COPY: Record<RoomType, {name: string; icon: string; hint: string; supported: boolean}> = {
  bathroom: {name: '卫生间', icon: 'bathtub', hint: '湿滑、起身和支撑问题较集中', supported: true},
  bedroom: {name: '卧室', icon: 'bed', hint: '起夜照明、床边防跌倒隐患', supported: false},
  living_room: {name: '客厅', icon: 'chair', hint: '动线障碍、地毯与线缆绊倒风险', supported: false},
  kitchen: {name: '厨房', icon: 'kitchen', hint: '高低处取物、地面油水防滑', supported: false},
  corridor: {name: '玄关走廊', icon: 'door_front', hint: '换鞋支撑、夜间光线照明', supported: false},
  balcony: {name: '阳台', icon: 'balcony', hint: '门槛高低差、晾衣安全', supported: false},
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
  share_expired: '分享链接已失效',
  analysis_interrupted: '服务重启中断了分析，请重新开始',
};
