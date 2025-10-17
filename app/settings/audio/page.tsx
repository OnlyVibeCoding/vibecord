"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { getAudioPrefs, saveAudioPrefs, type AudioPrefs } from "@/lib/audio-prefs"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { SettingsSidebar } from "./sidebar"
import { Mic, Monitor, TestTube2, Settings, Volume2 } from 'lucide-react'

type DeviceInfo = { deviceId: string; label: string }

export default function AudioSettingsPage() {
  const router = useRouter()
  const [inputs, setInputs] = useState<DeviceInfo[]>([])
  const [outputs, setOutputs] = useState<DeviceInfo[]>([])
  const [prefs, setPrefs] = useState<AudioPrefs>(getAudioPrefs())
  const [inputLevel, setInputLevel] = useState(0)
  const [isTestingMic, setIsTestingMic] = useState(false)
  const [isMonitoring, setIsMonitoring] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveNotification, setSaveNotification] = useState<string | null>(null)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const monitorGainRef = useRef<GainNode | null>(null)
  const monitorElementRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const prewarm = async () => {
      try {
        setIsLoading(true)
        setError(null)
        
        // Request audio permission first
        try {
          await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (mediaError) {
          console.warn('Audio permission denied or not available:', mediaError)
          setError('Permissão de áudio negada. Algumas funcionalidades podem estar limitadas.')
        }
        
        // Get audio devices
        const devices = await navigator.mediaDevices.enumerateDevices()
        const audioInputs = devices.filter(d => d.kind === 'audioinput')
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput')
        
        setInputs(audioInputs.map(d => ({ 
          deviceId: d.deviceId, 
          label: d.label || `Microfone ${audioInputs.indexOf(d) + 1}` 
        })))
        
        setOutputs(audioOutputs.map(d => ({ 
          deviceId: d.deviceId, 
          label: d.label || `Alto-falantes ${audioOutputs.indexOf(d) + 1}` 
        })))
        
        // Auto-select first devices if none selected
        if (!prefs.inputDeviceId && audioInputs.length > 0) {
          setPrefs(p => ({ ...p, inputDeviceId: audioInputs[0].deviceId }))
        }
        if (!prefs.outputDeviceId && audioOutputs.length > 0) {
          setPrefs(p => ({ ...p, outputDeviceId: audioOutputs[0].deviceId }))
        }
        
      } catch (err) {
        console.error('Failed to enumerate devices:', err)
        setError('Erro ao carregar dispositivos de áudio. Por favor, recarregue a página.')
      } finally {
        setIsLoading(false)
      }
    }
    
    prewarm()
  }, [])

  useEffect(() => {
    saveAudioPrefs(prefs)
    
    // Show save notification
    setSaveNotification('Configurações salvas!')
    setTimeout(() => setSaveNotification(null), 3000)
  }, [prefs])

  const startMicTest = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: prefs.inputDeviceId ? { exact: prefs.inputDeviceId } : undefined,
          ...prefs
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
      alert("Failed to start microphone test.")
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
    const stream = micStreamRef.current
    if (!stream) {
      alert("Start microphone test first.")
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
      console.warn("setSinkId not supported or failed:", e)
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
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = 440
      gain.gain.setValueAtTime(0.1, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5)
      osc.start()
      osc.stop(ctx.currentTime + 0.6)
      setTimeout(() => {
        try { ctx.close() } catch {}
      }, 600)
    } catch (e) {
      console.error(e)
      alert("Failed to play test sound.")
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-400 mx-auto mb-4"></div>
          <p className="text-white text-lg">Carregando configurações de áudio...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white items-center justify-center">
        <div className="bg-red-500/20 backdrop-blur-sm border border-red-500/30 rounded-lg p-6 max-w-md mx-4">
          <div className="flex items-center mb-4">
            <svg className="w-6 h-6 text-red-400 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="text-red-400 font-semibold">Erro</h3>
          </div>
          <p className="text-white mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg transition-colors duration-200"
          >
            Recarregar Página
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-cyan-900">
      <div className="flex h-screen">
        <SettingsSidebar />
        
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="max-w-6xl mx-auto">
            {/* Save Notification */}
            {saveNotification && (
              <div className="fixed top-4 right-4 z-50 bg-green-500/90 backdrop-blur-sm text-white px-6 py-3 rounded-lg shadow-lg animate-fade-in">
                <div className="flex items-center">
                  <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {saveNotification}
                </div>
              </div>
            )}
            
            <div className="mb-8">
              <h1 className="text-4xl font-bold bg-gradient-to-r from-cyan-400 via-purple-400 to-pink-400 bg-clip-text text-transparent mb-2">
                Voz e Vídeo
              </h1>
              <p className="text-slate-400 text-lg">Personalize sua experiência de áudio no Vibecord.</p>
            </div>

            <div className="space-y-6 md:space-y-8">
              {/* Device Selection */}
              <Card className="p-6 bg-slate-900/80 backdrop-blur-sm border border-cyan-500/20 shadow-2xl shadow-cyan-500/10 hover:shadow-cyan-500/20 transition-all duration-300">
                <h2 className="text-2xl font-semibold text-white mb-6 flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500 flex items-center justify-center">
                    <Mic className="h-4 w-4 text-white" />
                  </div>
                  Dispositivos de Áudio
                </h2>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <Label className="text-slate-300 font-medium">Microfone</Label>
                    <Select value={prefs.inputDeviceId || ""} onValueChange={(v) => setPrefs(p => ({ ...p, inputDeviceId: v }))}>
                      <SelectTrigger className="bg-slate-800/50 border-slate-600 text-white hover:bg-slate-700/50 transition-colors">
                        <SelectValue placeholder="Selecione um microfone" />
                      </SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-600">
                        {inputs.map(input => (
                          <SelectItem key={input.deviceId} value={input.deviceId} className="text-white hover:bg-slate-700">
                            {input.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {inputs.length === 0 && (
                      <p className="text-amber-400 text-sm flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                        Nenhum microfone detectado
                      </p>
                    )}
                  </div>
                  
                  <div className="space-y-3">
                    <Label className="text-slate-300 font-medium">Alto-falantes</Label>
                    <Select value={prefs.outputDeviceId || ""} onValueChange={(v) => setPrefs(p => ({ ...p, outputDeviceId: v }))}>
                      <SelectTrigger className="bg-slate-800/50 border-slate-600 text-white hover:bg-slate-700/50 transition-colors">
                        <SelectValue placeholder="Selecione os alto-falantes" />
                      </SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-600">
                        {outputs.map(output => (
                          <SelectItem key={output.deviceId} value={output.deviceId} className="text-white hover:bg-slate-700">
                            {output.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {outputs.length === 0 && (
                      <p className="text-amber-400 text-sm flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                        Nenhum dispositivo de saída detectado
                      </p>
                    )}
                  </div>
                </div>
              </Card>

              {/* Audio Test */}
              <Card className="p-6 bg-slate-900/80 backdrop-blur-sm border border-purple-500/20 shadow-2xl shadow-purple-500/10 hover:shadow-purple-500/20 transition-all duration-300">
                <h2 className="text-2xl font-semibold text-white mb-6 flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 flex items-center justify-center">
                    <TestTube2 className="h-4 w-4 text-white" />
                  </div>
                  Teste de Áudio
                </h2>
                
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <Label className="text-slate-300 font-medium">Nível do Microfone</Label>
                      <span className="text-cyan-400 font-mono text-sm">{inputLevel}%</span>
                    </div>
                    <div className="h-3 bg-slate-700 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-gradient-to-r from-green-500 via-yellow-500 to-red-500 transition-all duration-100 ease-out"
                        style={{ width: `${inputLevel}%` }}
                      />
                    </div>
                    <Button
                      onClick={isTestingMic ? stopMicTest : startMicTest}
                      className={cn(
                        "w-full transition-all duration-200",
                        isTestingMic 
                          ? "bg-red-600 hover:bg-red-700 text-white" 
                          : "bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-700 hover:to-purple-700 text-white"
                      )}
                    >
                      {isTestingMic ? "Parar Teste" : "Testar Microfone"}
                    </Button>
                  </div>
                  
                  <div className="space-y-4">
                    <Label className="text-slate-300 font-medium">Volume do Monitor</Label>
                    <Slider
                      value={[prefs.monitorVolume ?? 0.25]}
                      onValueChange={([v]) => setPrefs(p => ({ ...p, monitorVolume: v }))}
                      max={1}
                      step={0.01}
                      className="w-full"
                    />
                    <Button
                      onClick={toggleMonitor}
                      disabled={!isTestingMic}
                      className={cn(
                        "w-full transition-all duration-200",
                        !isTestingMic && "opacity-50 cursor-not-allowed",
                        isMonitoring 
                          ? "bg-orange-600 hover:bg-orange-700 text-white" 
                          : "bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white"
                      )}
                    >
                      <Monitor className="h-4 w-4 mr-2" />
                      {isMonitoring ? "Parar Monitor" : "Monitorar"}
                    </Button>
                  </div>
                  
                  <div className="space-y-4">
                    <Label className="text-slate-300 font-medium">Teste de Som</Label>
                    <p className="text-slate-400 text-sm">Reproduz um tom de teste nos alto-falantes selecionados.</p>
                    <Button
                      onClick={testOutputBeep}
                      className="w-full bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-700 hover:to-teal-700 text-white transition-all duration-200"
                    >
                      <Volume2 className="h-4 w-4 mr-2" />
                      Reproduzir Som de Teste
                    </Button>
                  </div>
                </div>
              </Card>

              {/* Voice Processing */}
              <Card className="p-6 bg-slate-900/80 backdrop-blur-sm border border-green-500/20 shadow-2xl shadow-green-500/10 hover:shadow-green-500/20 transition-all duration-300">
                <h2 className="text-2xl font-semibold text-white mb-6 flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-gradient-to-r from-green-500 to-emerald-500 flex items-center justify-center">
                    <Settings className="h-4 w-4 text-white" />
                  </div>
                  Processamento de Voz
                </h2>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-slate-300 font-medium">Cancelamento de Eco</Label>
                      <Switch
                        checked={prefs.echoCancellation ?? true}
                        onCheckedChange={(v) => setPrefs(p => ({ ...p, echoCancellation: v }))}
                      />
                    </div>
                    <p className="text-slate-400 text-sm">Remove ecos e reverberações indesejadas.</p>
                  </div>
                  
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-slate-300 font-medium">Supressão de Ruído</Label>
                      <Switch
                        checked={prefs.noiseSuppression ?? true}
                        onCheckedChange={(v) => setPrefs(p => ({ ...p, noiseSuppression: v }))}
                      />
                    </div>
                    <p className="text-slate-400 text-sm">Reduz ruídos de fundo automaticamente.</p>
                  </div>
                  
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-slate-300 font-medium">Controle Automático de Ganho</Label>
                      <Switch
                        checked={prefs.autoGainControl ?? true}
                        onCheckedChange={(v) => setPrefs(p => ({ ...p, autoGainControl: v }))}
                      />
                    </div>
                    <p className="text-slate-400 text-sm">Ajusta automaticamente o volume do microfone.</p>
                  </div>
                </div>
              </Card>

              {/* Voice Mode */}
              <Card className="p-6 bg-slate-900/80 backdrop-blur-sm border border-orange-500/20 shadow-2xl shadow-orange-500/10 hover:shadow-orange-500/20 transition-all duration-300">
                <h2 className="text-2xl font-semibold text-white mb-6 flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-gradient-to-r from-orange-500 to-red-500 flex items-center justify-center">
                    <Mic className="h-4 w-4 text-white" />
                  </div>
                  Modo de Transmissão
                </h2>
                
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Button
                      variant={prefs.voiceMode === "vad" ? "default" : "outline"}
                      onClick={() => setPrefs(p => ({ ...p, voiceMode: "vad" }))}
                      className={cn(
                        "h-auto p-4 flex flex-col items-start text-left transition-all duration-200",
                        prefs.voiceMode === "vad" 
                          ? "bg-gradient-to-r from-cyan-600 to-purple-600 text-white border-cyan-500" 
                          : "bg-slate-800/50 text-slate-300 border-slate-600 hover:bg-slate-700/50 hover:text-white"
                      )}
                    >
                      <div className="font-semibold mb-2">Detecção de Atividade de Voz</div>
                      <div className="text-sm opacity-90">Transmite automaticamente quando você fala</div>
                    </Button>
                    
                    <Button
                      variant={prefs.voiceMode === "ptt" ? "default" : "outline"}
                      onClick={() => setPrefs(p => ({ ...p, voiceMode: "ptt" }))}
                      className={cn(
                        "h-auto p-4 flex flex-col items-start text-left transition-all duration-200",
                        prefs.voiceMode === "ptt" 
                          ? "bg-gradient-to-r from-orange-600 to-red-600 text-white border-orange-500" 
                          : "bg-slate-800/50 text-slate-300 border-slate-600 hover:bg-slate-700/50 hover:text-white"
                      )}
                    >
                      <div className="font-semibold mb-2">Apertar para Falar</div>
                      <div className="text-sm opacity-90">Mantenha pressionado para transmitir</div>
                    </Button>
                  </div>
                  
                  <div className="bg-slate-800/30 rounded-lg p-4 border border-slate-700/50">
                    <p className="text-slate-300 text-sm leading-relaxed">
                      <strong className="text-white">Dica:</strong> A "Detecção de Atividade de Voz" é ideal para conversas casuais, 
                      enquanto "Apertar para Falar" oferece mais controle em ambientes barulhentos.
                    </p>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}