import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AssistantService } from './assistant-service.js'
import { publicAssistantError } from './assistant-service.js'
import { text } from './assistant-store.js'

/** Registered on the existing authenticated LAN server, never a second backend. */
export function registerAssistantRoutes(app: FastifyInstance, service: AssistantService): void {
  const prefix = '/api/v1/device/assistant'
  const pending = new Map<string, { id: string; expiresAt: number }>()
  let synthesizing = false
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 960000 },
    (_request, body, done) => done(null, body),
  )
  const device = (request: FastifyRequest) => {
    const value = request.headers['x-codepulse-device-id']
    if (typeof value !== 'string' || !/^[-A-Za-z0-9_:]{1,64}$/.test(value))
      throw new Error('语音设备标识无效')
    return value
  }
  const conversation = async (value: unknown, id: string) => {
    const input = text(value, 4000, true),
      current = pending.get(id)
    for (const [key, item] of pending) if (item.expiresAt <= Date.now()) pending.delete(key)
    if (
      /^(确认|确认添加|确认执行|确认保存|确定|好|好的)[。！!]?$/u.test(input) &&
      current &&
      current.expiresAt > Date.now()
    ) {
      service.apply(current.id)
      pending.delete(id)
      return { reply: '已保存。', draftId: null, needsConfirmation: false }
    }
    if (/^(取消|算了|不用了)[。！!]?$/u.test(input)) {
      pending.delete(id)
      return { reply: '已取消这条建议。', draftId: null, needsConfirmation: false }
    }
    pending.delete(id)
    const draft = await service.interpret(input, id)
    if (draft.actions.length && draft.actions.length <= 2) {
      if (pending.size >= 16 && !pending.has(id)) throw new Error('语音设备数量已达上限')
      pending.set(id, { id: draft.id, expiresAt: draft.expiresAt })
    }
    return {
      reply:
        draft.actions.length > 2
          ? `已准备 ${draft.actions.length} 项更改，请在桌面客户端查看建议并确认。`
          : draft.actions.length
            ? (draft.tasks
                .map(
                  (task) =>
                    `${task.title.slice(0, 70)}${task.dueAt ? `，${new Date(task.dueAt).toLocaleString('zh-CN')}提醒` : '，添加到待办'}`,
                )
                .join('；') || draft.reply.slice(0, 220)) + '。请说“确认”保存，或说“取消”。'
            : draft.reply.slice(0, 280),
      draftId: draft.actions.length ? draft.id : null,
      needsConfirmation: draft.actions.length > 0,
    }
  }
  app.get(prefix + '/info', async () => ({
    protocolVersion: 1,
    audio: { format: 'pcm_s16le', sampleRate: 16000, channels: 1, maxSeconds: 30 },
    voiceInput: service.snapshot().settings.voiceInput,
    voiceOutput: service.snapshot().settings.voiceOutput,
  }))
  app.post(prefix + '/text', { bodyLimit: 16000 }, async (request, reply) => {
    try {
      return await conversation((request.body as { text?: unknown })?.text, device(request))
    } catch (error) {
      return reply.code(400).send({ error: publicAssistantError(error) })
    }
  })
  app.post(prefix + '/voice', { bodyLimit: 960000 }, async (request, reply) => {
    try {
      const id = device(request)
      if (!(request.body instanceof Uint8Array)) throw new Error('请发送 PCM 语音数据')
      const transcript = await service.transcribe(request.body)
      return { text: transcript, ...(await conversation(transcript, id)) }
    } catch (error) {
      return reply.code(400).send({ error: publicAssistantError(error) })
    }
  })
  app.post(prefix + '/speech', { bodyLimit: 3000 }, async (request, reply) => {
    if (synthesizing) return reply.code(429).send({ error: '语音输出正在处理，请稍候' })
    synthesizing = true
    try {
      device(request)
      const audio = await service.speak((request.body as { text?: unknown })?.text)
      return reply
        .type('application/octet-stream')
        .header('x-codepulse-audio-rate', '16000')
        .header('cache-control', 'no-store')
        .send(Buffer.from(audio.pcm))
    } catch (error) {
      return reply.code(400).send({ error: publicAssistantError(error) })
    } finally {
      synthesizing = false
    }
  })
  app.get(prefix + '/announcement', async (request, reply) => {
    try {
      return { announcement: service.claimAnnouncement(device(request)) }
    } catch (error) {
      return reply.code(400).send({ error: publicAssistantError(error) })
    }
  })
  app.post(prefix + '/announcement/ack', { bodyLimit: 1000 }, async (request, reply) => {
    try {
      service.acknowledgeAnnouncement(
        device(request),
        text((request.body as { id?: unknown })?.id, 80, true),
      )
      return { ok: true }
    } catch (error) {
      return reply.code(400).send({ error: publicAssistantError(error) })
    }
  })
}
