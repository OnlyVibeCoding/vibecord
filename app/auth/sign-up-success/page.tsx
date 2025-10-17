import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { Mail, Mic } from "lucide-react"

export default function SignUpSuccessPage() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 p-6">
      <div className="w-full max-w-md">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600">
              <Mic className="h-8 w-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-white">VoiceChat</h1>
          </div>
          <Card className="border-slate-800 bg-slate-900/50 backdrop-blur">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
                <Mail className="h-8 w-8 text-green-500" />
              </div>
              <CardTitle className="text-2xl text-white">Verifique seu email</CardTitle>
              <CardDescription className="text-slate-400">
                Enviamos um link de confirmação para seu email. Clique no link para ativar sua conta.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              <p className="mb-6 text-sm text-slate-400">
                Após confirmar seu email, você poderá fazer login e começar a usar o VoiceChat.
              </p>
              <Button
                asChild
                className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700"
              >
                <Link href="/auth/login">Ir para login</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
