"use client"

import {
  Headphones,
  LogOut,
  User,
  Shield,
  Bell,
  Palette,
  ArrowLeft,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useEffect, useState } from "react"
import type { User as SupabaseUser } from "@supabase/supabase-js"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

const navItems = [
  { icon: Headphones, label: "Voz e Vídeo", href: "/settings/audio" },
  { icon: User, label: "Perfil", href: "/settings/profile" },
  { icon: Shield, label: "Privacidade", href: "/settings/privacy" },
  { icon: Bell, label: "Notificações", href: "/settings/notifications" },
  { icon: Palette, label: "Aparência", href: "/settings/appearance" },
]

export function SettingsSidebar() {
  const router = useRouter()
  const supabase = createClient()
  const [user, setUser] = useState<SupabaseUser | null>(null)
  const [isSigningOut, setIsSigningOut] = useState(false)

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const { data } = await supabase.auth.getUser()
        setUser(data.user)
      } catch (error) {
        console.error('Error getting user:', error)
      }
    }
    fetchUser()
  }, [supabase.auth])

  const handleSignOut = async () => {
    try {
      setIsSigningOut(true)
      await supabase.auth.signOut()
      router.push('/login')
    } catch (error) {
      console.error('Error signing out:', error)
      setIsSigningOut(false)
    }
  }

  return (
    <div className="w-64 h-full bg-slate-900/95 backdrop-blur-xl border-r border-cyan-500/20 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-slate-700/50">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-slate-300 hover:text-white hover:bg-slate-700/50"
            onClick={() => router.push("/")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-lg font-semibold text-white">Configurações</h2>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4">
        <div className="space-y-2">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = window.location.pathname === item.href
            
            return (
              <Button
                key={item.href}
                variant="ghost"
                className={cn(
                  "w-full justify-start text-left h-10 px-3",
                  "text-slate-300 hover:text-white hover:bg-slate-700/50",
                  "transition-all duration-200",
                  isActive && "bg-cyan-500/20 text-cyan-400 border-r-2 border-cyan-400"
                )}
                onClick={() => router.push(item.href)}
              >
                <Icon className="h-4 w-4 mr-3 flex-shrink-0" />
                <span className="truncate">{item.label}</span>
              </Button>
            )
          })}
        </div>
      </nav>

      {/* User Profile */}
      <div className="p-4 border-t border-slate-700/50">
        {user && (
          <div className="flex items-center gap-3 mb-3">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-gradient-to-r from-cyan-500 to-purple-500 text-white text-sm">
                {user.email?.charAt(0).toUpperCase() || 'U'}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {user.email}
              </p>
            </div>
          </div>
        )}
        
        <Button
          variant="ghost"
          className="w-full justify-start text-slate-300 hover:text-red-400 hover:bg-red-500/10"
          onClick={handleSignOut}
          disabled={isSigningOut}
        >
          <LogOut className="h-4 w-4 mr-3" />
          {isSigningOut ? "Saindo..." : "Sair"}
        </Button>
      </div>
    </div>
  )
}