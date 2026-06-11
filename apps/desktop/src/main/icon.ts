/**
 * 在运行时生成系统托盘图标。为避免随包分发二进制图片资源，
 * 一个微型 PNG 编码器绘制纯色圆点，颜色对应聚合后的
 * {@link OverallState}（需求 §5.6）。
 *
 * @module main/icon
 */
import { deflateSync } from 'node:zlib'
import { nativeImage, type NativeImage } from 'electron'
import type { OverallState } from '@codepulse/shared'

/** 每个总体状态对应的托盘颜色（RGB，需求 §5.6）。 */
const STATE_COLORS: Record<OverallState, [number, number, number]> = {
  idle: [156, 163, 175], // 灰
  running: [59, 130, 246], // 蓝
  attention: [234, 179, 8], // 黄
  done_unread: [34, 197, 94], // 绿
  error: [239, 68, 68], // 红
  stuck: [249, 115, 18], // 橙
}

/** CRC-32 查找表，构建一次用于 PNG 块校验和。 */
const crcTable = buildCrcTable()
/** 已生成图标的缓存，每种颜色至多编码一次。 */
const iconCache = new Map<OverallState, NativeImage>()

/**
 * 返回给定总体状态对应的 16×16 纯色托盘图标，
 * 首次使用时编码（并缓存）。
 *
 * @param state 要表示的聚合总体状态。
 * @returns 用于托盘的 Electron {@link NativeImage}。
 */
export function trayIconFor(state: OverallState): NativeImage {
  const cached = iconCache.get(state)
  if (cached) return cached
  const [r, g, b] = STATE_COLORS[state]
  const image = nativeImage.createFromBuffer(solidRoundedPng(16, r, g, b))
  iconCache.set(state, image)
  return image
}

/**
 * 编码一张 `size`×`size` 的 RGBA PNG：透明背景上以 `(r,g,b)`
 * 填充的实心圆。
 *
 * @param size 图片宽/高（像素）。
 * @param r 红色通道（0–255）。
 * @param g 绿色通道（0–255）。
 * @param b 蓝色通道（0–255）。
 * @returns 编码后的 PNG 字节。
 */
function solidRoundedPng(size: number, r: number, g: number, b: number): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  const cx = (size - 1) / 2
  const cy = (size - 1) / 2
  const radius = size / 2 - 0.5
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // 滤波器：无
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - cx, y - cy)
      const inside = dist <= radius
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
      raw[p++] = inside ? 255 : 0
    }
  }
  return buildPng(size, size, raw)
}

/**
 * 由已滤波的原始扫描线数据组装完整的 PNG 文件。
 *
 * @param width 图片宽度（像素）。
 * @param height 图片高度（像素）。
 * @param raw 已滤波的扫描线（每行以滤波字节开头）。
 * @returns 编码后的 PNG 字节（签名 + IHDR + IDAT + IEND）。
 */
function buildPng(width: number, height: number, raw: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：RGBA
  ihdr[10] = 0 // 压缩
  ihdr[11] = 0 // 滤波
  ihdr[12] = 0 // 隔行
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 把块数据包入 PNG 的 length/type/data/CRC 框架。
 *
 * @param type 4 字符块类型（如 `"IHDR"`）。
 * @param data 块载荷。
 * @returns 加框后的块字节。
 */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0)
  return Buffer.concat([length, typeBuf, data, crcBuf])
}

/**
 * 构建标准 CRC-32 查找表。
 *
 * @returns 256 项预计算 CRC 值的表。
 */
function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}

/**
 * 使用 {@link crcTable} 计算缓冲区的 CRC-32。
 *
 * @param buf 要校验的字节。
 * @returns 无符号 32 位 CRC。
 */
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
