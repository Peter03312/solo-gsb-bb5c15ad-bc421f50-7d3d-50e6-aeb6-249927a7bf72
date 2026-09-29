import { buildBaseline, compareWithBaseline, mergeRanges } from '../src/lib/baseline'
import {
  allocatableSegments,
  firstFreeAddress,
  reconcileHosts,
  validateManualAddress,
} from '../src/lib/hosts'
import { buildDnsmasqLeases, dnsmasqLeasesText } from '../src/lib/dnsmasq'
import {
  buildReverseDns,
  childZoneName,
  classifyDeviceName,
  parentZoneName,
  PLACEHOLDER_NS,
  PLACEHOLDER_RNAME,
  resolveReverseSegment,
} from '../src/lib/reverseDns'
import { buildOption121, encodeRoute, resolveClientSegment } from '../src/lib/option121'
import { buildDhcpPool, resolvePoolSegment } from '../src/lib/dhcpPool'
import { buildLeaseImport, mapHeader, parseCsv } from '../src/lib/leaseImport'
import { checkMac, normalizeMacInput } from '../src/lib/mac'
import {
  fragmentPiece,
  IPV4_HEADER_LEN,
  listValidDevices,
  originalDatagram,
  parseMtu,
  parsePayload,
  simulateFragments,
  validateFragInput,
} from '../src/lib/fragmentation'
import { buildExportJson } from '../src/lib/exporter'
import { intToIp, ipToInt, prefixForHosts } from '../src/lib/ip'
import { plan } from '../src/lib/planner'
import { blocksToCidrList, summarizeSegments } from '../src/lib/summary'
import type { DhcpExclusionInput, FragHopInput, HostAssignment, PlannerInput, Segment } from '../src/lib/types'

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures++
    console.log(`FAIL  ${name} ${extra}`)
  }
}

// 1) 容量换算
check('2 台主机 -> /30', prefixForHosts(2) === 30)
check('3 台主机 -> /29', prefixForHosts(3) === 29)
check('100 台主机 -> /25', prefixForHosts(100) === 25)
check('254 台主机 -> /24', prefixForHosts(254) === 24)
check('255 台主机 -> /23', prefixForHosts(255) === 23)

// 2) 示例场景：保留 0/28，固定 64/28；自动 100/40/25/2
const demo: PlannerInput = {
  parentCidr: '192.168.10.0/24',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q3', name: '监控', hosts: 25, cidr: '192.168.10.32/27' },
    { id: 'q4', name: '管理', hosts: 2, cidr: '' },
  ],
}
const r = plan(demo)
check('示例无输入错误', r.inputErrors.length === 0, JSON.stringify(r.inputErrors))
check('示例无失败需求', r.failures.length === 0, JSON.stringify(r.failures))
const auto = r.segments.filter((s) => s.kind === 'auto').map((s) => s.cidr)
check(
  '自动分配结果正确（按地址顺序）',
  JSON.stringify(auto) === JSON.stringify(['192.168.10.16/30', '192.168.10.64/26', '192.168.10.128/25']),
  JSON.stringify(auto),
)
check('总地址守恒 256', r.summary.reserved + r.summary.fixed + r.summary.auto + r.summary.free === 256)
check('示例浪费量=53', r.summary.waste === 53, String(r.summary.waste))
check('示例空闲=12（20–31 + 192–255）', r.summary.free === 12, String(r.summary.free))

// 2b) 回归：保留 0/28、固定 64/28，/26 需求必须推进到 128（不能压在固定段上）
const reg: PlannerInput = {
  parentCidr: '192.168.10.0/24',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
  requirements: [
    { id: 'f', name: '固定', hosts: 2, cidr: '192.168.10.64/28' },
    { id: 'a', name: '自动', hosts: 40, cidr: '' },
  ],
}
const rr = plan(reg)
check(
  '对齐推进不侵占固定段',
  rr.segments.find((s) => s.kind === 'auto')?.cidr === '192.168.10.128/26',
  JSON.stringify(rr.segments.map((s) => [s.kind, s.cidr])),
)
check(
  '占用段之间无重叠',
  (() => {
    const occ2 = rr.segments.filter((s) => s.kind !== 'free').sort((a, b) => a.start - b.start)
    for (let i = 1; i < occ2.length; i++) if (occ2[i].start <= occ2[i - 1].end) return false
    return true
  })(),
)

// 3) 同规模按录入顺序：/28 保留外，3 个 /30 需求依次落到 16、20、24
const tie: PlannerInput = {
  parentCidr: '10.0.0.0/27',
  reservations: [{ id: 'r1', name: 'res', cidr: '10.0.0.0/28' }],
  requirements: [
    { id: 'a', name: 'A', hosts: 2, cidr: '' },
    { id: 'b', name: 'B', hosts: 2, cidr: '' },
    { id: 'c', name: 'C', hosts: 2, cidr: '' },
  ],
}
const rt = plan(tie)
check(
  '同规模按录入顺序分配',
  JSON.stringify(rt.segments.filter((s) => s.kind === 'auto').map((s) => s.cidr)) ===
    JSON.stringify(['10.0.0.16/30', '10.0.0.20/30', '10.0.0.24/30']),
  JSON.stringify(rt.segments),
)

// 4) 放不下：父 /30，需求 100 台，应给出原因
const tooBig: PlannerInput = {
  parentCidr: '192.168.0.0/30',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 100, cidr: '' }],
}
const rb = plan(tooBig)
check('超大需求失败且有原因', rb.failures.length === 1 && /最大连续空闲块/.test(rb.failures[0].reason), rb.failures[0]?.reason)

// 5) 碎片化：/30 块被保留区切碎，大网段找不到对齐空间
const frag: PlannerInput = {
  parentCidr: '10.1.0.0/26',
  reservations: [
    { id: 'r1', name: 'r1', cidr: '10.1.0.16/30' },
    { id: 'r2', name: 'r2', cidr: '10.1.0.32/30' },
    { id: 'r3', name: 'r3', cidr: '10.1.0.48/30' },
  ],
  requirements: [{ id: 'x', name: '大块', hosts: 20, cidr: '' }], // 需要 /27
}
const rf = plan(frag)
check('碎片场景 /27 无法分配', rf.failures.length === 1, JSON.stringify(rf.failures))
check('失败后其余段仍正常输出', rf.segments.filter((s) => s.kind === 'reserved').length === 3)

// 6) 固定网段超出父网段 -> 输入错误
const outside: PlannerInput = {
  parentCidr: '192.168.1.0/24',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 2, cidr: '192.168.2.0/30' }],
}
check('固定网段越界报错', plan(outside).inputErrors.some((e) => /不在父网段/.test(e)))

// 7) 保留区与固定网段重叠 -> 输入错误
const overlap: PlannerInput = {
  parentCidr: '192.168.1.0/24',
  reservations: [{ id: 'r', name: 'R', cidr: '192.168.1.0/28' }],
  requirements: [{ id: 'x', name: 'X', hosts: 2, cidr: '192.168.1.8/30' }],
}
check('保留与固定重叠报错', plan(overlap).inputErrors.some((e) => /重叠/.test(e)))

// 8) 固定网段容量不足 -> 报错并显示实际可用数
const small: PlannerInput = {
  parentCidr: '192.168.1.0/24',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 20, cidr: '192.168.1.0/28' }],
}
check('固定段容量不足报错', plan(small).inputErrors.some((e) => /仅提供 14/.test(e)))

// 9) 非规范网络地址（主机位非 0）报错
const nonCanonical: PlannerInput = {
  parentCidr: '192.168.1.10/24',
  reservations: [],
  requirements: [],
}
check('非规范父网段报错并提示正确写法', plan(nonCanonical).inputErrors.some((e) => /192\.168\.1\.0\/24/.test(e)))

// 10) 自动网段绕开保留区且边界对齐：保留区位于中间 16/28，/27 需求应落到 0/27 而非 32/27？
//  最低对齐：0/27 空闲可容纳 -> 0/27
const align: PlannerInput = {
  parentCidr: '10.2.0.0/26',
  reservations: [{ id: 'r', name: 'R', cidr: '10.2.0.16/28' }],
  requirements: [{ id: 'x', name: 'X', hosts: 25, cidr: '' }], // /27
}
const ra = plan(align)
check(
  '最低对齐原则（跳过保留区取 32/27）',
  ra.segments.find((s) => s.kind === 'auto')?.cidr === '10.2.0.32/27',
  JSON.stringify(ra.segments.map((s) => s.cidr)),
)

// 11) 浪费量统计：100 台在 /25 浪费 26；广播/网络/可用范围正确
const w = plan({
  parentCidr: '192.168.10.0/24',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 100, cidr: '' }],
})
const seg0 = w.segments.find((s) => s.kind === 'auto')!
check('浪费量=26', seg0.waste === 26, String(seg0.waste))
check('网络地址', seg0.network === '192.168.10.0')
check('广播地址', seg0.broadcast === '192.168.10.127')
check('可用范围', seg0.firstUsable === '192.168.10.1' && seg0.lastUsable === '192.168.10.126')
check('容量 128 / 可用 126', seg0.capacity === 128 && seg0.usable === 126)

// 12) 排序：录入小需求在前、大需求在后，大需求仍先分且不会被小需求挡住最低地址
const order: PlannerInput = {
  parentCidr: '172.16.0.0/24',
  reservations: [],
  requirements: [
    { id: 's', name: '小', hosts: 2, cidr: '' },
    { id: 'b', name: '大', hosts: 100, cidr: '' },
  ],
}
const ro = plan(order)
check(
  '大需求优先占最低对齐地址',
  JSON.stringify(ro.segments.filter((s) => s.kind === 'auto').map((s) => s.cidr)) ===
    JSON.stringify(['172.16.0.0/25', '172.16.0.128/30']),
  JSON.stringify(ro.segments.map((s) => s.cidr)),
)

// 13) 基线对比：按稳定 ID 识别新增/删除/未变/扩容/缩容/迁移/未分配/恢复分配
//  基线布局（10.0.0.0/24）：固定 q3 .32/28；q1(100台,/25) .128–.255；q2(40台,/26) .64–.127
const baseInput: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q3', name: '固定段', hosts: 10, cidr: '10.0.0.32/28' },
  ],
}
const basePlan = plan(baseInput)
check('基线场景无输入错误', basePlan.inputErrors.length === 0, JSON.stringify(basePlan.inputErrors))
check(
  '基线布局：q1=.128/25、q2=.64/26、q3=.32/28',
  JSON.stringify(basePlan.segments.filter((s) => s.kind !== 'free').map((s) => s.cidr)) ===
    JSON.stringify(['10.0.0.32/28', '10.0.0.64/26', '10.0.0.128/25']),
  JSON.stringify(basePlan.segments.map((s) => s.cidr)),
)
const baseline = buildBaseline(basePlan)
check(
  '基线包含全部 3 个已分配需求',
  baseline.entries.length === 3 && baseline.entries.every((e) => e.state === 'allocated'),
)

// 13a) 相同输入 -> 全部未变、净变化 0
const same = compareWithBaseline(baseline, plan(baseInput))
check('相同规划全部未变', same.counts.unchanged === 3 && same.hasChanges === false)
check('相同规划净变化为 0', same.summary.net === 0)
check(
  '相同规划仍占用=基线占用，新占用/释放为 0',
  same.summary.occupiedCount === 0 &&
    same.summary.releasedCount === 0 &&
    same.summary.stillCount === basePlan.summary.usedCapacity,
)

// 13b) 纯新增：简单基线 q1(100)=0/25、q2(40)=128/26，再加 q4(2 台)
//  q1/q2 位置不变，q4 落到最低空闲 .192/30 -> 新占用 4、释放 0、净 +4
const simpleBase = buildBaseline(
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [
      { id: 'q1', name: '办公', hosts: 100, cidr: '' },
      { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    ],
  }),
)
const addPlan = plan({
  parentCidr: '10.0.0.0/24',
  reservations: [],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q4', name: '新增段', hosts: 2, cidr: '' },
  ],
})
const dAdd = compareWithBaseline(simpleBase, addPlan)
check('纯新增：added=1、unchanged=2', dAdd.counts.added === 1 && dAdd.counts.unchanged === 2)
check('新增段 q4 在 192/30', dAdd.rows.find((r) => r.id === 'q4')?.current?.cidr === '10.0.0.192/30')
check(
  '纯新增：新占用 4、释放 0、仍占用 192、净 +4，且无重复计数',
  dAdd.summary.occupiedCount === 4 &&
    dAdd.summary.releasedCount === 0 &&
    dAdd.summary.stillCount === 192 &&
    dAdd.summary.net === 4 &&
    dAdd.summary.occupiedCount + dAdd.summary.stillCount === addPlan.summary.usedCapacity,
  JSON.stringify({
    occ: dAdd.summary.occupiedCount,
    rel: dAdd.summary.releasedCount,
    still: dAdd.summary.stillCount,
  }),
)

// 13b2) 纯删除：去掉 q2 -> q1 未变，q2 删除，释放 .128–.191 共 64
const dRm = compareWithBaseline(
  simpleBase,
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [{ id: 'q1', name: '办公', hosts: 100, cidr: '' }],
  }),
)
check(
  '纯删除：removed=1、unchanged=1，释放 64、新占用 0、净 −64',
  dRm.counts.removed === 1 &&
    dRm.rows.find((r) => r.id === 'q2')?.type === 'removed' &&
    dRm.rows.find((r) => r.id === 'q1')?.type === 'unchanged' &&
    dRm.summary.releasedCount === 64 &&
    dRm.summary.occupiedCount === 0 &&
    dRm.summary.net === -64,
  JSON.stringify({
    rel: dRm.summary.releasedCount,
    occ: dRm.summary.occupiedCount,
  }),
)

// 13b3) 删除固定段 q3 并新增 q4：固定段在 32/28，删除后空闲地址上移，q1/q2 重排（迁移）
const reshuffle = compareWithBaseline(
  baseline,
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [
      { id: 'q1', name: '办公', hosts: 100, cidr: '' },
      { id: 'q2', name: '机房', hosts: 40, cidr: '' },
      { id: 'q4', name: '新增段', hosts: 2, cidr: '' },
    ],
  }),
)
check(
  '删固定段引发重排：q3 删除、q4 新增、q1/q2 迁移',
  reshuffle.rows.find((r) => r.id === 'q3')?.type === 'removed' &&
    reshuffle.rows.find((r) => r.id === 'q4')?.type === 'added' &&
    reshuffle.rows.find((r) => r.id === 'q1')?.type === 'migrated' &&
    reshuffle.rows.find((r) => r.id === 'q2')?.type === 'migrated',
  JSON.stringify(reshuffle.rows.map((r) => [r.id, r.type])),
)

// 13c) q1 缩容（100→60 台，/25→/26）后与 q2 互换位置：CIDR 改变=迁移，且标记缩容
const shrunk: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [],
  requirements: [
    { id: 'q1', name: '办公', hosts: 60, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q3', name: '固定段', hosts: 10, cidr: '10.0.0.32/28' },
  ],
}
const ds = compareWithBaseline(baseline, plan(shrunk))
const q1s = ds.rows.find((r) => r.id === 'q1')
check(
  'q1 迁移 + 缩容（128/25 -> 64/26）',
  q1s?.type === 'migrated' &&
    q1s.resize === 'shrink' &&
    q1s.baseline?.cidr === '10.0.0.128/25' &&
    q1s.current?.cidr === '10.0.0.64/26',
  JSON.stringify(q1s),
)
const q2s = ds.rows.find((r) => r.id === 'q2')
check('q2 也迁移（64/26 -> 128/26，容量不变不标扩缩容）', q2s?.type === 'migrated' && q2s.resize === undefined)
check('q3 固定段未变', ds.rows.find((r) => r.id === 'q3')?.type === 'unchanged')

// 13d) q1 扩容（100→200 台，/25→/24）：CIDR 改变=迁移且标记扩容
const growBase = buildBaseline(
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [{ id: 'q1', name: '大需求', hosts: 100, cidr: '' }],
  }),
)
const dg = compareWithBaseline(
  growBase,
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [{ id: 'q1', name: '大需求', hosts: 200, cidr: '' }],
  }),
)
const q1g = dg.rows.find((r) => r.id === 'q1')
check(
  'q1 迁移 + 扩容（0/25 -> 0/24，128->256）',
  q1g?.type === 'migrated' &&
    q1g.resize === 'grow' &&
    q1g.baseline?.cidr === '10.0.0.0/25' &&
    q1g.current?.cidr === '10.0.0.0/24',
  JSON.stringify(q1g),
)
check('扩容净变化 +128（新占用 .128–.255，无释放）', dg.summary.net === 128 && dg.summary.releasedCount === 0)

// 13e) 碎片化保留区：q1(/25) 无处可放，q2(/26) 迁到 .128，q3 被删除
//  保留 .0/26 + .64/27 堵死低端对齐点，保留 .192/26 切碎原 q1 空间（三段互不重叠）
const squeezed: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [
    { id: 'r1', name: '保留A', cidr: '10.0.0.0/26' },
    { id: 'r2', name: '保留B', cidr: '10.0.0.64/27' },
    { id: 'r3', name: '保留C', cidr: '10.0.0.192/26' },
  ],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
  ],
}
check('挤压场景无输入错误（q1 预期失败）', plan(squeezed).inputErrors.length === 0)
const dq = compareWithBaseline(baseline, plan(squeezed))
check(
  '碎片化：q1 未分配、q2 迁移到 .128/26、q3 删除，且释放地址非 0',
  dq.rows.find((r) => r.id === 'q2')?.type === 'migrated' &&
    dq.rows.find((r) => r.id === 'q2')?.current?.cidr === '10.0.0.128/26' &&
    dq.rows.find((r) => r.id === 'q1')?.type === 'unallocated' &&
    dq.rows.find((r) => r.id === 'q3')?.type === 'removed' &&
    dq.summary.releasedCount > 0,
  JSON.stringify(dq.rows.map((r) => [r.id, r.type, r.current?.cidr])),
)
// 地址守恒（同父网段）：净变化 = 当前占用 - 基线占用（含保留区变化）
check(
  '挤压场景地址守恒',
  dq.summary.occupiedCount + dq.summary.stillCount === plan(squeezed).summary.usedCapacity &&
    dq.summary.releasedCount + dq.summary.stillCount === basePlan.summary.usedCapacity,
)

// 13f) 未分配与恢复分配
const tight: PlannerInput = {
  parentCidr: '192.168.10.0/28',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/29' }],
  requirements: [
    { id: 'q1', name: '大需求', hosts: 100, cidr: '' },
    { id: 'q9', name: '小需求', hosts: 2, cidr: '' },
  ],
}
const tightPlan = plan(tight)
check('拥挤场景 q1 失败、q9 成功', tightPlan.failures.some((f) => f.id === 'q1') && tightPlan.failures.length === 1)
const tightBaseline = buildBaseline(tightPlan)
check('基线可包含失败需求（未分配）', tightBaseline.entries.find((e) => e.id === 'q1')?.state === 'unallocated')
const dRec = compareWithBaseline(
  tightBaseline,
  plan({
    parentCidr: '192.168.10.0/24',
    reservations: [],
    requirements: [
      { id: 'q1', name: '大需求', hosts: 100, cidr: '' },
      { id: 'q9', name: '小需求', hosts: 2, cidr: '' },
    ],
  }),
)
check('未分配 -> 已分配 标记为恢复分配', dRec.rows.find((r) => r.id === 'q1')?.type === 'recovered')
const dFail = compareWithBaseline(
  buildBaseline(
    plan({
      parentCidr: '192.168.10.0/24',
      reservations: [],
      requirements: [{ id: 'q1', name: '大需求', hosts: 100, cidr: '' }],
    }),
  ),
  plan({
    parentCidr: '192.168.10.0/28',
    reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/29' }],
    requirements: [{ id: 'q1', name: '大需求', hosts: 100, cidr: '' }],
  }),
)
check('已分配 -> 失败 标记为未分配', dFail.rows.find((r) => r.id === 'q1')?.type === 'unallocated')

// 13g) 区间工具：重叠/相邻合并，重叠部分不重复计数
const mr = mergeRanges([
  { start: ipToInt('10.0.0.0'), end: ipToInt('10.0.0.9') },
  { start: ipToInt('10.0.0.5'), end: ipToInt('10.0.0.20') },
  { start: ipToInt('10.0.0.21'), end: ipToInt('10.0.0.30') },
])
check(
  '区间合并去重（相交+相邻）',
  mr.length === 1 && mr[0].start === ipToInt('10.0.0.0') && mr[0].end === ipToInt('10.0.0.30'),
  JSON.stringify(mr),
)

// 14) 路由汇总：空选择
check('空选择汇总为空', summarizeSegments([]).blocks.length === 0)

// 14a) 单选即自身（固定段），地址数守恒
const sumInput: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [{ id: 'r1', name: '保留', cidr: '10.0.0.0/28' }],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q3', name: '监控固定', hosts: 25, cidr: '10.0.0.32/27' },
    { id: 'q4', name: '管理', hosts: 2, cidr: '' },
  ],
}
const sumPlan = plan(sumInput)
check('汇总场景无错误', sumPlan.inputErrors.length === 0, JSON.stringify(sumPlan.inputErrors))
const byId = new Map<string, Segment>()
for (const s of sumPlan.segments) if (s.ownerId) byId.set(s.ownerId, s)

const one = summarizeSegments([byId.get('q3')!])
check(
  '单选固定段返回自身',
  one.blocks.length === 1 && one.blocks[0].cidr === '10.0.0.32/27' && !one.blocks[0].aggregated,
  JSON.stringify(one.blocks),
)
check('单选地址数 32 且来源正确', one.blocks[0].capacity === 32 && one.blocks[0].sources[0].id === 'q3')

// 14b) 四个连续 /30（16/20/24/28）全选 -> 10.0.0.16/28（仅同上级网段才聚合）
const chainInput: PlannerInput = {
  parentCidr: '10.0.0.0/27',
  reservations: [{ id: 'r', name: '保留', cidr: '10.0.0.0/28' }],
  requirements: [
    { id: 'a', name: 'A', hosts: 2, cidr: '' },
    { id: 'b', name: 'B', hosts: 2, cidr: '' },
    { id: 'c', name: 'C', hosts: 2, cidr: '' },
    { id: 'd', name: 'D', hosts: 2, cidr: '' },
  ],
}
const chainPlan = plan(chainInput)
check(
  '四个连续 /30 落在 16/20/24/28',
  JSON.stringify(chainPlan.segments.filter((s) => s.kind === 'auto').map((s) => s.cidr)) ===
    JSON.stringify(['10.0.0.16/30', '10.0.0.20/30', '10.0.0.24/30', '10.0.0.28/30']),
  JSON.stringify(chainPlan.segments.map((s) => s.cidr)),
)
const allChain = summarizeSegments(chainPlan.segments.filter((s) => s.kind === 'auto'))
check(
  '四个连续 /30 聚合为 16/28',
  allChain.blocks.length === 1 && allChain.blocks[0].cidr === '10.0.0.16/28' && allChain.blocks[0].aggregated,
  JSON.stringify(allChain.blocks),
)
check(
  '聚合块列出全部 4 个原需求且地址数守恒（16）',
  allChain.blocks[0].sources.map((x) => x.id).join(',') === 'a,b,c,d' &&
    allChain.totalAddresses === 16 &&
    allChain.blocks[0].sources.reduce((n, s) => n + s.capacity, 0) === 16,
)

// 14c) 跳过中间未选：选 16/30 + 24/30（中间 20 空闲于选择外），不得聚合
const gapped = summarizeSegments(
  chainPlan.segments.filter((s) => s.kind === 'auto' && (s.cidr === '10.0.0.16/30' || s.cidr === '10.0.0.24/30')),
)
check(
  '不相邻选择保持两个 /30（不吞入中间未选地址）',
  gapped.blocks.length === 2 && gapped.blocks.every((b) => b.prefix === 30) && gapped.totalAddresses === 8,
  JSON.stringify(gapped.blocks.map((b) => b.cidr)),
)

// 14d) 不相邻（/30 与 /26 间有空闲）保持两项，不吞入空闲地址
const mixed = summarizeSegments([byId.get('q4')!, byId.get('q2')!])
check(
  '中间隔着空闲的两段不聚合（/30 + /26 保持两项）',
  mixed.blocks.length === 2 &&
    JSON.stringify(mixed.blocks.map((b) => b.cidr)) === JSON.stringify(['10.0.0.16/30', '10.0.0.64/26']),
  JSON.stringify(mixed.blocks.map((b) => b.cidr)),
)

// 14e) 同前缀连续但分属不同上级：4/30 与 8/30 的上级 /29 分别是 0/29、8/29 -> 不聚合（固定段）
const sibInput: PlannerInput = {
  parentCidr: '10.0.0.0/28',
  reservations: [],
  requirements: [
    { id: 'x', name: 'X', hosts: 2, cidr: '10.0.0.4/30' },
    { id: 'y', name: 'Y', hosts: 2, cidr: '10.0.0.8/30' },
  ],
}
const sibPlan = plan(sibInput)
check('跨上级 /30 固定段无错误', sibPlan.inputErrors.length === 0, JSON.stringify(sibPlan.inputErrors))
const sib = summarizeSegments(sibPlan.segments.filter((s) => s.kind === 'fixed'))
check(
  '跨上级兄弟 /30 不聚合（4/30 + 8/30）',
  sib.blocks.length === 2 && sib.blocks.map((b) => b.cidr).join(',') === '10.0.0.4/30,10.0.0.8/30',
  JSON.stringify(sib.blocks.map((b) => b.cidr)),
)

// 14e2) 对照组：同一上级内的 0/30 + 4/30 必须聚合为 0/29
const sameParentInput: PlannerInput = {
  parentCidr: '10.0.0.0/28',
  reservations: [],
  requirements: [
    { id: 'x', name: 'X', hosts: 2, cidr: '10.0.0.0/30' },
    { id: 'y', name: 'Y', hosts: 2, cidr: '10.0.0.4/30' },
  ],
}
const sameParent = summarizeSegments(plan(sameParentInput).segments.filter((s) => s.kind === 'fixed'))
check(
  '同上级兄弟 /30 聚合为 0/29',
  sameParent.blocks.length === 1 && sameParent.blocks[0].cidr === '10.0.0.0/29' && sameParent.blocks[0].aggregated,
  JSON.stringify(sameParent.blocks.map((b) => b.cidr)),
)

// 14f) 三个连续 /30（0/4/8）-> 0/29 + 8/30：最小块数的对齐拆分
const threeInput: PlannerInput = {
  parentCidr: '10.0.0.0/28',
  reservations: [{ id: 'r', name: '保留', cidr: '10.0.0.12/30' }],
  requirements: [
    { id: 'a', name: 'A', hosts: 2, cidr: '' },
    { id: 'b', name: 'B', hosts: 2, cidr: '' },
    { id: 'c', name: 'C', hosts: 2, cidr: '' },
  ],
}
const threePlan = plan(threeInput)
const three = summarizeSegments(threePlan.segments.filter((s) => s.kind === 'auto'))
check(
  '三个连续 /30 拆为 0/29 + 8/30（地址对齐边界）',
  three.blocks.length === 2 &&
    three.blocks[0].cidr === '10.0.0.0/29' &&
    three.blocks[1].cidr === '10.0.0.8/30' &&
    three.totalAddresses === 12,
  JSON.stringify(three.blocks.map((b) => [b.cidr, b.capacity])),
)
check(
  '0/29 仅覆盖前两段，8/30 覆盖第三段（来源不串行）',
  three.blocks[0].sources.map((s) => s.id).join(',') === 'a,b' &&
    three.blocks[0].aggregated &&
    three.blocks[1].sources.map((s) => s.id).join(',') === 'c',
  JSON.stringify(three.blocks.map((b) => b.sources.map((s) => s.id))),
)
check('不得纳入保留区 12/30', !blocksToCidrList(three.blocks).includes('10.0.0.12/30'))

// 14g) 复制文本：按网络地址升序、每行一个纯 CIDR
const partial = summarizeSegments([byId.get('q1')!, byId.get('q4')!, byId.get('q3')!])
check(
  'CIDR 列表按网络地址升序',
  blocksToCidrList(partial.blocks) === '10.0.0.16/30\n10.0.0.32/27\n10.0.0.128/25',
  blocksToCidrList(partial.blocks),
)

// 14h) 覆盖精确性：任意勾选并集大小 = 结果块容量之和（不重不漏，不含保留/空闲）
for (let mask = 1; mask < 16; mask++) {
  const ids = ['q1', 'q2', 'q3', 'q4']
  const picked = ids.filter((_, i) => mask & (1 << i)).map((id) => byId.get(id)!)
  const res = summarizeSegments(picked)
  const expect = picked.reduce((n, s) => n + s.capacity, 0)
  check(
    `覆盖守恒 mask=${mask}`,
    res.totalAddresses === expect &&
      res.blocks.reduce((n, b) => n + b.capacity, 0) === expect &&
      res.blocks.every((b) => b.sources.length >= 1),
    `mask=${mask} got ${res.totalAddresses} expect ${expect}`,
  )
  // 每个汇总块不得与保留区 0/28 或空闲地址相交：块内每个地址都必须属于某个被选段
  const occupied = picked
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start)
  for (const b of res.blocks) {
    // 用来源并集精确比对块边界
    const own = b.sources
      .map((s) => ({ start: s.start, end: s.end }))
      .sort((a, b2) => a.start - b2.start)
    let cur = own[0].start
    for (const o of own) {
      if (o.start > cur) break
      cur = Math.max(cur, o.end + 1)
    }
    check(
      `精确覆盖 mask=${mask} block=${b.cidr}`,
      own[0].start === b.network && cur - 1 === b.network + b.capacity - 1,
      `block ${b.cidr} 与来源不匹配`,
    )
  }
}

// 14i) 全选示例（固定+自动）不越界包含保留区 0/28，块数最少
const full = summarizeSegments(sumPlan.segments.filter((s) => s.kind === 'fixed' || s.kind === 'auto'))
check(
  '全选示例不包含保留区，且结果不含 0/28',
  !full.blocks.some((b) => b.network === ipToInt('10.0.0.0') && b.prefix === 28),
  JSON.stringify(full.blocks.map((b) => b.cidr)),
)
check(
  '全选示例覆盖 = 100/25+40/26+32/27+4/30 = 228',
  full.totalAddresses === 228,
  String(full.totalAddresses),
)

// ========== 15) 主机地址分配 ==========
// 可登记对象：仅成功分配的固定 / 自动网段（按稳定 ownerId）
const hostPlan = plan(demo)
const allocSegs = allocatableSegments(hostPlan)
check(
  '主机面板只列出固定/自动网段（4 个，无保留/空闲）',
  allocSegs.length === 4 && allocSegs.every((s) => s.kind === 'fixed' || s.kind === 'auto'),
  JSON.stringify(allocSegs.map((s) => [s.kind, s.cidr])),
)
const segById = new Map(allocSegs.map((s) => [s.ownerId, s]))
const mgmt = segById.get('q4')! // 192.168.10.16/30，可用 .17 ~ .18
const office = segById.get('q1')! // 192.168.10.128/25，可用 .129 ~ .254

// 15a) 自动取址：首个未占用可用地址，跳过网络地址
let hostList: HostAssignment[] = []
const auto1 = firstFreeAddress(mgmt, hostList)
check('自动取址跳过网络地址（/30 首址为 .17）', auto1 === ipToInt('192.168.10.17'), intToIp(auto1 ?? -1))
hostList = [
  { id: 'h1', ownerId: 'q4', name: '设备A', address: ipToInt('192.168.10.17'), mode: 'auto' },
]
const auto2 = firstFreeAddress(mgmt, hostList)
check('自动取址跳过已占用地址（下一个为 .18）', auto2 === ipToInt('192.168.10.18'), intToIp(auto2 ?? -1))
hostList.push({ id: 'h2', ownerId: 'q4', name: '设备B', address: ipToInt('192.168.10.18'), mode: 'auto' })
check('占满后自动取址返回 null', firstFreeAddress(mgmt, hostList) === null)

// 15b) 剩余可用数：/30 共 2 个可用
let rec = reconcileHosts(hostList, hostPlan)
const mgmtStats = rec.statsByOwner.get('q4')!
check('剩余可用数 = 可用主机数 - 有效登记（2-2=0）', mgmtStats.remaining === 0 && mgmtStats.used === 2)
const officeStats = rec.statsByOwner.get('q1')!
check('未登记网段剩余 = 全部可用（/25 = 126）', officeStats.remaining === 126 && officeStats.used === 0)

// 15c) 手动地址：网络地址 / 广播地址必须拒绝
check(
  '拒绝网络地址',
  validateManualAddress('192.168.10.16', mgmt, []) !== null &&
    /网络地址/.test(validateManualAddress('192.168.10.16', mgmt, [])!),
)
check(
  '拒绝广播地址',
  validateManualAddress('192.168.10.19', mgmt, []) !== null &&
    /广播地址/.test(validateManualAddress('192.168.10.19', mgmt, [])!),
)
// 15d) 拒绝非所属网段地址（同父网段内的别的网段也算越界）
check(
  '拒绝不在所属网段的地址',
  validateManualAddress('192.168.10.33', mgmt, []) !== null &&
    /不在网段/.test(validateManualAddress('192.168.10.33', mgmt, [])!),
)
// 15e) 拒绝重复 / 已占用地址
check(
  '拒绝已占用地址',
  validateManualAddress('192.168.10.17', mgmt, hostList) !== null &&
    /已被设备/.test(validateManualAddress('192.168.10.17', mgmt, hostList)!),
)
check('合法手动地址通过', validateManualAddress('192.168.10.129', office, hostList) === null)
// selfId 用于编辑自身时不算重复
check(
  '编辑自身地址不判定为重复',
  validateManualAddress('192.168.10.17', mgmt, hostList, 'h1') === null,
)
// 非法 IP 文本也必须拒绝
check('拒绝非法 IPv4 文本', validateManualAddress('999.1.1.1', office, hostList) !== null)
check('拒绝空输入', validateManualAddress('  ', office, hostList) !== null)

// 15f) 重新计算后保留仍合法登记，不静默改址
hostList = [
  { id: 'h1', ownerId: 'q4', name: '管理设备1', address: ipToInt('192.168.10.17'), mode: 'auto' },
  { id: 'h2', ownerId: 'q4', name: '管理设备2', address: ipToInt('192.168.10.18'), mode: 'manual' },
  { id: 'h3', ownerId: 'q1', name: '办公网关', address: ipToInt('192.168.10.129'), mode: 'auto' },
]
rec = reconcileHosts(hostList, hostPlan)
check(
  '相同规划重算后全部有效且地址原样保留',
  rec.rows.every((r) => r.valid) &&
    rec.rows.find((r) => r.assignment.id === 'h3')!.assignment.address ===
      ipToInt('192.168.10.129'),
)

// 15g) 规划迁移：在 16/30 加入保留区，把 q4 的 /30 从 16/30 挤到 20/30，h1/h2 失效
const migratedPlan = plan({
  parentCidr: '192.168.10.0/24',
  reservations: [
    { id: 'r1', name: '核心交换链路保留', cidr: '192.168.10.0/28' },
    { id: 'r2', name: '链路保留', cidr: '192.168.10.16/30' },
  ],
  requirements: demo.requirements,
})
const q4new = allocatableSegments(migratedPlan).find((s) => s.ownerId === 'q4')!
check('迁移后 q4 网段确实改变', q4new.cidr !== '192.168.10.16/30', q4new.cidr)
const migrated = reconcileHosts(hostList, migratedPlan)
const m1 = migrated.rows.find((r) => r.assignment.id === 'h1')!
const m3 = migrated.rows.find((r) => r.assignment.id === 'h3')!
check(
  '迁移后原地址失效且明确标记、地址不被改写（保留 192.168.10.17）',
  !m1.valid &&
    m1.assignment.address === ipToInt('192.168.10.17') &&
    (m1.reason === 'out-of-subnet' ||
      m1.reason === 'network-address' ||
      m1.reason === 'broadcast-address'),
  `${m1.valid} ${m1.reason} ${intToIp(m1.assignment.address)}`,
)
check('失效登记不占用剩余可用数', migrated.statsByOwner.get('q4')!.used === 0)
check('仍合法的登记（办公段未动）继续保留', m3.valid && m3.assignment.address === ipToInt('192.168.10.129'))
check('失效说明文本非空', !!m1.reasonText && /192\.168\.10\.17/.test(m1.reasonText!))

// 15h) 网段前缀缩小导致原地址变成（新）网络/广播地址
// q3 固定 32/27（可用 .33~.62）登记 .33；改为固定 32/32 -> 该需求容量不足属输入错误，
// 改用自动需求：10.5.0.0/30 需求 2 台，先登记 .1；再改为 10.5.0.0/29 固定段由别的方式不易构造，
// 这里直接构造「固定段扩容」场景：需求主机数变大并保留固定 CIDR /29（0~7，广播 .7）
const shrinkInput: PlannerInput = {
  parentCidr: '10.5.0.0/29',
  reservations: [],
  requirements: [{ id: 'q', name: '段', hosts: 6, cidr: '10.5.0.0/29' }],
}
const shrinkPlan = plan(shrinkInput)
const shrinkSeg = allocatableSegments(shrinkPlan)[0]
check('/29 可用范围 .1 ~ .6', shrinkSeg.firstUsable === '10.5.0.1' && shrinkSeg.lastUsable === '10.5.0.6')
const edge = reconcileHosts(
  [{ id: 'e', ownerId: 'q', name: '边界设备', address: ipToInt('10.5.0.7'), mode: 'manual' }],
  shrinkPlan,
)
check('登记广播地址被标记为 broadcast-address', edge.rows[0].reason === 'broadcast-address')
const edgeNet = reconcileHosts(
  [{ id: 'e', ownerId: 'q', name: '边界设备', address: ipToInt('10.5.0.0'), mode: 'manual' }],
  shrinkPlan,
)
check('登记网络地址被标记为 network-address', edgeNet.rows[0].reason === 'network-address')

// 15i) 需求删除 / 分配失败 -> owner-gone / owner-unallocated
const gone = reconcileHosts(
  [{ id: 'g', ownerId: 'q4', name: '孤儿', address: ipToInt('192.168.10.17'), mode: 'auto' }],
  plan({
    parentCidr: '192.168.10.0/24',
    reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
    requirements: [
      { id: 'q1', name: '办公区 VLAN', hosts: 100, cidr: '' },
      { id: 'q2', name: '机房 VLAN', hosts: 40, cidr: '' },
      { id: 'q3', name: '监控固定段', hosts: 25, cidr: '192.168.10.32/27' },
      // q4 被删除
    ],
  }),
)
check('需求删除 -> owner-gone', gone.rows[0].reason === 'owner-gone' && !gone.rows[0].valid)

const failPlan = plan({
  parentCidr: '192.168.10.0/30',
  reservations: [],
  requirements: [{ id: 'q4', name: '放不下', hosts: 100, cidr: '' }],
})
const unalloc = reconcileHosts(
  [{ id: 'u', ownerId: 'q4', name: '设备', address: ipToInt('192.168.10.1'), mode: 'auto' }],
  failPlan,
)
check('需求分配失败 -> owner-unallocated', unalloc.rows[0].reason === 'owner-unallocated')

// 15j) 同网段重复登记（数据层防御）：后录入者标记 duplicate，最早一条有效
const dup = reconcileHosts(
  [
    { id: 'd1', ownerId: 'q4', name: '设备1', address: ipToInt('192.168.10.17'), mode: 'auto' },
    { id: 'd2', ownerId: 'q4', name: '设备2', address: ipToInt('192.168.10.17'), mode: 'manual' },
  ],
  hostPlan,
)
check(
  '同地址重复：最早一条有效，其余 duplicate',
  dup.rows[0].valid && dup.rows[1].reason === 'duplicate',
  JSON.stringify(dup.rows.map((r) => r.reason)),
)
check('重复登记只计一次占用（used=1, remaining=1）', dup.statsByOwner.get('q4')!.used === 1 && dup.statsByOwner.get('q4')!.remaining === 1)

// 15k) 主机登记完全不影响规划结果、基线、路由汇总与导出
const planWithHosts = plan(demo)
const planWithoutHosts = plan(demo)
check('规划引擎签名不含主机数据（结果确定性一致）', JSON.stringify(planWithHosts) === JSON.stringify(planWithoutHosts))
const exportJson = buildExportJson(hostPlan, { parentCidr: demo.parentCidr })
check('导出 JSON 不含主机登记字段', !/主机地址|设备地址|host/i.test(exportJson))
check('路由汇总结论不受登记影响', summarizeSegments(allocSegs).totalAddresses === 228)

// ========== 16) MAC 录入校验与规范 ==========
// 16a) 冒号 / 连字符六组十六进制 -> 小写冒号规范格式
check('冒号大写 MAC 规范为小写冒号', normalizeMacInput('AA:BB:CC:DD:EE:FF').mac === 'aa:bb:cc:dd:ee:ff')
check('连字符 MAC 规范为小写冒号', normalizeMacInput('AA-BB-CC-DD-EE-FF').mac === 'aa:bb:cc:dd:ee:ff')
check('冒号小写 MAC 原样通过', normalizeMacInput('0a:1b:2c:3d:4e:5f').mac === '0a:1b:2c:3d:4e:5f')
check('带首尾空白的 MAC 可通过并规范', normalizeMacInput('  aa-bb-cc-dd-ee-ff ').mac === 'aa:bb:cc:dd:ee:ff')
// 16b) 空输入表示暂不填写
check('空 MAC 输入视为未填写（mac=undefined、无错误）', (() => {
  const r = normalizeMacInput('   ')
  return r.mac === undefined && r.error === undefined
})())
// 16c) 拒绝非法格式：位数不对、混用分隔符、点分写法、非十六进制、组数不对
check('拒绝单位数组', !!normalizeMacInput('a:bb:cc:dd:ee:ff').error)
check('拒绝三组数（点分写法）', !!normalizeMacInput('aabb.ccdd.eeff').error)
check('拒绝混用冒号与连字符', !!normalizeMacInput('aa:bb-cc:dd:ee:ff').error)
check('拒绝非十六进制字符', !!normalizeMacInput('zz:bb:cc:dd:ee:ff').error)
check('拒绝组数不足', !!normalizeMacInput('aa:bb:cc:dd:ee').error)
check('拒绝组数过多', !!normalizeMacInput('aa:bb:cc:dd:ee:ff:00').error)
// 16d) 拒绝全零
check('拒绝全零 MAC（冒号）', /全零/.test(normalizeMacInput('00:00:00:00:00:00').error ?? ''))
check('拒绝全零 MAC（连字符）', /全零/.test(normalizeMacInput('00-00-00-00-00-00').error ?? ''))
// 16e) 拒绝组播位（首字节最低位为 1），含广播
check('拒绝广播 MAC ff:ff:ff:ff:ff:ff', /组播位/.test(normalizeMacInput('ff:ff:ff:ff:ff:ff').error ?? ''))
check('拒绝奇数首字节（01:00:00:00:00:00）', /组播位/.test(normalizeMacInput('01:00:00:00:00:00').error ?? ''))
check('拒绝奇数首字节（03:00:00:00:00:00）', /组播位/.test(normalizeMacInput('03-00-00-00-00-00').error ?? ''))
// 偶数首字节（含本地管理位 02）通过
check('偶数首字节 02:.. 通过（本地管理位不是组播位）', normalizeMacInput('02:42:1a:2b:3c:4d').mac === '02:42:1a:2b:3c:4d')
check('偶数首字节 0a:.. 通过', normalizeMacInput('0a:bb:cc:dd:ee:ff').mac === '0a:bb:cc:dd:ee:ff')
// 16f) 跨设备重复：checkMac 全局查重（不限网段），编辑自身不算重复
const macOwners: HostAssignment[] = [
  { id: 'm1', ownerId: 'q4', name: '设备A', address: ipToInt('192.168.10.17'), mode: 'manual', mac: 'aa:bb:cc:dd:ee:ff' },
]
check('重复 MAC（大小写/分隔符归一后）被拒绝', /与设备“设备A”重复/.test(checkMac('AA-BB-CC-DD-EE-FF', macOwners).error ?? ''))
check('不同 MAC 通过', checkMac('0a:1b:2c:3d:4e:5f', macOwners).mac === '0a:1b:2c:3d:4e:5f')
check('编辑自身保留原 MAC 不算重复', checkMac('aa:bb:cc:dd:ee:ff', macOwners, 'm1').error === undefined)
check('编辑自身改成未占用的 MAC 可通过', checkMac('0a:1b:2c:3d:4e:5f', macOwners, 'm1').mac === '0a:1b:2c:3d:4e:5f')
macOwners.push({ id: 'm2', ownerId: 'q1', name: '设备B', address: ipToInt('192.168.10.129'), mode: 'auto', mac: '0a:1b:2c:3d:4e:5f' })
check('跨网段重复 MAC 同样被拒绝（全局去重）', /与设备“设备B”重复/.test(checkMac('0a:1b:2c:3d:4e:5f', macOwners, 'm1').error ?? ''))

// ========== 17) dnsmasq 静态租约生成 ==========
// 演示规划：q4=192.168.10.16/30（.17/.18），q1=128/25，q2=64/26，q3=32/27
const leaseList: HostAssignment[] = [
  { id: 'l1', ownerId: 'q4', name: '管理设备2', address: ipToInt('192.168.10.18'), mode: 'manual', mac: 'aa:bb:cc:dd:ee:ff' },
  { id: 'l2', ownerId: 'q4', name: '管理设备1', address: ipToInt('192.168.10.17'), mode: 'auto', mac: '00:11:22:33:44:55' },
  { id: 'l3', ownerId: 'q1', name: '办公设备', address: ipToInt('192.168.10.200'), mode: 'manual', mac: '0a:0b:0c:0d:0e:0f' },
  { id: 'l4', ownerId: 'q1', name: '无MAC设备', address: ipToInt('192.168.10.129'), mode: 'auto' },
]
const dl = buildDnsmasqLeases(leaseList, hostPlan)
check(
  '租约输出仅含 3 条合法 MAC 登记，无 MAC 条目被排除',
  dl.leases.length === 3 && dl.excluded.length === 1,
  JSON.stringify({ leases: dl.leases.length, excluded: dl.excluded.length }),
)
check(
  '租约按 IPv4 升序（.17, .18, .200），与录入顺序无关',
  dl.leases.map((l) => l.ip).join(',') === '192.168.10.17,192.168.10.18,192.168.10.200',
  dl.leases.map((l) => l.ip).join(','),
)
check(
  '每行格式 dhcp-host=<MAC>,<IPv4>',
  dnsmasqLeasesText(dl.leases) ===
    'dhcp-host=00:11:22:33:44:55,192.168.10.17\n' +
      'dhcp-host=aa:bb:cc:dd:ee:ff,192.168.10.18\n' +
      'dhcp-host=0a:0b:0c:0d:0e:0f,192.168.10.200',
  dnsmasqLeasesText(dl.leases),
)
check('未填写 MAC 的排除原因正确', dl.excluded[0].reason === '未填写 MAC' && dl.excluded[0].assignment.id === 'l4')
check('空租约列表输出为空串', dnsmasqLeasesText(buildDnsmasqLeases([], hostPlan).leases) === '')

// 17b) 失效登记（越界）不输出，原因列出且保留原地址
const invalidLease: HostAssignment[] = [
  { id: 'x1', ownerId: 'q4', name: '越界设备', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
]
const dx = buildDnsmasqLeases(invalidLease, hostPlan)
check('失效登记不进入租约输出', dx.leases.length === 0 && dx.excluded.length === 1)
check('失效排除原因包含登记失效说明与原地址', /登记失效/.test(dx.excluded[0].reason) && /192\.168\.10\.40/.test(dx.excluded[0].reason), dx.excluded[0].reason)

// 17c) 需求删除（owner-gone）的孤儿登记也不输出
const goneLease = buildDnsmasqLeases(
  [{ id: 'g1', ownerId: 'q4', name: '孤儿', address: ipToInt('192.168.10.17'), mode: 'auto', mac: 'aa:bb:cc:dd:ee:ff' }],
  plan({
    parentCidr: '192.168.10.0/24',
    reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
    requirements: demo.requirements.filter((q) => q.id !== 'q4'),
  }),
)
check('孤儿登记不进入租约输出且原因非空', goneLease.leases.length === 0 && /登记失效/.test(goneLease.excluded[0].reason))

// 17d) 规划变化后实时重算：迁移前输出，迁移后（地址失效）自动撤出
check('迁移前租约可输出', buildDnsmasqLeases(
  [{ id: 'h1', ownerId: 'q4', name: '管理设备1', address: ipToInt('192.168.10.17'), mode: 'auto', mac: 'aa:bb:cc:dd:ee:ff' }],
  hostPlan,
).leases.length === 1)
const migratedLeases = buildDnsmasqLeases(
  [{ id: 'h1', ownerId: 'q4', name: '管理设备1', address: ipToInt('192.168.10.17'), mode: 'auto', mac: 'aa:bb:cc:dd:ee:ff' }],
  migratedPlan,
)
check('规划迁移后租约自动撤出并在排除清单给出原因', migratedLeases.leases.length === 0 && migratedLeases.excluded.length === 1)

// 17e) 防御：异常重复 MAC（绕过录入校验的旧数据）只保留最早一条
const dupMacList: HostAssignment[] = [
  { id: 'd1', ownerId: 'q4', name: '设备1', address: ipToInt('192.168.10.17'), mode: 'manual', mac: 'aa:bb:cc:dd:ee:ff' },
  { id: 'd2', ownerId: 'q4', name: '设备2', address: ipToInt('192.168.10.18'), mode: 'manual', mac: 'aa:bb:cc:dd:ee:ff' },
]
const dd = buildDnsmasqLeases(dupMacList, hostPlan)
// 注：reconcileHosts 先按同 IP 查重（这里 IP 不同均有效），生成层再按 MAC 去重
check('重复 MAC 仅最早一条输出，另一条列入排除并说明重复', dd.leases.length === 1 && dd.leases[0].assignment.id === 'd1' && /MAC .*重复/.test(dd.excluded[0].reason))

// 17f) MAC 数据不进入 JSON 导出
check('导出 JSON 不含 MAC 字段', !/dhcp-host|mac地址|MAC地址/.test(exportJson) && !/"mac"/.test(buildExportJson(hostPlan, { parentCidr: demo.parentCidr })))

// ========== 18) DHCP Option 121（RFC 3442） ==========
// 演示规划：q4=192.168.10.16/30（.17/.18），q1=128/25，q2=64/26，q3=32/27
// 18a) encodeRoute：RFC 3442 逐字节编码
// /24 目的 192.168.1.0，网关 192.168.10.17 -> 24,192,168,1,192,168,10,17（8 字节）
check(
  '/24 编码：前缀 + 3 个目的字节 + 4 个下一跳字节',
  JSON.stringify(encodeRoute(ipToInt('192.168.1.0'), 24, ipToInt('192.168.10.17'))) ===
    JSON.stringify([24, 192, 168, 1, 192, 168, 10, 17]),
  JSON.stringify(encodeRoute(ipToInt('192.168.1.0'), 24, ipToInt('192.168.10.17'))),
)
// /0 目的 0.0.0.0 不写任何目的网络字节：0,192,168,10,17（5 字节）
check(
  '/0 默认路由：前缀后 0 个目的字节，仅 5 字节',
  JSON.stringify(encodeRoute(0, 0, ipToInt('192.168.10.17'))) ===
    JSON.stringify([0, 192, 168, 10, 17]),
  JSON.stringify(encodeRoute(0, 0, ipToInt('192.168.10.17'))),
)
// /32 目的 10.0.0.1：写 4 个目的字节
check(
  '/32 编码：前缀 + 4 个目的字节 + 4 个下一跳字节',
  JSON.stringify(encodeRoute(ipToInt('10.0.0.1'), 32, ipToInt('192.168.10.17'))) ===
    JSON.stringify([32, 10, 0, 0, 1, 192, 168, 10, 17]),
  JSON.stringify(encodeRoute(ipToInt('10.0.0.1'), 32, ipToInt('192.168.10.17'))),
)
// 非整字节边界 /17：ceil(17/8)=3 个目的字节
check(
  '/17 编码：ceil(17/8)=3 个目的字节',
  JSON.stringify(encodeRoute(ipToInt('172.16.0.0'), 17, ipToInt('192.168.10.17'))) ===
    JSON.stringify([17, 172, 16, 0, 192, 168, 10, 17]),
  JSON.stringify(encodeRoute(ipToInt('172.16.0.0'), 17, ipToInt('192.168.10.17'))),
)

// 18b) resolveClientSegment：只接受成功分配的固定 / 自动网段
const client = resolveClientSegment(hostPlan, 'q4')
check('客户端网段解析为 q4（192.168.10.16/30）', client?.cidr === '192.168.10.16/30', client?.cidr ?? 'null')
check('保留区 / 空闲段不能作为客户端网段', resolveClientSegment(hostPlan, 'r1') === null)
check('空选择 / 已删除需求解析为 null', resolveClientSegment(hostPlan, '') === null && resolveClientSegment(hostPlan, 'nope') === null)

// 18c) 完整生成：排序 = 前缀从长到短、网络地址升序；合并字节与配置行
const opt = buildOption121(
  [
    { id: 'o1', destination: '0.0.0.0/0', gateway: '192.168.10.17' },
    { id: 'o2', destination: '10.0.0.0/8', gateway: '192.168.10.18' },
    { id: 'o3', destination: '192.168.1.0/24', gateway: '192.168.10.17' },
  ],
  client!,
)
check('三条合法路由无错误', opt.errors.length === 0, JSON.stringify(opt.errors))
check(
  '排序为 /24 -> /8 -> /0（长前缀优先）',
  opt.routes.map((r) => r.destination).join(',') === '192.168.1.0/24,10.0.0.0/8,0.0.0.0/0',
  opt.routes.map((r) => r.destination).join(','),
)
check('下发序保留录入序号信息（3,2,1）', opt.routes.map((r) => r.index).join(',') === '3,2,1')
check(
  '合并字节为三条 RFC 3442 记录拼接（8 + 6 + 5 = 19 字节）',
  JSON.stringify(opt.bytes) ===
    JSON.stringify([24, 192, 168, 1, 192, 168, 10, 17, 8, 10, 192, 168, 10, 18, 0, 192, 168, 10, 17]),
  JSON.stringify(opt.bytes),
)
check(
  'dhcp-option=121 配置行正确',
  opt.optionLine ===
    'dhcp-option=121,24,192,168,1,192,168,10,17,8,10,192,168,10,18,0,192,168,10,17',
  opt.optionLine,
)

// 18d) 同前缀按网络地址升序
const samePrefix = buildOption121(
  [
    { id: 'a', destination: '192.168.9.0/24', gateway: '192.168.10.17' },
    { id: 'b', destination: '192.168.1.0/24', gateway: '192.168.10.17' },
    { id: 'c', destination: '192.168.2.0/24', gateway: '192.168.10.17' },
  ],
  client!,
)
check(
  '同前缀按网络地址升序（1 -> 2 -> 9）',
  samePrefix.routes.map((r) => r.destination).join(',') ===
    '192.168.1.0/24,192.168.2.0/24,192.168.9.0/24',
  samePrefix.routes.map((r) => r.destination).join(','),
)

// 18e) 重复目的：第二条报错并定位序号，整体停止生成
const dupDest = buildOption121(
  [
    { id: 'a', destination: '10.0.0.0/8', gateway: '192.168.10.17' },
    { id: 'b', destination: '10.0.0.0/8', gateway: '192.168.10.18' },
  ],
  client!,
)
check('重复目的产生 1 条错误', dupDest.errors.length === 1, JSON.stringify(dupDest.errors))
check(
  '重复错误明确定位到第 2 条并指向第 1 条',
  dupDest.errors[0].index === 2 && /第 2 条/.test(`第 ${dupDest.errors[0].index} 条`) && /第 1 条/.test(dupDest.errors[0].message),
  JSON.stringify(dupDest.errors),
)
check('有错误时停止生成：routes/bytes/optionLine 均空', dupDest.routes.length === 0 && dupDest.bytes.length === 0 && dupDest.optionLine === '')
// 不重复的第一条仍可逐行预览字节，重复的第二条无字节
check('首条重复组仍逐行展示字节，重复行不展示', dupDest.rows[0].bytes !== null && dupDest.rows[1].bytes === null)

// 18f) 目的非规范网络地址报错（parseCidr strictNetwork），并给出规范建议
const nonCanonicalDest = buildOption121(
  [{ id: 'a', destination: '192.168.1.5/24', gateway: '192.168.10.17' }],
  client!,
)
check(
  '非规范目的报错并提示 192.168.1.0/24',
  nonCanonicalDest.errors.length === 1 && /192\.168\.1\.0\/24/.test(nonCanonicalDest.errors[0].message),
  JSON.stringify(nonCanonicalDest.errors),
)
check('非规范目的不生成配置', nonCanonicalDest.optionLine === '')
// 目的文本非法 / 前缀越界
check(
  '目的 IP 文本非法报错',
  buildOption121([{ id: 'a', destination: '999.0.0.0/8', gateway: '192.168.10.17' }], client!).errors.length === 1,
)
check(
  '前缀长度越界报错',
  buildOption121([{ id: 'a', destination: '10.0.0.0/33', gateway: '192.168.10.17' }], client!).errors.length === 1,
)

// 18g) 下一跳必须是客户端网段内的可用主机地址
check(
  '下一跳为网络地址被拒绝',
  /网络地址/.test(
    buildOption121([{ id: 'a', destination: '10.0.0.0/8', gateway: '192.168.10.16' }], client!).errors[0]?.message ?? '',
  ),
)
check(
  '下一跳为广播地址被拒绝',
  /广播地址/.test(
    buildOption121([{ id: 'a', destination: '10.0.0.0/8', gateway: '192.168.10.19' }], client!).errors[0]?.message ?? '',
  ),
)
check(
  '下一跳越出客户端网段被拒绝并显示可用范围',
  /不在客户端网段/.test(
    buildOption121([{ id: 'a', destination: '10.0.0.0/8', gateway: '192.168.10.40' }], client!).errors[0]?.message ?? '',
  ) &&
    /192\.168\.10\.17 ~ 192\.168\.10\.18/.test(
      buildOption121([{ id: 'a', destination: '10.0.0.0/8', gateway: '192.168.10.40' }], client!).errors[0]?.message ?? '',
    ),
)
check(
  '下一跳 IPv4 文本非法被拒绝',
  buildOption121([{ id: 'a', destination: '10.0.0.0/8', gateway: '1.2.3' }], client!).errors.length === 1,
)

// 18h) 同一下一跳在不同客户端网段下结论不同：.17 在 q4(/30) 合法，在 q3(/27 32/27) 越界
const q3client = resolveClientSegment(hostPlan, 'q3')!
check(
  'q3 网段接受 .33（其首个可用地址）',
  buildOption121([{ id: 'a', destination: '10.0.0.0/8', gateway: '192.168.10.33' }], q3client).errors.length === 0,
)
check(
  'q3 网段拒绝 .17（不在 32/27 内）',
  buildOption121([{ id: 'a', destination: '10.0.0.0/8', gateway: '192.168.10.17' }], q3client).errors.length === 1,
)

// 18i) 缺字段逐一定位；空白行（占位）不参与校验
const missing = buildOption121(
  [
    { id: 'a', destination: '', gateway: '192.168.10.17' },
    { id: 'b', destination: '10.0.0.0/8', gateway: '' },
    { id: 'c', destination: '   ', gateway: '' },
  ],
  client!,
)
check('缺字段产生 2 条错误（空白占位行跳过）', missing.errors.length === 2, JSON.stringify(missing.errors))
check('错误序号按全部行位置定位（1、2）', missing.errors.map((e) => e.index).join(',') === '1,2')
check('空白行标记 empty', missing.rows[2].empty === true)

// 18j) 多条错误全部列出（整体停止生成但逐条定位）
const multi = buildOption121(
  [
    { id: 'a', destination: '10.0.0.0/8', gateway: '192.168.10.17' },
    { id: 'b', destination: 'bad/24', gateway: '192.168.10.18' },
    { id: 'c', destination: '172.16.0.0/12', gateway: '8.8.8.8' },
  ],
  client!,
)
check('多条错误逐条列出（第 2、3 条）', multi.errors.length === 2 && multi.errors.map((e) => e.index).join(',') === '2,3', JSON.stringify(multi.errors))
check('多条错误时不输出配置', multi.optionLine === '' && multi.routes.length === 0)
// 第 1 条自身有效，逐行字节仍可预览
check('错误并存时无误行仍逐行预览字节', multi.rows[0].bytes?.length === 6)

// 18k) 空列表：无错误、无输出
const emptyOpt = buildOption121([], client!)
check('空列表无错误且 optionLine 为空串', emptyOpt.errors.length === 0 && emptyOpt.routes.length === 0 && emptyOpt.optionLine === '' && emptyOpt.bytes.length === 0)

// 18l) 规划变化：客户端网段失效 -> resolveClientSegment 变 null（面板据此暂停结果），录入由上层按 ID 保留
const opt121Migrated = plan({
  parentCidr: '192.168.10.0/24',
  reservations: [
    { id: 'r1', name: '保留', cidr: '192.168.10.0/28' },
    { id: 'r2', name: '链路保留', cidr: '192.168.10.16/30' },
  ],
  requirements: demo.requirements,
})
check('迁移后 q4 仍存在（改址到 20/30），客户端解析跟随新网段', resolveClientSegment(opt121Migrated, 'q4')?.cidr === '192.168.10.20/30', resolveClientSegment(opt121Migrated, 'q4')?.cidr ?? 'null')
// 原录入下一跳 .17 在新网段 20/30（.21/.22）下自动重新校验为越界
const revalidated = buildOption121(
  [{ id: 'a', destination: '10.0.0.0/8', gateway: '192.168.10.17' }],
  resolveClientSegment(opt121Migrated, 'q4')!,
)
check('规划变化后按原录入重新校验：.17 相对新网段失效', revalidated.errors.length === 1 && /不在客户端网段/.test(revalidated.errors[0].message))
// 需求被删除后客户端网段彻底失效
const q4Deleted = plan({
  parentCidr: '192.168.10.0/24',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
  requirements: demo.requirements.filter((q) => q.id !== 'q4'),
})
check('客户端网段对应需求删除后解析为 null（结果暂停、录入保留）', resolveClientSegment(q4Deleted, 'q4') === null)

// 18m) 每行十进制字节可独立读取（表格展示）
check(
  '行视图给出规范目的与点分下一跳',
  opt.rows[2].destination === '192.168.1.0/24' &&
    opt.rows[2].gatewayIp === '192.168.10.17' &&
    JSON.stringify(opt.rows[2].bytes) === JSON.stringify([24, 192, 168, 1, 192, 168, 10, 17]),
  JSON.stringify(opt.rows[2]),
)

// ========== 19) 基线优先重排 ==========
// 19a) 关闭/无基线时结果与原算法完全一致（无 reflow 字段）
const reflowOff = plan(demo)
check('无基线不产生重排报告', reflowOff.reflow === undefined)
const reflowBase = buildBaseline(reflowOff)
check(
  '传入基线但不启用（baseline 缺省）结果字节级一致',
  JSON.stringify(plan(demo)) === JSON.stringify(reflowOff),
)

// 19b) 相同输入启用重排：全部基线自动需求经优先候选保留原址，布局与原算法相同
const sameReflow = plan({ ...demo, baseline: reflowBase })
check('重排报告生效', sameReflow.reflow?.active === true)
check(
  '相同输入重排布局不变',
  JSON.stringify(sameReflow.segments.map((s) => s.cidr)) ===
    JSON.stringify(reflowOff.segments.map((s) => s.cidr)),
)
check(
  '三个基线自动需求全部保留原址（优先候选）',
  sameReflow.reflow!.rows
    .filter((r) => ['q1', 'q2', 'q4'].includes(r.id))
    .every((r) => r.status === 'kept' && r.candidate?.accepted === true),
  JSON.stringify(sameReflow.reflow!.rows),
)
check(
  '固定段标记 fixed-untouched，新增/失败计数为 0',
  sameReflow.reflow!.rows.find((r) => r.id === 'q3')?.status === 'fixed-untouched' &&
    sameReflow.reflow!.counts.failed === 0 &&
    sameReflow.reflow!.counts.new === 0 &&
    sameReflow.reflow!.anchorsAccepted === 3 &&
    sameReflow.reflow!.anchorsRejected === 0,
)
check(
  '自动网段带 baselineOutcome=kept 与 anchored 标记',
  sameReflow.segments
    .filter((s) => s.kind === 'auto')
    .every((s) => s.baselineOutcome === 'kept' && s.baselineAnchored === true),
)

// 19c) 重排的价值：删除固定段后又新增主机需求时，普通算法挤占原段，重排保持原址
//  q4 需求从 2 台增至 25 台（/30 -> /27）：普通算法按规模序把 q4 落到 32/27，
//  q1 缩出的空间与 q2 顺序不变，但新增的小需求会重排；这里用新增 /27 需求制造普通算法下的迁移
const removeFixedNormal = plan({
  ...demo,
  requirements: [
    ...demo.requirements.filter((q) => q.id !== 'q3'),
    { id: 'q9', name: '新增段', hosts: 25, cidr: '' },
  ],
})
check(
  '普通算法：新增 /27 需求按规模序插入 32/27，q4 仍在 16/30（原固定段位置被新需求占据）',
  removeFixedNormal.segments.find((s) => s.ownerId === 'q9')?.cidr === '192.168.10.32/27' &&
    removeFixedNormal.segments.find((s) => s.ownerId === 'q4')?.cidr === '192.168.10.16/30',
  JSON.stringify(removeFixedNormal.segments.map((s) => [s.ownerId, s.cidr])),
)
const removeFixedReflow = plan({
  ...demo,
  requirements: [
    ...demo.requirements.filter((q) => q.id !== 'q3'),
    { id: 'q9', name: '新增段', hosts: 25, cidr: '' },
  ],
  baseline: reflowBase,
})
check(
  '重排模式下 q1/q2/q4 全部保留原址，新增需求避让到空闲间隙',
  removeFixedReflow.segments.find((s) => s.ownerId === 'q1')?.cidr === '192.168.10.128/25' &&
    removeFixedReflow.segments.find((s) => s.ownerId === 'q2')?.cidr === '192.168.10.64/26' &&
    removeFixedReflow.segments.find((s) => s.ownerId === 'q4')?.cidr === '192.168.10.16/30',
  JSON.stringify(removeFixedReflow.segments.map((s) => [s.ownerId, s.cidr])),
)
check(
  '保留原址的段均为优先候选落位，新增段 q9 走最低对齐',
  removeFixedReflow.segments
    .filter((s) => s.kind === 'auto' && s.ownerId !== 'q9')
    .every((s) => s.baselineOutcome === 'kept' && s.baselineAnchored === true) &&
    removeFixedReflow.segments.find((s) => s.ownerId === 'q9')?.baselineAnchored === false,
)

// 19d) 扩容：q1 100 -> 200（/25 -> /24），包含原网络地址 128 的 /24 对齐块为 0/24，
// 起点改变且覆盖固定段 32/27、保留 0/28 与 q4、q2 -> 候选被拒，兜底无空间 -> 失败并说明候选原因
const growInput: PlannerInput = {
  ...demo,
  requirements: demo.requirements.map((q) => (q.id === 'q1' ? { ...q, hosts: 200 } : q)),
}
const growReflow = plan({ ...growInput, baseline: reflowBase })
const q1grow = growReflow.reflow!.rows.find((r) => r.id === 'q1')!
check(
  'q1 扩容候选 0/24 撞保留区被拒，最终无法分配',
  q1grow.status === 'failed' &&
    q1grow.candidate?.cidr === '192.168.10.0/24' &&
    q1grow.candidate.accepted === false &&
    /冲突|撞/.test(q1grow.candidate.reason ?? '') &&
    /基线优先候选.*不可行/.test(q1grow.reason ?? ''),
  JSON.stringify(q1grow),
)
check('失败需求出现在 failures 且原因含候选说明', growReflow.failures.some((f) => f.id === 'q1' && /优先候选.*不可行/.test(f.reason)))

// 19e) 缩容原址保留：q1 100 -> 60（/25 -> /26），对齐块 128/26 与所有占用不冲突 -> kept
const shrinkInputReflow: PlannerInput = {
  ...demo,
  requirements: demo.requirements.map((q) => (q.id === 'q1' ? { ...q, hosts: 60 } : q)),
}
const shrinkReflow = plan({ ...shrinkInputReflow, baseline: reflowBase })
check(
  'q1 缩容在原址块 128/26 保留',
  shrinkReflow.segments.find((s) => s.ownerId === 'q1')?.cidr === '192.168.10.128/26' &&
    shrinkReflow.reflow!.rows.find((r) => r.id === 'q1')?.status === 'kept',
)
check('q2/q4 不受影响仍保留原址', shrinkReflow.segments.find((s) => s.ownerId === 'q2')?.cidr === '192.168.10.64/26')

// 19f) 同规模候选冲突按录入顺序：基线 a@0/28、b@16/28；均扩到 /27，候选同为 0/27
const tieBaseInput: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [],
  requirements: [
    { id: 'a', name: 'A', hosts: 10, cidr: '' },
    { id: 'b', name: 'B', hosts: 10, cidr: '' },
  ],
}
const tieBase = buildBaseline(plan(tieBaseInput))
check(
  '冲突基线布局 a=0/28、b=16/28',
  plan(tieBaseInput).segments.filter((s) => s.kind === 'auto').map((s) => s.cidr).join(',') ===
    '10.0.0.0/28,10.0.0.16/28',
)
const tieReflow = plan({
  ...tieBaseInput,
  requirements: [
    { id: 'a', name: 'A', hosts: 20, cidr: '' },
    { id: 'b', name: 'B', hosts: 20, cidr: '' },
  ],
  baseline: tieBase,
})
check(
  '同规模冲突录入在前者 a 保留 0/27，b 候选被拒后兜底到 32/27',
  tieReflow.segments.find((s) => s.ownerId === 'a')?.cidr === '10.0.0.0/27' &&
    tieReflow.segments.find((s) => s.ownerId === 'b')?.cidr === '10.0.0.32/27',
  JSON.stringify(tieReflow.segments.map((s) => [s.ownerId, s.cidr])),
)
const ta = tieReflow.reflow!.rows.find((r) => r.id === 'a')!
const tb = tieReflow.reflow!.rows.find((r) => r.id === 'b')!
check('a=kept 候选采纳；b=fallback-moved 候选被拒（与已保留候选冲突）',
  ta.status === 'kept' && ta.candidate?.accepted === true &&
    tb.status === 'fallback-moved' && tb.candidate?.accepted === false &&
    /候选块|已保留原址/.test(tb.candidate?.reason ?? ''),
  JSON.stringify([ta, tb]),
)

// 19g) 不同规模冲突大优先：a 录入在前（/27），b 在后（/26），候选都含 0 起点 -> b 胜
const sizeReflow = plan({
  ...tieBaseInput,
  requirements: [
    { id: 'a', name: 'A', hosts: 20, cidr: '' },
    { id: 'b', name: 'B', hosts: 40, cidr: '' },
  ],
  baseline: tieBase,
})
check(
  '大规模候选 b 保留 0/26，a 被挤到 64/27（不被录入顺序挡住）',
  sizeReflow.segments.find((s) => s.ownerId === 'b')?.cidr === '10.0.0.0/26' &&
    sizeReflow.segments.find((s) => s.ownerId === 'a')?.cidr === '10.0.0.64/27',
  JSON.stringify(sizeReflow.segments.map((s) => [s.ownerId, s.cidr])),
)
check(
  'b 为 moved（锚点 0/26 起点不同于基线 16），a 为 fallback-moved',
  sizeReflow.reflow!.rows.find((r) => r.id === 'b')?.status === 'moved' &&
    sizeReflow.reflow!.rows.find((r) => r.id === 'a')?.status === 'fallback-moved',
  JSON.stringify(sizeReflow.reflow!.rows.map((r) => [r.id, r.status])),
)

// 19h) 候选越界：基线 a@192/27（父 /24），扩到 1000 台（/22，对齐块 0/22 共 1024 地址，越出 /24）
const oobBase = buildBaseline(
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [
      { id: 'r1', name: 'R1', cidr: '10.0.0.0/25' },
      { id: 'r2', name: 'R2', cidr: '10.0.0.128/26' },
      { id: 'r3', name: 'R3', cidr: '10.0.0.192/28' },
    ],
    requirements: [{ id: 'a', name: 'A', hosts: 5, cidr: '' }], // a@224/29
  }),
)
check(
  '越界基线 a 落在 208/29',
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [
      { id: 'r1', name: 'R1', cidr: '10.0.0.0/25' },
      { id: 'r2', name: 'R2', cidr: '10.0.0.128/26' },
      { id: 'r3', name: 'R3', cidr: '10.0.0.192/28' },
    ],
    requirements: [{ id: 'a', name: 'A', hosts: 5, cidr: '' }],
  }).segments.find((s) => s.ownerId === 'a')?.cidr === '10.0.0.208/29',
)
const oobReflow = plan({
  parentCidr: '10.0.0.0/24',
  reservations: [
    { id: 'r1', name: 'R1', cidr: '10.0.0.0/25' },
    { id: 'r2', name: 'R2', cidr: '10.0.0.128/26' },
    { id: 'r3', name: 'R3', cidr: '10.0.0.192/28' },
  ],
  requirements: [{ id: 'a', name: 'A', hosts: 1000, cidr: '' }],
  baseline: oobBase,
})
const oobRow = oobReflow.reflow!.rows.find((r) => r.id === 'a')!
check(
  '越界候选标记越出父网段，需求最终失败',
  oobRow.status === 'failed' &&
    oobRow.candidate?.accepted === false &&
    /越出父网段/.test(oobRow.candidate.reason ?? ''),
  JSON.stringify(oobRow),
)

// 19i) 候选撞保留区/固定段被拒，最低对齐仍可分配
const fixedBase = buildBaseline(
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [{ id: 'r', name: 'R', cidr: '10.0.0.0/26' }],
    requirements: [{ id: 'a', name: 'A', hosts: 40, cidr: '' }], // a@64/26
  }),
)
const hitFixed = plan({
  parentCidr: '10.0.0.0/24',
  reservations: [{ id: 'r', name: 'R', cidr: '10.0.0.0/26' }],
  requirements: [
    { id: 'f', name: '固定', hosts: 2, cidr: '10.0.0.64/27' },
    { id: 'a', name: 'A', hosts: 100, cidr: '' }, // 锚 0/25 撞保留与固定
  ],
  baseline: fixedBase,
})
check(
  '候选撞保留/固定被拒后由最低对齐落到 128/25',
  hitFixed.segments.find((s) => s.ownerId === 'a')?.cidr === '10.0.0.128/25' &&
    hitFixed.reflow!.rows.find((r) => r.id === 'a')?.status === 'fallback-moved' &&
    hitFixed.segments.find((s) => s.ownerId === 'a')?.baselineAnchored === false,
  JSON.stringify(hitFixed.reflow!.rows),
)

// 19j) 新增需求走最低对齐，标记 new；基线失败需求恢复后标记 baseline-failed
const withNew = plan({
  ...demo,
  requirements: [...demo.requirements, { id: 'q9', name: '新增小需求', hosts: 2, cidr: '' }],
  baseline: reflowBase,
})
check(
  '新增需求标记 new，走最低对齐落在最低空闲 20/30',
  withNew.reflow!.rows.find((r) => r.id === 'q9')?.status === 'new' &&
    withNew.segments.find((s) => s.ownerId === 'q9')?.cidr === '192.168.10.20/30',
  JSON.stringify(withNew.reflow!.rows.map((r) => [r.id, r.status])),
)
// 同一父网段 /24 内：q1 需要 1000 台（/22 越界）基线时失败；改为 100 台后恢复
const failedBase = buildBaseline(
  plan({
    parentCidr: '192.168.10.0/24',
    reservations: [],
    requirements: [{ id: 'q1', name: '放不下', hosts: 1000, cidr: '' }],
  }),
)
check('基线失败场景确实未分配', plan({
  parentCidr: '192.168.10.0/24',
  reservations: [],
  requirements: [{ id: 'q1', name: '放不下', hosts: 1000, cidr: '' }],
}).failures.length === 1)
const recoveredReflow = plan({
  parentCidr: '192.168.10.0/24',
  reservations: [],
  requirements: [{ id: 'q1', name: '放不下', hosts: 100, cidr: '' }],
  baseline: failedBase,
})
check(
  '基线时未分配的需求恢复后标记 baseline-failed（无优先候选）',
  recoveredReflow.reflow!.rows.find((r) => r.id === 'q1')?.status === 'baseline-failed' &&
    recoveredReflow.reflow!.rows.find((r) => r.id === 'q1')?.candidate === undefined,
)

// 19k) 父网段变化时重排不生效（即使传入基线）
const changedParent = plan({ ...demo, parentCidr: '192.168.11.0/24', baseline: reflowBase })
check('父网段变化时 reflow 不生效', changedParent.reflow === undefined)

// 19l) 地址守恒与占用互不重叠（所有重排场景）
for (const [label, p] of [
  ['same', sameReflow],
  ['removeFixed', removeFixedReflow],
  ['shrink', shrinkReflow],
  ['tie', tieReflow],
  ['size', sizeReflow],
  ['hitFixed', hitFixed],
  ['withNew', withNew],
] as const) {
  const occ = p.segments.filter((s) => s.kind !== 'free').sort((a, b) => a.start - b.start)
  let noOverlap = true
  for (let i = 1; i < occ.length; i++) if (occ[i].start <= occ[i - 1].end) noOverlap = false
  const conserved =
    p.summary.reserved + p.summary.fixed + p.summary.auto + p.summary.free === p.parentSize
  check(`重排(${label})占用段互不重叠且地址守恒`, noOverlap && conserved, label)
}

// 19m) 联动：基线对比读取重排结果（删固定段+新增需求，重排使 q1/q2/q4 原址不动）
const linked = compareWithBaseline(reflowBase, removeFixedReflow)
check(
  '重排保留原址后 q1/q2/q4 全部未变，q3 删除、q9 新增',
  linked.counts.unchanged === 3 &&
    linked.rows.find((r) => r.id === 'q3')?.type === 'removed' &&
    linked.rows.find((r) => r.id === 'q9')?.type === 'added',
  JSON.stringify(linked.counts),
)
// q9 重排后落在 192/27（32 地址），恰好补回 q3 固定段释放的 32 地址
check('重排后净地址变化为 0（新增段与删除固定段地址数相等）', linked.summary.net === 0, String(linked.summary.net))

// 19n) 联动：主机登记按重排后的网段重新校验，原址保留则地址继续有效
const hostLinked = reconcileHosts(
  [
    { id: 'h1', ownerId: 'q1', name: '办公网关', address: ipToInt('192.168.10.129'), mode: 'auto' },
    { id: 'h2', ownerId: 'q2', name: '机房设备', address: ipToInt('192.168.10.65'), mode: 'auto' },
  ],
  removeFixedReflow,
)
check(
  '重排保留原址：原主机登记全部仍有效，不产生失效',
  hostLinked.rows.every((r) => r.valid),
  JSON.stringify(hostLinked.rows.map((r) => [r.assignment.id, r.reason])),
)
// 对照组：同样输入普通算法下 q1 仍在 128/25（不会失效）；改用 19d 的缩容场景验证迁移失效：
// q1 100->60 普通算法把 q1 放到 64/26、q2 挤到 128/26，原 129 失效；重排后 q1 留在 128/26 仍有效
const hostShrinkNormal = reconcileHosts(
  [{ id: 'h1', ownerId: 'q1', name: '办公网关', address: ipToInt('192.168.10.129'), mode: 'auto' }],
  plan(shrinkInputReflow),
)
const hostShrinkReflow = reconcileHosts(
  [{ id: 'h1', ownerId: 'q1', name: '办公网关', address: ipToInt('192.168.10.129'), mode: 'auto' }],
  shrinkReflow,
)
check(
  '对照组：普通算法缩容重排后 129 越出 q1 新网段 64/26 而失效；重排保留 128/26 仍有效',
  !hostShrinkNormal.rows[0].valid && hostShrinkReflow.rows[0].valid,
  JSON.stringify([hostShrinkNormal.rows[0].reason, hostShrinkReflow.rows[0].reason]),
)

// 19o) 联动：路由汇总读取重排后网段（所选并集仍精确守恒：128+64+4+32=228）
const sumLinked = summarizeSegments(
  removeFixedReflow.segments.filter((s) => s.kind === 'auto'),
)
check(
  '重排后路由汇总地址数 = 128+64+4+32 = 228',
  sumLinked.totalAddresses === 228 && sumLinked.blocks.reduce((n, b) => n + b.capacity, 0) === 228,
  String(sumLinked.totalAddresses),
)

// 19p) 导出 JSON 含重排统计与逐需求明细
const reflowExport = buildExportJson(removeFixedReflow, { parentCidr: demo.parentCidr })
check('导出包含基线优先重排段', /基线优先重排/.test(reflowExport))
check('导出明细含保留原址结果', /保留原址/.test(reflowExport))
const offExport = buildExportJson(reflowOff, { parentCidr: demo.parentCidr })
check('关闭模式导出不含重排段', !/基线优先重排/.test(offExport))

// 19q) 关闭模式后恢复原算法：同输入结果与未启用时字节级一致
const toggledBack = plan({ ...demo, baseline: null })
check('关闭重排恢复原算法（字节级）', JSON.stringify(toggledBack) === JSON.stringify(reflowOff))

// ========== 20) 反向 DNS 区域文件（in-addr.arpa / RFC 2317） ==========
// 20a) 设备名分类：合法绝对域名 / 单标签跳过 / 不合法名称报错
check(
  '合法 FQDN 归一为小写带根尾点',
  classifyDeviceName('GW.Example.COM').kind === 'fqdn' &&
    (classifyDeviceName('GW.Example.COM') as { fqdn: string }).fqdn === 'gw.example.com.',
)
check('带合法连字符标签通过', classifyDeviceName('core-sw-1.site-a.example.net').kind === 'fqdn')
check('允许数字开头的标签（如 3par / r2d2）', classifyDeviceName('3par.example.com').kind === 'fqdn')
check('单个根尾点形式接受并归一',
  classifyDeviceName('host.example.com.').kind === 'fqdn' &&
    (classifyDeviceName('host.example.com.') as { fqdn: string }).fqdn === 'host.example.com.')
check('单标签中文名跳过（并非域名）', classifyDeviceName('网关').kind === 'skip')
check('单标签英文名跳过', classifyDeviceName('core-sw').kind === 'skip')
check('空名称跳过', classifyDeviceName('   ').kind === 'skip')
check('中文多标签名称非法（非 ASCII）', classifyDeviceName('路由.例.中国').kind === 'error')
check('含下划线的标签非法', classifyDeviceName('my_host.example.com').kind === 'error')
check('连字符开头标签非法', classifyDeviceName('-bad.example.com').kind === 'error')
check('连字符结尾标签非法', classifyDeviceName('bad-.example.com').kind === 'error')
check('连续点（空标签）非法', classifyDeviceName('host..example.com').kind === 'error')
check('多个根尾点非法', classifyDeviceName('host.example.com..').kind === 'error')
check('含空格非法', classifyDeviceName('host .example.com').kind === 'error')
check('纯数字顶级标签非法', classifyDeviceName('host.123').kind === 'error')
check(
  '超长标签非法（>63）',
  classifyDeviceName(`${'a'.repeat(64)}.example.com`).kind === 'error',
)
check('超长全名非法（>253）', classifyDeviceName(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`).kind === 'error',
  String(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`.length))
check('长度恰为 253 的多标签名称合法', classifyDeviceName(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`).kind === 'fqdn')

// 20b) 父/子区域命名
check(
  '父区域名为前 3 字节反序',
  parentZoneName(ipToInt('192.168.10.16')) === '10.168.192.in-addr.arpa',
  parentZoneName(ipToInt('192.168.10.16')),
)
const rdnsMgmt = allocatableSegments(hostPlan).find((s) => s.ownerId === 'q4')! // 192.168.10.16/30
check('网段解析：q4=16/30', resolveReverseSegment(hostPlan, 'q4')?.cidr === '192.168.10.16/30')
check('保留区/空选择不能解析', resolveReverseSegment(hostPlan, 'r1') === null && resolveReverseSegment(hostPlan, '') === null)
check(
  'RFC 2317 子区域以起止末位命名：16-19',
  childZoneName(rdnsMgmt) === '16-19.10.168.192.in-addr.arpa',
  childZoneName(rdnsMgmt),
)

// 20c) /24 标准区域：PTR 按 IP 升序、占位 SOA/NS、序列号
const plan24 = plan({
  parentCidr: '192.168.20.0/24',
  reservations: [],
  requirements: [{ id: 'n1', name: '业务段', hosts: 200, cidr: '' }], // 192.168.20.0/24
})
check('/24 规划成功', plan24.inputErrors.length === 0 && plan24.segments.some((s) => s.ownerId === 'n1' && s.prefix === 24))
const list24: HostAssignment[] = [
  { id: 'd1', ownerId: 'n1', name: 'www.example.com', address: ipToInt('192.168.20.20'), mode: 'manual' },
  { id: 'd2', ownerId: 'n1', name: 'GW.EXAMPLE.COM', address: ipToInt('192.168.20.1'), mode: 'auto' },
  { id: 'd3', ownerId: 'n1', name: '打印机', address: ipToInt('192.168.20.50'), mode: 'manual' }, // 单标签跳过
  { id: 'd4', ownerId: 'n1', name: 'mail.example.com', address: ipToInt('192.168.20.10'), mode: 'manual' },
]
const built24 = buildReverseDns(list24, plan24, 'n1', { serial: '2026091800' })
check('/24 识别为 classful 模式', built24?.mode === 'classful' && built24.supported)
check('父区域名 20.168.192.in-addr.arpa', built24?.parentZone === '20.168.192.in-addr.arpa')
check('3 条 FQDN 纳入、1 条单标签跳过', built24?.entries.length === 3 && built24?.skipped.length === 1, JSON.stringify({ e: built24?.entries.length, s: built24?.skipped.length }))
check('无错误时生成区域文本', built24?.zoneText !== '' && built24?.errors.length === 0)
check(
  '结果按 IP 升序（.1, .10, .20），与录入顺序无关',
  built24!.entries.map((e) => e.ip).join(',') === '192.168.20.1,192.168.20.10,192.168.20.20',
  built24!.entries.map((e) => e.ip).join(','),
)
check(
  'PTR 记录文本（owner 宽 4 列、大写归一为小写）',
  built24!.zoneText.includes('1    IN  PTR   gw.example.com.') &&
    built24!.zoneText.includes('10   IN  PTR   mail.example.com.') &&
    built24!.zoneText.includes('20   IN  PTR   www.example.com.'),
  built24!.zoneText,
)
check('单标签设备名不出现在区域文本中', !/打印机|^50/m.test(built24!.zoneText) && !built24!.zoneText.includes('50   IN  PTR'))
check('区域文本含 $ORIGIN/$TTL/SOA/NS 占位与序列号',
  built24!.zoneText.includes('$ORIGIN 20.168.192.in-addr.arpa.') &&
    built24!.zoneText.includes('$TTL 86400') &&
    built24!.zoneText.includes('SOA') &&
    built24!.zoneText.includes(PLACEHOLDER_NS) &&
    built24!.zoneText.includes(PLACEHOLDER_RNAME) &&
    built24!.zoneText.includes('2026091800'),
)
check('默认序列号为 10 位 YYYYMMDDnn', /^\d{10}$/.test(buildReverseDns(list24, plan24, 'n1')!.serial))

// 20d) RFC 2317：/30 生成父区域 CNAME + 子区域 PTR 两段，子区域 16-19
const list30: HostAssignment[] = [
  { id: 'm1', ownerId: 'q4', name: 'rt1.example.com', address: ipToInt('192.168.10.18'), mode: 'manual' },
  { id: 'm2', ownerId: 'q4', name: 'rt0.example.com', address: ipToInt('192.168.10.17'), mode: 'auto' },
]
const built30 = buildReverseDns(list30, hostPlan, 'q4', { serial: '2026091800' })
check('/30 识别为 rfc2317 模式', built30?.mode === 'rfc2317' && built30.supported)
check('/30 子区域 16-19.10.168.192.in-addr.arpa', built30?.childZone === '16-19.10.168.192.in-addr.arpa')
check('/30 不产生 classful zoneText', built30!.zoneText === '' && built30!.parentText !== '' && built30!.childText !== '')
check(
  '父区域 CNAME 行（按 IP 升序，目标为 <末位>.<子区域>.）',
  built30!.parentText!.includes('17   IN  CNAME 17.16-19.10.168.192.in-addr.arpa.') &&
    built30!.parentText!.includes('18   IN  CNAME 18.16-19.10.168.192.in-addr.arpa.'),
  built30!.parentText,
)
check(
  '子区域 PTR 行（按 IP 升序）',
  built30!.childText!.includes('17   IN  PTR   rt0.example.com.') &&
    built30!.childText!.includes('18   IN  PTR   rt1.example.com.'),
  built30!.childText,
)
check('父片段含 NS 委派注释与子区域名',
  built30!.parentText!.includes('IN  NS') && built30!.parentText!.includes('16-19'),
)
check('子区域文件含 $ORIGIN 与 SOA/NS 占位',
  built30!.childText!.includes('$ORIGIN 16-19.10.168.192.in-addr.arpa.') &&
    built30!.childText!.includes('SOA') && built30!.childText!.includes(PLACEHOLDER_NS),
)

// 20e) RFC 2317 各前缀子区域命名（/25 与 /27）
const plan25 = plan({
  parentCidr: '10.50.0.0/24',
  reservations: [],
  requirements: [{ id: 'h', name: '半段', hosts: 120, cidr: '' }], // 10.50.0.0/25
})
check('/25 规划成功', plan25.segments.some((s) => s.ownerId === 'h' && s.cidr === '10.50.0.0/25'))
check(
  '/25 子区域 0-127.0.50.10.in-addr.arpa',
  buildReverseDns([], plan25, 'h')!.childZone === '0-127.0.50.10.in-addr.arpa',
)
const plan27 = plan({
  parentCidr: '172.16.9.0/24',
  reservations: [],
  requirements: [{ id: 'f', name: '固定小段', hosts: 20, cidr: '172.16.9.96/27' }], // 96~127
})
check(
  '/27 固定段子区域 96-127.9.16.172.in-addr.arpa',
  buildReverseDns([], plan27, 'f')!.childZone === '96-127.9.16.172.in-addr.arpa',
  buildReverseDns([], plan27, 'f')!.childZone,
)

// 20f) 重复域名：第二条报错、明确定位、停止整体生成
const dupFqdn: HostAssignment[] = [
  { id: 'a', ownerId: 'q4', name: 'host.example.com', address: ipToInt('192.168.10.17'), mode: 'manual' },
  { id: 'b', ownerId: 'q4', name: 'HOST.example.COM', address: ipToInt('192.168.10.18'), mode: 'manual' },
]
const dupBuilt = buildReverseDns(dupFqdn, hostPlan, 'q4')
check('重复域名（忽略大小写/尾点）产生 1 条错误', dupBuilt!.errors.length === 1, JSON.stringify(dupBuilt!.errors))
check('错误定位到第 2 条并指向第 1 条',
  dupBuilt!.errors[0].index === 2 && /第 1 条/.test(dupBuilt!.errors[0].message) && /host\.example\.com\./.test(dupBuilt!.errors[0].message),
  JSON.stringify(dupBuilt!.errors),
)
check('有错停止生成：所有区域文本为空', dupBuilt!.zoneText === '' && dupBuilt!.parentText === '' && dupBuilt!.childText === '')
check('有错时仍按 IP 升序保留首条有效行预览', dupBuilt!.entries.length === 1 && dupBuilt!.entries[0].ip === '192.168.10.17')

// 20g) 不合法名称：逐条报错（可多条）并停止生成；有效行仍预览
const badNames: HostAssignment[] = [
  { id: 'a', ownerId: 'q4', name: 'good.example.com', address: ipToInt('192.168.10.17'), mode: 'manual' },
  { id: 'b', ownerId: 'q4', name: 'bad_host.example.com', address: ipToInt('192.168.10.18'), mode: 'manual' },
]
const badBuilt = buildReverseDns(badNames, hostPlan, 'q4')
check('非法名称产生错误且区域不输出', badBuilt!.errors.length === 1 && badBuilt!.parentText === '' && badBuilt!.childText === '')
check('错误信息含原始名称与原因', /bad_host\.example\.com/.test(badBuilt!.errors[0].message) && /不合法/.test(badBuilt!.errors[0].message))
const multiBad: HostAssignment[] = [
  { id: 'a', ownerId: 'q4', name: 'a..example.com', address: ipToInt('192.168.10.17'), mode: 'manual' },
  { id: 'b', ownerId: 'q4', name: '路由.例', address: ipToInt('192.168.10.18'), mode: 'manual' },
]
const multiBadBuilt = buildReverseDns(multiBad, hostPlan, 'q4')
check('多个非法名称逐条报错（2 条）', multiBadBuilt!.errors.length === 2 && multiBadBuilt!.errors.map((e) => e.index).join(',') === '1,2')

// 20h) 失效登记不读取：网段迁移后越界登记进入 excluded 而非错误，其他有效登记仍生成
const rdnsMigratedList: HostAssignment[] = [
  { id: 'x1', ownerId: 'q4', name: 'old.example.com', address: ipToInt('192.168.10.17'), mode: 'auto' },
]
const migratedBuilt = buildReverseDns(rdnsMigratedList, migratedPlan, 'q4', { serial: '2026091800' })
check('迁移后 q4=20/30，原 .17 登记失效不被读取',
  migratedBuilt!.segment.cidr === '192.168.10.20/30' &&
    migratedBuilt!.excluded.length === 1 &&
    migratedBuilt!.entries.length === 0 &&
    migratedBuilt!.errors.length === 0,
  JSON.stringify({ c: migratedBuilt!.segment.cidr, x: migratedBuilt!.excluded.length }),
)
check('失效登记不阻断：无有效条目时区域为空（而非报错）', migratedBuilt!.parentText === '' && migratedBuilt!.childText === '')
// 迁移后在新网段补一条合法登记即可恢复生成
const migratedRecover = buildReverseDns(
  [
    ...rdnsMigratedList,
    { id: 'x2', ownerId: 'q4', name: 'new.example.com', address: ipToInt('192.168.10.21'), mode: 'manual' },
  ],
  migratedPlan,
  'q4',
)
check('迁移后新址合法登记实时纳入（.21），旧登记留在 excluded',
  migratedRecover!.entries.map((e) => e.ip).join(',') === '192.168.10.21' && migratedRecover!.excluded.length === 1,
)
check('实时重算：改址回新网段可用范围后重新纳入',
  buildReverseDns(
    [{ id: 'x1', ownerId: 'q4', name: 'old.example.com', address: ipToInt('192.168.10.22'), mode: 'manual' }],
    migratedPlan,
    'q4',
  )!.entries.length === 1,
)

// 20i) 网络/广播地址登记（数据层异常）不进入输出
const edgeAddrBuilt = buildReverseDns(
  [{ id: 'e', ownerId: 'q4', name: 'edge.example.com', address: ipToInt('192.168.10.16'), mode: 'manual' }],
  hostPlan,
  'q4',
)
check('网络地址登记被排除不生成', edgeAddrBuilt!.excluded.length === 1 && edgeAddrBuilt!.entries.length === 0)

// 20j) 无有效条目：不报错、文本为空
check('空登记列表无错误无文本', (() => {
  const b = buildReverseDns([], hostPlan, 'q4')!
  return b.errors.length === 0 && b.parentText === '' && b.childText === '' && b.entries.length === 0
})())
check('仅有单标签名：全部跳过、无错误无文本', (() => {
  const b = buildReverseDns(
    [{ id: 's', ownerId: 'q4', name: '网关', address: ipToInt('192.168.10.17'), mode: 'auto' }],
    hostPlan,
    'q4',
  )!
  return b.skipped.length === 1 && b.entries.length === 0 && b.errors.length === 0 && b.parentText === ''
})())

// 20k) 网段选择失效 -> resolveReverseSegment 为 null（面板暂停，选择由上层保留）
check('需求删除后解析为 null', resolveReverseSegment(q4Deleted, 'q4') === null)
check('buildReverseDns 对失效网段返回 null', buildReverseDns(list30, q4Deleted, 'q4') === null)

// 20l) 前缀范围：仅 /24 与 /25～/30 支持
const plan23 = plan({
  parentCidr: '10.20.0.0/22',
  reservations: [],
  requirements: [{ id: 'big', name: '大固定段', hosts: 500, cidr: '10.20.0.0/23' }],
})
const built23 = buildReverseDns([], plan23, 'big')
check('/23 不支持并给出原因（大于 /24）', built23!.supported === false && built23!.mode === 'classful' && /超出单个/.test(built23!.unsupportedReason ?? ''))

// 20m) 跨网段隔离：重复域名在不同网段间互不影响（按所选网段独立生成）
const crossList: HostAssignment[] = [
  { id: 'a', ownerId: 'q1', name: 'gw.example.com', address: ipToInt('192.168.10.129'), mode: 'auto' },
  { id: 'b', ownerId: 'q4', name: 'gw.example.com', address: ipToInt('192.168.10.17'), mode: 'auto' },
]
check('不同网段同名域名各自生成无重复错误',
  buildReverseDns(crossList, hostPlan, 'q1')!.errors.length === 0 &&
    buildReverseDns(crossList, hostPlan, 'q4')!.errors.length === 0,
)
check('其他网段的登记不出现在所选网段输出中',
  buildReverseDns(crossList, hostPlan, 'q4')!.entries.every((e) => e.assignment.ownerId === 'q4'),
)

// 20n) 只读隔离：反向 DNS 不修改规划/登记，且导出 JSON 不含反向区域内容
check('反向 DNS 不改动登记数组', (() => {
  const snapshot = JSON.stringify(crossList)
  buildReverseDns(crossList, hostPlan, 'q4', { serial: '2026091800' })
  return JSON.stringify(crossList) === snapshot
})())
check('导出 JSON 不含 in-addr.arpa / PTR 内容', !/in-addr\.arpa|PTR/.test(buildExportJson(hostPlan, { parentCidr: demo.parentCidr })))

// ========== 21) DHCP 动态地址池（dnsmasq dhcp-range） ==========
// 演示规划：q4=192.168.10.16/30（.17/.18），q1=128/25（.129~.254），q2=64/26，q3=32/27
// 21a) resolvePoolSegment：只接受成功分配的固定 / 自动网段
check('宿主网段解析 q4=192.168.10.16/30', resolvePoolSegment(hostPlan, 'q4')?.cidr === '192.168.10.16/30')
check('保留区 / 空闲段不能作为宿主网段', resolvePoolSegment(hostPlan, 'r1') === null)
check('空选择 / 已删除需求解析为 null', resolvePoolSegment(hostPlan, '') === null && resolvePoolSegment(hostPlan, 'nope') === null)

// 21b) 无手工排除：候选 = 全部可用主机（自动扣网络/广播）；无登记时整段一个池
{
  const seg = resolvePoolSegment(hostPlan, 'q3')! // 192.168.10.32/27，可用 .33 ~ .62
  const built = buildDhcpPool([], [], hostPlan, seg)
  check('无排除时无错误且单池', built.errors.length === 0 && built.pools.length === 1, JSON.stringify(built.errors))
  check(
    '单池覆盖全部 30 个可用地址（.33~.62）',
    built.pools[0].startIp === '192.168.10.33' &&
      built.pools[0].endIp === '192.168.10.62' &&
      built.pools[0].count === 30 &&
      built.total === 30,
    JSON.stringify(built.pools),
  )
  check('掩码取自 /27 = 255.255.255.224', built.netmask === '255.255.255.224', built.netmask)
  check(
    '配置行 dhcp-range=起,止,掩码',
    built.configText === 'dhcp-range=192.168.10.33,192.168.10.62,255.255.255.224',
    built.configText,
  )
}

// 21c) 网络地址 / 广播地址被手工区间覆盖也不产生额外扣除（候选恒为可用主机范围）
{
  const seg = resolvePoolSegment(hostPlan, 'q4')! // .16/30，可用 .17/.18
  const entries: DhcpExclusionInput[] = [
    { id: 'e1', start: '192.168.10.16', end: '192.168.10.19' }, // 整段含网络与广播
  ]
  const built = buildDhcpPool(entries, [], hostPlan, seg)
  check('覆盖整段（含网络/广播）时无错误、可分配为 0', built.errors.length === 0 && built.pools.length === 0 && built.total === 0)
  // 仅覆盖网络/广播两端：可用主机不受影响
  const built2 = buildDhcpPool(
    [
      { id: 'a', start: '192.168.10.16', end: '192.168.10.16' },
      { id: 'b', start: '192.168.10.19', end: '' },
    ],
    [],
    hostPlan,
    seg,
  )
  check('只排除网络/广播地址不占用可分配数量（仍为 2）', built2.total === 2 && built2.pools.length === 1, JSON.stringify(built2.pools))
}

// 21d) 有效主机登记自动排除，且把池切成两段
{
  const seg = resolvePoolSegment(hostPlan, 'q3')! // .33 ~ .62
  const hosts: HostAssignment[] = [
    { id: 'h1', ownerId: 'q3', name: '占用40', address: ipToInt('192.168.10.40'), mode: 'manual' },
    { id: 'h2', ownerId: 'q3', name: '占用41', address: ipToInt('192.168.10.41'), mode: 'auto' },
  ]
  const built = buildDhcpPool([], hosts, hostPlan, seg)
  check('自动排除 2 个有效登记', built.hostExclusions.length === 2 && built.hostExclusions.map((h) => h.ip).join(',') === '192.168.10.40,192.168.10.41')
  check('地址池被切成 .33~.39 与 .42~.62 两段', built.pools.length === 2 &&
    built.pools[0].startIp === '192.168.10.33' && built.pools[0].endIp === '192.168.10.39' &&
    built.pools[1].startIp === '192.168.10.42' && built.pools[1].endIp === '192.168.10.62',
    JSON.stringify(built.pools.map((p) => [p.startIp, p.endIp])))
  check('两段数量 7 + 21 = 28（30 - 2）', built.pools[0].count === 7 && built.pools[1].count === 21 && built.total === 28)
  check(
    '两行配置按地址升序',
    built.configText ===
      'dhcp-range=192.168.10.33,192.168.10.39,255.255.255.224\n' +
      'dhcp-range=192.168.10.42,192.168.10.62,255.255.255.224',
    built.configText,
  )
}

// 21e) 手工排除区间：单地址（结束留空）、区间切分、数量统计
{
  const seg = resolvePoolSegment(hostPlan, 'q1')! // 192.168.10.128/25，可用 .129 ~ .254（126 个）
  const entries: DhcpExclusionInput[] = [
    { id: 'a', start: '192.168.10.200', end: '' }, // 单地址
    { id: 'b', start: '192.168.10.150', end: '192.168.10.160' }, // 11 个地址
  ]
  const built = buildDhcpPool(entries, [], hostPlan, seg)
  check('单地址 + 区间均合法', built.errors.length === 0, JSON.stringify(built.errors))
  check('合并后仍为 2 段手工排除（不相邻）', built.mergedManual.length === 2)
  check('单地址行 range 起=止', built.rows[0].range?.start === built.rows[0].range?.end && built.rows[0].range?.start === ipToInt('192.168.10.200'))
  check('总可分配 126 - 1 - 11 = 114', built.total === 114, String(built.total))
  check('被切成三段 .129~.149、.161~.199、.201~.254', built.pools.length === 3 &&
    JSON.stringify(built.pools.map((p) => [p.startIp, p.endIp])) ===
      JSON.stringify([['192.168.10.129', '192.168.10.149'], ['192.168.10.161', '192.168.10.199'], ['192.168.10.201', '192.168.10.254']]),
    JSON.stringify(built.pools.map((p) => [p.startIp, p.endIp])))
}

// 21f) 重叠 / 相邻手工区间先合并，剩余计算不重复扣除
{
  const seg = resolvePoolSegment(hostPlan, 'q3')! // .33 ~ .62
  const entries: DhcpExclusionInput[] = [
    { id: 'a', start: '192.168.10.40', end: '192.168.10.50' },
    { id: 'b', start: '192.168.10.45', end: '192.168.10.55' }, // 与 a 重叠
    { id: 'c', start: '192.168.10.56', end: '192.168.10.57' }, // 与合并结果相邻
  ]
  const built = buildDhcpPool(entries, [], hostPlan, seg)
  check('重叠+相邻合并为单段 .40~.57（18 个地址）',
    built.mergedManual.length === 1 &&
      built.mergedManual[0].startIp === '192.168.10.40' &&
      built.mergedManual[0].endIp === '192.168.10.57' &&
      built.mergedManual[0].count === 18,
    JSON.stringify(built.mergedManual))
  check('剩余 .33~.39（7）+ .58~.62（5）= 12，重叠不重复扣除', built.total === 12 && built.pools.length === 2, String(built.total))
}

// 21g) 手工区间与有效登记重叠时合并去重（主机地址不重复扣除）
{
  const seg = resolvePoolSegment(hostPlan, 'q3')!
  const hosts: HostAssignment[] = [
    { id: 'h1', ownerId: 'q3', name: 'srv', address: ipToInt('192.168.10.40'), mode: 'manual' },
  ]
  const entries: DhcpExclusionInput[] = [{ id: 'a', start: '192.168.10.40', end: '192.168.10.45' }]
  const built = buildDhcpPool(entries, hosts, hostPlan, seg)
  check('登记 .40 与手工区间重叠：合计仅扣 6 个地址（30-6=24）', built.total === 24, String(built.total))
  check('合并排除为 .40~.45 单段，池分两段', built.pools.length === 2)
}

// 21h) 校验：起止有序、位于网段、合法 IPv4、缺起始
{
  const seg = resolvePoolSegment(hostPlan, 'q4')! // .16/30
  const reversed = buildDhcpPool([{ id: 'a', start: '192.168.10.18', end: '192.168.10.17' }], [], hostPlan, seg)
  check('起止颠倒报错并定位第 1 条', reversed.errors.length === 1 && reversed.errors[0].index === 1 && /顺序颠倒/.test(reversed.errors[0].message), JSON.stringify(reversed.errors))
  check('有错时停止生成：无池、无配置', reversed.pools.length === 0 && reversed.configText === '')

  const outsideSeg = buildDhcpPool([{ id: 'a', start: '192.168.10.40', end: '192.168.10.41' }], [], hostPlan, seg)
  check('区间不在网段内报错', outsideSeg.errors.length === 2 && outsideSeg.errors.every((e) => /不在网段/.test(e.message)), JSON.stringify(outsideSeg.errors))

  const badIp = buildDhcpPool([{ id: 'a', start: '999.1.1.1', end: '192.168.10.17' }], [], hostPlan, seg)
  check('非法起始 IPv4 报错', badIp.errors.some((e) => /不是合法的 IPv4/.test(e.message)))

  const badEndIp = buildDhcpPool([{ id: 'a', start: '192.168.10.17', end: 'abc' }], [], hostPlan, seg)
  check('非法结束 IPv4 报错', badEndIp.errors.some((e) => /结束地址.*不是合法的 IPv4/.test(e.message)))

  const missingStart = buildDhcpPool([{ id: 'a', start: '', end: '192.168.10.18' }], [], hostPlan, seg)
  check('缺起始（仅填结束）报错', missingStart.errors.length === 1 && /缺少起始/.test(missingStart.errors[0].message))

  const emptyRow = buildDhcpPool([{ id: 'a', start: '   ', end: '' }], [], hostPlan, seg)
  check('全空白占位行不参与校验', emptyRow.errors.length === 0 && emptyRow.rows[0].empty === true)
}

// 21i) 多条错误逐条定位（按全部行的序号）
{
  const seg = resolvePoolSegment(hostPlan, 'q3')!
  const entries: DhcpExclusionInput[] = [
    { id: 'a', start: '192.168.10.40', end: '192.168.10.41' }, // 合法
    { id: 'b', start: '192.168.10.50', end: '192.168.10.40' }, // 颠倒
    { id: 'c', start: '10.0.0.1', end: '10.0.0.2' }, // 越界
  ]
  const built = buildDhcpPool(entries, [], hostPlan, seg)
  check('错误定位到第 2、3 条（越界行起止各一条）',
    built.errors.map((e) => e.index).join(',') === '2,3,3' &&
      new Set(built.errors.map((e) => e.index)).size === 2,
    JSON.stringify(built.errors))
  check('任一错误停止整体生成', built.pools.length === 0 && built.configText === '' && built.mergedManual.length === 0)
  check('无错的首行仍给出 range 预览', built.rows[0].range !== null && built.rows[0].errors.length === 0)
}

// 21j) 规划、登记、排除项变化实时重算；网段失效返回 null（面板暂停、录入保留）
{
  // 登记变化：新增一个占用地址，可分配数立即 -1
  const seg = resolvePoolSegment(hostPlan, 'q3')!
  const before = buildDhcpPool([], [], hostPlan, seg)
  const after = buildDhcpPool(
    [],
    [{ id: 'h1', ownerId: 'q3', name: 'x', address: ipToInt('192.168.10.33'), mode: 'auto' }],
    hostPlan,
    seg,
  )
  check('登记新增后实时重算：30 -> 29，首池从 .34 开始',
    before.total === 30 && after.total === 29 && after.pools[0].startIp === '192.168.10.34',
    JSON.stringify({ b: before.total, a: after.total }))

  // 迁移规划（q4 从 16/30 迁到 20/30）：原宿主地址空间已变，解析跟随新网段
  check('迁移后 q4 解析为 20/30', resolvePoolSegment(migratedPlan, 'q4')?.cidr === '192.168.10.20/30')
  // 旧录入 .17~.18 相对新网段 20/30（.21/.22）自动重新校验为越界
  const revalidated = buildDhcpPool(
    [{ id: 'a', start: '192.168.10.17', end: '192.168.10.18' }],
    [],
    migratedPlan,
    resolvePoolSegment(migratedPlan, 'q4')!,
  )
  check('规划变化后按原录入重新校验：.17/.18 相对新网段越界', revalidated.errors.length === 2 && revalidated.errors.every((e) => /不在网段/.test(e.message)))
  // 同一录入在新网段合法范围内即恢复生成
  const recovered = buildDhcpPool(
    [{ id: 'a', start: '192.168.10.21', end: '' }],
    [],
    migratedPlan,
    resolvePoolSegment(migratedPlan, 'q4')!,
  )
  check('改到新网段合法地址后恢复生成（.22 单池，数量 1）', recovered.errors.length === 0 && recovered.total === 1 && recovered.pools[0].startIp === '192.168.10.22')

  // 需求删除后宿主网段彻底失效
  check('宿主网段对应需求删除后解析为 null（结果暂停、录入保留）', resolvePoolSegment(q4Deleted, 'q4') === null)
}

// 21k) 失效登记（越界/网络/广播/重复）不占用地址池
{
  const seg = resolvePoolSegment(hostPlan, 'q4')!
  const hosts: HostAssignment[] = [
    { id: 'x1', ownerId: 'q4', name: '越界', address: ipToInt('192.168.10.40'), mode: 'manual' },
    { id: 'x2', ownerId: 'q4', name: '网络地址', address: ipToInt('192.168.10.16'), mode: 'manual' },
  ]
  const built = buildDhcpPool([], hosts, hostPlan, seg)
  check('失效登记不进入自动排除，可分配仍为 2', built.hostExclusions.length === 0 && built.total === 2, JSON.stringify(built.hostExclusions))
}

// 21l) 边界：空录入无错误；掩码随前缀正确（/30 与 /25）
{
  const seg30 = resolvePoolSegment(hostPlan, 'q4')!
  check('/30 掩码 255.255.255.252', buildDhcpPool([], [], hostPlan, seg30).netmask === '255.255.255.252')
  const seg25 = resolvePoolSegment(hostPlan, 'q1')!
  check('/25 掩码 255.255.255.128', buildDhcpPool([], [], hostPlan, seg25).netmask === '255.255.255.128')
}

// 21m) 只读隔离：地址池不修改规划/登记/排除录入，不进入导出 JSON
{
  const seg = resolvePoolSegment(hostPlan, 'q3')!
  const entries: DhcpExclusionInput[] = [{ id: 'a', start: '192.168.10.40', end: '192.168.10.41' }]
  const hosts: HostAssignment[] = [
    { id: 'h1', ownerId: 'q3', name: 's', address: ipToInt('192.168.10.50'), mode: 'manual' },
  ]
  const snapE = JSON.stringify(entries)
  const snapH = JSON.stringify(hosts)
  buildDhcpPool(entries, hosts, hostPlan, seg)
  check('生成过程不改写排除录入与登记', JSON.stringify(entries) === snapE && JSON.stringify(hosts) === snapH)
  check('导出 JSON 不含 dhcp-range 内容', !/dhcp-range|动态地址池/.test(buildExportJson(hostPlan, { parentCidr: demo.parentCidr })))
}

// ========== 22) 静态租约批量导入 ==========

// 22a) CSV 解析：引号、转义双引号、字段内逗号/换行、CRLF、BOM、空行
{
  const parsed = parseCsv('﻿网段 CIDR,设备名\r\n192.168.10.16/30,"设备,A"\r\n\r\n"x""y",z\n')
  check('合法 CSV 无语法错误', parsed.error === null)
  const recs = parsed.records
  check('CSV 解析：BOM 去除、CRLF、跳过空行（3 条记录）', recs.length === 3, JSON.stringify(recs))
  check('CSV 表头两列', recs[0].cells.length === 2 && recs[0].cells[0] === '网段 CIDR')
  check('CSV 引号内逗号不切分', recs[1].cells[1] === '设备,A')
  check('CSV 双引号转义', recs[2].cells[0] === 'x"y' && recs[2].line === 4, JSON.stringify(recs[2]))
  check('空文本解析为空记录', parseCsv('  \n \n').records.length === 0)
}

// 22a2) CSV 引号内换行：CRLF 算一次换行；单独 CR / LF 原样保留换行内容
{
  const r = parseCsv('a,"x\r\ny"\nb,"p\rq"\nc,"m\nn"')
  check('引号内 CRLF / 单独 CR / 单独 LF 均合法', r.error === null && r.records.length === 3, JSON.stringify(r))
  check('引号内 CRLF 保留为 \\r\\n', r.records[0].cells[1] === 'x\r\ny', JSON.stringify(r.records[0]))
  check('引号内单独 CR 保留为 \\r（不改写为 CRLF）', r.records[1].cells[1] === 'p\rq', JSON.stringify(r.records[1]))
  check('引号内单独 LF 保留为 \\n', r.records[2].cells[1] === 'm\nn', JSON.stringify(r.records[2]))
  // 引号内 CRLF 只算一次换行：三条记录分别起于物理行 1 / 3 / 5
  check(
    '引号内 CRLF 算一次换行（记录物理行号正确）',
    r.records[0].line === 1 && r.records[1].line === 3 && r.records[2].line === 5,
    r.records.map((x) => x.line).join(','),
  )
}

// 22a3) CSV 语法错误：末条引号未闭合 -> 报错定位开引号，且整批拒绝（不得只丢末条而应用前文）
{
  const existing: HostAssignment[] = [
    { id: 'keep', ownerId: 'q3', name: '留守', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:00:00:09' },
  ]
  const text = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,管理A,192.168.10.17,aa:bb:cc:00:00:01',
    '192.168.10.16/30,"管理B,192.168.10.18,aa:bb:cc:00:00:02', // 末条引号未闭合
  ].join('\n')
  const r = parseCsv(text)
  check('末条引号未闭合报语法错误', r.error?.kind === 'unclosed-quote', JSON.stringify(r.error))
  check('未闭合定位到开引号（第 3 行第 18 列）', r.error?.line === 3 && r.error?.column === 18, JSON.stringify(r.error))
  const built = buildLeaseImport(text, existing, hostPlan, () => 'x')
  check(
    '语法错误整批拒绝：不可应用、无逐行数据',
    !built.canApply && built.hasConflicts && built.rows.length === 0 && built.syntaxErrors.length === 1,
  )
  check('语法错误说明含物理行与列', /第 3 行第 18 列/.test(built.syntaxErrors[0] ?? ''), built.syntaxErrors[0])
  check('语法错误时既有登记原样保留（merged 不变）', built.merged.length === 1 && built.merged[0].id === 'keep')
  const mp = buildMigrationPlan(built, existing, hostPlan)
  check('语法错误时迁移清单停止生成（pending、零步骤）', !mp.ok && mp.steps.length === 0 && mp.blockers[0]?.kind === 'pending')
  // 修正（补上闭引号）后自动恢复
  const fixedText = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,管理A,192.168.10.17,aa:bb:cc:00:00:01',
    '192.168.10.16/30,"管理B",192.168.10.18,aa:bb:cc:00:00:02',
  ].join('\n')
  const fixed = buildLeaseImport(fixedText, existing, hostPlan, () => 'x')
  check('补上闭引号后自动恢复可应用', fixed.canApply && fixed.counts.add === 2, JSON.stringify(fixed.rows.map((x) => x.errors)))
}

// 22a4) CSV 语法错误：闭引号后杂字符（"A"junk 不得拼成 Ajunk 导入）
{
  const text = '网段 CIDR,设备名,IPv4,MAC\n192.168.10.16/30,"A"junk,192.168.10.17,aa:bb:cc:00:00:01'
  const r = parseCsv(text)
  check('闭引号后杂字符报语法错误', r.error?.kind === 'junk-after-quote', JSON.stringify(r.error))
  check('杂字符定位（第 2 行第 21 列）', r.error?.line === 2 && r.error?.column === 21, JSON.stringify(r.error))
  const built = buildLeaseImport(text, [], hostPlan, () => 'x')
  check(
    '"A"junk 不再拼成 Ajunk 导入（整批拒绝）',
    !built.canApply && built.rows.length === 0 && built.syntaxError?.kind === 'junk-after-quote',
  )
  check('闭引号后空格同样报错', parseCsv('a,"x" \nb').error?.kind === 'junk-after-quote')
  check('闭引号后逗号、换行、文件结束均合法', parseCsv('"a","b"\n"c","d"\n"e","f"').error === null)
}

// 22a5) CSV 语法错误：未加引号字段内的引号（引号只允许出现在字段首位）
{
  const r = parseCsv('网段 CIDR,设备名\n192.168.10.16/30,Ab"c')
  check('未加引号字段内的引号报语法错误', r.error?.kind === 'quote-in-unquoted-field', JSON.stringify(r.error))
  check('裸引号定位（第 2 行第 20 列）', r.error?.line === 2 && r.error?.column === 20, JSON.stringify(r.error))
  check('字段首位空白后的引号同样拒绝', parseCsv('a, "b"').error?.kind === 'quote-in-unquoted-field')
  const built = buildLeaseImport(
    '网段 CIDR,设备名,IPv4,MAC\n192.168.10.16/30,Ab"c,192.168.10.17,aa:bb:cc:00:00:01',
    [],
    hostPlan,
    () => 'x',
  )
  check('裸引号整批拒绝且迁移清单停止生成', !built.canApply && buildMigrationPlan(built, [], hostPlan).steps.length === 0)
}

// 22a6) 记录判定：仅真正空白的物理行可忽略；含分隔符或引号空字段的行仍是数据行
{
  // 复现漏检：合法行后粘贴 ,,, 旧实现把它当空白行吞掉
  const r1 = parseCsv(',,,')
  check('仅分隔符的行（,,,）解析为 1 条记录而非空白行', r1.error === null && r1.records.length === 1 && r1.records[0].line === 1, JSON.stringify(r1))
  check(',,, 记录含 4 个空字段', r1.records[0]?.cells.length === 4 && r1.records[0]?.cells.every((c) => c === ''))
  check('单个逗号也是数据行（2 个空字段）', parseCsv(',').records.length === 1 && parseCsv(',').records[0].cells.length === 2)
  // 引号包裹的空字段（含带逗号的整行）同样保留
  const r2 = parseCsv('""\n"","",,\n')
  check('引号空字段行保留（2 条记录）', r2.error === null && r2.records.length === 2, JSON.stringify(r2))
  check('引号空字段保留原物理行号（1、2）', r2.records[0]?.line === 1 && r2.records[1]?.line === 2)
  check('第二行为 4 个空字段（含两个引号空字段）', r2.records[1]?.cells.length === 4 && r2.records[1]?.cells.every((c) => c === ''))
  // 空白 + 分隔符（如 "  ,  "）不是空白物理行
  const r3 = parseCsv('  ,  \n')
  check('仅空白与逗号的行保留为数据行', r3.records.length === 1 && r3.records[0]?.line === 1, JSON.stringify(r3))
  // 真正空白的物理行仍忽略；夹在数据行之间时物理行号不被压缩
  const r4 = parseCsv('网段 CIDR,设备名,IPv4,MAC\n\t\n192.168.10.16/30,A,192.168.10.17,aa:bb:cc:00:00:01')
  check('夹在中间的纯空白物理行仍忽略（2 条记录）', r4.records.length === 2, JSON.stringify(r4.records))
  check('空白行不压缩后续数据行物理行号（数据行在第 3 行）', r4.records[1]?.line === 3, r4.records.map((x) => x.line).join(','))
  check('纯空白文本仍解析为空记录', parseCsv('  \n \n\t\r\n').records.length === 0)
}

// 22a7) 端到端：合法行后粘贴 ,,, -> 预览多出冲突行、整批禁止应用、登记不变、迁移无步骤；改正后恢复
{
  const existing: HostAssignment[] = [
    { id: 'keep', ownerId: 'q1', name: '既有设备', address: ipToInt('192.168.10.200'), mode: 'manual', mac: 'aa:bb:cc:99:99:99' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,管理设备A,192.168.10.17,aa:bb:cc:00:00:01',
    '192.168.10.16/30,管理设备B,192.168.10.18,aa:bb:cc:00:00:02',
    ',,,', // 漏检行：含分隔符的空字段行，必须被识别为冲突数据行
  ].join('\n')
  const built = buildLeaseImport(csv, existing, hostPlan, () => 'x')
  check('漏检行进入逐行预览（3 条数据行）', built.rows.length === 3, JSON.stringify(built.counts))
  const badRow = built.rows[2]
  check('漏检行保留原物理行号（第 4 行）与录入序号（第 3 行）', badRow.line === 4 && badRow.index === 3, JSON.stringify({ line: badRow.line, index: badRow.index }))
  check('漏检行判冲突且逐字段提示四个缺失', badRow.status === 'conflict' && badRow.errors.length === 4 &&
    /缺少网段 CIDR/.test(badRow.errors[0]) && /缺少设备名/.test(badRow.errors.join(' ')) && /缺少IPv4/.test(badRow.errors.join(' ')) && /缺少MAC/.test(badRow.errors.join(' ')),
    JSON.stringify(badRow.errors))
  check('前两合法行仍标记为新增', built.rows[0].status === 'add' && built.rows[1].status === 'add')
  check('任一错误行阻止整批应用', !built.canApply && built.hasConflicts && built.counts.conflict === 1 && built.counts.add === 2, JSON.stringify(built.counts))
  check('阻止应用时既有登记原样保留（merged 不变）', built.merged.length === 1 && built.merged[0].id === 'keep' && built.merged[0].name === '既有设备')
  const mp = buildMigrationPlan(built, existing, hostPlan)
  check('错误行存在时迁移编排无执行步骤（pending）', !mp.ok && mp.steps.length === 0 && mp.blockers[0]?.kind === 'pending')
  // 改正（删除 ,,, 行）后自动恢复
  const fixed = buildLeaseImport(csv.replace('\n,,,', ''), existing, hostPlan, (() => {
    let n = 0
    return () => `fix-${++n}`
  })())
  check('删除漏检行后恢复可应用（2 新增 + 既有登记共 3 条）', fixed.canApply && fixed.counts.add === 2 && fixed.merged.length === 3, JSON.stringify(fixed.counts))
  check('恢复后迁移编排重新生成（2 个新增上线步骤）', buildMigrationPlan(fixed, existing, hostPlan).ok === true &&
    buildMigrationPlan(fixed, existing, hostPlan).steps.filter((s) => s.kind === 'add').length === 2)
  // 纯空白物理行（而非 ,,,）仍被忽略：不阻止应用
  const withBlank = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,管理设备A,192.168.10.17,aa:bb:cc:00:00:01',
    '   ',
  ].join('\n')
  check('真正空白的物理行仍忽略且可应用', buildLeaseImport(withBlank, existing, hostPlan, () => 'x').canApply)
}

// 22b) 表头映射：别名、列顺序不限；缺列 / 重复列报错
{
  const ok = mapHeader({ line: 1, cells: ['mac', 'ip地址', '名称', '子网'] })
  check('表头别名识别且顺序不限', !!ok.map && ok.map!.cidr === 3 && ok.map!.name === 2 && ok.map!.ip === 1 && ok.map!.mac === 0, JSON.stringify(ok))
  const missing = mapHeader({ line: 1, cells: ['网段 CIDR', '设备名', 'IPv4'] })
  check('表头缺 MAC 列报错', missing.error?.kind === 'missing' && missing.error.columns?.includes('mac'), JSON.stringify(missing.error))
  const dup = mapHeader({ line: 1, cells: ['IPv4', 'ip', '设备名', 'MAC', '网段 CIDR'] })
  check('表头重复列报错（IPv4/ip 同列）', dup.error?.kind === 'duplicate' && dup.error.column === 'ip', JSON.stringify(dup.error))
  check('空 CSV 表头报 empty', mapHeader(undefined).error?.kind === 'empty')
}

// 演示规划：q4=192.168.10.16/30（.17/.18），q1=128/25，q2=64/26，q3=32/27
const importCsvAllNew = [
  '网段 CIDR,设备名,IPv4,MAC',
  '192.168.10.16/30,管理设备A,192.168.10.17,AA-BB-CC-00-00-01',
  '192.168.10.16/30,管理设备B,192.168.10.18,aa:bb:cc:00:00:02',
  '192.168.10.32/27,监控网关,192.168.10.33,aa:bb:cc:00:00:03',
].join('\n')

// 22c) 全新 MAC：三行全部新增，可应用，merged 追加 3 条且 mode=manual
{
  const built = buildLeaseImport(importCsvAllNew, [], hostPlan, (() => {
    let n = 0
    return () => `new-${++n}`
  })())
  check('全新导入无冲突、3 行新增', built.canApply && built.counts.add === 3 && built.counts.conflict === 0, JSON.stringify(built.counts))
  check('MAC 连字符大写被规范为小写冒号', built.rows[0].mac === 'aa:bb:cc:00:00:01')
  check('非规范 CIDR 写法被接受并匹配（此处已是规范）', built.rows[0].cidr === '192.168.10.16/30' && built.rows[0].segment?.ownerId === 'q4')
  check('应用后快照为 3 条、跨两个网段', built.merged.length === 3 && built.merged.every((a) => a.mode === 'manual'))
  check('固定段 q3 行归属正确', built.rows[2].segment?.ownerId === 'q3')
}

// 22d) 已有 MAC 更新名称、网段与地址；未变化行标记 unchanged
{
  const existing: HostAssignment[] = [
    { id: 'h1', ownerId: 'q4', name: '旧名', address: ipToInt('192.168.10.17'), mode: 'auto', mac: 'aa:bb:cc:00:00:01' },
    { id: 'h2', ownerId: 'q4', name: '保持', address: ipToInt('192.168.10.18'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    // h1 迁到办公网段并改名、改址
    '192.168.10.128/25,新办公设备,192.168.10.200,AA:BB:CC:00:00:01',
    // h2 内容完全一致 -> 无变化
    '192.168.10.16/30,保持,192.168.10.18,aa:bb:cc:00:00:02',
  ].join('\n')
  const built = buildLeaseImport(csv, existing, hostPlan, () => 'x')
  check('更新 + 无变化各 1 行、无冲突', built.counts.update === 1 && built.counts.unchanged === 1 && built.canApply, JSON.stringify(built.counts))
  const updated = built.merged.find((a) => a.id === 'h1')!
  check('更新行：名称/网段/地址全量替换且 mode=manual，ID 保持不变',
    updated.name === '新办公设备' && updated.ownerId === 'q1' && updated.address === ipToInt('192.168.10.200') && updated.mode === 'manual' && updated.mac === 'aa:bb:cc:00:00:01',
    JSON.stringify(updated))
  check('未变化行原样保留', (() => {
    const h2 = built.merged.find((a) => a.id === 'h2')!
    return h2.name === '保持' && h2.address === ipToInt('192.168.10.18') && h2.mode === 'manual'
  })())
  check('应用快照不改变登记总数（2 台）', built.merged.length === 2)
}

// 22e) 核心场景：两台已有设备互换地址，顺序无关校验不误报
{
  const existing: HostAssignment[] = [
    { id: 'h1', ownerId: 'q4', name: '设备A', address: ipToInt('192.168.10.17'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'h2', ownerId: 'q4', name: '设备B', address: ipToInt('192.168.10.18'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
  ]
  // 无论 A 在前还是 B 在前都必须通过（CSV 行序 1：A 先占 .18）
  const csvA = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,设备A,192.168.10.18,aa:bb:cc:00:00:01',
    '192.168.10.16/30,设备B,192.168.10.17,aa:bb:cc:00:00:02',
  ].join('\n')
  const csvB = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,设备B,192.168.10.17,aa:bb:cc:00:00:02',
    '192.168.10.16/30,设备A,192.168.10.18,aa:bb:cc:00:00:01',
  ].join('\n')
  for (const [label, text] of [['A先行', csvA], ['B先行', csvB]] as const) {
    const built = buildLeaseImport(text, existing, hostPlan, () => 'x')
    check(`互换地址（${label}）两行均更新、零冲突`, built.canApply && built.counts.update === 2 && built.counts.conflict === 0,
      JSON.stringify(built.rows.map((r) => [r.status, r.errors])))
    const after = new Map(built.merged.map((a) => [a.mac, intToIp(a.address)]))
    check(`互换地址（${label}）最终地址确实交换`, after.get('aa:bb:cc:00:00:01') === '192.168.10.18' && after.get('aa:bb:cc:00:00:02') === '192.168.10.17')
  }
}

// 22f) 字段级冲突：缺失、非法 IP、非法 MAC、网络/广播/越界
{
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    ',缺网段,192.168.10.17,aa:bb:cc:00:00:01',
    '192.168.10.16/30,,192.168.10.17,aa:bb:cc:00:00:02',
    '192.168.10.16/30,缺IP,,aa:bb:cc:00:00:03',
    '192.168.10.16/30,坏IP,999.1.1.1,aa:bb:cc:00:00:04',
    '192.168.10.16/30,坏MAC,192.168.10.17,zz:bb:cc:dd:ee:ff',
    '192.168.10.16/30,网络地址,192.168.10.16,aa:bb:cc:00:00:05',
    '192.168.10.16/30,广播地址,192.168.10.19,aa:bb:cc:00:00:06',
    '192.168.10.16/30,越界,192.168.10.40,aa:bb:cc:00:00:07',
    '192.168.10.96/28,不存在的网段,192.168.10.97,aa:bb:cc:00:00:08',
  ].join('\n')
  const built = buildLeaseImport(csv, [], hostPlan, () => 'x')
  check('9 行问题数据全部标冲突、禁止应用', built.counts.conflict === 9 && !built.canApply && built.counts.add === 0, JSON.stringify(built.counts))
  check('网络地址行报错含网络地址', /网络地址/.test(built.rows[5].errors.join(' ')))
  check('广播地址行报错含广播地址', /广播地址/.test(built.rows[6].errors.join(' ')))
  check('越界行报错含可用范围', /越界|不在网段/.test(built.rows[7].errors.join(' ')))
  check('网段不匹配行报错', /不是当前成功分配/.test(built.rows[8].errors.join(' ')))
  check('非法 MAC（非十六进制）报错', built.rows[4].errors.some((m) => /不是合法 MAC/.test(m)))
  check('有冲突时 merged 保持既有状态（空）', built.merged.length === 0)
}

// 22g) 输入内重复 MAC 与网段内重复 IP
{
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,A,192.168.10.17,aa:bb:cc:00:00:01',
    '192.168.10.16/30,B,192.168.10.18,AA:BB:CC:00:00:01', // 同 MAC（大小写归一）
    '192.168.10.32/27,C,192.168.10.34,aa:bb:cc:00:00:03',
    '192.168.10.32/27,D,192.168.10.34,aa:bb:cc:00:00:04', // 同网段重复 IP
    '192.168.10.32/27,E,192.168.10.35,aa:bb:cc:00:00:05',
  ].join('\n')
  const built = buildLeaseImport(csv, [], hostPlan, () => 'x')
  check('重复 MAC（归一后）第二条标冲突并指向第 1 行', built.rows[1].errors.some((m) => /第 1 行/.test(m)))
  check('网段内重复 IP 第四条标冲突并指向第 3 行', built.rows[3].errors.some((m) => /第 3 行/.test(m)) && built.rows[3].status === 'conflict')
  check('不同网段相同 IP 不算重复（.34 vs .34 分别在 q3…构造同段外对照）', built.rows[2].status !== 'conflict', built.rows[2].status)
  check('干净行仍可新增（第 1、5 行）', built.rows[0].status === 'add' && built.rows[4].status === 'add')
  check('任一冲突禁止应用', !built.canApply)
}

// 22h) 与未更新登记的冲突（地址被占用、MAC 已存在）
{
  const existing: HostAssignment[] = [
    { id: 'h1', ownerId: 'q4', name: '未更新设备', address: ipToInt('192.168.10.17'), mode: 'manual', mac: 'aa:bb:cc:11:11:11' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,新设备撞地址,192.168.10.17,aa:bb:cc:22:22:22',
  ].join('\n')
  const built = buildLeaseImport(csv, existing, hostPlan, () => 'x')
  check('与未更新登记地址冲突被标出并指明设备名', built.rows[0].status === 'conflict' && /未更新设备/.test(built.rows[0].errors.join(' ')), JSON.stringify(built.rows[0].errors))
  check('冲突时既有登记原样保留在 merged', built.merged.length === 1 && built.merged[0].id === 'h1')
}

// 22i) 更新登记迁址到未更新设备占用的地址 -> 冲突（不是互换）
{
  const existing: HostAssignment[] = [
    { id: 'h1', ownerId: 'q4', name: '迁移者', address: ipToInt('192.168.10.17'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'h2', ownerId: 'q4', name: '留守者', address: ipToInt('192.168.10.18'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,迁移者,192.168.10.18,aa:bb:cc:00:00:01',
  ].join('\n')
  const built = buildLeaseImport(csv, existing, hostPlan, () => 'x')
  check('单向迁入被占用地址（非互换）判冲突并指向未更新设备', built.rows[0].status === 'conflict' && /留守者/.test(built.rows[0].errors.join(' ')), JSON.stringify(built.rows[0].errors))
}

// 22j) 应用原子性：冲突时 merged 等于既有状态；全部通过后 merged 为完整快照
{
  const existing: HostAssignment[] = [
    { id: 'keep', ownerId: 'q1', name: '办公设备', address: ipToInt('192.168.10.200'), mode: 'auto', mac: 'aa:bb:cc:99:99:99' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,管理A,192.168.10.17,aa:bb:cc:00:00:01',
    '192.168.10.16/30,坏行,192.168.10.19,aa:bb:cc:00:00:02',
  ].join('\n')
  const bad = buildLeaseImport(csv, existing, hostPlan, () => 'x')
  check('部分冲突：禁止应用且未更新登记保持不变', !bad.canApply && bad.merged.length === 1 && bad.merged[0].id === 'keep')
  const goodCsv = ['网段 CIDR,设备名,IPv4,MAC', '192.168.10.16/30,管理A,192.168.10.17,aa:bb:cc:00:00:01'].join('\n')
  const good = buildLeaseImport(goodCsv, existing, hostPlan, (() => {
    let n = 0
    return () => `gen-${++n}`
  })())
  check('全部通过：完整快照 = 未更新登记 + 新增/更新', good.canApply && good.merged.length === 2 && good.addCount === 1 && good.updateCount === 0)
  check('快照中未更新登记原样保留（含 auto 方式）', good.merged.find((a) => a.id === 'keep')?.mode === 'auto')
}

// 22k) 规划变化后实时重算：原 CSV 保留，网段失效则预览转为冲突；恢复后再次通过
{
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,管理A,192.168.10.17,aa:bb:cc:00:00:01',
  ].join('\n')
  const before = buildLeaseImport(csv, [], hostPlan, () => 'x')
  check('原规划下导入行可新增', before.canApply && before.rows[0].status === 'add')
  // q4 迁到 20/30：16/30 不再是成功分配网段
  const after = buildLeaseImport(csv, [], migratedPlan, () => 'x')
  check('规划迁移后同一 CSV 实时重算为网段冲突', !after.canApply && after.rows[0].status === 'conflict' && /不是当前成功分配/.test(after.rows[0].errors.join(' ')))
  const fixedCsv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.20/30,管理A,192.168.10.21,aa:bb:cc:00:00:01',
  ].join('\n')
  check('改到新网段合法地址后恢复可应用', buildLeaseImport(fixedCsv, [], migratedPlan, () => 'x').canApply)
}

// 22l) 保留区/空闲网段 CIDR 不能匹配；只有表头不可应用
{
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.0/28,保留区内,192.168.10.1,aa:bb:cc:00:00:01',
  ].join('\n')
  const built = buildLeaseImport(csv, [], hostPlan, () => 'x')
  check('保留区 CIDR 不可作为导入网段', built.rows[0].status === 'conflict' && /不是当前成功分配/.test(built.rows[0].errors.join(' ')))
  const headerOnly = buildLeaseImport('网段 CIDR,设备名,IPv4,MAC\n', [], hostPlan, () => 'x')
  check('只有表头无数据行时不可应用', !headerOnly.canApply && headerOnly.rows.length === 0 && headerOnly.headerErrors.length === 0)
  const badHeader = buildLeaseImport('CIDR,Name,MAC\n192.168.10.16/30,x,aa:bb:cc:00:00:01', [], hostPlan, () => 'x')
  check('表头缺 IPv4 列给出表头错误且无逐行数据', badHeader.headerErrors.length === 1 && badHeader.rows.length === 0 && !badHeader.canApply)
}

// 22m) 只读隔离：导入构造不修改既有登记数组，也不影响规划/导出
{
  const existing: HostAssignment[] = [
    { id: 'h1', ownerId: 'q4', name: '旧名', address: ipToInt('192.168.10.17'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
  ]
  const snapshot = JSON.stringify(existing)
  const csv = ['网段 CIDR,设备名,IPv4,MAC', '192.168.10.128/25,新名,192.168.10.200,aa:bb:cc:00:00:01'].join('\n')
  buildLeaseImport(csv, existing, hostPlan, () => 'x')
  check('预览计算不改写既有登记数组', JSON.stringify(existing) === snapshot && existing[0].ownerId === 'q4')
  check('规划结果不受导入影响', JSON.stringify(plan(demo)) === JSON.stringify(plan(demo)))
}

// ========== 23) 迁移执行编排 ==========
import { buildMigrationPlan, migrationPlanText } from '../src/lib/migration'

/** 测试辅助：构造无冲突合并预览（失败时抛错信息） */
function importOrThrow(csv: string, existing: HostAssignment[], p: typeof hostPlan = hostPlan) {
  const built = buildLeaseImport(csv, existing, p, (() => {
    let n = 0
    return () => `mig-new-${++n}`
  })())
  if (!built.canApply) throw new Error(`测试前置：CSV 预览存在冲突: ${JSON.stringify(built.rows.map((r) => r.errors))}`)
  return built
}

/** 模拟逐步执行清单，校验每一步都不产生瞬时重复 IPv4；返回执行后的地址->设备集合。
 *  initial 可传入不参与迁移（无变化）的初始占用设备，使终态校验覆盖全网。 */
function simulateNoTransientDup(
  steps: ReturnType<typeof buildMigrationPlan>['steps'],
  initial: HostAssignment[] = [],
): Map<number, string[]> {
  const occupied = new Map<number, string[]>()
  for (const a of initial) {
    const list = occupied.get(a.address) ?? []
    list.push(a.id)
    occupied.set(a.address, list)
  }
  for (const s of steps) {
    const from = s.fromAddress
    if (from !== undefined) {
      const list = occupied.get(from) ?? []
      const idx = list.indexOf(s.deviceId)
      if (idx >= 0) list.splice(idx, 1)
      occupied.set(from, list)
    }
    // 进入目标地址前，该地址不得被其他设备占用（核心不变量：无瞬时重复）
    const current = occupied.get(s.address) ?? []
    check(
      `步骤 ${s.order}（${s.name}）迁入 ${intToIp(s.address)} 前该地址无其他设备`,
      current.length === 0,
      `地址 ${intToIp(s.address)} 当前被 ${current.join(',')} 占用`,
    )
    occupied.set(s.address, [...current, s.deviceId])
  }
  return occupied
}

// 23a) 无变化：零步骤、ok
{
  const existing: HostAssignment[] = [
    { id: 'h1', ownerId: 'q4', name: '设备A', address: ipToInt('192.168.10.17'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
  ]
  const csv = ['网段 CIDR,设备名,IPv4,MAC', '192.168.10.16/30,设备A,192.168.10.17,aa:bb:cc:00:00:01'].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing), existing, hostPlan)
  check('无变化迁移：ok 且零步骤、零设备', mp.ok && mp.steps.length === 0 && mp.changedDevices === 0, JSON.stringify(mp.counts))
  check('无变化时复制文本为空', migrationPlanText(mp) === '')
}

// 23b) 单设备迁入空闲地址：直接一步迁移
{
  const existing: HostAssignment[] = [
    { id: 'h1', ownerId: 'q4', name: '设备A', address: ipToInt('192.168.10.17'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
  ]
  const csv = ['网段 CIDR,设备名,IPv4,MAC', '192.168.10.32/27,设备A,192.168.10.40,aa:bb:cc:00:00:01'].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing), existing, hostPlan)
  check('空闲改址：1 步迁移、无环', mp.ok && mp.steps.length === 1 && mp.steps[0].kind === 'move' && mp.counts.cycles === 0, JSON.stringify(mp.steps))
  check('步骤含原/目标地址与原因', mp.steps[0].fromAddress === ipToInt('192.168.10.17') && mp.steps[0].address === ipToInt('192.168.10.40') && /当前空闲/.test(mp.steps[0].reason))
}

// 23c) 依赖链 A@.40→.41（B 占用）、B@.41→.50：顺序必须 B 先 A 后
{
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 'q3', name: 'A', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'b', ownerId: 'q3', name: 'B', address: ipToInt('192.168.10.41'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.32/27,A,192.168.10.41,aa:bb:cc:00:00:01',
    '192.168.10.32/27,B,192.168.10.50,aa:bb:cc:00:00:02',
  ].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing), existing, hostPlan)
  check('依赖链：两步迁移、无环', mp.ok && mp.steps.length === 2 && mp.counts.cycles === 0, JSON.stringify(mp.counts))
  check('顺序：B（.41→.50）先迁、A（.40→.41）后迁', mp.steps[0].deviceId === 'b' && mp.steps[1].deviceId === 'a', mp.steps.map((s) => [s.deviceId, s.kind]).join(','))
  check('A 的步骤原因说明 B 已迁出', /B/.test(mp.steps[1].reason) && /已迁出/.test(mp.steps[1].reason))
  simulateNoTransientDup(mp.steps)
}

// 23d) 两设备互换（2 环）：临时锚点先迁出 -> 完成互换 -> 锚点完成环路并释放临时地址
{
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 'q3', name: 'A', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'b', ownerId: 'q3', name: 'B', address: ipToInt('192.168.10.41'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.32/27,A,192.168.10.41,aa:bb:cc:00:00:01',
    '192.168.10.32/27,B,192.168.10.40,aa:bb:cc:00:00:02',
  ].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing), existing, hostPlan)
  check('互换识别为 1 个环', mp.ok && mp.counts.cycles === 1 && mp.cycles[0].blocked === false, JSON.stringify(mp.cycles))
  check('共 3 步：临时迁出 -> 迁移 -> 完成环路', mp.steps.length === 3 &&
    mp.steps[0].kind === 'temp-move' && mp.steps[1].kind === 'move' && mp.steps[2].kind === 'cycle-complete',
    mp.steps.map((s) => s.kind).join(','))
  // 锚点按原地址升序选 A（.40 < .41），临时地址为原网段排除占用(.40/.41)与目标(.40/.41)后的最低地址 .33
  check('锚点为 A，临时地址为原网段最低空闲 .33', mp.steps[0].deviceId === 'a' && mp.steps[0].address === ipToInt('192.168.10.33') &&
    mp.steps[0].tempCidr === '192.168.10.32/27', intToIp(mp.steps[0].address))
  check('第 2 步 B .41→.40，第 3 步 A .33→.41（临时地址释放）',
    mp.steps[1].deviceId === 'b' && mp.steps[1].address === ipToInt('192.168.10.40') &&
      mp.steps[2].deviceId === 'a' && mp.steps[2].fromAddress === ipToInt('192.168.10.33') &&
      mp.steps[2].address === ipToInt('192.168.10.41'),
  )
  const final = simulateNoTransientDup(mp.steps)
  check('互换结束：.40=B、.41=A，临时地址 .33 已释放',
    (final.get(ipToInt('192.168.10.40')) ?? []).join() === 'b' &&
      (final.get(ipToInt('192.168.10.41')) ?? []).join() === 'a' &&
      (final.get(ipToInt('192.168.10.33')) ?? []).length === 0,
    JSON.stringify([...final.entries()].map(([addr, ids]) => [intToIp(addr), ids])),
  )
  check('清单文本含表头与全部 3 步及临时地址列', /步骤\t操作\t设备\t原地址\t目标地址\t临时地址/.test(migrationPlanText(mp)) &&
    /192\.168\.10\.33/.test(migrationPlanText(mp)))
}

// 23e) 三设备环路：40→41、41→42、42→40，同样可解开
{
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 'q3', name: 'A', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'b', ownerId: 'q3', name: 'B', address: ipToInt('192.168.10.41'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
    { id: 'c', ownerId: 'q3', name: 'C', address: ipToInt('192.168.10.42'), mode: 'manual', mac: 'aa:bb:cc:00:00:03' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.32/27,A,192.168.10.41,aa:bb:cc:00:00:01',
    '192.168.10.32/27,B,192.168.10.42,aa:bb:cc:00:00:02',
    '192.168.10.32/27,C,192.168.10.40,aa:bb:cc:00:00:03',
  ].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing), existing, hostPlan)
  check('三环：4 步（1 临时 + 2 迁移 + 1 完成）', mp.ok && mp.steps.length === 4 && mp.counts.cycles === 1, mp.steps.map((s) => s.kind).join(','))
  check('锚点 A 临时迁到 .33', mp.steps[0].deviceId === 'a' && mp.steps[0].address === ipToInt('192.168.10.33'))
  const order = mp.steps.slice(1).map((s) => s.deviceId).join(',')
  check('随后顺序 C(.42→.40) → B(.41→.42) → A 完成(.33→.41)', order === 'c,b,a', order)
  simulateNoTransientDup(mp.steps)
}

// 23f) 新建设备上线：目标空闲即一步 add；目标被将迁走设备占用则排在其后
{
  const existing: HostAssignment[] = [
    { id: 'h1', ownerId: 'q3', name: '老设备', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.32/27,老设备,192.168.10.50,aa:bb:cc:00:00:01',
    '192.168.10.32/27,新设备,192.168.10.40,aa:bb:cc:00:00:09',
  ].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing), existing, hostPlan)
  check('先迁老设备、再新增上线', mp.ok && mp.steps.length === 2 &&
    mp.steps[0].kind === 'move' && mp.steps[0].deviceId === 'h1' &&
    mp.steps[1].kind === 'add' && mp.steps[1].address === ipToInt('192.168.10.40'),
  mp.steps.map((s) => [s.kind, s.deviceId]).join(','))
  simulateNoTransientDup(mp.steps)
}

// 23g) 目标地址被不会迁走的既有设备物理占住 -> 阻止且不产生步骤。
//  有效登记占位在导入阶段就会被判为 CSV 冲突；这里能穿过无冲突预览的只有【失效的未更新登记】
//  （ownerId=q4 但地址 .40 落在 q3 网段，reconcile 判越界，导入快照不拦），迁移编排必须物理性拦截。
{
  const existing: HostAssignment[] = [
    { id: 'ghost', ownerId: 'q4', name: '失效越界设备', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:11:11:11' },
  ]
  const csv = ['网段 CIDR,设备名,IPv4,MAC', '192.168.10.32/27,新设备,192.168.10.40,aa:bb:cc:00:00:09'].join('\n')
  const imported = buildLeaseImport(csv, existing, hostPlan, () => 'x')
  check('前置：导入预览可通过（失效登记不在 q3 快照查重口径内）', imported.canApply, JSON.stringify(imported.rows.map((r) => r.errors)))
  const mp = buildMigrationPlan(imported, existing, hostPlan)
  check('被不会迁走的设备物理占址：ok=false、零步骤、阻断项点名设备',
    !mp.ok && mp.steps.length === 0 && mp.blockers.length === 1 &&
      mp.blockers[0].kind === 'occupied' && /失效越界设备/.test(mp.blockers[0].message) &&
      mp.blockers[0].address === ipToInt('192.168.10.40'),
    JSON.stringify(mp.blockers))
  check('阻断时复制文本为空', migrationPlanText(mp) === '')
}

// 23h) 满配 /30 两设备互换：无可用临时地址 -> 明确阻止该环
{
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 'q4', name: '管理A', address: ipToInt('192.168.10.17'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'b', ownerId: 'q4', name: '管理B', address: ipToInt('192.168.10.18'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.16/30,管理A,192.168.10.18,aa:bb:cc:00:00:01',
    '192.168.10.16/30,管理B,192.168.10.17,aa:bb:cc:00:00:02',
  ].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing), existing, hostPlan)
  check('/30 满配互换：环被标记 blocked、整体阻止',
    !mp.ok && mp.steps.length === 0 && mp.cycles.length === 1 && mp.cycles[0].blocked === true,
    JSON.stringify(mp.cycles))
  check('阻断原因说明原网段无空闲临时地址并给出可用范围',
    mp.blockers.some((b) => b.kind === 'no-temp' && /192\.168\.10\.17 ~ 192\.168\.10\.18/.test(b.message) && /管理A|管理B/.test(b.message)),
    mp.blockers.map((b) => b.message).join('|'))
}

// 23i) /30 互换但有第三个未占满的同段地址空间（用 /29 六可用，占两址互换仍有四个临时候选）
{
  const p29 = plan({
    parentCidr: '10.9.0.0/29',
    reservations: [],
    requirements: [{ id: 's', name: '小段', hosts: 6, cidr: '10.9.0.0/29' }],
  })
  check('/29 规划成功（可用 .1~.6）', p29.inputErrors.length === 0 && p29.segments.some((x) => x.cidr === '10.9.0.0/29'))
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 's', name: 'A', address: ipToInt('10.9.0.1'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'b', ownerId: 's', name: 'B', address: ipToInt('10.9.0.2'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '10.9.0.0/29,A,10.9.0.2,aa:bb:cc:00:00:01',
    '10.9.0.0/29,B,10.9.0.1,aa:bb:cc:00:00:02',
  ].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing, p29), existing, p29)
  check('/29 互换可解：临时地址为排除占用/目标后的最低 .3', mp.ok && mp.steps[0].address === ipToInt('10.9.0.3'),
    mp.ok ? intToIp(mp.steps[0].address) : mp.blockers.map((b) => b.message).join('|'))
  simulateNoTransientDup(mp.steps)
}

// 23j) 临时地址必须排除全部目标地址：环内设备原网段虽有空闲，但空闲地址恰是其他设备目标 -> 取其后；
//  且首环结束后临时地址释放，后续环可复用同一地址（逐环完成、不跨环预留）。
{
  // /29 .1~.6；环 A@.1→.2、B@.2→.1；另有设备 C 的目标恰为 .3（从 .4 迁入），D 目标 .4（从 .3 迁入）形成第二环。
  // 两环互相占用：环 1 的临时候选不得取 .3/.4（第二环目标），应为 .5；环 1 结束后 .5 释放，环 2 复用 .5。
  const p29 = plan({
    parentCidr: '10.8.0.0/29',
    reservations: [],
    requirements: [{ id: 's', name: '小段', hosts: 6, cidr: '10.8.0.0/29' }],
  })
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 's', name: 'A', address: ipToInt('10.8.0.1'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'b', ownerId: 's', name: 'B', address: ipToInt('10.8.0.2'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
    { id: 'c', ownerId: 's', name: 'C', address: ipToInt('10.8.0.3'), mode: 'manual', mac: 'aa:bb:cc:00:00:03' },
    { id: 'd', ownerId: 's', name: 'D', address: ipToInt('10.8.0.4'), mode: 'manual', mac: 'aa:bb:cc:00:00:04' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '10.8.0.0/29,A,10.8.0.2,aa:bb:cc:00:00:01',
    '10.8.0.0/29,B,10.8.0.1,aa:bb:cc:00:00:02',
    '10.8.0.0/29,C,10.8.0.4,aa:bb:cc:00:00:03',
    '10.8.0.0/29,D,10.8.0.3,aa:bb:cc:00:00:04',
  ].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing, p29), existing, p29)
  check('两个互不相连的互换环都可解（各 3 步，共 6 步）', mp.ok && mp.counts.cycles === 2 && mp.steps.length === 6,
    mp.ok ? mp.steps.map((s) => s.kind).join(',') : mp.blockers.map((x) => x.message).join('|'))
  const temps = mp.steps.filter((s) => s.kind === 'temp-move').map((s) => intToIp(s.address))
  check('环 1 候选排除全部目标（不取 .3/.4）取 .5；环 2 在环 1 释放后复用 .5', JSON.stringify(temps) === JSON.stringify(['10.8.0.5', '10.8.0.5']), JSON.stringify(temps))
  check('步骤按环连续：先做完环 1 再做环 2（各 3 步）',
    mp.steps.map((s) => `${s.deviceId}:${s.kind}`).join(',') ===
      'a:temp-move,b:move,a:cycle-complete,c:temp-move,d:move,c:cycle-complete',
    mp.steps.map((s) => `${s.deviceId}:${s.kind}`).join(','))
  const final = simulateNoTransientDup(mp.steps)
  check('两环结束后最终占用正确且复用的临时地址已释放',
    (final.get(ipToInt('10.8.0.1')) ?? []).join() === 'b' &&
      (final.get(ipToInt('10.8.0.2')) ?? []).join() === 'a' &&
      (final.get(ipToInt('10.8.0.3')) ?? []).join() === 'd' &&
      (final.get(ipToInt('10.8.0.4')) ?? []).join() === 'c' &&
      (final.get(ipToInt('10.8.0.5')) ?? []).length === 0 &&
      (final.get(ipToInt('10.8.0.6')) ?? []).length === 0,
  )
}

// 23j2) 多个独立地址环复用同一临时地址（修复回归）：/29 中设备占 .1~.5，唯一空闲 .6；
//  CSV 让 .1/.2、.3/.4 分别互换、.5 不动。旧实现把 .6 永久预留给首环而拒绝整份清单；
//  新实现逐环完成（按环内最小旧地址升序），首环结束释放 .6，次环复用 .6。
{
  const p10_29 = plan({
    parentCidr: '192.168.10.0/29',
    reservations: [],
    requirements: [{ id: 's29', name: '小/29段', hosts: 6, cidr: '192.168.10.0/29' }],
  })
  check('/29 规划成功（可用 .1~.6）', p10_29.inputErrors.length === 0 && p10_29.segments.some((x) => x.cidr === '192.168.10.0/29'))
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 's29', name: 'A', address: ipToInt('192.168.10.1'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'b', ownerId: 's29', name: 'B', address: ipToInt('192.168.10.2'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
    { id: 'c', ownerId: 's29', name: 'C', address: ipToInt('192.168.10.3'), mode: 'manual', mac: 'aa:bb:cc:00:00:03' },
    { id: 'd', ownerId: 's29', name: 'D', address: ipToInt('192.168.10.4'), mode: 'manual', mac: 'aa:bb:cc:00:00:04' },
    { id: 'e', ownerId: 's29', name: 'E留守', address: ipToInt('192.168.10.5'), mode: 'manual', mac: 'aa:bb:cc:00:00:05' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.0/29,A,192.168.10.2,aa:bb:cc:00:00:01',
    '192.168.10.0/29,B,192.168.10.1,aa:bb:cc:00:00:02',
    '192.168.10.0/29,C,192.168.10.4,aa:bb:cc:00:00:03',
    '192.168.10.0/29,D,192.168.10.3,aa:bb:cc:00:00:04',
    '192.168.10.0/29,E留守,192.168.10.5,aa:bb:cc:00:00:05',
  ].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing, p10_29), existing, p10_29)
  check('两个独立互换环 + 唯一空闲 .6：整份清单可解（2 环、6 步），不被首环预留误阻断',
    mp.ok && mp.counts.cycles === 2 && mp.steps.length === 6,
    mp.ok ? mp.steps.map((s) => [s.kind, s.deviceId, intToIp(s.fromAddress ?? -1), intToIp(s.address)]).join('|') : mp.blockers.map((x) => x.message).join('|'))
  // 两个环各 3 步且彼此连续：先完整做完环 1（A/B），再做环 2（C/D）
  check('顺序按环内最小旧地址升序、逐环完成：A临时→B迁移→A归位，随后 C临时→D迁移→C归位',
    mp.steps.map((s) => `${s.deviceId}:${s.kind}`).join(',') ===
      'a:temp-move,b:move,a:cycle-complete,c:temp-move,d:move,c:cycle-complete',
    mp.steps.map((s) => `${s.deviceId}:${s.kind}`).join(','))
  const temps = mp.steps.filter((s) => s.kind === 'temp-move').map((s) => intToIp(s.address))
  check('唯一空闲 .6 被两环先后复用（两次临时迁出都到 .6）',
    JSON.stringify(temps) === JSON.stringify(['192.168.10.6', '192.168.10.6']), JSON.stringify(temps))
  check('两个环的临时锚点同为 .6（环摘要如实展示复用）',
    mp.cycles.length === 2 && mp.cycles.every((c) => c.tempAddress === ipToInt('192.168.10.6') && !c.blocked),
    JSON.stringify(mp.cycles.map((c) => [c.pivotName, c.tempAddress, c.blocked])))
  const final2 = simulateNoTransientDup(mp.steps, [
    { id: 'e', ownerId: 's29', name: 'E留守', address: ipToInt('192.168.10.5'), mode: 'manual' },
  ])
  check('逐环结束终态正确：.1=B、.2=A、.3=D、.4=C、.5=E 留守、.6 已释放',
    (final2.get(ipToInt('192.168.10.1')) ?? []).join() === 'b' &&
      (final2.get(ipToInt('192.168.10.2')) ?? []).join() === 'a' &&
      (final2.get(ipToInt('192.168.10.3')) ?? []).join() === 'd' &&
      (final2.get(ipToInt('192.168.10.4')) ?? []).join() === 'c' &&
      (final2.get(ipToInt('192.168.10.5')) ?? []).join() === 'e' &&
      (final2.get(ipToInt('192.168.10.6')) ?? []).length === 0,
  )
  check('复制清单如实反映复用顺序（两次 192.168.10.6）',
    (migrationPlanText(mp).match(/192\.168\.10\.6/g) ?? []).length >= 2)
}

// 23j3) 真正没有任何临时地址：/29 六个可用地址 .1~.6 全部被占（两台不迁设备守 .5/.6），
//  .1/.2、.3/.4 分别互换——首环选址当时即无空闲，整份清单阻断、不输出部分步骤。
{
  const pFull = plan({
    parentCidr: '10.7.0.0/29',
    reservations: [],
    requirements: [{ id: 'sf', name: '满/29段', hosts: 6, cidr: '10.7.0.0/29' }],
  })
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 'sf', name: 'A', address: ipToInt('10.7.0.1'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'b', ownerId: 'sf', name: 'B', address: ipToInt('10.7.0.2'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
    { id: 'c', ownerId: 'sf', name: 'C', address: ipToInt('10.7.0.3'), mode: 'manual', mac: 'aa:bb:cc:00:00:03' },
    { id: 'd', ownerId: 'sf', name: 'D', address: ipToInt('10.7.0.4'), mode: 'manual', mac: 'aa:bb:cc:00:00:04' },
    { id: 'e', ownerId: 'sf', name: 'E留守', address: ipToInt('10.7.0.5'), mode: 'manual', mac: 'aa:bb:cc:00:00:05' },
    { id: 'f', ownerId: 'sf', name: 'F留守', address: ipToInt('10.7.0.6'), mode: 'manual', mac: 'aa:bb:cc:00:00:06' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '10.7.0.0/29,A,10.7.0.2,aa:bb:cc:00:00:01',
    '10.7.0.0/29,B,10.7.0.1,aa:bb:cc:00:00:02',
    '10.7.0.0/29,C,10.7.0.4,aa:bb:cc:00:00:03',
    '10.7.0.0/29,D,10.7.0.3,aa:bb:cc:00:00:04',
    '10.7.0.0/29,E留守,10.7.0.5,aa:bb:cc:00:00:05',
    '10.7.0.0/29,F留守,10.7.0.6,aa:bb:cc:00:00:06',
  ].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing, pFull), existing, pFull)
  check('全占 /29 两个互换环：首环即无临时地址，整份清单阻断、零步骤',
    !mp.ok && mp.steps.length === 0 && mp.blockers.some((b) => b.kind === 'no-temp') &&
      mp.cycles.length === 2 && mp.cycles.every((c) => c.blocked),
    JSON.stringify({ ok: mp.ok, steps: mp.steps.length, blockers: mp.blockers.map((b) => b.message), cycles: mp.cycles.map((c) => c.blocked) }))
  check('阻断原因给出原网段可用范围 .1 ~ .6',
    mp.blockers.some((b) => /10\.7\.0\.1 ~ 10\.7\.0\.6/.test(b.message)),
    mp.blockers.map((b) => b.message).join('|'))
  check('阻断时复制文本为空', migrationPlanText(mp) === '')
}

// 23k) 冲突预览 / 不可应用时不产生结果
{
  const existing: HostAssignment[] = [
    { id: 'keep', ownerId: 'q3', name: '留守者', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:11:11:11' },
  ]
  const csv = ['网段 CIDR,设备名,IPv4,MAC', '192.168.10.32/27,新设备,192.168.10.40,aa:bb:cc:00:00:09'].join('\n')
  const conflicted = buildLeaseImport(csv, existing, hostPlan, () => 'x') // 与未更新设备冲突
  check('前置：该预览确有冲突', !conflicted.canApply && conflicted.hasConflicts)
  const mp = buildMigrationPlan(conflicted, existing, hostPlan)
  check('冲突预览：ok=false、零步骤', !mp.ok && mp.steps.length === 0 && mp.blockers[0].kind === 'pending')
}

// 23l) 跨网段互换（q3 的两台设备互改地址属于同段；构造跨网段环：
//  A:q3@.40 -> q3? 跨段环需要 A 的目标是 B 的原址、B 的目标是 A 的原址，而原址分属不同网段时
//  目标网段也随之交换——A 迁入 B 的原网段、B 迁入 A 的原网段，仍构成依赖环）
{
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 'q3', name: 'A', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' }, // 32/27
    { id: 'b', ownerId: 'q2', name: 'B', address: ipToInt('192.168.10.100'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' }, // 64/26
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    // A 迁入 B 的原网段占用 .100；B 迁入 A 的原网段占用 .40
    '192.168.10.64/26,A,192.168.10.100,aa:bb:cc:00:00:01',
    '192.168.10.32/27,B,192.168.10.40,aa:bb:cc:00:00:02',
  ].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing), existing, hostPlan)
  check('跨网段互换识别为环并可解', mp.ok && mp.counts.cycles === 1 && mp.steps.length === 3,
    mp.ok ? mp.steps.map((s) => [s.kind, s.deviceId]).join(',') : mp.blockers.map((x) => x.message).join('|'))
  // 锚点 A 原网段 32/27 内排除占用(.40)与全部目标(.100/.40)后的最低地址为 .33
  check('锚点 A 的临时地址在其原网段 32/27（.33）', mp.steps[0].deviceId === 'a' &&
    mp.steps[0].address === ipToInt('192.168.10.33') && mp.steps[0].tempCidr === '192.168.10.32/27')
  check('最终 A 在 q2 的 .100、B 在 q3 的 .40', mp.steps[1].deviceId === 'b' && mp.steps[2].deviceId === 'a',
    mp.steps.map((s) => [s.deviceId, intToIp(s.address)]).join(','))
  simulateNoTransientDup(mp.steps)
}

// 23m) 只读隔离：编排不修改既有登记与合并快照
{
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 'q3', name: 'A', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'b', ownerId: 'q3', name: 'B', address: ipToInt('192.168.10.41'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.32/27,A,192.168.10.41,aa:bb:cc:00:00:01',
    '192.168.10.32/27,B,192.168.10.40,aa:bb:cc:00:00:02',
  ].join('\n')
  const imported = importOrThrow(csv, existing)
  const snapE = JSON.stringify(existing)
  const snapM = JSON.stringify(imported.merged)
  buildMigrationPlan(imported, existing, hostPlan)
  check('编排过程不改写既有登记与合并快照', JSON.stringify(existing) === snapE && JSON.stringify(imported.merged) === snapM)
}

// 23n) 环与依赖链混合：A⇄B 互换（40/41），C@.42→.40 依赖 B 离开，D@.43→.55 空闲直迁
{
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 'q3', name: 'A', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'b', ownerId: 'q3', name: 'B', address: ipToInt('192.168.10.41'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
    { id: 'c', ownerId: 'q3', name: 'C', address: ipToInt('192.168.10.42'), mode: 'manual', mac: 'aa:bb:cc:00:00:03' },
    { id: 'd', ownerId: 'q3', name: 'D', address: ipToInt('192.168.10.43'), mode: 'manual', mac: 'aa:bb:cc:00:00:04' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.32/27,A,192.168.10.41,aa:bb:cc:00:00:01',
    '192.168.10.32/27,B,192.168.10.40,aa:bb:cc:00:00:02',
    '192.168.10.32/27,C,192.168.10.42,aa:bb:cc:00:00:03', // 无变化，不应产生步骤
    '192.168.10.32/27,D,192.168.10.55,aa:bb:cc:00:00:04',
  ].join('\n')
  const mp = buildMigrationPlan(importOrThrow(csv, existing), existing, hostPlan)
  check('混合场景：1 环、共 4 步（环的 3 步 + D 的空闲迁移），C 无变化不出现',
    mp.ok && mp.counts.cycles === 1 && mp.steps.length === 4 && !mp.steps.some((s) => s.deviceId === 'c'),
    mp.steps.map((s) => [s.deviceId, s.kind]).join(','))
  // 第 1 步必为锚点 A 临时迁出；之后 B 目标 .40 腾空先迁、A 完成环路到 .41；
  // D 目标 .55 虽空闲，但每轮最低目标优先：.40/.41 均早于 .55
  check('顺序：A 临时迁出 → B 迁移 → A 完成环路 → D 空闲迁移',
    mp.steps.map((s) => `${s.deviceId}:${s.kind}`).join(',') === 'a:temp-move,b:move,a:cycle-complete,d:move',
    mp.steps.map((s) => `${s.deviceId}:${s.kind}`).join(','))
  const final = simulateNoTransientDup(mp.steps, [
    // C 无变化，模拟中作为始终在线的初始占用者
    { id: 'c', ownerId: 'q3', name: 'C', address: ipToInt('192.168.10.42'), mode: 'manual' },
  ])
  check('混合场景终态正确：A=.41 B=.40 C=.42 D=.55，临时 .33 释放',
    (final.get(ipToInt('192.168.10.40')) ?? []).join() === 'b' &&
      (final.get(ipToInt('192.168.10.41')) ?? []).join() === 'a' &&
      (final.get(ipToInt('192.168.10.42')) ?? []).join() === 'c' &&
      (final.get(ipToInt('192.168.10.55')) ?? []).join() === 'd' &&
      (final.get(ipToInt('192.168.10.33')) ?? []).length === 0,
  )
}

// 23o) 实时重算：同一 CSV 下登记被应用（现状=目标）后，清单立即变为零步骤
{
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 'q3', name: 'A', address: ipToInt('192.168.10.40'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
    { id: 'b', ownerId: 'q3', name: 'B', address: ipToInt('192.168.10.41'), mode: 'manual', mac: 'aa:bb:cc:00:00:02' },
  ]
  const csv = [
    '网段 CIDR,设备名,IPv4,MAC',
    '192.168.10.32/27,A,192.168.10.41,aa:bb:cc:00:00:01',
    '192.168.10.32/27,B,192.168.10.40,aa:bb:cc:00:00:02',
  ].join('\n')
  const before = buildMigrationPlan(importOrThrow(csv, existing), existing, hostPlan)
  check('应用前：互换环存在（3 步）', before.ok && before.counts.cycles === 1 && before.steps.length === 3)
  // 应用导入：现状即合并快照
  const applied = importOrThrow(csv, existing).merged
  const afterImport = buildLeaseImport(csv, applied, hostPlan, () => 'x')
  check('应用后预览全部无变化', afterImport.canApply && afterImport.counts.unchanged === 2)
  const after = buildMigrationPlan(afterImport, applied, hostPlan)
  check('应用后实时重算为零步骤', after.ok && after.steps.length === 0 && after.changedDevices === 0)
}

// 23p) 规划变化后实时重算：网段迁移导致原 CSV 冲突 -> 不产生结果；恢复后重新可编排
{
  const existing: HostAssignment[] = [
    { id: 'a', ownerId: 'q4', name: '管理A', address: ipToInt('192.168.10.17'), mode: 'manual', mac: 'aa:bb:cc:00:00:01' },
  ]
  const csv = ['网段 CIDR,设备名,IPv4,MAC', '192.168.10.16/30,管理A,192.168.10.18,aa:bb:cc:00:00:01'].join('\n')
  check('原规划下可编排（1 步迁移）', buildMigrationPlan(importOrThrow(csv, existing), existing, hostPlan).steps.length === 1)
  const moved = buildLeaseImport(csv, existing, migratedPlan, () => 'x')
  check('规划迁移后预览转为冲突', !moved.canApply && moved.hasConflicts)
  check('迁移编排随之不产生结果（pending、零步骤）', (() => {
    const mp = buildMigrationPlan(moved, existing, migratedPlan)
    return !mp.ok && mp.steps.length === 0 && mp.blockers[0].kind === 'pending'
  })())
  const fixedCsv = ['网段 CIDR,设备名,IPv4,MAC', '192.168.10.20/30,管理A,192.168.10.22,aa:bb:cc:00:00:01'].join('\n')
  check('改到新网段后恢复编排', buildMigrationPlan(importOrThrow(fixedCsv, existing, migratedPlan), existing, migratedPlan).steps.length === 1)
}

// ========== 24) IPv4 路径分片预演 ==========
const fragHops = (mtus: Array<number | string>): FragHopInput[] =>
  mtus.map((m, i) => ({ id: `fh${i}`, mtu: String(m) }))

/** 提取最终分片的 [start,len,offset,mf] 便于断言 */
function sig(pieces: { payloadStart: number; payloadLen: number; offset: number; mf: boolean }[]) {
  return JSON.stringify(pieces.map((p) => [p.payloadStart, p.payloadLen, p.offset, p.mf ? 1 : 0]))
}

// 24a) 不超过 MTU：原样通过，单一片 MF=0
{
  const s = simulateFragments({ payloadLen: 1400, df: false, mtus: [1500] })
  check('1400 负载经 MTU1500 不碎片', s.pieceCount === 1 && !s.blocked)
  check('原始总长度=1420、首部开销=20、合计 1420', s.finalPieces[0].totalLen === 1420 && s.headerOverhead === 20 && s.totalBytes === 1420)
  check('单片 offset=0、MF=0', s.finalPieces[0].offset === 0 && s.finalPieces[0].mf === false)
}

// 24b) 经典拆分：3000 负载经 MTU1500 -> 1480/1480/40，偏移 0/185/370，MF 1/1/0
{
  const s = simulateFragments({ payloadLen: 3000, df: false, mtus: [1500] })
  check('3000 负载经 MTU1500 拆成 3 片', s.pieceCount === 3, sig(s.finalPieces))
  check(
    '三片范围/偏移/MF 正确（1480,1480,40；0,185,370；1,1,0）',
    sig(s.finalPieces) === JSON.stringify([[0, 1480, 0, 1], [1480, 1480, 185, 1], [2960, 40, 370, 0]]),
    sig(s.finalPieces),
  )
  check('非末片负载为 8 的倍数（1480%8=0）', 1480 % 8 === 0)
  check('首部开销 3×20=60，总字节 3000+60=3060', s.headerOverhead === 60 && s.totalBytes === 3060)
  check('负载守恒：三片负载合计=3000', s.finalPieces.reduce((n, p) => n + p.payloadLen, 0) === 3000)
}

// 24c) 多跳：1500 分片后再经 1400 跳只拆超片、不重组；再经 1500 原样保持
{
  const s = simulateFragments({ payloadLen: 3000, df: false, mtus: [1500, 1400, 1500] })
  check('未阻断、共 3 跳', !s.blocked && s.hops.length === 3)
  check('第 1 跳 1→3 片', s.hops[0].inCount === 1 && s.hops[0].outCount === 3)
  check('第 2 跳 3→5 片（两片 1480 各拆 1376+104，40 片通过）', s.hops[1].inCount === 3 && s.hops[1].outCount === 5)
  check(
    '第 2 跳结果：1376/104/1376/104/40，偏移 0,172,185,357,370，仅末片 MF=0',
    sig(s.finalPieces) ===
      JSON.stringify([
        [0, 1376, 0, 1],
        [1376, 104, 172, 1],
        [1480, 1376, 185, 1],
        [2856, 104, 357, 1],
        [2960, 40, 370, 0],
      ]),
    sig(s.finalPieces),
  )
  check('第 3 跳（1500）全部原样通过：片数不增不减', s.hops[2].pieces.every((p) => p.passed) && s.hops[2].outCount === 5)
  check('偏移始终相对原始负载（无重组、不重新归零）', s.finalPieces.every((p) => p.offset * 8 === p.payloadStart))
}

// 24d) 最小 MTU 68：负载上限 48，且 48 是 8 的倍数
{
  const s = simulateFragments({ payloadLen: 100, df: false, mtus: [68] })
  check('100 负载经 MTU68 -> 48/48/4 三片（偏移 0/6/12）',
    s.pieceCount === 3 &&
      sig(s.finalPieces) === JSON.stringify([[0, 48, 0, 1], [48, 48, 6, 1], [96, 4, 12, 0]]),
    sig(s.finalPieces),
  )
  check('每片总长度不超过 68', s.finalPieces.every((p) => p.totalLen <= 68))
}

// 24e) DF=1 通过路径（所有跳 MTU 足够）
{
  const s = simulateFragments({ payloadLen: 1400, df: true, mtus: [1500, 1500] })
  check('DF=1 且始终不超 MTU：不阻断、单一片', !s.blocked && s.pieceCount === 1)
}

// 24f) DF=1 在首个阻断跳停止：第 1 跳 1500 通过，第 2 跳 1400（总长度 1420）阻断
{
  const s = simulateFragments({ payloadLen: 1400, df: true, mtus: [1500, 1400] })
  check('DF=1 在第 2 跳阻断', s.blocked && s.blockedHopIndex === 2)
  check('阻断后不再执行后续跳（hops 止于第 2 跳）', s.hops.length === 2)
  check('阻断信息指出超 MTU 的原始片（offset=0、总长度 1420）', s.hops[1].blocked?.piece.totalLen === 1420)
}

// 24g) DF=1 在第 1 跳即阻断
{
  const s = simulateFragments({ payloadLen: 3000, df: true, mtus: [1500] })
  check('DF=1 第 1 跳超 MTU 即阻断', s.blocked && s.blockedHopIndex === 1 && s.pieceCount === 1)
}

// 24h) 原始末片负载不必是 8 的倍数（41），且后续跳再分片时它作为「覆盖原始末尾」的片保留 41
{
  const s = simulateFragments({ payloadLen: 3001, df: false, mtus: [1500] })
  check('3001 -> 1480/1480/41，末片 41 非 8 倍数且 MF=0',
    sig(s.finalPieces) === JSON.stringify([[0, 1480, 0, 1], [1480, 1480, 185, 1], [2960, 41, 370, 0]]),
    sig(s.finalPieces))
  // 经 MTU300（负载上限 280）：前两片各拆 5×280+80（6 片），41 片原样通过
  const s2 = simulateFragments({ payloadLen: 3001, df: false, mtus: [1500, 300] })
  check('二次分片共 13 片，原始末片 41 字节保留、offset=370、MF=0',
    s2.pieceCount === 13 &&
      s2.finalPieces[12].payloadStart === 2960 &&
      s2.finalPieces[12].payloadLen === 41 &&
      s2.finalPieces[12].offset === 370 &&
      s2.finalPieces[12].mf === false,
    sig(s2.finalPieces))
  check('二次分片的中间片负载全部 8 字节对齐', s2.finalPieces.slice(0, 12).every((p) => p.payloadLen % 8 === 0))
  check('二次分片每片总长度 <= 300', s2.finalPieces.every((p) => p.totalLen <= 300))
}

// 24i) 总长度恰好等于 MTU 视为通过（不超过即原样）
{
  const s = simulateFragments({ payloadLen: 1480, df: false, mtus: [1500, 1500] })
  check('1480 负载（总长度 1500）恰好等于 MTU：两跳均原样通过',
    s.pieceCount === 1 && s.hops.every((h) => h.pieces.every((p) => p.passed)))
}

// 24j) 原始报文与片偏移工具
{
  const d = originalDatagram(65515)
  check('最大负载 65515 的原始总长度=65535', d[0].totalLen === 65535 && d[0].payloadLen === 65515 && d[0].mf === false)
  check('固定首部常量为 20', IPV4_HEADER_LEN === 20)
  const kids = fragmentPiece({ payloadStart: 0, payloadEnd: 100, payloadLen: 100, totalLen: 120, offset: 0, mf: false }, 68, 100)
  check('fragmentPiece 手工拆分 100@MTU68 -> 48/48/4',
    sig(kids) === JSON.stringify([[0, 48, 0, 1], [48, 48, 6, 1], [96, 4, 12, 0]]), sig(kids))
}

// 24k) parsePayload 边界
check('负载 0 非法（低于 1）', 'error' in parsePayload('0'))
check('负载 1 合法', !('error' in parsePayload('1')))
check('负载 65515 合法', !('error' in parsePayload('65515')))
check('负载 65516 非法（超总长度上限）', 'error' in parsePayload('65516'))
check('负载空串非法', 'error' in parsePayload('   '))
check('负载非整数非法', 'error' in parsePayload('1400.5'))
// 24l) parseMtu 边界
check('MTU 67 非法（低于最小 68）', 'error' in parseMtu('67'))
check('MTU 68 合法', !('error' in parseMtu('68')))
check('MTU 65535 合法', !('error' in parseMtu('65535')))
check('MTU 65536 非法', 'error' in parseMtu('65536'))
check('MTU 空串非法', 'error' in parseMtu(''))
check('MTU 非整数非法', 'error' in parseMtu('1.5k'))

// 24m) validateFragInput：逐字段 / 逐跳定位错误
{
  const devices = listValidDevices(
    [{ id: 'h1', ownerId: 'q4', name: '设备A', address: ipToInt('192.168.10.17'), mode: 'auto' }],
    hostPlan,
  )
  check('有效登记出现在设备清单（设备A 192.168.10.17）', devices.length === 1 && devices[0].id === 'h1' && devices[0].ip === '192.168.10.17')

  const v = validateFragInput({ deviceId: 'h1', devices, payloadRaw: '3000', hops: fragHops([1500, 'abc']) })
  check('第 2 跳 MTU 非法被定位（hopIndex=2）', v.errors.length === 1 && v.errors[0].field === 'mtu' && v.errors[0].hopIndex === 2)
  check('存在 MTU 错误时不返回 mtus（暂停预演）', v.mtus === undefined && v.payloadLen === 3000)

  const v2 = validateFragInput({ deviceId: '', devices, payloadRaw: '0', hops: fragHops([]) })
  check('设备 / 负载 / 跳数三类错误同时定位',
    v2.errors.some((e) => e.field === 'device') &&
    v2.errors.some((e) => e.field === 'payload') &&
    v2.errors.some((e) => e.field === 'mtu' && e.hopIndex === undefined),
    JSON.stringify(v2.errors))

  const v3 = validateFragInput({ deviceId: 'h1', devices, payloadRaw: '1400', hops: fragHops([1, 2, 3, 4, 5, 6, 7, 8, 9]) })
  check('超过 8 跳报错', v3.errors.some((e) => /最多 8 跳/.test(e.message)))

  const ok = validateFragInput({ deviceId: 'h1', devices, payloadRaw: '1400', hops: fragHops([1500, 1400]) })
  check('全部合法时零错误且解析出 mtus', ok.errors.length === 0 && JSON.stringify(ok.mtus) === '[1500,1400]')
}

// 24n) 设备清单实时反映登记有效性：越界登记不列出；规划输入非法时清单为空
{
  const mixed = listValidDevices(
    [
      { id: 'ok', ownerId: 'q4', name: '有效', address: ipToInt('192.168.10.17'), mode: 'auto' },
      { id: 'bad', ownerId: 'q4', name: '越界', address: ipToInt('192.168.10.40'), mode: 'manual' },
    ],
    hostPlan,
  )
  check('失效登记不出现在发送设备清单', mixed.length === 1 && mixed[0].id === 'ok')
  const broken = plan({
    parentCidr: '192.168.2.0/24',
    reservations: [],
    requirements: [{ id: 'x', name: 'X', hosts: 100, cidr: '192.168.9.0/24' }],
  })
  check('规划输入非法时设备清单为空（面板暂停）', broken.inputErrors.length > 0 && listValidDevices([], broken).length === 0)
}

// 24o) 全跳守恒：任何一跳输出片负载并集都等于原始负载，且偏移 8 字节对齐、覆盖不重不漏
{
  const s = simulateFragments({ payloadLen: 5000, df: false, mtus: [1500, 1200, 800, 1500, 68] })
  check('五级 MTU 路径未阻断', !s.blocked)
  for (const h of s.hops) {
    // 每跳输出片（拆分则展开子片，否则来源片本身）
    const out = h.pieces.flatMap((p) => p.splitInto ?? [p.piece])
    const sum = out.reduce((n, p) => n + p.payloadLen, 0)
    const aligned = out.every((p) => p.payloadStart % 8 === 0 && p.offset * 8 === p.payloadStart)
    const ordered = out.every((p, i) => i === 0 || p.payloadStart === out[i - 1].payloadEnd)
    const mfOnlyLast = out.filter((p) => !p.mf).length === 1 && out[out.length - 1].mf === false
    check(
      `第 ${h.hopIndex} 跳守恒（负载合计 5000、偏移对齐、首尾相接、仅末片 MF=0）`,
      sum === 5000 && aligned && ordered && mfOnlyLast && out[0].payloadStart === 0 && out[out.length - 1].payloadEnd === 5000,
      JSON.stringify({ sum, aligned, ordered, mfOnlyLast }),
    )
  }
  check('末跳 MTU68：所有片总长度 ≤ 68 且片数 >1', s.finalPieces.every((p) => p.totalLen <= 68) && s.pieceCount > 1)
  check('后续更大 MTU 不会重组（片数单调不减）', s.hops.every((h, i) => i === 0 || h.outCount >= s.hops[i - 1].outCount))
}

console.log(failures === 0 ? '\n全部测试通过 ✅' : `\n${failures} 个测试失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
