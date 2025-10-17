"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { getAudioPrefs, saveAudioPrefs, type AudioPrefs } from "@/lib/audio-prefs"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"

type DeviceInfo = { deviceId: string; label: string }

export default function AudioSettingsPage() {
  const router = useRouter()
  const [inputs, setInputs] = useState<DeviceInfo[]>([])
  const [outputs, setOutputs] = useState<DeviceInfo[]>([])
  const [prefs, setPrefs] = useState<AudioPrefs>(getAudioPrefs())
  const [inputLevel, setInputLevel] = useState(0)
  const [isTestingMic, setIsTestingMic] = useState(false)
  const [isMonitoring, setIsMonitoring] = useState(false)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const monitorGainRef = useRef<GainNode | null>(null)
  const monitorElementRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    // Pré-permissão para listar dispositivos com labels
    const prewarm = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch {}
      const devices = await navigator.mediaDevices.enumerateDevices()
      const ins = devices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label || "Microfone" }))
      const outs = devices
        .filter((d) => d.kind === "audiooutput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label || "Dispositivo de saída" }))
      setInputs(ins)
      setOutputs(outs)
    }
    prewarm()
  }, [])

  useEffect(() => {
    saveAudioPrefs(prefs)
  }, [prefs])

  // Sair da tela via ESC
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (typeof window !== "undefined" && window.history.length > 1) {
          router.back()
        } else {
          router.push("/")
        }
      }
    }
    window.addEventListener("keydown", handle)
    return () => window.removeEventListener("keydown", handle)
  }, [router])

  const startMicTest = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: prefs.inputDeviceId ? { exact: prefs.inputDeviceId } : undefined,
          echoCancellation: prefs.echoCancellation,
          noiseSuppression: prefs.noiseSuppression,
          autoGainControl: prefs.autoGainControl,
        },
      })
      micStreamRef.current = stream
      setIsTestingMic(true)
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      audioCtxRef.current = ctx
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.8
      src.connect(analyser)
      analyserRef.current = analyser
      const tick = () => {
        const a = analyserRef.current
        if (!a) return
        const data = new Float32Array(a.fftSize)
        a.getFloatTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        const level = Math.min(1, Math.sqrt(sum / data.length) * 4)
        setInputLevel(Math.round(level * 100))
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (err) {
      alert("Não foi possível iniciar o teste do microfone.")
      console.error(err)
    }
  }

  const stopMicTest = () => {
    setIsTestingMic(false)
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setInputLevel(0)
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop())
      micStreamRef.current = null
    }
    if (monitorGainRef.current) {
      try { monitorGainRef.current.disconnect() } catch {}
      monitorGainRef.current = null
    }
    const el = monitorElementRef.current
    if (el) {
      try { el.pause() } catch {}
      monitorElementRef.current = null
    }
    const ctx = audioCtxRef.current
    if (ctx) {
      try { ctx.close() } catch {}
      audioCtxRef.current = null
    }
  }

  const toggleMonitor = async () => {
    if (isMonitoring) {
      setIsMonitoring(false)
      const el = monitorElementRef.current
      if (el) {
        try { el.pause() } catch {}
        monitorElementRef.current = null
      }
      if (monitorGainRef.current) {
        try { monitorGainRef.current.disconnect() } catch {}
        monitorGainRef.current = null
      }
      return
    }
    // iniciar
    const stream = micStreamRef.current
    if (!stream) {
      alert("Inicie o teste de microfone primeiro.")
      return
    }
    const ctx = audioCtxRef.current || new (window.AudioContext || (window as any).webkitAudioContext)()
    audioCtxRef.current = ctx
    const src = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    gain.gain.value = prefs.monitorVolume ?? 0.25
    const dest = ctx.createMediaStreamDestination()
    src.connect(gain)
    gain.connect(dest)
    monitorGainRef.current = gain
    const el = new Audio()
    ;(el as any).srcObject = dest.stream
    try {
      if ((el as any).setSinkId && prefs.outputDeviceId) {
        await (el as any).setSinkId(prefs.outputDeviceId)
      }
    } catch (e) {
      console.warn("setSinkId não suportado ou falhou:", e)
    }
    try { await el.play() } catch (e) { console.error(e) }
    monitorElementRef.current = el
    setIsMonitoring(true)
  }

  const testOutputBeep = async () => {
    try {
      const el = new Audio()
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      gain.gain.value = prefs.monitorVolume ?? 0.25
      const dest = ctx.createMediaStreamDestination()
      osc.type = "sine"
      osc.frequency.value = 880
      osc.connect(gain)
      gain.connect(dest)
      ;(el as any).srcObject = dest.stream
      try {
        if ((el as any).setSinkId && prefs.outputDeviceId) {
          await (el as any).setSinkId(prefs.outputDeviceId)
        }
      } catch {}
      osc.start()
      await el.play()
      setTimeout(() => {
        try { osc.stop() } catch {}
        try { ctx.close() } catch {}
        try { el.pause() } catch {}
      }, 600)
    } catch (e) {
      console.error(e)
      alert("Falha ao reproduzir o som de teste.")
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <Button
          variant="secondary"
          className="rounded-full bg-slate-800 text-white hover:bg-indigo-600"
          onClick={() => (typeof window !== "undefined" && window.history.length > 1 ? router.back() : router.push("/"))}
        >
          <ArrowLeft className="h-4 w-4 mr-2" /> Voltar
        </Button>
        <span className="text-xs text-slate-500">ESC também fecha</span>
      </div>
      <h1 className="text-2xl font-semibold text-white">Configurações de Áudio</h1>
      <p className="text-slate-400">Selecione dispositivos e ajuste preferências de processamento e monitoração.</p>

      <div className="mt-6 grid gap-6">
        <Card className="p-4 bg-slate-900 border-slate-800">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="text-slate-300">Dispositivo de entrada</Label>
              <Select
                value={prefs.inputDeviceId || ""}
                onValueChange={(v) => setPrefs((p) => ({ ...p, inputDeviceId: v }))}
              >
                <SelectTrigger className="mt-2 bg-slate-800 text-white">
                  <SelectValue placeholder="Selecione o microfone" />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 text-white">
                  {inputs.map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-slate-300">Dispositivo de saída</Label>
              <Select
                value={prefs.outputDeviceId || ""}
                onValueChange={(v) => setPrefs((p) => ({ ...p, outputDeviceId: v }))}
              >
                <SelectTrigger className="mt-2 bg-slate-800 text-white">
                  <SelectValue placeholder="Selecione o alto-falante" />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 text-white">
                  {outputs.map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
            <div>
              <Label className="text-slate-300">Volume de entrada</Label>
              <div className="mt-2 h-2 w-full rounded bg-slate-800 overflow-hidden">
                <div
                  style={{ width: `${inputLevel}%` }}
                  className={cn(
                    "h-full transition-[width]",
                    inputLevel > 60 ? "bg-green-500" : inputLevel > 30 ? "bg-yellow-500" : "bg-slate-500",
                  )}
                />
              </div>
              <div className="mt-2 flex gap-2">
                {!isTestingMic ? (
                  <Button onClick={startMicTest} className="bg-indigo-600 text-white">Testar microfone</Button>
                ) : (
                  <Button onClick={stopMicTest} variant="secondary" className="bg-slate-800 text-white">Parar teste</Button>
                )}
                <Button onClick={toggleMonitor} variant="secondary" className="bg-slate-800 text-white">
                  {isMonitoring ? "Parar monitor" : "Ouvir microfone"}
                </Button>
              </div>
            </div>

            <div>
              <Label className="text-slate-300">Volume de saída (monitor/teste)</Label>
              <div className="mt-2">
                <Slider
                  value={[Math.round((prefs.monitorVolume ?? 0.25) * 100)]}
                  onValueChange={([v]) => setPrefs((p) => ({ ...p, monitorVolume: (v ?? 25) / 100 }))}
                />
              </div>
              <div className="mt-2 flex gap-2">
                <Button onClick={testOutputBeep} variant="secondary" className="bg-slate-800 text-white">Tocar som de teste</Button>
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-4 bg-slate-900 border-slate-800">
          <h2 className="text-white font-medium mb-3">Processamento de entrada</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex items-center justify-between">
              <Label className="text-slate-300">Cancelamento de eco</Label>
              <Switch
                checked={prefs.echoCancellation}
                onCheckedChange={(v) => setPrefs((p) => ({ ...p, echoCancellation: v }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-slate-300">Supressão de ruído</Label>
              <Switch
                checked={prefs.noiseSuppression}
                onCheckedChange={(v) => setPrefs((p) => ({ ...p, noiseSuppression: v }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-slate-300">Controle automático de ganho</Label>
              <Switch
                checked={prefs.autoGainControl}
                onCheckedChange={(v) => setPrefs((p) => ({ ...p, autoGainControl: v }))}
              />
            </div>
          </div>
        </Card>

        <Card className="p-4 bg-slate-900 border-slate-800">
          <h2 className="text-white font-medium mb-3">Modo de entrada</h2>
          <div className="flex items-center gap-4">
            <Button
              variant={prefs.voiceMode === "vad" ? "default" : "secondary"}
              className={cn(prefs.voiceMode === "vad" ? "bg-indigo-600 text-white" : "bg-slate-800 text-white")}
              onClick={() => setPrefs((p) => ({ ...p, voiceMode: "vad" }))}
            >
              Detecção de voz
            </Button>
            <Button
              variant={prefs.voiceMode === "ptt" ? "default" : "secondary"}
              className={cn(prefs.voiceMode === "ptt" ? "bg-indigo-600 text-white" : "bg-slate-800 text-white")}
              onClick={() => setPrefs((p) => ({ ...p, voiceMode: "ptt" }))}
            >
              Apertar para falar (prévia)
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-400">O modo escolhido será aplicado ao conectar em uma sala.</p>
        </Card>
      </div>
    </div>
  )
}