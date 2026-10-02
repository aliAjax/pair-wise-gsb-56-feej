export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
  | 'returned'
  | 'approved'
  | 'licensed'
  | 'locked'
export type ApprovalLevel = 'standard' | 'enhanced' | 'senior'
export type FindingLevel = 'high' | 'medium' | 'low'
export type FindingType = 'missing-declaration' | 'escalation' | 'version-mismatch' | 'unclassified-page' | 'quota' | 'manual-review'

/** 预占状态：held 占用规则额度；released 已释放（携带释放原因，仅留痕） */
export type ReservationStatus = 'held' | 'released'
export type ReservationReleaseReason =
  | 'deducted'
  | 'returned'
  | 'invalidated'
  | 'shortfall'
  | 'superseded'

export interface QuotaReservation {
  id: string
  packageId: string
  ruleId: string
  /** 预占时绑定的规则版本；规则发布新版本后旧预占立即失效 */
  ruleVersion: number
  /** 审批轮次，与当时生成的审批路线绑定 */
  round: number
  /** 申请预占（也是将来扣减）的额度，不可超扣 */
  amount: number
  status: ReservationStatus
  releaseReason?: ReservationReleaseReason
  /** 额度不足时记录的缺口 */
  shortfall?: number
  /** 绑定的审批路线指纹（顺序/角色/等级/处理人） */
  routeSignature: string
  /** 绑定时的申报内容指纹（目的地、分类、标签、人员、声明、引用文件版本） */
  contentSignature: string
  /** 绑定时的规则内容指纹（不含版本号本身） */
  ruleFingerprint: string
  createdBy: string
  clientId: string
  backfilled?: boolean
  note?: string
  createdAt: string
  releasedAt?: string
}

/** 已完成的许可扣减记录，任何流程都不得修改或删除 */
export interface LicenseRecord {
  id: string
  packageId: string
  packageCode: string
  ruleId: string
  ruleVersion: number
  reservationId: string
  amount: number
  /** 扣减后规则池剩余额度快照 */
  balanceAfter: number
  backfilled?: boolean
  operator: string
  licensedAt: string
}

export interface PageReview {
  id: string
  page: number
  category: MaterialCategory
  controlled: boolean
  desensitized: boolean
  note: string
  reviewer: string
  reviewedAt?: string
}

export interface FileVersion {
  id: string
  label: string
  uploadedAt: string
  hash: string
  sizeKb: number
  pages: PageReview[]
  changeSummary: string
}

export interface MaterialFile {
  id: string
  packageId: string
  name: string
  kind: MaterialCategory
  activeVersionId: string
  referencedVersionId: string
  versions: FileVersion[]
}

export interface ApprovalStep {
  id: string
  order: number
  role: string
  assignee: string
  level: ApprovalLevel
  status: 'waiting' | 'active' | 'approved' | 'returned'
  comment: string
  decidedAt?: string
}

export interface PackageVersion {
  id: string
  label: string
  createdAt: string
  createdBy: string
  summary: string
  snapshot: {
    title: string
    category: MaterialCategory
    destination: string
    endUse: string
    technologyTags: string[]
    personnelScopes: string[]
    declarations: string[]
    activeFileVersions: Record<string, string>
  }
}

export interface ReviewComment {
  id: string
  packageId: string
  author: string
  content: string
  createdAt: string
  round: number
}

export interface MaterialPackage {
  id: string
  code: string
  title: string
  category: MaterialCategory
  applicant: string
  recipient: string
  destination: string
  endUse: string
  technologyTags: string[]
  personnelScopes: string[]
  declarations: string[]
  status: PackageStatus
  matchedRuleId?: string
  approvalRoute: ApprovalStep[]
  currentRound: number
  /** 本次申报申请使用的额度，提交审批时按此数额预占、扣减时按此数额扣减 */
  quotaRequest: number
  /** 旧数据升级无法回填预占时置为待人工核对，阻止扣减 */
  manualReviewRequired?: boolean
  /** 最近一次预占记录 id（含已释放），便于界面直接定位 */
  lastReservationId?: string
  quotaUsed: number
  quotaLimit: number
  createdAt: string
  updatedAt: string
  versions: PackageVersion[]
}

export interface LicenseRule {
  id: string
  name: string
  categories: MaterialCategory[]
  destinations: string[]
  technologyTags: string[]
  personnelScopes: string[]
  requiredDeclarations: string[]
  approvalLevel: ApprovalLevel
  quotaLimit: number
  /** 规则版本，内容变化时由发布动作递增；预占绑定具体版本 */
  version: number
  explanation: string
}

export interface ValidationFinding {
  id: string
  packageId: string
  type: FindingType
  level: FindingLevel
  message: string
  action: string
  ruleId?: string
}

export interface AuditEntry {
  id: string
  packageId?: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
}

export interface WorkspaceState {
  /** 数据模式版本，旧数据缺省视为 1；当前为 2 */
  schemaVersion: number
  packages: MaterialPackage[]
  files: MaterialFile[]
  rules: LicenseRule[]
  findings: ValidationFinding[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  /** 规则级额度预占记录 */
  reservations: QuotaReservation[]
  /** 已完成的许可扣减台账，只增不改 */
  licenses: LicenseRecord[]
}

export interface WorkspaceNotice {
  type: 'info' | 'warning' | 'error'
  message: string
}

/** mutation 返回：工作区状态 + 需要展示给操作者的提示（如并发预占提示） */
export interface WorkspaceMutationResult {
  state: WorkspaceState
  notice?: WorkspaceNotice
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}
