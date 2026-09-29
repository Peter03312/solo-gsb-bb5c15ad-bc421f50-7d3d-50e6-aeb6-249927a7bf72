// IPv4 与 CIDR 数值工具（全部使用 >>> 0 保证无符号 32 位运算）

export function ipToInt(ip: string): number {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
  if (!m) return NaN
  let result = 0
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i])
    if (octet < 0 || octet > 255) return NaN
    result = (result << 8) + octet
  }
  return result >>> 0
}

export function intToIp(value: number): string {
  const v = value >>> 0
  return `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`
}

export function blockSize(prefix: number): number {
  return Math.pow(2, 32 - prefix)
}

/** 将任意地址规整为所在 /prefix 网络地址 */
export function alignTo(value: number, prefix: number): number {
  const size = blockSize(prefix)
  return (Math.floor(value / size) * size) >>> 0
}

export function prefixMask(prefix: number): number {
  if (prefix <= 0) return 0
  if (prefix >= 32) return 0xffffffff
  return (0xffffffff << (32 - prefix)) >>> 0
}

export function isValidPrefix(p: number): boolean {
  return Number.isInteger(p) && p >= 0 && p <= 32
}

export interface ParsedCidr {
  address: string
  addressInt: number
  prefix: number
  network: number
  broadcast: number
  size: number
}

/**
 * 解析 CIDR。strictNetwork=true 时要求网络位全 0（如 192.168.1.5/24 非法）。
 */
export function parseCidr(input: string, strictNetwork = true): ParsedCidr | { error: string } {
  const raw = input.trim()
  const parts = raw.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return { error: `“${raw}”格式无效，应为 a.b.c.d/nn` }
  }
  const addressInt = ipToInt(parts[0])
  if (Number.isNaN(addressInt)) {
    return { error: `“${raw}”的 IP 地址无效` }
  }
  const prefix = Number(parts[1])
  if (!isValidPrefix(prefix) || !/^\d+$/.test(parts[1])) {
    return { error: `“${raw}”的前缀长度无效（需为 0-32 的整数）` }
  }
  const network = (addressInt & prefixMask(prefix)) >>> 0
  if (strictNetwork && network !== addressInt) {
    return {
      error: `“${raw}”不是规范网络地址，应为 ${intToIp(network)}/${prefix}（请将主机位置 0）`,
    }
  }
  const size = blockSize(prefix)
  // /32 时广播地址 = 网络地址；使用无符号运算防止 0xffffffff + 1 溢出
  const broadcast = prefix === 32 ? network : (network + size - 1) >>> 0
  return { address: parts[0].trim(), addressInt, prefix, network, broadcast, size }
}

/** 满足 usableHosts 台主机（容量 = 主机数 + 2）的最小前缀；最小网段 /30 */
export function prefixForHosts(hosts: number): number {
  if (hosts <= 0) return 30
  let needed = hosts + 2 // 网络地址 + 广播地址
  let size = 4 // /30
  let prefix = 30
  while (size < needed) {
    if (prefix === 0) break
    size *= 2
    prefix -= 1
  }
  return prefix
}

export function formatCidr(network: number, prefix: number): string {
  return `${intToIp(network)}/${prefix}`
}
