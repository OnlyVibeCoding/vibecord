"use client"

import { useState, useEffect, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Mic, MicOff, Volume2, VolumeX, PhoneOff, Users, Hash, LogOut } from "lucide-react"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import type { RealtimeChannel } from "@supabase/supabase-js"

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
  const [isMuted, setIsMuted] = useState(false)
  const [isDeafened, setIsDeafened] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const mediaStreamRef = useRef<MediaStream | null>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)

  useEffect(() => {
    loadUserData()
    loadRooms()
  }, [])

  useEffect(() => {
    if (!currentRoom) return

    const channel = supabase
      .channel(`room:${currentRoom}`)
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
      .subscribe()

    channelRef.current = channel
    loadParticipants(currentRoom)

    return () => {
      channel.unsubscribe()
    }
  }, [currentRoom])

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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream

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
        </div>

        <ScrollArea className="flex-1 p-2">
          <div className="space-y-1">
            {rooms.map((room) => {
              const roomParticipantCount = participants.filter((p) => p.room_id === room.id).length
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
                    {currentRoom === room.id && (
                      <div className="flex items-center gap-1 text-xs text-slate-300">
                        <Users className="h-3 w-3" />
                        {roomParticipantCount} {roomParticipantCount === 1 ? "usuário" : "usuários"}
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </ScrollArea>

        {/* Controles de Usuário */}
        <div className="border-t border-slate-800 bg-slate-900/80 p-3">
          <div className="mb-3 flex items-center gap-3">
            <Avatar className="h-8 w-8">
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
