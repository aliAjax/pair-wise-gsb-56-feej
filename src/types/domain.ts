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
export type FindingType = 'missing-declaration' | 'escalation' | 'version-mismatch' | 'unclassified-page' | 'quota'
export type ReservationStatus = 'active' | 'stale' | 'released' | 'consumed'

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
  quotaRequested: number
  quotaUsed: number
  quotaLimit: number
  quotaReviewRequired?: boolean
  createdAt: string
  updatedAt: string
  versions: PackageVersion[]
}

/**
 * 额度预占记录：提交审批时按匹配规则占用共享额度池。
 * 与审批路线、规则版本和申报内容签名绑定，任一变化即失效重算。
 */
export interface QuotaReservation {
  id: string
  packageId: string
  ruleId: string
  ruleVersion: string
  routeSignature: string
  contentSignature: string
  amount: number
  round: number
  status: ReservationStatus
  backfilled?: boolean
  note?: string
  consumedAmount?: number
  releasedAmount?: number
  createdAt: string
  updatedAt: string
  releasedAt?: string
}

export interface LicenseRule {
  id: string
  name: string
  version: string
  categories: MaterialCategory[]
  destinations: string[]
  technologyTags: string[]
  personnelScopes: string[]
  requiredDeclarations: string[]
  approvalLevel: ApprovalLevel
  quotaLimit: number
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
  packages: MaterialPackage[]
  files: MaterialFile[]
  rules: LicenseRule[]
  findings: ValidationFinding[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  reservations: QuotaReservation[]
}

export interface RuleQuotaSummary {
  ruleId: string
  limit: number
  consumed: number
  reserved: number
  available: number
}

export interface SubmitApprovalResult {
  state: WorkspaceState
  deduplicated: boolean
  reservation?: QuotaReservation
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}
