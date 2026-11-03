import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { UiLocale } from '@codepulse/shared'

// Only this fixed script is executed; request data travels as ASCII JSON on stdin.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $request.culture } | Select-Object -First 1
  if (-not $voice) { exit 2 }
  $synth.SelectVoice($voice.VoiceInfo.Name)
  if ($request.mode -eq 'pcm') {
    $stream = New-Object System.IO.MemoryStream
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToAudioStream($stream, $format)
    $synth.Volume = 100
    $synth.Speak([string]$request.text)
    $bytes = $stream.ToArray()
    [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
    $stream.Dispose()
  } else {
    $synth.Volume = 75
    $synth.Speak([string]$request.text)
  }
  $synth.Dispose()
} catch { exit 1 }
`

/** Bounded local TTS: either play on this computer or return PCM for an audio-capable device. */
export class LocalSpeech {
  readonly supported = process.platform === 'win32'
  private child?: ChildProcess

  async speak(text: string, locale: UiLocale): Promise<void> {
    await this.run(text, locale, 'speaker')
  }
  synthesize(text: string, locale: UiLocale): Promise<Uint8Array> {
    return this.run(text, locale, 'pcm')
  }

  private run(text: string, locale: UiLocale, mode: 'speaker' | 'pcm'): Promise<Uint8Array> {
    if (!this.supported || this.child) return Promise.reject(new Error('speech unavailable'))
    return new Promise((resolve, reject) => {
      const child = spawn(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SCRIPT],
        {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      )
      this.child = child
      let size = 0,
        settled = false,
        exceeded = false
      const chunks: Buffer[] = []
      const timer = setTimeout(() => child.kill(), 20_000)
      timer.unref?.()
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.child === child) this.child = undefined
        const pcm = Buffer.concat(chunks)
        if (
          ok &&
          !exceeded &&
          (mode !== 'pcm' ||
            (pcm.length >= 3200 && pcm.length % 2 === 0 && pcm.toString('ascii', 0, 4) !== 'RIFF'))
        )
          resolve(pcm)
        else reject(new Error('local speech failed'))
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 640000) {
          exceeded = true
          child.kill()
        } else chunks.push(chunk)
      })
      child.once('error', () => finish(false))
      child.once('close', (code) => finish(code === 0))
      child.stdin?.on('error', () => {})
      child.stdin?.end(
        JSON.stringify({ text, culture: locale === 'zh' ? 'zh-CN' : 'en-US', mode }).replace(
          /[\u007f-\uffff]/g,
          (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
        ),
      )
    })
  }
  cancel(): void {
    this.child?.kill()
    this.child = undefined
  }
}
