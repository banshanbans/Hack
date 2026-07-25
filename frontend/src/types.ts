export type InputMode = 'photo' | 'video_frame';
export type RoomType = 'bathroom' | 'bedroom' | 'living_room' | 'kitchen' | 'corridor' | 'balcony';
export type Severity = 'high' | 'medium' | 'low';

export interface SessionState {
  assessment_id: string;
  access_token: string;
  last_route?: string;
}

export interface ElderProfile {
  mobility: 'normal' | 'limited' | 'cane' | 'walker' | 'wheelchair';
  fall_history: 'none' | 'once' | 'multiple';
  living_status: 'alone' | 'with_family';
  profile_version?: string;
}

export interface MediaQuality {
  usable: boolean;
  clear: boolean;
  floor_visible: boolean;
  path_visible: boolean;
  lighting_sufficient: boolean;
  major_occlusion: boolean;
  scene_elements: string[];
  missing_views: string[];
  error?: string;
}

export interface MediaAsset {
  media_id: string;
  mime_type: string;
  width: number;
  height: number;
  content_path: string;
  quality: MediaQuality;
}

export interface RoomAssessment {
  room_id: string;
  room_type: RoomType;
  status: string;
  coverage_percent: number;
  score: number | null;
  supported: boolean;
  media: MediaAsset[];
}

export interface Assessment {
  assessment_id: string;
  input_mode: InputMode;
  status: string;
  profile_json?: ElderProfile;
  profile?: ElderProfile;
  planned_rooms_json?: RoomType[];
  rooms: RoomAssessment[];
  rule_set_version: string;
  price_rule_version: string;
}

export interface BBoxRegion {
  type: 'bbox';
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PolygonRegion {
  type: 'polygon';
  points: [number, number][];
}

export type RiskRegion = BBoxRegion | PolygonRegion;

export interface SafetyRisk {
  risk_id: string;
  room_id: string;
  media_id: string;
  risk_code: string;
  state: string;
  feedback: string | null;
  title: string;
  evidence: string;
  confidence: number;
  region: RiskRegion | null;
  severity: Severity;
  score_deduction: number;
}

export interface ScoreBreakdown {
  risk_id: string;
  title: string;
  deduction: number;
  rule_ids: string[];
}

export interface CoverageResult {
  percent: number;
  limited: boolean;
  label?: string;
  missing_elements?: string[];
}

export interface RoomResult {
  room_id: string;
  room_type: RoomType;
  status: string;
  score: number;
  score_label: string;
  coverage: CoverageResult;
  counts: Record<Severity, number>;
  risks: SafetyRisk[];
  score_breakdown: ScoreBreakdown[];
  main_deductions: ScoreBreakdown[];
  rule_set_version: string;
}

export interface AnalysisStatus {
  job_id?: string;
  status: 'not_started' | 'queued' | 'running' | 'completed' | 'failed';
  stage: string;
  error: string | null;
  updated_at?: string;
}

export interface PriceRule {
  currency: string;
  material_min: number | null;
  material_max: number | null;
  labor_min: number | null;
  labor_max: number | null;
  other_min?: number | null;
  other_max?: number | null;
  total_min: number | null;
  total_max: number | null;
  included?: string[];
  excluded?: string[];
}

export interface SolutionPackage {
  solution_package_id: string;
  tier: 'A' | 'B' | 'C';
  title: string;
  summary: string;
  actions: string[];
  difficulty: string;
  duration: string;
  construction_required: boolean;
  professional_installation: string;
  improvement: string;
  limitations: string[];
  budget_group_id: string;
  expected_score_gain_min: number;
  expected_score_gain_max: number;
  price: PriceRule;
}

export interface SolutionsResult {
  risk_id: string;
  solutions: SolutionPackage[];
  selected_solution_package_id: string | null;
  price_disclaimer: string;
}

export interface SelectedItem {
  selected_solution_id: string;
  risk_id: string;
  risk_title: string;
  severity: Severity;
  status: string;
  solution: SolutionPackage;
}

export interface Budget {
  currency: string;
  total_min: number;
  total_max: number;
  material_min: number;
  material_max: number;
  labor_min: number;
  labor_max: number;
  unknown_items: string[];
}

export interface AssessmentReport {
  assessment_id?: string;
  status: string;
  checked_room_count: number;
  planned_room_count: number;
  coverage_percent: number;
  score_title: string;
  assessed_area_score: number | null;
  household_score: number | null;
  rooms: RoomResult[];
  selected_items: SelectedItem[];
  budget: Budget;
  projected_score: {current: number; min: number; max: number; display: number} | null;
  price_disclaimer: string;
  rule_set_version?: string;
  price_rule_version?: string;
}

export interface ApiFailure extends Error {
  code?: string;
  status?: number;
}
