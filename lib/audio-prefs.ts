export type AudioPrefs = {
  inputDeviceId?: string
  outputDeviceId?: string
  monitorVolume: number
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  voiceMode: "vad" | "ptt"
}

const KEY = "voicechat.audio.prefs"

const DEFAULT: AudioPrefs = {
  monitorVolume: 0.25,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
  voiceMode: "vad",
}

export function getAudioPrefs(): AudioPrefs {
  if (typeof window === "undefined") return DEFAULT
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return DEFAULT
    const parsed = JSON.parse(raw)
    return { ...DEFAULT, ...parsed }
  } catch {
    return DEFAULT
  }
}

export function saveAudioPrefs(partial: Partial<AudioPrefs>) {
  if (typeof window === "undefined") return
  const current = getAudioPrefs()
  const next = { ...current, ...partial }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
}