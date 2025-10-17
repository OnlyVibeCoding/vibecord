"use client"

import { useState, useEffect, useRef } from "react"
import { getAudioPrefs } from "@/lib/audio-prefs"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Mic, MicOff, Volume2, VolumeX, PhoneOff, Users, Hash, LogOut, Headphones } from "lucide-react"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import type { RealtimeChannel } from "@supabase/supabase-js"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

interface Profile {
  id: string
  display_name: string
  avatar_url: string | null
}

interface Room {
  id: string
  name: string
  created_by: string
  created_at: string
}

interface RoomParticipant {
  room_id: string
  user_id: string
  joined_at: string
  is_speaking: boolean
  is_muted: boolean
  is_deafened: boolean
  profiles: Profile
}

export function VoiceApp() {
  const router = useRouter()
  const supabase = createClient()

  const [currentUser, setCurrentUser] = useState<Profile | null>(null)
  const [rooms, setRooms] = useState<Room[]>([])
  const [currentRoom, setCurrentRoom] = useState<string | null>(null)
  const [participants, setParticipants] = useState<RoomParticipant[]>([])
  const [roomCounts, setRoomCounts] = useState<Record<string, number>>({})
  const [isMuted, setIsMuted] = useState(false)
  const [isDeafened, setIsDeafened] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const mediaStreamRef = useRef<MediaStream | null>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const countsChannelRef = useRef<RealtimeChannel | null>(null)
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({})
  const remoteAudioElsRef = useRef<Record<string, HTMLAudioElement>>({})
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const micTestStreamRef = useRef<MediaStream | null>(null)
  const levelRafRef = useRef<number | null>(null)
  const speakingStateRef = useRef<boolean>(false)
  const monitorGainRef = useRef<GainNode | null>(null)
  const monitorSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const monitorElementRef = useRef<HTMLAudioElement | null>(null)

  const [inputLevel, setInputLevel] = useState(0)
  const [isTestingMic, setIsTestingMic] = useState(false)
  const [isSpeakingLocal, setIsSpeakingLocal] = useState(false)
  const [isMonitoringMic, setIsMonitoringMic] = useState(false)

  useEffect(() => {
    loadUserData()
    loadRooms()
  }, [])

  // Assinatura global para contagens por sala
  useEffect(() => {
    const loadRoomCounts = async () => {
      try {
        const { data, error } = await supabase.from("room_participants").select("room_id")
        if (error) throw error
        const counts: Record<string, number> = {}
        ;(data || []).forEach((row: any) => {
          const rid = row.room_id
          counts[rid] = (counts[rid] || 0) + 1
        })
        setRoomCounts(counts)
      } catch (e) {
        console.error("[v0] Error loading room counts:", e)
      }
    }

    const channel = supabase
      .channel("room_counts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "room_participants" },
        (payload: any) => {
          const rid = payload?.new?.room_id
          if (!rid) return
          setRoomCounts((prev) => ({ ...prev, [rid]: (prev[rid] || 0) + 1 }))
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "room_participants" },
        (payload: any) => {
          const rid = payload?.old?.room_id
          if (!rid) return
          setRoomCounts((prev) => {
            const next = { ...prev }
            next[rid] = Math.max(0, (next[rid] || 0) - 1)
            return next
          })
        },
      )
      .subscribe()

    countsChannelRef.current = channel
    loadRoomCounts()

    return () => {
      channel.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!currentRoom || !currentUser) return

    const channel = supabase.channel(`room:${currentRoom}`, {
      config: { presence: { key: currentUser.id } },
    })

    channel
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "room_participants",
          filter: `room_id=eq.${currentRoom}`,
        },
        () => {
          loadParticipants(currentRoom)
        },
      )
      .on("presence", { event: "sync" }, () => {
        // Conectar com todos presentes (mesh simples)
        const state = channel.presenceState() as Record<string, any[]>
        const peers: string[] = Object.values(state)
          .flat()
          .map((p: any) => p.user_id)
          .filter((uid: string) => uid && uid !== currentUser.id)
        peers.forEach((uid) => initiateOffer(uid))
      })
      .on("presence", { event: "join" }, (payload: any) => {
        const presences = (payload?.newPresences || []) as any[]
        presences.forEach((p) => {
          const uid = p?.user_id
          if (uid && uid !== currentUser.id) initiateOffer(uid)
        })
      })
      .on("broadcast", { event: "webrtc-offer" }, async ({ payload }: any) => {
        if (!payload || payload.toId !== currentUser.id) return
        const fromId = payload.fromId as string
        const sdp = payload.sdp
        const pc = createPeerConnection(fromId)
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp))
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          channel.send({
            type: "broadcast",
            event: "webrtc-answer",
            payload: { fromId: currentUser.id, toId: fromId, sdp: answer },
          })
        } catch (e) {
          console.error("[v0] Error handling offer:", e)
        }
      })
      .on("broadcast", { event: "webrtc-answer" }, async ({ payload }: any) => {
        if (!payload || payload.toId !== currentUser.id) return
        const fromId = payload.fromId as string
        const sdp = payload.sdp
        const pc = peerConnectionsRef.current[fromId]
        if (!pc) return
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp))
        } catch (e) {
          console.error("[v0] Error handling answer:", e)
        }
      })
      .on("broadcast", { event: "webrtc-ice" }, async ({ payload }: any) => {
        if (!payload || payload.toId !== currentUser.id) return
        const fromId = payload.fromId as string
        const candidate = payload.candidate
        const pc = peerConnectionsRef.current[fromId]
        if (!pc || !candidate) return
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate))
        } catch (e) {
          console.error("[v0] Error adding ICE candidate:", e)
        }
      })

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        try {
          await channel.track({ user_id: currentUser.id, display_name: currentUser.display_name })
        } catch (e) {
          console.warn("[v0] Presence track failed:", e)
        }
        loadParticipants(currentRoom)
      }
    })

    channelRef.current = channel

    return () => {
      channel.unsubscribe()
      // Fechar conexões e parar áudios ao sair da sala
      Object.values(peerConnectionsRef.current).forEach((pc) => {
        try { pc.close() } catch {}
      })
      peerConnectionsRef.current = { }
      Object.values(remoteAudioElsRef.current).forEach((el) => {
        try { el.pause() } catch {}
      })
      remoteAudioElsRef.current = { }
    }
  }, [currentRoom, currentUser])

  const createPeerConnection = (peerId: string) => {
    let pc = peerConnectionsRef.current[peerId]
    if (pc) return pc
    pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    })

    const localStream = mediaStreamRef.current
    if (localStream) {
      const track = localStream.getAudioTracks()[0]
      if (track) pc.addTrack(track, localStream)
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate) return
      const channel = channelRef.current
      if (!channel || !currentUser) return
      channel.send({
        type: "broadcast",
        event: "webrtc-ice",
        payload: { fromId: currentUser.id, toId: peerId, candidate: e.candidate },
      })
    }

    pc.ontrack = (evt) => {
      const stream = evt.streams[0]
      if (!stream) return
      let el = remoteAudioElsRef.current[peerId]
      if (!el) {
        el = new Audio()
        el.autoplay = true
        remoteAudioElsRef.current[peerId] = el
      }
      ;(el as any).srcObject = stream
      const prefs = getAudioPrefs()
      if ((el as any).setSinkId && prefs.outputDeviceId) {
        ;(el as any).setSinkId(prefs.outputDeviceId).catch((e: any) =>
          console.warn("setSinkId remote failed:", e),
        )
      }
      try { el.play() } catch (e) { console.error(e) }
    }

    peerConnectionsRef.current[peerId] = pc
    return pc
  }

  const initiateOffer = async (peerId: string) => {
    try {
      if (!currentUser) return
      const pc = createPeerConnection(peerId)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const channel = channelRef.current
      channel?.send({
        type: "broadcast",
        event: "webrtc-offer",
        payload: { fromId: currentUser.id, toId: peerId, sdp: offer },
      })
    } catch (e) {
      console.error("[v0] Error initiating offer:", e)
    }
  }

  const loadUserData = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        router.push("/auth/login")
        return
      }

      // Verificar se o perfil existe
      const { data: profile, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .maybeSingle() // Usa maybeSingle em vez de single para não gerar erro se não encontrar

      if (error) {
        console.error("[v0] Error fetching profile:", error)
        return
      }

      if (profile) {
        setCurrentUser(profile)
      } else {
        // Criar um perfil se não existir
        const displayName = user.email ? user.email.split('@')[0] : `user_${Date.now()}`
        
        const { data: newProfile, error: insertError } = await supabase
          .from("profiles")
          .insert([
            { 
              id: user.id, 
              display_name: displayName
            }
          ])
          .select()
          .single()
        
        if (insertError) {
          console.error("[v0] Error creating profile:", insertError)
          return
        }
        
        setCurrentUser(newProfile)
      }
    } catch (error) {
      console.error("[v0] Error loading user data:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const loadRooms = async () => {
    try {
      const { data, error } = await supabase.from("rooms").select("*").order("created_at", { ascending: true })

      if (error) throw error
      if (data) setRooms(data)
    } catch (error) {
      console.error("[v0] Error loading rooms:", error)
    }
  }

  const loadParticipants = async (roomId: string) => {
    try {
      const { data, error } = await supabase
        .from("room_participants")
        .select(`
          *,
          profiles (
            id,
            display_name,
            avatar_url
          )
        `)
        .eq("room_id", roomId)

      if (error) throw error
      if (data) setParticipants(data as RoomParticipant[])
    } catch (error) {
      console.error("[v0] Error loading participants:", error)
    }
  }

  const handleConnectToRoom = async (roomId: string) => {
    if (!currentUser) return

    try {
      const prefs = getAudioPrefs()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: prefs.inputDeviceId ? { exact: prefs.inputDeviceId } : undefined,
          echoCancellation: prefs.echoCancellation,
          noiseSuppression: prefs.noiseSuppression,
          autoGainControl: prefs.autoGainControl,
        },
      })
      mediaStreamRef.current = stream

      setupAnalyser(stream, true)

      const { error } = await supabase.from("room_participants").insert({
        room_id: roomId,
        user_id: currentUser.id,
        is_muted: false,
        is_deafened: false,
        is_speaking: false,
      })

      if (error && error.code !== "23505") {
        // Ignore duplicate key error
        throw error
      }

      setIsConnected(true)
      setCurrentRoom(roomId)
    } catch (error) {
      console.error("[v0] Error connecting to room:", error)
      alert("Não foi possível conectar à sala. Verifique as permissões do microfone.")
    }
  }

  const handleDisconnect = async () => {
    if (!currentUser || !currentRoom) return

    try {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop())
        mediaStreamRef.current = null
      }

      stopLevelMonitor()
      stopMonitor()

      await supabase.from("room_participants").delete().eq("room_id", currentRoom).eq("user_id", currentUser.id)

      setIsConnected(false)
      setCurrentRoom(null)
      setParticipants([])
      setIsMuted(false)
      setIsDeafened(false)
    } catch (error) {
      console.error("[v0] Error disconnecting:", error)
    }
  }

  const toggleMute = async () => {
    if (!currentUser || !currentRoom) return

    const newMutedState = !isMuted
    setIsMuted(newMutedState)

    await supabase
      .from("room_participants")
      .update({ is_muted: newMutedState })
      .eq("room_id", currentRoom)
      .eq("user_id", currentUser.id)

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !newMutedState
      })
    }
  }

  const toggleDeafen = async () => {
    if (!currentUser || !currentRoom) return

    const newDeafenState = !isDeafened
    setIsDeafened(newDeafenState)

    await supabase
      .from("room_participants")
      .update({
        is_deafened: newDeafenState,
        is_muted: newDeafenState ? true : isMuted,
      })
      .eq("room_id", currentRoom)
      .eq("user_id", currentUser.id)

    if (newDeafenState) {
      setIsMuted(true)
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = false
        })
      }
    } else {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = !isMuted
        })
      }
    }
  }

  const setupAnalyser = (stream: MediaStream, forRoomUpdate: boolean) => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      audioContextRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.8
      source.connect(analyser)
      analyserRef.current = analyser
      startLevelMonitor(forRoomUpdate)
    } catch (err) {
      console.error("[v0] Error setting up analyser:", err)
    }
  }

  const startLevelMonitor = (forRoomUpdate: boolean) => {
    const measure = async () => {
      const analyser = analyserRef.current
      if (!analyser) return

      const data = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const s = data[i]
        sum += s * s
      }
      const rms = Math.sqrt(sum / data.length)
      const level = Math.min(1, rms * 4)
      const pct = Math.round(level * 100)
      setInputLevel(pct)

      const speaking = pct > 15 && !isMuted && !isDeafened
      setIsSpeakingLocal(speaking)

      if (forRoomUpdate && currentUser && currentRoom && speaking !== speakingStateRef.current) {
        speakingStateRef.current = speaking
        try {
          await supabase
            .from("room_participants")
            .update({ is_speaking: speaking })
            .eq("room_id", currentRoom)
            .eq("user_id", currentUser.id)
        } catch (e) {
          console.error("[v0] Error updating speaking state:", e)
        }
      }

      levelRafRef.current = requestAnimationFrame(measure)
    }
    if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
    levelRafRef.current = requestAnimationFrame(measure)
  }

  const stopLevelMonitor = () => {
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current)
      levelRafRef.current = null
    }
    setInputLevel(0)
    setIsSpeakingLocal(false)
    speakingStateRef.current = false
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close()
      } catch {}
      audioContextRef.current = null
    }
    analyserRef.current = null
  }

  const startMicTest = async () => {
    try {
      const prefs = getAudioPrefs()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: prefs.inputDeviceId ? { exact: prefs.inputDeviceId } : undefined,
          echoCancellation: prefs.echoCancellation,
          noiseSuppression: prefs.noiseSuppression,
          autoGainControl: prefs.autoGainControl,
        },
      })
      micTestStreamRef.current = stream
      setIsTestingMic(true)
      setupAnalyser(stream, false)
    } catch (err) {
      console.error("[v0] Error starting mic test:", err)
      alert("Não foi possível acessar o microfone para teste.")
    }
  }

  const stopMicTest = () => {
    setIsTestingMic(false)
    if (micTestStreamRef.current) {
      micTestStreamRef.current.getTracks().forEach((t) => t.stop())
      micTestStreamRef.current = null
    }
    stopLevelMonitor()
    stopMonitor()
  }

  const startMonitor = async () => {
    try {
      if (isMonitoringMic) return
      const stream = micTestStreamRef.current || mediaStreamRef.current
      if (!stream) {
        alert("Inicie o teste de microfone ou conecte-se a uma sala para ouvir.")
        return
      }
      const ctx = audioContextRef.current || new (window.AudioContext || (window as any).webkitAudioContext)()
      audioContextRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const gain = ctx.createGain()
      const prefs = getAudioPrefs()
      gain.gain.value = prefs.monitorVolume ?? 0.25
      const dest = ctx.createMediaStreamDestination()
      source.connect(gain)
      gain.connect(dest)
      monitorSourceRef.current = source
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
      setIsMonitoringMic(true)
    } catch (err) {
      console.error("[v0] Error starting monitor:", err)
      alert("Não foi possível iniciar a monitoração do microfone.")
    }
  }

  const stopMonitor = () => {
    try {
      setIsMonitoringMic(false)
      if (monitorGainRef.current) {
        try { monitorGainRef.current.disconnect() } catch {}
        monitorGainRef.current = null
      }
      if (monitorSourceRef.current) {
        try { monitorSourceRef.current.disconnect() } catch {}
        monitorSourceRef.current = null
      }
      const el = monitorElementRef.current
      if (el) {
        try { el.pause() } catch {}
        monitorElementRef.current = null
      }
    } catch (err) {
      console.error("[v0] Error stopping monitor:", err)
    }
  }

  const handleLogout = async () => {
    if (isConnected) {
      await handleDisconnect()
    }
    await supabase.auth.signOut()
    router.push("/auth/login")
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900">
        <div className="text-center">
          <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent mx-auto" />
          <p className="text-slate-400">Carregando...</p>
        </div>
      </div>
    )
  }

  if (!currentUser) {
    return null
  }

  return (
    <div className="flex h-screen bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900">
      {/* Sidebar - Lista de Salas */}
      <div className="flex w-72 flex-col border-r border-slate-800 bg-slate-900/50 backdrop-blur">
        <div className="flex h-14 items-center justify-between border-b border-slate-800 px-4">
          <h2 className="font-semibold text-white">Salas de Voz</h2>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="sm"
                  className="rounded-full bg-slate-800 text-white hover:bg-indigo-600 gap-2 px-3"
                  onClick={() => router.push("/settings/audio")}
                >
                  <Headphones className="h-4 w-4" />
                  <span>Áudio</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="bg-slate-800 text-white border-slate-700">
                Configurar dispositivos e voz
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        <ScrollArea className="flex-1 p-2">
          <div className="space-y-1">
            {rooms.map((room) => {
              const roomParticipantCount =
                currentRoom === room.id ? participants.length : roomCounts[room.id] ?? 0
              return (
                <button
                  key={room.id}
                  onClick={() => !isConnected && handleConnectToRoom(room.id)}
                  disabled={isConnected && currentRoom !== room.id}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
                    currentRoom === room.id ? "bg-indigo-600 text-white" : "text-slate-300 hover:bg-slate-800",
                    isConnected && currentRoom !== room.id && "opacity-50 cursor-not-allowed",
                  )}
                >
                  <Hash className="h-4 w-4 text-slate-400" />
                  <div className="flex-1">
                    <div className="font-medium">{room.name}</div>
                    <div className="flex items-center gap-1 text-xs text-slate-300">
                      <Users className="h-3 w-3" />
                      {roomParticipantCount} {roomParticipantCount === 1 ? "usuário" : "usuários"}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </ScrollArea>

        {/* Controles de Usuário */}
        <div className="border-t border-slate-800 bg-slate-900/80 p-3">
          <div className="mb-3 flex items-center gap-3">
            <Avatar className={cn("h-8 w-8", isSpeakingLocal && "ring-2 ring-green-500") }>
              <AvatarFallback className="bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-sm">
                {currentUser.display_name.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 overflow-hidden">
              <div className="truncate text-sm font-medium text-white">{currentUser.display_name}</div>
              <div className="text-xs text-slate-400">{isConnected ? "Conectado" : "Desconectado"}</div>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-slate-400 hover:text-white hover:bg-slate-800"
              onClick={handleLogout}
              title="Sair"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-2 h-2 w-full rounded bg-slate-800 overflow-hidden">
            <div
              style={{ width: `${inputLevel}%` }}
              className={cn(
                "h-full transition-[width]",
                inputLevel > 60 ? "bg-green-500" : inputLevel > 30 ? "bg-yellow-500" : "bg-slate-500",
              )}
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            {!isMonitoringMic ? (
              <Button onClick={startMonitor} variant="secondary" className="bg-slate-800 text-white">
                Ouvir microfone
              </Button>
            ) : (
              <Button onClick={stopMonitor} variant="secondary" className="bg-slate-800 text-white">
                Parar monitor
              </Button>
            )}
            <span className="text-xs text-slate-400">Use com cuidado para evitar eco.</span>
          </div>

          <div className="flex gap-2">
            <Button
              size="icon"
              variant={isMuted ? "destructive" : "secondary"}
              onClick={toggleMute}
              disabled={!isConnected}
              className="flex-1 bg-slate-800 hover:bg-slate-700 text-white disabled:opacity-50"
            >
              {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
            <Button
              size="icon"
              variant={isDeafened ? "destructive" : "secondary"}
              onClick={toggleDeafen}
              disabled={!isConnected}
              className="flex-1 bg-slate-800 hover:bg-slate-700 text-white disabled:opacity-50"
            >
              {isDeafened ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </Button>
            {isConnected && (
              <Button
                size="icon"
                variant="destructive"
                onClick={handleDisconnect}
                className="flex-1 bg-red-600 hover:bg-red-700"
              >
                <PhoneOff className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Área Principal */}
      <div className="flex flex-1 flex-col">
        {/* Header */}
        <div className="flex h-14 items-center justify-between border-b border-slate-800 px-6 bg-slate-900/30 backdrop-blur">
          <div className="flex items-center gap-2">
            <Hash className="h-5 w-5 text-slate-400" />
            <h1 className="text-lg font-semibold text-white">
              {currentRoom ? rooms.find((r) => r.id === currentRoom)?.name : "Selecione uma sala"}
            </h1>
          </div>
          {isConnected && (
            <Badge className="gap-1 bg-green-500/20 text-green-400 border-green-500/30">
              <div className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
              Conectado
            </Badge>
          )}
        </div>

        {/* Lista de Participantes */}
        <div className="flex-1 p-6 overflow-auto">
          {!isConnected ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600">
                  <Volume2 className="h-10 w-10 text-white" />
                </div>
                <h2 className="mb-2 text-xl font-semibold text-white text-balance">Selecione uma sala de voz</h2>
                <p className="text-slate-400 text-pretty">Escolha uma sala na barra lateral para começar a conversar</p>

                <div className="mt-6 flex flex-col items-center gap-3">
                  <div className="w-64 h-3 rounded bg-slate-800 overflow-hidden">
                    <div
                      style={{ width: `${inputLevel}%` }}
                      className="h-full bg-indigo-500 transition-[width]"
                    />
                  </div>
                  {!isTestingMic ? (
                    <Button onClick={startMicTest} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                      Testar microfone
                    </Button>
                  ) : (
                    <Button onClick={stopMicTest} variant="secondary" className="bg-slate-800 text-white">
                      Parar teste
                    </Button>
                  )}
                  {!isMonitoringMic ? (
                    <Button onClick={startMonitor} variant="secondary" className="bg-slate-800 text-white">
                      Ouvir microfone
                    </Button>
                  ) : (
                    <Button onClick={stopMonitor} variant="secondary" className="bg-slate-800 text-white">
                      Parar monitor
                    </Button>
                  )}
                  <p className="text-xs text-slate-400">Fale algo e veja a barra mover.</p>
                  <p className="text-xs text-slate-500">Ative “Ouvir microfone” para monitorar a qualidade.</p>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-4 flex items-center gap-2">
                <Users className="h-5 w-5 text-slate-400" />
                <h2 className="font-semibold text-white">Participantes — {participants.length}</h2>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {participants.map((participant) => (
                  <Card
                    key={participant.user_id}
                    className={cn(
                      "p-4 transition-all border-slate-800 bg-slate-900/50 backdrop-blur",
                      participant.is_speaking && "ring-2 ring-green-500",
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <Avatar className="h-12 w-12">
                          <AvatarFallback className="bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
                            {participant.profiles.display_name.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        {participant.is_speaking && (
                          <div className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-green-500">
                            <Volume2 className="h-3 w-3 text-white" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 overflow-hidden">
                        <div className="truncate font-medium text-white">
                          {participant.profiles.display_name}
                          {participant.user_id === currentUser.id && (
                            <span className="ml-1 text-xs text-slate-400">(você)</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {participant.is_muted && <MicOff className="h-3 w-3 text-red-400" />}
                          {participant.is_deafened && <VolumeX className="h-3 w-3 text-red-400" />}
                          {!participant.is_muted && !participant.is_deafened && (
                            <span className="text-xs text-green-400">Online</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
