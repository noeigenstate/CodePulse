import type {
  StatusSnapshot,
  UiLocale,
  WorkVoiceTargetsSnapshot,
  WorkVoiceTarget,
  WorkVoicePreferences,
  WorkVoiceSettings,
} from '@codepulse/shared'
import { WorkVoice } from './work-voice.js'
import { LocalSpeech } from './local-speech.js'
import { WorkVoiceDelivery } from './work-voice-delivery.js'

export class WorkVoiceRuntime {
  private desktopSpeech = new LocalSpeech()
  private inkSpeech = new LocalSpeech()
  private desktop: WorkVoice
  private ink: WorkVoice
  readonly delivery: WorkVoiceDelivery

  constructor(config: WorkVoicePreferences, changed: (value: WorkVoiceTargetsSnapshot) => void) {
    const emit = () => {
      if (this.desktop && this.ink) changed(this.snapshot())
    }
    this.delivery = new WorkVoiceDelivery(
      (text, locale) => this.inkSpeech.synthesize(text, locale),
      emit,
    )
    this.desktop = new WorkVoice(config.desktop, {
      supported: this.desktopSpeech.supported,
      speak: (text, locale) => this.desktopSpeech.speak(text, locale),
      cancel: () => this.desktopSpeech.cancel(),
      changed: emit,
    })
    this.ink = new WorkVoice(config.ink, {
      supported: this.inkSpeech.supported,
      speak: async (text, locale, valid) => this.delivery.publish(text, locale, valid),
      cancel: () => {
        this.delivery.clear()
        this.inkSpeech.cancel()
      },
      changed: emit,
    })
  }
  snapshot(): WorkVoiceTargetsSnapshot {
    return {
      version: 2,
      desktop: this.desktop.snapshot(),
      ink: {
        ...this.ink.snapshot(),
        deviceAvailable: this.delivery.available(),
        error: this.delivery.error ?? this.ink.snapshot().error,
      },
    }
  }
  setLocale(locale: UiLocale): void {
    this.desktop.setLocale(locale)
    this.ink.setLocale(locale)
  }
  observe(snapshot: StatusSnapshot): void {
    this.desktop.observe(snapshot)
    this.ink.observe(snapshot)
  }
  configure(target: WorkVoiceTarget, value: WorkVoiceSettings): WorkVoiceTargetsSnapshot {
    this[target].configure(value)
    return this.snapshot()
  }
  async test(target: WorkVoiceTarget, locale: UiLocale): Promise<WorkVoiceTargetsSnapshot> {
    await this[target].test(locale)
    return this.snapshot()
  }
  stopSpeaking(target: WorkVoiceTarget): WorkVoiceTargetsSnapshot {
    this[target].stopSpeaking()
    return this.snapshot()
  }
  close(): void {
    this.desktop.close()
    this.ink.close()
  }
}
