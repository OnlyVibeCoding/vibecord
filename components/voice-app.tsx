"use client"

import { useState, useEffect, useRef } from "react"
import { getAudioPrefs } from "@/lib/audio-prefs"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Mic, MicOff, Volume2, VolumeX, PhoneOff, Users, Hash, LogOut, Headphones, Settings, Menu, X, Zap, Gamepad2 } from "lucide-react"
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
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)

  const mediaStreamRef = useRef<MediaStream | null>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const countsChannelRef = useRef<RealtimeChannel | null>(null)
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({})
  const remoteAudioElsRef = useRef<Record<string, HTMLAudioElement>>({})
  const heartbeatRef = useRef<number | null>(null)
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
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(new Set())
  const [audioLevels, setAudioLevels] = useState<Record<string, number>>({})
  const [lastHeartbeat, setLastHeartbeat] = useState<number>(Date.now())
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const presenceUsersRef = useRef<Set<string>>(new Set())

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
        
        // Atualizar lista de usuários presentes
        const currentPresenceUsers = new Set(Object.values(state).flat().map((p: any) => p.user_id).filter(Boolean))
        presenceUsersRef.current = currentPresenceUsers
        
        // Remover participantes que não estão mais presentes
        cleanupDisconnectedUsers(currentRoom, currentPresenceUsers)
        
        peers.forEach((uid) => initiateOffer(uid))
      })
      .on("presence", { event: "join" }, (payload: any) => {
        const presences = (payload?.newPresences || []) as any[]
        presences.forEach((p) => {
          const uid = p?.user_id
          if (uid && uid !== currentUser.id) {
            presenceUsersRef.current.add(uid)
            initiateOffer(uid)
          }
        })
      })
      .on("presence", { event: "leave" }, (payload: any) => {
        const presences = (payload?.leftPresences || []) as any[]
        presences.forEach((p) => {
          const uid = p?.user_id
          if (uid) {
            presenceUsersRef.current.delete(uid)
            // Remover imediatamente da tabela room_participants
            removeDisconnectedUser(currentRoom, uid)
          }
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
      .on("broadcast", { event: "heartbeat" }, ({ payload }: any) => {
        if (payload?.userId && payload.userId !== currentUser.id) {
          // Atualizar timestamp do heartbeat do usuário
          setLastHeartbeat(Date.now())
        }
      })

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        try {
          await channel.track({ 
            user_id: currentUser.id, 
            display_name: currentUser.display_name,
            last_seen: Date.now()
          })
        } catch (e) {
          console.warn("[v0] Presence track failed:", e)
        }
        loadParticipants(currentRoom)
        startHeartbeat(channel)
      }
    })

    channelRef.current = channel

    return () => {
      stopHeartbeat()
      channel.unsubscribe()
      // Fechar conexões e parar áudios ao sair da sala
      Object.values(peerConnectionsRef.current).forEach((pc) => {
        try { pc.close() } catch {}
      })
      peerConnectionsRef.current = {}
      Object.values(remoteAudioElsRef.current).forEach((el) => {
        try { el.pause() } catch {}
      })
      remoteAudioElsRef.current = {}
      setAudioLevels({})
      setAudioLevels({})
      setSpeakingUsers(new Set())
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

  // Função para remover usuário desconectado
  const removeDisconnectedUser = async (roomId: string, userId: string) => {
    try {
      const { error } = await supabase
        .from("room_participants")
        .delete()
        .eq("room_id", roomId)
        .eq("user_id", userId)

      if (error) {
        console.error("[v0] Error removing disconnected user:", error)
      } else {
        console.log(`[v0] Removed disconnected user ${userId} from room ${roomId}`)
      }
    } catch (error) {
      console.error("[v0] Error removing disconnected user:", error)
    }
  }

  // Função para limpar usuários desconectados baseado na presença
  const cleanupDisconnectedUsers = async (roomId: string, presenceUsers: Set<string>) => {
    try {
      // Buscar todos os participantes da sala
      const { data: roomParticipants, error } = await supabase
        .from("room_participants")
        .select("user_id")
        .eq("room_id", roomId)

      if (error) {
        console.error("[v0] Error fetching room participants:", error)
        return
      }

      // Encontrar usuários que estão na tabela mas não estão presentes
      const disconnectedUsers = roomParticipants?.filter(
        participant => !presenceUsers.has(participant.user_id)
      ) || []

      // Remover usuários desconectados
      for (const user of disconnectedUsers) {
        await removeDisconnectedUser(roomId, user.user_id)
      }

      if (disconnectedUsers.length > 0) {
        console.log(`[v0] Cleaned up ${disconnectedUsers.length} disconnected users`)
      }
    } catch (error) {
      console.error("[v0] Error during cleanup:", error)
    }
  }

  // Sistema de heartbeat para detectar conexões perdidas
  const startHeartbeat = (channel: any) => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current)
    }

    heartbeatIntervalRef.current = setInterval(() => {
      if (currentUser && currentRoom) {
        channel.send({
          type: "broadcast",
          event: "heartbeat",
          payload: { 
            userId: currentUser.id, 
            timestamp: Date.now(),
            roomId: currentRoom
          }
        })
      }
    }, 30000) // Heartbeat a cada 30 segundos
  }

  const stopHeartbeat = () => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current)
      heartbeatIntervalRef.current = null
    }
  }

  // Cleanup periódico baseado em inatividade
  useEffect(() => {
    if (!currentRoom) return

    const cleanupInterval = setInterval(async () => {
      if (currentRoom && presenceUsersRef.current.size > 0) {
        await cleanupDisconnectedUsers(currentRoom, presenceUsersRef.current)
      }
    }, 60000) // Cleanup a cada 1 minuto

    return () => clearInterval(cleanupInterval)
  }, [currentRoom])

  // Cleanup ao desmontar o componente
  useEffect(() => {
    const handleBeforeUnload = async () => {
      if (currentUser && currentRoom) {
        await removeDisconnectedUser(currentRoom, currentUser.id)
      }
    }

    const handleVisibilityChange = async () => {
      if (document.hidden && currentUser && currentRoom) {
        // Usuário saiu da aba/minimizou - remover após delay
        setTimeout(async () => {
          if (document.hidden && currentUser && currentRoom) {
            await removeDisconnectedUser(currentRoom, currentUser.id)
          }
        }, 10000) // 10 segundos de delay
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      stopHeartbeat()
    }
  }, [currentUser, currentRoom])

  const handleLogout = async () => {
    if (isConnected) {
      await handleDisconnect()
    }
    await supabase.auth.signOut()
    router.push("/auth/login")
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
        <div className="text-center">
          <div className="mb-4 inline-flex h-16 w-16 animate-spin items-center justify-center rounded-full bg-gradient-to-r from-cyan-500 to-purple-500">
            <Gamepad2 className="h-8 w-8 text-white" />
          </div>
          <p className="text-lg font-medium text-white">Carregando GameVoice...</p>
          <div className="mt-2 h-1 w-48 overflow-hidden rounded-full bg-slate-700">
            <div className="h-full w-full animate-pulse bg-gradient-to-r from-cyan-500 to-purple-500"></div>
          </div>
        </div>
      </div>
    )
  }

  if (!currentUser) {
    return null
  }

  return (
    <div className="flex h-screen bg-gradient-to-br from-slate-900 via-purple-900/20 to-slate-900 text-white overflow-hidden">
      {/* Mobile Header */}
      <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between bg-slate-900/95 backdrop-blur-md border-b border-cyan-500/20 p-4 lg:hidden">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500">
            <Gamepad2 className="h-5 w-5 text-white" />
          </div>
          <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent">
            GameVoice
          </h1>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="text-cyan-400 hover:bg-cyan-500/10 hover:text-cyan-300 transition-all duration-200"
        >
          {isSidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
      </div>

      {/* Sidebar */}
      <div className={cn(
        "fixed inset-y-0 left-0 z-40 w-80 transform bg-slate-900/95 backdrop-blur-xl border-r border-cyan-500/20 transition-transform duration-300 ease-in-out lg:relative lg:translate-x-0 flex flex-col relative",
        isSidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {/* Sidebar Header */}
        <div className="flex items-center gap-3 border-b border-cyan-500/20 p-6 bg-gradient-to-r from-slate-900 to-slate-800">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-r from-cyan-500 to-purple-500 shadow-lg shadow-cyan-500/25">
            <Gamepad2 className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent">
              Vibecord
            </h1>
            <p className="text-xs text-slate-400">Ultimate Gaming Voice Chat</p>
          </div>
        </div>

        {/* Rooms List */}
        <ScrollArea className="flex-1 p-4 pb-28">
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Zap className="h-4 w-4 text-cyan-400" />
              Game Rooms
            </h2>
          </div>
          <div className="space-y-2">
            {rooms.map((room) => {
              const roomParticipantCount = currentRoom === room.id ? participants.length : roomCounts[room.id] ?? 0
              const isCurrentRoom = currentRoom === room.id
              return (
                <div
                  key={room.id}
                  className={cn(
                    "group relative overflow-hidden rounded-xl border transition-all duration-200 cursor-pointer",
                    isCurrentRoom 
                      ? "bg-gradient-to-r from-cyan-600/20 to-purple-600/20 border-cyan-500/50 shadow-lg shadow-cyan-500/25" 
                      : "bg-slate-800/50 border-slate-700/50 hover:bg-slate-800/80 hover:border-cyan-500/30 hover:shadow-lg hover:shadow-cyan-500/10"
                  )}
                  onClick={() => !isConnected && handleConnectToRoom(room.id)}
                >
                  {/* Animated background gradient */}
                  <div className={cn(
                    "absolute inset-0 bg-gradient-to-r from-cyan-500/10 to-purple-500/10 opacity-0 transition-opacity duration-200",
                    isCurrentRoom ? "opacity-100" : "group-hover:opacity-50"
                  )} />
                  
                  <div className="relative p-4">
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-lg transition-all duration-300",
                        "group-hover:scale-110 group-hover:rotate-3",
                        isCurrentRoom
                          ? "bg-gradient-to-r from-cyan-500 to-purple-500 shadow-lg shadow-cyan-500/25"
                          : "bg-gradient-to-r from-slate-600 to-slate-500 group-hover:from-cyan-500/80 group-hover:to-purple-500/80"
                      )}>
                        <Hash className={cn(
                          "h-5 w-5 transition-all duration-300",
                          isCurrentRoom ? "text-white" : "text-slate-200 group-hover:text-white"
                        )} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={cn(
                          "font-semibold truncate transition-all duration-300",
                          "group-hover:translate-x-1",
                          isCurrentRoom ? "text-white" : "text-slate-200 group-hover:text-white"
                        )}>
                          {room.name}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex items-center gap-1">
                            <Users className={cn(
                              "h-3 w-3 transition-all duration-300",
                              isCurrentRoom ? "text-cyan-400" : "text-slate-400 group-hover:text-cyan-400"
                            )} />
                            <span className={cn(
                              "text-xs transition-colors duration-300",
                              isCurrentRoom ? "text-slate-300" : "text-slate-400 group-hover:text-slate-300"
                            )}>
                              {roomParticipantCount} {roomParticipantCount === 1 ? "player" : "players"}
                            </span>
                          </div>
                          {roomParticipantCount > 0 && (
                            <div className="flex h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                          )}
                        </div>
                        {isConnected && currentRoom !== room.id && (
                          <div className="text-xs text-slate-500 bg-slate-700/50 px-2 py-1 rounded transition-all duration-300 group-hover:bg-slate-600/50">
                            Locked
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </ScrollArea>

        {/* User Controls */}
        <div className="absolute bottom-0 left-0 right-0 border-t border-slate-800 bg-gradient-to-r from-slate-900 to-slate-800 p-4">
          {currentUser && (
            <div className="mb-4 flex items-center gap-3">
              <Avatar className="h-12 w-12 ring-2 ring-cyan-500/50">
                <AvatarFallback className="bg-gradient-to-br from-cyan-500 to-purple-600 text-white font-semibold">
                  {currentUser.display_name.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white truncate">{currentUser.display_name}</div>
                <div className="text-xs text-slate-400">
                  {isConnected ? "In Game" : "Ready to Play"}
                </div>
              </div>
              <Button
                onClick={() => router.push("/settings/audio")}
                variant="secondary"
                size="sm"
                aria-label="Open Settings"
                className={cn(
                  "shrink-0 transition-all duration-300 hover:scale-105 active:scale-95",
                  "hover:shadow-lg",
                  "bg-slate-700 hover:bg-slate-600 shadow-slate-700/25 hover:shadow-slate-600/40"
                )}
              >
                <Settings className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Audio Controls */}
          {isConnected && (
            <div className="space-y-3">
              {/* Input Level Visualizer */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Mic Level</span>
                  <span>{inputLevel}%</span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div 
                    className={cn(
                      "h-full transition-all duration-100 rounded-full",
                      inputLevel > 70 ? "bg-gradient-to-r from-red-500 to-red-400" :
                      inputLevel > 30 ? "bg-gradient-to-r from-yellow-500 to-orange-400" :
                      "bg-gradient-to-r from-green-500 to-cyan-400"
                    )}
                    style={{ width: `${inputLevel}%` }}
                  />
                </div>
              </div>

              {/* Control Buttons */}
              <div className="flex gap-2">
                <Button
                  onClick={toggleMute}
                  variant={isMuted ? "destructive" : "secondary"}
                  size="sm"
                  className={cn(
                    "transition-all duration-300 hover:scale-105 active:scale-95",
                    "hover:shadow-lg",
                    isMuted 
                      ? "bg-red-600 hover:bg-red-500 shadow-red-500/25 hover:shadow-red-500/40" 
                      : "bg-slate-700 hover:bg-slate-600 shadow-slate-700/25 hover:shadow-slate-600/40"
                  )}
                >
                  {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>
                <Button
                  onClick={toggleDeafen}
                  variant={isDeafened ? "destructive" : "secondary"}
                  size="sm"
                  className={cn(
                    "transition-all duration-300 hover:scale-105 active:scale-95",
                    "hover:shadow-lg",
                    isDeafened 
                      ? "bg-red-600 hover:bg-red-500 shadow-red-500/25 hover:shadow-red-500/40" 
                      : "bg-slate-700 hover:bg-slate-600 shadow-slate-700/25 hover:shadow-slate-600/40"
                  )}
                >
                  {isDeafened ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </Button>
                <Button
                  onClick={() => router.push("/settings/audio")}
                  variant="secondary"
                  size="sm"
                  aria-label="Audio Settings"
                  className={cn(
                    "transition-all duration-300 hover:scale-105 active:scale-95",
                    "hover:shadow-lg",
                    "bg-slate-700 hover:bg-slate-600 shadow-slate-700/25 hover:shadow-slate-600/40"
                  )}
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </div>

              <Button
                onClick={handleDisconnect}
                variant="destructive"
                size="sm"
                className="w-full transition-all duration-300 hover:scale-105 active:scale-95 hover:shadow-lg hover:shadow-red-500/40 bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400"
              >
                <PhoneOff className="mr-2 h-4 w-4" />
                Leave Game
              </Button>
            </div>
          )}

          {/* Mic Testing Controls for Non-Connected State */}
          {!isConnected && (
            <div className="space-y-3">
              {/* Input Level Visualizer */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Mic Level</span>
                  <span>{inputLevel}%</span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div 
                    className={cn(
                      "h-full transition-all duration-100 rounded-full",
                      inputLevel > 70 ? "bg-gradient-to-r from-red-500 to-red-400" :
                      inputLevel > 30 ? "bg-gradient-to-r from-yellow-500 to-orange-400" :
                      "bg-gradient-to-r from-green-500 to-cyan-400"
                    )}
                    style={{ width: `${inputLevel}%` }}
                  />
                </div>
              </div>
            </div>
          )}




        </div>
      </div>

      {/* Mobile Overlay */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Main Area */}
      <div className="flex flex-1 flex-col">
        {/* Room Content */}
        <div className="flex-1 p-4 lg:p-6">
          {currentRoom ? (
            <div className="h-full">
              {/* Room Header */}
              <div className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-r from-cyan-500 to-purple-500 shadow-lg shadow-cyan-500/25">
                    <Hash className="h-6 w-6 text-white" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-bold text-white">
                      {rooms.find(r => r.id === currentRoom)?.name || "Unknown Room"}
                    </h2>
                    <div className="flex items-center gap-2 text-slate-400">
                      <Users className="h-4 w-4" />
                      <span>{participants.length} {participants.length === 1 ? "player" : "players"} connected</span>
                      {isConnected && (
                        <>
                          <div className="h-1 w-1 rounded-full bg-slate-600" />
                          <div className="flex items-center gap-1">
                            <div className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                            <span className="text-green-400">Live</span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Participants Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {participants.map((participant) => {
                  const isSpeaking = speakingUsers.has(participant.user_id)
                  const isCurrentUser = participant.user_id === currentUser?.id
                  const audioLevel = audioLevels[participant.user_id] || 0
                  
                  return (
                    <div
                      key={participant.user_id}
                      className={cn(
                        "group relative overflow-hidden rounded-xl border transition-all duration-300",
                        "hover:scale-[1.02] hover:shadow-lg",
                        isSpeaking 
                          ? "border-green-500/50 bg-gradient-to-br from-green-600/10 to-cyan-600/10 shadow-lg shadow-green-500/20 hover:shadow-green-500/30" 
                          : "border-slate-700/50 bg-slate-800/50 hover:border-slate-600/50 hover:shadow-slate-500/20",
                        isCurrentUser && "ring-2 ring-cyan-500/50 hover:ring-cyan-400/60"
                      )}
                    >
                      {/* Animated speaking indicator */}
                      {isSpeaking && (
                        <div className="absolute inset-0 bg-gradient-to-r from-green-500/10 to-cyan-500/10 animate-pulse" />
                      )}
                      
                      <div className="relative p-4">
                        <div className="flex items-center gap-3 mb-3">
                          <div className="relative">
                            <Avatar className={cn(
                              "h-12 w-12 transition-all duration-300",
                              "group-hover:scale-110",
                              isSpeaking ? "ring-2 ring-green-500 shadow-lg shadow-green-500/25" : "ring-2 ring-slate-700"
                            )}>
                              <AvatarFallback className={cn(
                                "font-semibold transition-all duration-300",
                                isSpeaking 
                                  ? "bg-gradient-to-br from-green-500 to-cyan-500 text-white" 
                                  : "bg-gradient-to-br from-slate-600 to-slate-500 text-slate-200"
                              )}>
                                {participant.profiles.display_name.charAt(0).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            {/* Speaking pulse indicator */}
                            {isSpeaking && (
                              <div className="absolute -inset-1 rounded-full bg-green-500/20 animate-ping" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className={cn(
                              "font-medium truncate transition-all duration-300",
                              "group-hover:translate-x-1",
                              isSpeaking ? "text-white" : "text-slate-200 group-hover:text-white"
                            )}>
                              {participant.profiles.display_name}
                              {isCurrentUser && (
                                <span className="ml-2 text-xs text-cyan-400 animate-pulse">(You)</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <div className={cn(
                                "text-xs transition-colors duration-300",
                                isSpeaking ? "text-green-400" : "text-slate-400 group-hover:text-slate-300"
                              )}>
                                {isSpeaking ? "Speaking" : "Connected"}
                              </div>
                              {!isCurrentUser && (
                                <div className="flex items-center gap-1">
                                  <Volume2 className={cn(
                                    "h-3 w-3 text-slate-400",
                                    isSpeaking ? "text-green-400" : "text-slate-400 group-hover:text-slate-300"
                                  )} />
                                  <span className={cn(
                                    "text-xs transition-colors duration-300",
                                    isSpeaking ? "text-green-400" : "text-slate-400 group-hover:text-slate-300"
                                  )}>
                                    {Math.round(audioLevel)}%
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Audio Level Visualizer */}
                        <div className="space-y-2">
                          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                            <div 
                              className={cn(
                                "h-full transition-all duration-100 rounded-full",
                                isSpeaking 
                                  ? "bg-gradient-to-r from-green-500 to-cyan-400 shadow-sm shadow-green-500/50" 
                                  : "bg-gradient-to-r from-slate-600 to-slate-500"
                              )}
                              style={{ width: `${audioLevel}%` }}
                            />
                          </div>
                          
                          {/* Audio bars visualizer */}
                          <div className="flex items-end justify-center gap-1 h-8">
                            {Array.from({ length: 5 }).map((_, i) => (
                              <div
                                key={i}
                                className={cn(
                                  "w-1 rounded-full transition-all duration-100",
                                  isSpeaking && audioLevel > (i * 20)
                                    ? "bg-gradient-to-t from-green-500 to-cyan-400 shadow-sm shadow-green-500/50 animate-pulse"
                                    : "bg-slate-600 group-hover:bg-slate-500"
                                )}
                                style={{
                                  height: isSpeaking && audioLevel > (i * 20) 
                                    ? `${Math.max(20, (audioLevel / 100) * 32)}px`
                                    : "4px"
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}

                {/* Empty state for no participants */}
                {participants.length === 0 && (
                  <div className="col-span-full flex flex-col items-center justify-center py-12 text-center">
                    <div className="rounded-full bg-slate-800 p-6 mb-4">
                      <Users className="h-12 w-12 text-slate-400" />
                    </div>
                    <h3 className="text-lg font-semibold text-slate-300 mb-2">No players in this room</h3>
                    <p className="text-slate-500 max-w-md">
                      Be the first to join this voice room and start the conversation!
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* Welcome Screen */
            <div className="flex h-full items-center justify-center">
              <div className="text-center max-w-md">
                <div className="mb-6">
                  <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-r from-cyan-500 to-purple-500 shadow-lg shadow-cyan-500/25">
                    <Gamepad2 className="h-10 w-10 text-white" />
                  </div>
                  <h2 className="text-2xl font-bold text-white mb-2">Welcome to Vibecord</h2>
                  <p className="text-slate-400">
                    Select a room from the sidebar to start your gaming voice chat experience
                  </p>
                </div>
                
                <div className="space-y-3 text-sm text-slate-500">
                  <div className="flex items-center gap-2 justify-center">
                    <Mic className="h-4 w-4 text-cyan-400" />
                    <span>Crystal clear voice communication</span>
                  </div>
                  <div className="flex items-center gap-2 justify-center">
                    <Users className="h-4 w-4 text-purple-400" />
                    <span>Real-time participant tracking</span>
                  </div>
                  <div className="flex items-center gap-2 justify-center">
                    <Zap className="h-4 w-4 text-yellow-400" />
                    <span>Low latency gaming optimized</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
