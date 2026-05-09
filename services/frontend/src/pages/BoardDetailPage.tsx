import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Plus, Trash2, ArrowLeft, ChevronLeft, ChevronRight, Clock, Palette } from 'lucide-react'
import type { Column, Task } from '@/lib/types'
import { PRIORITY_CONFIG, COLUMN_COLORS } from '@/lib/types'
import * as api from '@/lib/api'
import Navbar from '@/components/Navbar'
import TaskModal from '@/components/TaskModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

interface ColumnWithTasks extends Column {
  tasks: Task[]
}

type ModalState =
  | { kind: 'none' }
  | { kind: 'create'; columnId: number }
  | { kind: 'edit'; task: Task }

function colStyle(color: string | null) {
  const cfg = COLUMN_COLORS.find(c => c.id === color) ?? COLUMN_COLORS[0]
  return cfg
}

export default function BoardDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const boardId = Number(id)

  const [boardName, setBoardName] = useState('')
  const [columns, setColumns] = useState<ColumnWithTasks[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [apiError, setApiError] = useState('')

  const [modal, setModal] = useState<ModalState>({ kind: 'none' })

  const [colDialogOpen, setColDialogOpen] = useState(false)
  const [newColName, setNewColName] = useState('')
  const [newColColor, setNewColColor] = useState<string | null>(null)
  const [addingCol, setAddingCol] = useState(false)

  const loadBoard = useCallback(async () => {
    setLoading(true)
    try {
      const [boards, cols] = await Promise.all([api.listBoards(), api.listColumns(boardId)])
      const board = boards.find(b => b.id === boardId)
      if (!board) { navigate('/boards'); return }
      setBoardName(board.name)

      const withTasks = await Promise.all(
        cols.map(async col => ({ ...col, tasks: await api.listTasks(col.id) }))
      )
      setColumns(withTasks)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [boardId, navigate])

  useEffect(() => { loadBoard() }, [loadBoard])

  // ── column actions ──────────────────────────────────────────────────────────

  async function addColumn(e: React.FormEvent) {
    e.preventDefault()
    if (!newColName.trim()) return
    setAddingCol(true)
    setApiError('')
    try {
      const col = await api.createColumn(boardId, newColName.trim(), newColColor)
      setColumns(prev => [...prev, { ...col, tasks: [] }])
      setNewColName('')
      setNewColColor(null)
      setColDialogOpen(false)
    } catch (e: unknown) {
      setApiError(e instanceof Error ? e.message : 'Failed to add column')
    } finally {
      setAddingCol(false)
    }
  }

  async function deleteColumn(colId: number) {
    setApiError('')
    try {
      await api.deleteColumn(colId)
      setColumns(prev => prev.filter(c => c.id !== colId))
    } catch (e: unknown) {
      setApiError(e instanceof Error ? e.message : 'Failed to delete column')
    }
  }

  async function moveColumn(colId: number, direction: -1 | 1) {
    const idx = columns.findIndex(c => c.id === colId)
    const newPos = idx + direction
    if (newPos < 0 || newPos >= columns.length) return
    setApiError('')
    try {
      const updated = await api.updateColumn(colId, { position: newPos })
      // Optimistic reorder: swap in local state, backend does the real reorder
      setColumns(prev => {
        const next = [...prev]
        const a = next[idx], b = next[newPos]
        next[idx] = { ...b, tasks: b.tasks }
        next[newPos] = { ...a, tasks: a.tasks }
        return next
      })
      // Re-fetch to get server-authoritative positions
      const cols = await api.listColumns(boardId)
      setColumns(prev => cols.map(c => ({ ...c, tasks: prev.find(p => p.id === c.id)?.tasks ?? [] })))
      void updated
    } catch (e: unknown) {
      setApiError(e instanceof Error ? e.message : 'Failed to reorder')
    }
  }

  async function setColumnColor(colId: number, color: string | null) {
    try {
      const updated = await api.updateColumn(colId, color === null ? { clear_color: true } : { color })
      setColumns(prev => prev.map(c => c.id === colId ? { ...c, color: updated.color } : c))
    } catch (e: unknown) {
      setApiError(e instanceof Error ? e.message : 'Failed to update color')
    }
  }

  // ── task actions ─────────────────────────────────────────────────────────────

  function handleTaskCreated(task: Task) {
    setColumns(prev =>
      prev.map(c => c.id === task.column_id ? { ...c, tasks: [...c.tasks, task] } : c)
    )
  }

  function handleTaskUpdated(updated: Task) {
    setColumns(prev =>
      prev.map(c => ({ ...c, tasks: c.tasks.map(t => t.id === updated.id ? updated : t) }))
    )
    if (modal.kind === 'edit') setModal({ kind: 'edit', task: updated })
  }

  async function handleTaskDeleted(taskId: number) {
    await api.deleteTask(taskId)
    setColumns(prev => prev.map(c => ({ ...c, tasks: c.tasks.filter(t => t.id !== taskId) })))
    setModal({ kind: 'none' })
  }

  if (loading) return <div className="min-h-screen"><Navbar /><p className="p-8 text-muted-foreground">Loading…</p></div>
  if (error) return <div className="min-h-screen"><Navbar /><p className="p-8 text-destructive">{error}</p></div>

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Navbar />

      {/* Board header */}
      <div className="flex items-center gap-3 border-b bg-gradient-to-r from-indigo-500/10 via-violet-500/5 to-transparent px-4 py-3 dark:from-indigo-900/20">
        <Button variant="ghost" size="icon" onClick={() => navigate('/boards')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-lg font-semibold">{boardName}</h1>
        <div className="flex-1" />
        {apiError && <p className="text-sm text-destructive">{apiError}</p>}
        <Button
          size="sm"
          className="bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700"
          onClick={() => { setColDialogOpen(true) }}
          disabled={columns.length >= 10}
        >
          <Plus className="mr-1 h-4 w-4" /> Column
        </Button>
      </div>

      {/* Kanban board */}
      <div className="flex flex-1 gap-4 overflow-x-auto p-4 pb-8">
        {columns.map((col, idx) => {
          const colorCfg = colStyle(col.color)
          return (
            <div
              key={col.id}
              className={cn(
                'flex w-72 shrink-0 flex-col rounded-xl border shadow-sm',
                colorCfg.wrapper || 'bg-muted/40'
              )}
            >
              {/* Column header */}
              <div className={cn('flex items-center gap-2 rounded-t-xl px-3 py-2.5', colorCfg.header || 'bg-muted/60')}>
                {/* Color dot */}
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', colorCfg.dot || 'bg-slate-400')} />
                <span className="flex-1 truncate text-sm font-semibold">{col.name}</span>
                <Badge variant="secondary" className="text-xs">{col.tasks.length}</Badge>

                {/* Color picker */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground">
                      <Palette className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <div className="grid grid-cols-5 gap-1 p-1.5">
                      {COLUMN_COLORS.map(c => (
                        <button
                          key={String(c.id)}
                          title={c.label}
                          onClick={() => setColumnColor(col.id, c.id)}
                          className={cn(
                            'h-6 w-6 rounded-full border-2 transition-transform hover:scale-110',
                            c.dot,
                            col.color === c.id ? 'border-foreground scale-110' : 'border-transparent'
                          )}
                        />
                      ))}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Move left */}
                <Button
                  variant="ghost" size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  disabled={idx === 0}
                  onClick={() => moveColumn(col.id, -1)}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>

                {/* Move right */}
                <Button
                  variant="ghost" size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  disabled={idx === columns.length - 1}
                  onClick={() => moveColumn(col.id, 1)}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>

                {/* Delete */}
                <Button
                  variant="ghost" size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  disabled={columns.length <= 1}
                  onClick={() => deleteColumn(col.id)}
                  title="Delete column"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <Separator />

              {/* Tasks */}
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                {col.tasks.map(task => {
                  const overdue = task.deadline && new Date(task.deadline) < new Date()
                  const pCfg = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.medium
                  return (
                    <button
                      key={task.id}
                      className="group w-full rounded-lg border bg-background/90 p-3 text-left shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-ring"
                      onClick={() => setModal({ kind: 'edit', task })}
                    >
                      {/* Priority badge */}
                      <div className={cn('mb-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', pCfg.badge)}>
                        {pCfg.emoji} {pCfg.label}
                      </div>

                      <p className="text-sm font-medium leading-snug">{task.title}</p>

                      {task.description && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {task.description}
                        </p>
                      )}

                      {task.deadline && (
                        <div className={cn('mt-2 flex items-center gap-1 text-xs', overdue ? 'text-destructive' : 'text-muted-foreground')}>
                          <Clock className="h-3 w-3" />
                          {new Date(task.deadline).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          {overdue && ' · Overdue'}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Add task */}
              <div className="p-2 pt-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground hover:text-foreground"
                  onClick={() => setModal({ kind: 'create', columnId: col.id })}
                >
                  <Plus className="mr-1 h-4 w-4" /> Add task
                </Button>
              </div>
            </div>
          )
        })}

        {columns.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            No columns yet. Add one to get started.
          </div>
        )}
      </div>

      {/* Task modal (create or edit) */}
      {modal.kind === 'create' && (
        <TaskModal
          mode="create"
          columnId={modal.columnId}
          open
          onClose={() => setModal({ kind: 'none' })}
          onCreated={t => { handleTaskCreated(t); setModal({ kind: 'none' }) }}
        />
      )}
      {modal.kind === 'edit' && (
        <TaskModal
          mode="edit"
          task={modal.task}
          open
          onClose={() => setModal({ kind: 'none' })}
          onUpdated={handleTaskUpdated}
          onDeleted={handleTaskDeleted}
        />
      )}

      {/* Add column dialog */}
      <Dialog open={colDialogOpen} onOpenChange={setColDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add column</DialogTitle></DialogHeader>
          <form onSubmit={addColumn} className="space-y-4">
            <Input
              placeholder="Column name"
              value={newColName}
              onChange={e => setNewColName(e.target.value)}
              maxLength={50}
              autoFocus
            />
            {/* Color picker */}
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Color</p>
              <div className="flex flex-wrap gap-2">
                {COLUMN_COLORS.map(c => (
                  <button
                    type="button"
                    key={String(c.id)}
                    title={c.label}
                    onClick={() => setNewColColor(c.id)}
                    className={cn(
                      'h-7 w-7 rounded-full border-2 transition-transform hover:scale-110',
                      c.dot,
                      newColColor === c.id ? 'border-foreground scale-110' : 'border-transparent'
                    )}
                  />
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setColDialogOpen(false)}>Cancel</Button>
              <Button
                type="submit"
                disabled={addingCol || !newColName.trim()}
                className="bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700"
              >
                {addingCol ? 'Adding…' : 'Add column'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
