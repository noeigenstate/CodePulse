/** Explicit user-initiated capture only; no background microphone or wake-word listener. */
export interface DeskRecording {
  stop: () => Promise<Uint8Array>
  cancel: () => void
}
export async function recordDeskVoice(
  onLimit: () => void,
  isActive = () => true,
): Promise<DeskRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  })
  if (!isActive()) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('录音已取消')
  }
  let context: AudioContext | undefined
  try {
    context = new AudioContext()
    await context.resume()
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop())
    void context?.close()
    throw error
  }
  const source = context.createMediaStreamSource(stream),
    processor = context.createScriptProcessor(4096, 1, 1),
    mute = context.createGain()
  const chunks: Float32Array[] = []
  let closed = false,
    total = 0
  mute.gain.value = 0
  source.connect(processor)
  processor.connect(mute)
  mute.connect(context.destination)
  processor.onaudioprocess = (event) => {
    if (!closed) {
      const samples = event.inputBuffer.getChannelData(0)
      if (total < context.sampleRate * 30) {
        chunks.push(new Float32Array(samples))
        total += samples.length
      }
    }
  }
  const timer = setTimeout(onLimit, 25000)
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    processor.onaudioprocess = null
    source.disconnect()
    processor.disconnect()
    mute.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void context.close()
  }
  return {
    cancel: close,
    stop: async () => {
      if (closed) throw new Error('录音已结束')
      close()
      const all = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        all.set(chunk, offset)
        offset += chunk.length
      }
      return resamplePcm(all, context.sampleRate)
    },
  }
}
export function resamplePcm(samples: Float32Array, rate: number): Uint8Array {
  if (!Number.isFinite(rate) || rate < 16000 || rate > 192000) throw new Error('不支持的录音采样率')
  const count = Math.min(480000, Math.floor((samples.length * 16000) / rate)),
    out = new Uint8Array(count * 2),
    view = new DataView(out.buffer)
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * rate) / 16000),
      end = Math.min(samples.length, Math.floor(((i + 1) * rate) / 16000))
    let sum = 0
    for (let n = start; n < end; n++) sum += samples[n]
    const value = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)))
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return out
}
export async function playDeskVoice(pcm: Uint8Array, isActive = () => true): Promise<() => void> {
  if (!pcm.length || pcm.length % 2 || pcm.length > 1920000) throw new Error('语音数据无效')
  const context = new AudioContext(),
    buffer = context.createBuffer(1, pcm.length / 2, 16000),
    channel = buffer.getChannelData(0),
    view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768
  const source = context.createBufferSource(),
    gain = context.createGain()
  gain.gain.value = 0.5
  source.buffer = buffer
  source.connect(gain)
  gain.connect(context.destination)
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    try {
      source.stop()
    } catch {}
    void context.close()
  }
  source.onended = stop
  try {
    await context.resume()
    if (isActive()) source.start()
    else stop()
  } catch (error) {
    stop()
    throw error
  }
  return stop
}
