import { useMemo, useState } from 'react'
import { Button, Input, Select, Space, Table, Tag, message } from 'antd'
import type { TableColumnsType } from 'antd'
import { DownloadOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { PageHeader } from '@/components/PageHeader'
import {
  useAddAuditMutation,
  useGetWorkspaceQuery,
  useResetWorkspaceMutation,
  useSimulateLegacyUpgradeMutation,
} from '@/app/api'
import type { AuditEntry } from '@/types/domain'
import { allRulePools, verifyConsistency } from '@/services/quota'

function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([`\ufeff${content}`], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

export function AuditPage() {
  const { data, isLoading } = useGetWorkspaceQuery()
  const [addAudit] = useAddAuditMutation()
  const [resetWorkspace, resetState] = useResetWorkspaceMutation()
  const [simulateLegacy, legacyState] = useSimulateLegacyUpgradeMutation()
  const [keyword, setKeyword] = useState('')
  const [action, setAction] = useState('')
  const [packageId, setPackageId] = useState('')

  const actions = useMemo(
    () => [...new Set(data?.audit.map((item) => item.action) ?? [])],
    [data],
  )
  const filtered = useMemo(
    () =>
      data?.audit.filter((item) => {
        const matchesKeyword =
          !keyword ||
          `${item.action}${item.target}${item.detail}`.toLowerCase().includes(keyword.toLowerCase())
        return (
          matchesKeyword &&
          (!action || item.action === action) &&
          (!packageId || item.packageId === packageId)
        )
      }) ?? [],
    [action, data, keyword, packageId],
  )

  if (isLoading || !data) return <div className="panel">正在加载审计日志...</div>
  const workspace = data
  const consistencyIssues = verifyConsistency(workspace)

  const columns: TableColumnsType<AuditEntry> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
    { title: '操作', dataIndex: 'action', width: 130 },
    {
      title: '资料包',
      dataIndex: 'packageId',
      width: 140,
      render: (value: string | undefined) =>
        data.packages.find((item) => item.id === value)?.code ?? '系统',
    },
    { title: '对象', dataIndex: 'target', width: 220 },
    { title: '操作人', dataIndex: 'operator', width: 105 },
    {
      title: '详情',
      dataIndex: 'detail',
      render: (value: string) => <div className="audit-detail">{value}</div>,
    },
  ]

  async function exportTrace() {
    const consistencyIssues = verifyConsistency(workspace)
    const payload = {
      exportedAt: new Date().toISOString(),
      policySet: '2026 出口管制规则集',
      quota: {
        pools: allRulePools(workspace),
        reservations: workspace.reservations,
        licenses: workspace.licenses,
        consistency: {
          ok: consistencyIssues.length === 0,
          issues: consistencyIssues,
        },
      },
      packages: workspace.packages.map((item) => ({
        code: item.code,
        title: item.title,
        destination: item.destination,
        status: item.status,
        round: item.currentRound,
        quotaRequest: item.quotaRequest,
        manualReviewRequired: Boolean(item.manualReviewRequired),
        activeReservation: workspace.reservations.find(
          (reservation) => reservation.packageId === item.id && reservation.status === 'held',
        ),
        license: workspace.licenses.find((license) => license.packageId === item.id),
        rule: workspace.rules.find((rule) => rule.id === item.matchedRuleId)
          ? {
              name: workspace.rules.find((rule) => rule.id === item.matchedRuleId)?.name,
              version: workspace.rules.find((rule) => rule.id === item.matchedRuleId)?.version,
            }
          : undefined,
        files: workspace.files
          .filter((file) => file.packageId === item.id)
          .map((file) => ({
            name: file.name,
            activeVersion: file.versions.find((version) => version.id === file.activeVersionId)?.label,
            referencedVersion: file.versions.find(
              (version) => version.id === file.referencedVersionId,
            )?.label,
          })),
      })),
      findings: workspace.findings,
      audit: workspace.audit,
    }
    await addAudit({
      entry: {
        action: '导出追溯包',
        target: '全量审批追溯 JSON',
        operator: '当前用户',
        detail: `导出 ${workspace.packages.length} 个资料包、${workspace.reservations.length} 条预占、${workspace.licenses.length} 条许可台账与 ${workspace.audit.length} 条审计；一致性${consistencyIssues.length === 0 ? '通过' : `发现 ${consistencyIssues.length} 项问题`}。`,
      },
    }).unwrap()
    downloadFile(
      `出口管制审批追溯-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    )
    message.success('追溯包已导出并写入审计')
  }

  function exportCsv() {
    const header = ['时间', '操作', '资料包', '对象', '操作人', '详情']
    const rows = filtered.map((item) => [
      new Date(item.createdAt).toLocaleString('zh-CN'),
      item.action,
      workspace.packages.find((pkg) => pkg.id === item.packageId)?.code ?? '系统',
      item.target,
      item.operator,
      item.detail,
    ])
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
      .join('\n')
    downloadFile('出口管制审计日志.csv', csv, 'text/csv;charset=utf-8')
  }

  async function reset() {
    await resetWorkspace().unwrap()
    message.success('演示数据已恢复')
  }

  async function runLegacyUpgrade() {
    try {
      const result = await simulateLegacy().unwrap()
      message.warning(result.notice?.message ?? '旧数据升级完成')
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '升级演示失败')
    }
  }

  return (
    <div>
      <PageHeader
        title="审计与追溯导出"
        description="按资料包查看拆解、分类、版本、审批、额度扣减和导出操作，生成完整追溯包。"
        actions={
          <Space>
            <Button danger icon={<ReloadOutlined />} loading={resetState.isLoading} onClick={reset}>
              恢复演示数据
            </Button>
            <Button icon={<UploadOutlined />} loading={legacyState.isLoading} onClick={runLegacyUpgrade}>
              模拟旧数据升级回填
            </Button>
            <Button onClick={exportCsv}>导出当前日志</Button>
            <Button type="primary" icon={<DownloadOutlined />} onClick={exportTrace}>
              导出追溯包
            </Button>
          </Space>
        }
      />

      {consistencyIssues.length ? (
        <div className="panel" style={{ borderColor: '#ff4d4f' }}>
          <Space direction="vertical" size={6}>
            <strong style={{ color: '#ff4d4f' }}>
              额度/状态一致性检查发现 {consistencyIssues.length} 项问题
            </strong>
            {consistencyIssues.map((issue, index) => (
              <div key={index} className="muted">
                {issue.scope}：{issue.message}
              </div>
            ))}
          </Space>
        </div>
      ) : null}

      <div className="toolbar">
        <Input.Search
          allowClear
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索操作、对象或详情"
          style={{ width: 280 }}
        />
        <Select
          allowClear
          value={action || undefined}
          onChange={(value) => setAction(value ?? '')}
          placeholder="操作类型"
          style={{ width: 180 }}
          options={actions.map((value) => ({ value, label: value }))}
        />
        <Select
          allowClear
          value={packageId || undefined}
          onChange={(value) => setPackageId(value ?? '')}
          placeholder="资料包"
          style={{ width: 240 }}
          options={data.packages.map((item) => ({ value: item.id, label: `${item.code} · ${item.title}` }))}
        />
        <span className="grow" />
        <Tag>{filtered.length} 条日志</Tag>
      </div>

      <section className="panel">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          scroll={{ x: 1180 }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
        />
      </section>
    </div>
  )
}
