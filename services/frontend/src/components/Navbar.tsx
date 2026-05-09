import { Link, useNavigate } from 'react-router-dom'
import { Moon, Sun, LayoutDashboard, LogOut } from 'lucide-react'
import { useTheme } from '@/context/ThemeContext'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

export default function Navbar() {
  const { theme, toggle } = useTheme()
  const navigate = useNavigate()

  function logout() {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    navigate('/login')
  }

  const user = (() => {
    try { return JSON.parse(localStorage.getItem('user') ?? '') } catch { return null }
  })()

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur">
      <div className="flex h-14 items-center gap-4 px-4">
        <Link to="/boards" className="flex items-center gap-2 font-semibold">
          <LayoutDashboard className="h-5 w-5 text-primary" />
          TaskBoard
        </Link>

        <div className="flex-1" />

        {user && (
          <span className="hidden text-sm text-muted-foreground sm:block">{user.name}</span>
        )}

        <Separator orientation="vertical" className="h-6" />

        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>

        <Button variant="ghost" size="icon" onClick={logout} aria-label="Log out">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
