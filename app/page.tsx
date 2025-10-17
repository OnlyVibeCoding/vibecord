import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { VoiceApp } from "@/components/voice-app"

export default async function Home() {
  const supabase = await createClient()

  try {
    const { data, error } = await supabase.auth.getUser()
    if (error || !data?.user) {
      redirect("/auth/login")
    }
    
    return (
      <div className="flex flex-col min-h-screen bg-background">
        <main className="flex-1">
          <VoiceApp />
        </main>
      </div>
    )
  } catch (error) {
    console.error("Erro na página inicial:", error)
    redirect("/auth/login")
  }
}
