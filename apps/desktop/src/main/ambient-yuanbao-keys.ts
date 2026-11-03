import type { YuanbaoKeyInput } from '@codepulse/shared'
import { yuanbaoCredentials, type YuanbaoCredentials } from './ambient-yuanbao.js'

/** OS encryption and file access are injected so Node tests never import Electron or real user data. */
export class YuanbaoKeyStore {
  private value: YuanbaoCredentials | null = null
  constructor(
    private io: {
      available: () => boolean
      encrypt: (plaintext: string) => Buffer
      decrypt: (ciphertext: Buffer) => string
      read: () => Record<string, unknown>
      write: (value: Record<string, unknown>) => void
    },
  ) {
    if (!io.available()) return
    try {
      const encrypted = io.read().yuanbao
      if (typeof encrypted === 'string')
        this.value = yuanbaoCredentials(JSON.parse(io.decrypt(Buffer.from(encrypted, 'base64'))))
    } catch {
      this.value = null
    }
  }
  get(): YuanbaoCredentials | null {
    return this.value ? { ...this.value } : null
  }
  set(input: YuanbaoKeyInput): void {
    const next = yuanbaoCredentials(input)
    if (next && !this.io.available()) throw Error('系统加密存储不可用，未保存密钥')
    try {
      const stored = this.io.read()
      if (next) stored.yuanbao = this.io.encrypt(JSON.stringify(next)).toString('base64')
      else delete stored.yuanbao
      this.io.write(stored)
    } catch {
      throw Error('密钥未能保存')
    }
    this.value = next
  }
}
