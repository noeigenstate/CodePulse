/** Local desk assistant. Separate from programming-agent status and usage data. */
export type AssistantScene = 'general_assistant' | 'teacher_work' | 'family_reading'
export interface DeskTask {
  id: string
  title: string
  notes: string
  dueAt: number | null
  status: 'pending' | 'completed' | 'cancelled'
  reminderState: 'none' | 'pending' | 'delivered' | 'expired'
  createdAt: number
  updatedAt: number
  notifiedAt: number | null
}
export interface DeskMemory {
  id: string
  text: string
  createdAt: number
}
export interface AssistantSettings {
  version: 1
  scene: AssistantScene
  provider: 'tongyi' | 'glm'
  model: string
  voice: string
  voiceInput: boolean
  voiceOutput: boolean
  quietStart: number
  quietEnd: number
  notifications: boolean
}
export type AssistantSecret = 'llmKey' | 'speechAppKey' | 'speechToken'
export interface AssistantSnapshot {
  proposal?: AssistantDraft
  tasks: DeskTask[]
  memories: DeskMemory[]
  settings: AssistantSettings
  credentials: Record<AssistantSecret, boolean>
  busy: boolean
  error: string | null
}
export interface DeskTaskInput {
  title: string
  notes?: string
  dueAt?: number | null
}
export type AssistantAction =
  | {
      kind: 'create_task'
      title: string
      notes?: string
      secondsFromNow?: number
      localDate?: string
      localTime?: string
    }
  | { kind: 'complete_task'; id: string }
  | { kind: 'snooze_task'; id: string; secondsFromNow: number }
  | { kind: 'save_memory'; text: string }
  | { kind: 'switch_scene'; scene: AssistantScene }
export interface AssistantDraft {
  id: string
  reply: string
  actions: AssistantAction[]
  expiresAt: number
  /** Times are resolved by the host at interpretation time, never invented epoch values. */
  tasks: DeskTaskInput[]
}
export interface AssistantAudio {
  pcm: Uint8Array
  sampleRate: 16000
}
export interface AssistantConversationTurn {
  role: 'user' | 'assistant'
  content: string
}
export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  version: 1,
  scene: 'general_assistant',
  provider: 'glm',
  model: 'glm-4-flash',
  voice: 'xiaoyun',
  voiceInput: false,
  voiceOutput: false,
  quietStart: 22,
  quietEnd: 8,
  notifications: true,
}
