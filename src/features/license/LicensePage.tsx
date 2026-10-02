import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Form,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import {
  useDeductQuotaMutation,
  useGetWorkspaceQuery,
  usePublishRuleMutation,
  useResolveManualReviewMutation,
  useValidatePackageMutation,
} from '@/app/api'
import type { LicenseRule, QuotaReservation } from '@/types/domain'
import { approvalLevelLabels, findApplicableRule } from '@/services/rules'
import {
  heldReservationFor,
  isReservationCurrent,
  lastReservationFor,
  licenseForPackage,
  ruleQuotaPool,
} from '@/services/quota'

const releaseReasonLabels: Record<string, string> = {
  deducted: '已转扣减',
  returned: '审批退回释放',
  invalidated: '规则/申报变化失效',
  shortfall: '额度不足未占用',
  superseded: '被新预占取代',
}

export function LicensePage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [validatePackage] = useValidatePackageMutation()
  const [deductQuota, deductState] = useDeductQuotaMutation()
  const [publishRule, publishState] = usePublishRuleMutation()
  const [resolveManual, resolveState] = useResolveManualReviewMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [publishingRule, setPublishingRule] = useState<LicenseRule>()
  const [publishForm] = Form.useForm<{ quotaLimit: number; approvalLevel: LicenseRule['approvalLevel'] }>()

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const applicableRule = selected && data ? findApplicableRule(selected, data.rules) : undefined
  const packageFindings = data?.findings.filter((item) => item.packageId === selectedId) ?? []
  const hasHighFindings = packageFindings.some((item) => item.level === 'high')
  const heldReservation = selected && data ? heldReservationFor(data, selected.id) : undefined
  const reservationCurrent =
    heldReservation && selected && data
      ? isReservationCurrent(heldReservation, selected, data)
      : false
  const lastReservation = selected && data ? lastReservationFor(data, selected.id) : undefined
  const licenseRecord = selected && data ? licenseForPackage(data, selected.id) : undefined
  const quotaPool =
    selected?.matchedRuleId && data ? ruleQuotaPool(data, selected.matchedRuleId) : undefined

  if (isLoading || !data) return <div className="panel">正在加载许可规则...</div>

  const poolColumns: TableColumnsType<LicenseRule & { consumed: number; held: number; available: number }> = [
    { title: '规则名称', dataIndex: 'name', minWidth: 220 },
    {
      title: '国家或地区',
      dataIndex: 'destinations',
      width: 120,
      render: (values: string[]) => values.join('、'),
    },
    {
      title: '版本',
      dataIndex: 'version',
      width: 70,
      render: (value: number) => <Tag>v{value}</Tag>,
    },
    {
      title: '审批等级',
      dataIndex: 'approvalLevel',
      width: 100,
      render: (value: LicenseRule['approvalLevel']) => approvalLevelLabels[value],
    },
    { title: '上限', dataIndex: 'quotaLimit', width: 70 },
    { title: '已扣', dataIndex: 'consumed', width: 70 },
    { title: '预占', dataIndex: 'held', width: 70 },
    {
      title: '可用',
      dataIndex: 'available',
      width: 80,
      render: (value: number) => (
        <Tag color={value <= 0 ? 'error' : value <= 10 ? 'warning' : 'success'}>{value}</Tag>
      ),
    },
    {
      title: '操作',
      width: 110,
      render: (_, record) => (
        <Button
          type="link"
          onClick={() => {
            setPublishingRule(record)
            publishForm.setFieldsValue({
              quotaLimit: record.quotaLimit,
              approvalLevel: record.approvalLevel,
            })
          }}
        >
          发布新版本
        </Button>
      ),
    },
  ]

  const ruleRows = data.rules.map((rule) => {
    const pool = ruleQuotaPool(data, rule.id)
    return { ...rule, consumed: pool.consumed, held: pool.held, available: pool.available }
  })

  const reservationColumns: TableColumnsType<QuotaReservation> = [
    {
      title: '预占号',
      dataIndex: 'id',
      width: 150,
      render: (value: string) => value.slice(-12),
    },
    { title: '数额', dataIndex: 'amount', width: 70 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: QuotaReservation['status'], record) =>
        value === 'held' ? (
          <Tag color="processing">占用中</Tag>
        ) : (
          <Tag>{releaseReasonLabels[record.releaseReason ?? ''] ?? '已释放'}</Tag>
        ),
    },
    { title: '轮次', dataIndex: 'round', width: 70, render: (v: number) => `第 ${v} 轮` },
    { title: '规则版本', dataIndex: 'ruleVersion', width: 90, render: (v: number) => `v${v}` },
    {
      title: '缺口',
      dataIndex: 'shortfall',
      width: 70,
      render: (v?: number) => v ?? '—',
    },
    {
      title: '来源',
      dataIndex: 'backfilled',
      width: 100,
      render: (v?: boolean) => (v ? '旧数据回填' : '提交预占'),
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
  ]

  const packageReservations = selected
    ? data.reservations.filter((item) => item.packageId === selected.id)
    : []

  async function refreshValidation() {
    if (!selected) return
    await validatePackage({ packageId: selected.id }).unwrap()
    message.success('规则匹配和缺失声明已重新校验')
  }

  async function deduct() {
    if (!selected) return
    try {
      const result = await deductQuota({ packageId: selected.id }).unwrap()
      message.success(result.notice?.message ?? '已扣减许可额度')
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '额度扣减失败')
    }
  }

  async function confirmPublish() {
    if (!publishingRule) return
    const values = await publishForm.validateFields()
    const quotaLimitChanged = values.quotaLimit !== publishingRule.quotaLimit
    const levelChanged = values.approvalLevel !== publishingRule.approvalLevel
    try {
      const result = await publishRule({
        ruleId: publishingRule.id,
        patch: { quotaLimit: values.quotaLimit, approvalLevel: values.approvalLevel },
        quotaLimitChanged: quotaLimitChanged || levelChanged,
      }).unwrap()
      message.success(result.notice?.message ?? '规则新版本已发布')
      setPublishingRule(undefined)
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '规则发布失败')
    }
  }

  async function confirmManualResolve() {
    if (!selected) return
    try {
      const result = await resolveManual({ packageId: selected.id }).unwrap()
      message.success(result.notice?.message ?? '人工核对已解除')
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '解除人工核对失败')
    }
  }

  const deductDisabled =
    !selected ||
    selected.status !== 'approved' ||
    selected.manualReviewRequired ||
    hasHighFindings ||
    !heldReservation ||
    !reservationCurrent

  return (
    <div>
      <PageHeader
        title="许可与额度"
        description="额度在规则级共享：提交审批时按匹配规则预占，扣减以有效预占为准，台账不可变。"
        actions={
          selected ? (
            <Button loading={deductState.isLoading} onClick={refreshValidation}>
              重新校验
            </Button>
          ) : null
        }
      />

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>选择资料包</h3>
            <Tag>{data.rules.length} 条规则</Tag>
          </div>
          <Select
            value={selectedId || undefined}
            style={{ width: '100%' }}
            onChange={setSelectedId}
            options={data.packages.map((item) => ({
              value: item.id,
              label: `${item.code} · ${item.title} · ${item.destination}`,
            }))}
          />
          {selected ? (
            <Descriptions column={1} bordered size="small" style={{ marginTop: 16 }}>
              <Descriptions.Item label="收件方">{selected.recipient}</Descriptions.Item>
              <Descriptions.Item label="最终用途">{selected.endUse}</Descriptions.Item>
              <Descriptions.Item label="申请额度">{selected.quotaRequest}</Descriptions.Item>
              <Descriptions.Item label="审批状态">
                {selected.status === 'approved'
                  ? '已批准，可核对额度'
                  : selected.status === 'licensed'
                    ? '已扣减额度（记录不可改）'
                    : '尚未完成审批'}
              </Descriptions.Item>
              <Descriptions.Item label="人工核对">
                {selected.manualReviewRequired ? (
                  <Tag color="error">待人工核对，已阻止扣减</Tag>
                ) : (
                  '正常'
                )}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>规则匹配解释</h3>
            <Tag color={applicableRule ? 'success' : 'error'}>
              {applicableRule ? '存在适用规则' : '无适用规则'}
            </Tag>
          </div>
          {applicableRule ? (
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message={`${applicableRule.name}（版本 ${applicableRule.version}）`}
                description={applicableRule.explanation}
              />
              <div>
                <strong>必要声明核对</strong>
                <div style={{ marginTop: 8 }}>
                  {applicableRule.requiredDeclarations.map((declaration) => (
                    <Tag
                      key={declaration}
                      color={selected?.declarations.includes(declaration) ? 'success' : 'error'}
                    >
                      {declaration}
                    </Tag>
                  ))}
                </div>
              </div>
            </Space>
          ) : (
            <Alert type="error" showIcon message="没有匹配到规则，必须执行人工判定。" />
          )}
        </section>
      </div>

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>缺失声明与升级要求</h3>
            <Tag color={hasHighFindings ? 'error' : 'success'}>{packageFindings.length} 项</Tag>
          </div>
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {packageFindings.map((finding) => (
              <Alert
                key={finding.id}
                type={finding.level === 'high' ? 'error' : finding.level === 'medium' ? 'warning' : 'info'}
                showIcon
                message={finding.message}
                description={finding.action}
              />
            ))}
            {!packageFindings.length ? (
              <Alert type="success" showIcon message="当前资料包没有许可核对缺口。" />
            ) : null}
          </Space>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>额度预占与扣减</h3>
            <SafetyCertificateOutlined />
          </div>
          {selected && quotaPool ? (
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Progress
                percent={Math.round(((quotaPool.consumed + quotaPool.held) / quotaPool.limit) * 100)}
                status={quotaPool.available <= 0 ? 'exception' : 'active'}
              />
              <div>
                规则池：上限 {quotaPool.limit}，已扣 {quotaPool.consumed}，预占 {quotaPool.held}，
                可用 <strong>{quotaPool.available}</strong>
              </div>
              {licenseRecord ? (
                <Alert
                  type="success"
                  showIcon
                  message={`已完成许可扣减 ${licenseRecord.amount} 个额度（台账 ${licenseRecord.id.slice(-8)}），记录不可改动。`}
                  description={`扣减时间 ${new Date(licenseRecord.licensedAt).toLocaleString('zh-CN')}，扣减后池内剩余 ${licenseRecord.balanceAfter}。`}
                />
              ) : heldReservation ? (
                <Alert
                  type={reservationCurrent ? 'info' : 'warning'}
                  showIcon
                  message={
                    reservationCurrent
                      ? `有效预占 ${heldReservation.amount} 个额度（第 ${heldReservation.round} 轮，规则版本 v${heldReservation.ruleVersion}）。`
                      : '预占已与当前申报或规则不一致，必须重新提交审批后才能扣减。'
                  }
                  description={`预占号 ${heldReservation.id.slice(-12)}，审批退回只释放该笔占用。`}
                />
              ) : lastReservation ? (
                <Alert
                  type="warning"
                  showIcon
                  message={`最近一笔预占已${releaseReasonLabels[lastReservation.releaseReason ?? ''] ?? '释放'}`}
                  description={
                    lastReservation.shortfall
                      ? `当时申请 ${lastReservation.amount} 个，缺口 ${lastReservation.shortfall} 个，资料包留在草稿。`
                      : '补正后重新提交审批可再次预占。'
                  }
                />
              ) : (
                <Alert type="info" showIcon message="尚无预占记录，提交审批后按规则池预占。" />
              )}
              {selected.manualReviewRequired ? (
                <>
                  <Alert
                    type="error"
                    showIcon
                    message="旧数据升级未能回填预占，资料包待人工核对，系统已阻止扣减。"
                  />
                  <Button
                    danger
                    block
                    loading={resolveState.isLoading}
                    onClick={confirmManualResolve}
                  >
                    合规专员核对无误，补建预占并解除阻断
                  </Button>
                </>
              ) : null}
              <Button
                type="primary"
                block
                disabled={deductDisabled}
                loading={deductState.isLoading}
                onClick={deduct}
              >
                {heldReservation
                  ? `确认按预占扣减 ${heldReservation.amount} 个额度并完成许可`
                  : '确认扣减并完成许可'}
              </Button>
              {selected.status !== 'approved' && selected.status !== 'licensed' ? (
                <Alert type="warning" showIcon message="只有全部审批步骤完成后才允许扣减额度。" />
              ) : null}
              {hasHighFindings ? (
                <Alert type="error" showIcon message="存在高风险核对项，系统拒绝扣减额度。" />
              ) : null}
            </Space>
          ) : null}
        </section>
      </div>

      {selected ? (
        <section className="panel">
          <div className="panel-title">
            <h3>{selected.code} 的预占记录</h3>
            <span className="muted">含已释放与缺口记录，全部保留审计痕迹</span>
          </div>
          <Table
            rowKey="id"
            columns={reservationColumns}
            dataSource={packageReservations}
            pagination={false}
            size="small"
          />
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-title">
          <h3>规则额度池与版本</h3>
          <span className="muted">发布新版本（调整额度上限或审批等级）后，旧版本预占立即失效重算</span>
        </div>
        <Table rowKey="id" columns={poolColumns} dataSource={ruleRows} pagination={false} />
      </section>

      <Modal
        title={publishingRule ? `发布规则新版本：${publishingRule.name}` : ''}
        open={Boolean(publishingRule)}
        onCancel={() => setPublishingRule(undefined)}
        onOk={confirmPublish}
        confirmLoading={publishState.isLoading}
        okText="发布新版本并重算预占"
        cancelText="取消"
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="版本递增后，所有按旧版本预占的在途资料包立即失效并按新规则重算，额度不足的将退回草稿。"
        />
        <Form form={publishForm} layout="vertical">
          <Form.Item name="quotaLimit" label="规则额度上限" rules={[{ required: true }]}>
            <InputNumber min={0} max={99999} style={{ width: '100%' }} addonAfter="额度单位" />
          </Form.Item>
          <Form.Item name="approvalLevel" label="审批等级" rules={[{ required: true }]}>
            <Select
              options={Object.entries(approvalLevelLabels).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
